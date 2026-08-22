using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace TiaMcpServer.Siemens
{
    // Manual Siemens.Engineering.dll resolve
    public class Engineering
    {
        public static int TiaMajorVersion { get; set; }

        // Optional explicit override (CLI --tia-portal-location), e.g. D:\app\TIA20\Portal V20.
        // Takes precedence over TiaPortalLocation env var and registry lookup.
        public static string? TiaPortalLocationOverride { get; set; }

        // When true, launch TIA Portal with its full GUI (slower cold start, allows visual inspection).
        // Default false = headless (WithoutUserInterface), which starts much faster. Set via --with-ui.
        // Lives here (not on Portal) because Program.Main must set it without forcing the CLR to load the
        // Portal type — Portal's Siemens.Engineering field types would be needed before Resolver is wired up.
        public static bool LaunchWithUserInterface { get; set; } = false;

        public static Assembly? Resolver(object sender, ResolveEventArgs args)
        {
            var assemblyName = new AssemblyName(args.Name);
            if (!assemblyName.Name.StartsWith("Siemens.Engineering"))
            {
                return null;
            }

            var tiaInstallPath = GetTiaPortalInstallPath();
            if (string.IsNullOrEmpty(tiaInstallPath))
            {
                throw new InvalidOperationException($"Could not find TIA Portal installation path for version {TiaMajorVersion} in the registry.");
            }

            var tiaMajorVersionString = TiaMajorVersion.ToString();
            var searchDirectories = new[]
            {
                Path.Combine(tiaInstallPath, "PublicAPI", $"V{tiaMajorVersionString}"),
                Path.Combine(tiaInstallPath, "Bin", "PublicAPI")
            };

            // IEnumerable without given majorVersionString
            var excludedTiaMajorVersions = new[] { "V13", "V14", "V15", "V16", "V17", "V18", "V19", "V20" }
                                    .Where(v => v != $"V{tiaMajorVersionString}");

            foreach (var dir in searchDirectories)
            {
                var assemblyPath = FindAssemblyRecursive(dir, assemblyName.Name + ".dll", excludedTiaMajorVersions);
                if (assemblyPath != null)
                {
                    return Assembly.LoadFrom(assemblyPath);
                }
            }

            throw new FileNotFoundException($"Could not find DLL '{assemblyName.Name}' for TIA Portal version {TiaMajorVersion} in the installation directories.");
        }

        /// <summary>
        /// Detects the highest installed TIA Portal major version without requiring a CLI flag.
        /// Detection order:
        ///   1. TiaPortalLocation env var — extract version from path (e.g. "Portal V21" → 21)
        ///   2. Registry: HKLM\SOFTWARE\Siemens\Automation\_InstalledSW\TIAP*\TIA_Opns
        ///   3. Filesystem: C:\Program Files\Siemens\Automation\Portal V*
        /// Returns the highest found version, or null if nothing detected.
        /// </summary>
        public static int? DetectTiaMajorVersion()
        {
            var candidates = new List<int>();

            // 0. Explicit override (CLI --tia-portal-location)
            if (!string.IsNullOrWhiteSpace(TiaPortalLocationOverride))
            {
                var m = System.Text.RegularExpressions.Regex.Match(TiaPortalLocationOverride, @"[Vv](\d{2})", System.Text.RegularExpressions.RegexOptions.RightToLeft);
                if (m.Success && int.TryParse(m.Groups[1].Value, out int ovVer))
                    candidates.Add(ovVer);
            }

            // 1. TiaPortalLocation env var
            var env = Environment.GetEnvironmentVariable("TiaPortalLocation");
            if (!string.IsNullOrWhiteSpace(env))
            {
                var match = System.Text.RegularExpressions.Regex.Match(env, @"[Vv](\d{2})", System.Text.RegularExpressions.RegexOptions.RightToLeft);
                if (match.Success && int.TryParse(match.Groups[1].Value, out int envVer))
                    candidates.Add(envVer);
            }

            // 2. Registry scan
            try
            {
                using var regBase = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
                using var installedSw = regBase.OpenSubKey(@"SOFTWARE\Siemens\Automation\_InstalledSW");
                if (installedSw != null)
                {
                    foreach (var subName in installedSw.GetSubKeyNames())
                    {
                        // Key names follow pattern TIAP21, TIAP20, etc.
                        var numMatch = System.Text.RegularExpressions.Regex.Match(subName, @"TIAP(\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                        if (!numMatch.Success || !int.TryParse(numMatch.Groups[1].Value, out int regVer)) continue;

                        using var opnsKey = installedSw.OpenSubKey(subName + @"\TIA_Opns");
                        if (opnsKey?.GetValue("Path") is string path && Directory.Exists(path))
                            candidates.Add(regVer);
                    }
                }
            }
            catch { }

            // 3. Filesystem scan
            try
            {
                var siemensRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Siemens", "Automation");
                if (Directory.Exists(siemensRoot))
                {
                    foreach (var dir in Directory.GetDirectories(siemensRoot, "Portal V*"))
                    {
                        var dirMatch = System.Text.RegularExpressions.Regex.Match(dir, @"Portal V(\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                        if (dirMatch.Success && int.TryParse(dirMatch.Groups[1].Value, out int fsVer))
                            candidates.Add(fsVer);
                    }
                }
            }
            catch { }

            return candidates.Count > 0 ? candidates.Max() : (int?)null;
        }

        private static string? GetTiaPortalInstallPath()
        {
            // 1. Explicit CLI override (--tia-portal-location). Highest priority.
            if (!string.IsNullOrWhiteSpace(TiaPortalLocationOverride) && Directory.Exists(TiaPortalLocationOverride))
            {
                return TiaPortalLocationOverride;
            }

            // 2. Version-specific environment variable. Do not silently use a
            // different TIA major version on machines with side-by-side installs.
            var env = Environment.GetEnvironmentVariable("TiaPortalLocation");
            bool envUsable = !string.IsNullOrWhiteSpace(env) && Directory.Exists(env);
            if (envUsable && PathMatchesVersion(env!, TiaMajorVersion))
            {
                return env;
            }

            // 3. Siemens' optional _InstalledSW TIA_Opns registration.
            var installedRoot = $@"SOFTWARE\Siemens\Automation\_InstalledSW\TIAP{TiaMajorVersion}";
            var tiaOpnsPath = ReadRegistryPath(installedRoot + @"\TIA_Opns");
            if (Directory.Exists(tiaOpnsPath))
            {
                return tiaOpnsPath;
            }

            // 4. EditionMain is present on installations where TIA_Opns is not.
            var editionPath = ReadRegistryPath(installedRoot + @"\EditionMain");
            if (Directory.Exists(editionPath))
            {
                return editionPath;
            }

            // 5. The Openness hive records the exact Siemens.Engineering.Base.dll
            // location. Derive Portal Vxx from that path when the vendor's
            // _InstalledSW subkey is absent (the common customer failure mode).
            foreach (var framework in new[] { "net48", "net47" })
            {
                var opennessKey = $@"SOFTWARE\Siemens\Automation\Openness\{TiaMajorVersion}.0\PublicAPI\{TiaMajorVersion}.0.0.0\{framework}";
                var assemblyPath = ReadRegistryValue(opennessKey, "Siemens.Engineering.Base");
                var opennessRoot = PortalRootFromAssemblyPath(assemblyPath);
                if (Directory.Exists(opennessRoot))
                {
                    return opennessRoot;
                }
            }

            // 6. Standard Program Files location, including non-registry
            // installs where the user kept the vendor default folder.
            var defaultRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Siemens", "Automation", $"Portal V{TiaMajorVersion}");
            if (Directory.Exists(defaultRoot))
            {
                return defaultRoot;
            }

            // A version-mismatched env var is deliberately not used: loading a
            // V21 assembly into the V20 process produces a misleading CLR error.
            return null;
        }

        private static string? ReadRegistryPath(string keyPath)
        {
            var path = ReadRegistryValue(keyPath, "Path");
            return string.IsNullOrWhiteSpace(path) ? null : path.TrimEnd('\\', '/');
        }

        private static string? ReadRegistryValue(string keyPath, string valueName)
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                    using var key = baseKey.OpenSubKey(keyPath);
                    var value = key?.GetValue(valueName)?.ToString();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        return value;
                    }
                }
                catch
                {
                    // A locked or missing registry view is not fatal; try the other view.
                }
            }
            return null;
        }

        private static string? PortalRootFromAssemblyPath(string? assemblyPath)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath)) return null;
            var normalized = assemblyPath.Trim().TrimEnd('\\', '/');
            var marker = $"\\PublicAPI\\V{TiaMajorVersion}\\";
            var index = normalized.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (index < 0)
            {
                marker = $"\\PublicAPI\\{TiaMajorVersion}.0.0.0\\";
                index = normalized.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            }
            return index > 0 ? normalized.Substring(0, index) : null;
        }
        /// <summary>True when the path names no version at all, or names exactly V{version}.</summary>
        private static bool PathMatchesVersion(string path, int version)
        {
            var m = System.Text.RegularExpressions.Regex.Match(path, @"[Vv](\d{2})",
                System.Text.RegularExpressions.RegexOptions.RightToLeft);
            if (!m.Success) return true;
            return int.TryParse(m.Groups[1].Value, out int pv) && pv == version;
        }

        private static string? FindAssemblyRecursive(string directory, string fileName, IEnumerable<string> excludedTiaMajorVersions)
        {
            if (!Directory.Exists(directory))
            {
                return null;
            }

            var filePath = Path.Combine(directory, fileName);
            if (File.Exists(filePath))
            {
                return filePath;
            }

            foreach (var subDir in Directory.GetDirectories(directory))
            {
                var subDirName = new DirectoryInfo(subDir).Name;
                if (excludedTiaMajorVersions.Contains(subDirName))
                {
                    continue;
                }

                var result = FindAssemblyRecursive(subDir, fileName, excludedTiaMajorVersions);
                if (result != null)
                {
                    return result;
                }
            }

            return null;
        }
    }
}
