using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

sealed class GreenUpdater
{
    const int Failure = 10;
    const long MaxPackageBytes = 250L * 1024L * 1024L;
    const string HealthUrl = "http://localhost:3000/api/license";

    [STAThread]
    static int Main(string[] args)
    {
        bool replaced = false;
        bool restored = false;
        string root = null;
        string backup = null;
        string work = null;
        Process launched = null;
        try
        {
            if (args == null || args.Length != 1) return Fail(false);
            Dictionary<string, object> plan = LoadPlan(args[0]);
            root = Required(plan, "root");
            string package = Required(plan, "package");
            string expectedSha = Required(plan, "sha256").ToLowerInvariant();
            long expectedSize = RequiredLong(plan, "sizeBytes");
            int parentPid = (int)RequiredLong(plan, "parentPid");
            if (!IsSafePath(root) || !File.Exists(package) || expectedSha.Length != 64 || expectedSize <= 0 || expectedSize > MaxPackageBytes) return Fail(false);
            if (!VerifyPackage(package, expectedSize, expectedSha)) return Fail(false);
            if (!WaitForParentExit(parentPid)) return Fail(false);

            work = Path.Combine(Path.GetTempPath(), "老殷工控PLC助手", "updates", "apply-" + Guid.NewGuid().ToString("N"));
            string extract = Path.Combine(work, "extract");
            backup = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + ".backup-" + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(extract);
            SafeExtract(package, extract);
            string candidate = FindPackageRoot(extract);
            if (candidate == null || !IsPackageSafe(candidate)) return Fail(false);

            Directory.Move(root, backup);
            replaced = true;
            Directory.Move(candidate, root);
            string launcher = Path.Combine(root, "老殷工控PLC助手.exe");
            if (!File.Exists(launcher)) throw new InvalidOperationException();
            launched = Process.Start(new ProcessStartInfo(launcher) { WorkingDirectory = root, UseShellExecute = true });
            if (launched == null || !WaitForHealthyService(launched)) throw new InvalidOperationException();
            TryDelete(backup);
            TryDelete(work);
            return 0;
        }
        catch
        {
            if (launched != null && !launched.HasExited) KillTree(launched);
            if (replaced && !string.IsNullOrWhiteSpace(root) && !string.IsNullOrWhiteSpace(backup))
            {
                TryDelete(root);
                try
                {
                    if (Directory.Exists(backup))
                    {
                        Directory.Move(backup, root);
                        restored = true;
                        string oldLauncher = Path.Combine(root, "老殷工控PLC助手.exe");
                        if (File.Exists(oldLauncher)) Process.Start(new ProcessStartInfo(oldLauncher) { WorkingDirectory = root, UseShellExecute = true });
                    }
                }
                catch { restored = false; }
            }
            if (!string.IsNullOrWhiteSpace(work)) TryDelete(work);
            return Fail(restored);
        }
    }

    static Dictionary<string, object> LoadPlan(string path)
    {
        if (!IsSafePath(path) || !File.Exists(path)) throw new InvalidOperationException();
        string json = File.ReadAllText(path, Encoding.UTF8);
        var result = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
        if (result == null) throw new InvalidOperationException();
        return result;
    }

    static string Required(Dictionary<string, object> data, string key)
    {
        object value;
        if (!data.TryGetValue(key, out value) || value == null || string.IsNullOrWhiteSpace(Convert.ToString(value))) throw new InvalidOperationException();
        return Convert.ToString(value);
    }

    static long RequiredLong(Dictionary<string, object> data, string key)
    {
        long value;
        if (!long.TryParse(Required(data, key), out value)) throw new InvalidOperationException();
        return value;
    }

    static bool IsSafePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        string full = Path.GetFullPath(path);
        return Path.IsPathRooted(full) && full.IndexOf((char)0) < 0;
    }

    static bool VerifyPackage(string path, long expectedSize, string expectedSha)
    {
        var file = new FileInfo(path);
        if (!file.Exists || file.Length != expectedSize || file.Length > MaxPackageBytes) return false;
        using (var sha = SHA256.Create())
        using (var input = file.OpenRead())
        {
            string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
            return actual == expectedSha;
        }
    }

    static bool WaitForParentExit(int pid)
    {
        if (pid <= 0) return false;
        for (int i = 0; i < 150; i++)
        {
            try
            {
                using (var process = Process.GetProcessById(pid))
                {
                    if (process.HasExited) return true;
                }
            }
            catch (ArgumentException) { return true; }
            catch { }
            System.Threading.Thread.Sleep(200);
        }
        return false;
    }

    static bool WaitForHealthyService(Process launcher)
    {
        for (int i = 0; i < 120; i++)
        {
            if (launcher.HasExited) return false;
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
                request.Timeout = 700;
                request.ReadWriteTimeout = 700;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    if (response.StatusCode == HttpStatusCode.OK && body.Contains("\"ok\":true")) return true;
                }
            }
            catch { }
            System.Threading.Thread.Sleep(250);
        }
        return false;
    }

    static void SafeExtract(string zipPath, string destination)
    {
        string baseDir = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            foreach (var entry in archive.Entries)
            {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0) throw new InvalidOperationException();
                string[] parts = relative.Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
                foreach (string part in parts) if (part == "..") throw new InvalidOperationException();
                string target = Path.GetFullPath(Path.Combine(baseDir, relative));
                if (!target.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                {
                    Directory.CreateDirectory(target);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (var input = entry.Open())
                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    input.CopyTo(output);
                }
            }
        }
    }

    static string FindPackageRoot(string extract)
    {
        if (IsPackageSafe(extract)) return extract;
        string[] dirs = Directory.GetDirectories(extract);
        if (dirs.Length != 1 || !IsPackageSafe(dirs[0])) return null;
        return dirs[0];
    }

    static bool IsPackageSafe(string root)
    {
        if (!Directory.Exists(root)) return false;
        string[] required = {
            Path.Combine(root, "老殷工控PLC助手.exe"),
            Path.Combine(root, "老殷工控PLC助手更新器.exe"),
            Path.Combine(root, "runtime", "laoyin-server.exe"),
            Path.Combine(root, "app", "login.html"),
            Path.Combine(root, "app", "web", "app.js")
        };
        foreach (string path in required) if (!File.Exists(path)) return false;
        foreach (string path in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
        {
            string name = Path.GetFileName(path);
            if (name.Equals(".env", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("license.json", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("trial.marker", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("plc_assistant.db", StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    static void KillTree(Process process)
    {
        try
        {
            Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + process.Id + " /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            }).WaitForExit(5000);
        }
        catch { }
    }

    static void TryDelete(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); else if (File.Exists(path)) File.Delete(path); } catch { }
    }

    static int Fail(bool restored)
    {
        string message = restored ? "更新失败，已恢复原版本。" : "更新失败，当前版本未修改。";
        if (Environment.GetEnvironmentVariable("LAOYIN_UPDATER_SILENT") == "1")
        {
            try { Console.Error.WriteLine(message); } catch { }
        }
        else
        {
            try { MessageBox.Show(message, "老殷工控PLC助手", MessageBoxButtons.OK, MessageBoxIcon.Warning); } catch { }
        }
        return Failure;
    }
}
