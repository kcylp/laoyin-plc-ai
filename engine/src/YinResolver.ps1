# ============================================================
#  Engineer Yin - native assembly resolver
#  WHY THIS EXISTS: a PowerShell ScriptBlock used as an
#  AssemblyResolve handler consumes a very large stack frame per
#  invocation. TiaPortal.Attach() resolves dependencies deeply
#  enough that this overflows the stack - and StackOverflowException
#  cannot be caught, it kills the process.
#  Compiling the handler to C# keeps every resolve on a plain .NET
#  frame, so the same call depth costs a fraction of the stack.
# ============================================================

if (-not ('EngineerYin.NativeResolver' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace EngineerYin
{
    public static class NativeResolver
    {
        private static string _probeDir;
        private static readonly Dictionary<string, Assembly> _cache =
            new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> _inFlight =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static bool _installed;

        public static int ResolveCount { get; private set; }

        public static void Install(string probeDir)
        {
            _probeDir = probeDir;
            if (_installed) { return; }
            AppDomain.CurrentDomain.AssemblyResolve += OnResolve;
            _installed = true;
        }

        private static Assembly OnResolve(object sender, ResolveEventArgs args)
        {
            string simpleName = args.Name.Split(',')[0];

            Assembly hit;
            if (_cache.TryGetValue(simpleName, out hit)) { return hit; }

            // Already-loaded assemblies win, and cost no disk access.
            foreach (Assembly a in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (string.Equals(a.GetName().Name, simpleName, StringComparison.OrdinalIgnoreCase))
                {
                    _cache[simpleName] = a;
                    return a;
                }
            }

            // Re-entrancy guard: breaks resolve cycles without recursing.
            if (_inFlight.Contains(simpleName)) { return null; }
            _inFlight.Add(simpleName);
            try
            {
                string dll = Path.Combine(_probeDir, simpleName + ".dll");
                if (File.Exists(dll))
                {
                    Assembly loaded = Assembly.LoadFrom(dll);
                    _cache[simpleName] = loaded;
                    ResolveCount++;
                    return loaded;
                }
                return null;
            }
            catch
            {
                return null;
            }
            finally
            {
                _inFlight.Remove(simpleName);
            }
        }

        // Load every assembly in the probe directory up front so the
        // handler mostly serves cache hits during Attach().
        public static int PreloadAll()
        {
            int n = 0;
            if (!Directory.Exists(_probeDir)) { return 0; }
            foreach (string f in Directory.GetFiles(_probeDir, "*.dll"))
            {
                try
                {
                    Assembly a = Assembly.LoadFrom(f);
                    _cache[a.GetName().Name] = a;
                    n++;
                }
                catch { }
            }
            return n;
        }
    }
}
'@ -ErrorAction Stop
}
