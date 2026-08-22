using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;

sealed class GreenContext : ApplicationContext
{
    const string BaseUrl = "http://localhost:3000";
    const string CurrentVersion = "1.0.2";
    const string ManifestUrl = "https://raw.githubusercontent.com/kcylp/laoyin-plc-ai/main/update-manifest.json";
    readonly string root;
    readonly string shutdownToken;
    readonly Process server;
    readonly NotifyIcon tray;
    readonly SynchronizationContext ui;

    GreenContext(string rootDir, Process child, string token)
    {
        root = rootDir;
        server = child;
        shutdownToken = token;
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        tray = new NotifyIcon();
        tray.Icon = SystemIcons.Application;
        tray.Text = "老殷工控PLC助手";
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenBrowser(BaseUrl); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开工作台", null, delegate { OpenBrowser(BaseUrl); });
        menu.Items.Add("检查更新", null, delegate { CheckForUpdates(); });
        menu.Items.Add("退出老殷工控PLC助手", null, delegate { Shutdown(); });
        tray.ContextMenuStrip = menu;
        server.EnableRaisingEvents = true;
        server.Exited += delegate { BeginExit(); };
    }

    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (IsOurApp()) { OpenBrowser(BaseUrl); return 0; }
        if (IsPortOpen()) {
            Fail(root, "端口 3000 已被其他程序占用，请关闭占用程序后重试。");
            return 2;
        }

        string appDir = Path.Combine(root, "app");
        string serverExe = Path.Combine(root, "runtime", "laoyin-server.exe");
        if (!File.Exists(serverExe) || !Directory.Exists(appDir)) {
            Fail(root, "启动失败：绿色包文件不完整，请重新解压完整压缩包。");
            return 1;
        }

        string userDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "老殷工控PLC助手");
        try {
            Directory.CreateDirectory(userDir);
            Directory.CreateDirectory(Path.Combine(appDir, "work", "logs"));
            Directory.CreateDirectory(Path.Combine(appDir, "work", "db-backups"));
        } catch {
            Fail(root, "启动失败：无法创建运行目录，请检查当前用户权限。");
            return 1;
        }

        string token = Guid.NewGuid().ToString("N");
        var psi = new ProcessStartInfo();
        psi.FileName = serverExe;
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.RedirectStandardError = true;
        psi.EnvironmentVariables["APP_ROOT"] = appDir;
        psi.EnvironmentVariables["DB_PATH"] = Path.Combine(userDir, "plc_assistant.db");
        psi.EnvironmentVariables["PORT"] = "3000";
        psi.EnvironmentVariables["LAUNCHER_SHUTDOWN_TOKEN"] = token;

        Process child;
        try { child = Process.Start(psi); }
        catch {
            Fail(root, "启动失败：服务程序无法运行，请重新解压后重试。");
            return 1;
        }

        for (int i = 0; i < 120; i++) {
            Thread.Sleep(250);
            if (child.HasExited) {
                string detail = "";
                try { detail = child.StandardError.ReadToEnd().Trim(); } catch { }
                int exitCode = child.ExitCode;
                Fail(root, FriendlyFailure(detail, exitCode), BuildSafeDiagnostic(detail, exitCode, root, serverExe));
                return child.ExitCode;
            }
            if (IsOurApp()) {
                OpenBrowser(BaseUrl);
                Application.Run(new GreenContext(root, child, token));
                return 0;
            }
        }
        KillTree(child);
        Fail(root, "启动超时：30 秒内服务未就绪，请查看启动日志。");
        return 1;
    }

    static string FriendlyFailure(string detail, int exitCode)
    {
        string firstLine = (detail ?? "").Split(new[] {'\r','\n'})[0].Trim();
        if (exitCode == 78 || firstLine.Contains("授权")) return "授权校验未通过，请联系软件管理员。";
        if (exitCode == 98 || firstLine.Contains("端口")) return "端口 3000 已被其他程序占用，请关闭占用程序后重试。";
        return "启动失败，请联系软件管理员并提供启动日志。";
    }

    static string BuildSafeDiagnostic(string detail, int exitCode, string root, string serverExe)
    {
        var lines = new List<string>();
        lines.Add("诊断时间: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss zzz"));
        lines.Add("启动器版本: " + CurrentVersion);
        lines.Add("Windows: " + Environment.OSVersion.VersionString);
        lines.Add("64位系统: " + (Environment.Is64BitOperatingSystem ? "是" : "否"));
        lines.Add("程序目录写入: " + (CanWriteDirectory(root) ? "可写" : "不可写"));
        bool serverExists = !string.IsNullOrEmpty(serverExe) && File.Exists(serverExe);
        lines.Add("后端文件: " + (serverExists ? "存在" : "缺失"));
        if (serverExists) {
            try { lines.Add("后端文件大小: " + new FileInfo(serverExe).Length + " 字节"); }
            catch { lines.Add("后端文件大小: 无法读取"); }
        }
        lines.Add("后端退出码: " + (exitCode < 0 ? "未取得" : exitCode.ToString()));
        lines.Add("后端错误摘要: " + SanitizeDiagnostic(detail));
        string result = string.Join(Environment.NewLine, lines);
        return result.Length > 8192 ? result.Substring(0, 8192) : result;
    }

    static bool CanWriteDirectory(string directory)
    {
        if (string.IsNullOrEmpty(directory)) return false;
        string probe = null;
        try {
            if (!Directory.Exists(directory)) return false;
            probe = Path.Combine(directory, ".launcher-write-check-" + Guid.NewGuid().ToString("N") + ".tmp");
            File.WriteAllText(probe, "ok", Encoding.UTF8);
            return true;
        } catch { return false; }
        finally {
            try { if (probe != null && File.Exists(probe)) File.Delete(probe); } catch { }
        }
    }

    static string SanitizeDiagnostic(string detail)
    {
        if (string.IsNullOrWhiteSpace(detail)) return "后端未提供错误详情";
        string value = detail.Replace("\0", " ").Trim();
        value = Regex.Replace(value, @"(?im)^\s*at\b.*$", "[堆栈已隐藏]");
        value = Regex.Replace(value, @"(?i)node:internal[^\r\n ]*", "[Node内部信息已隐藏]");
        value = Regex.Replace(value, @"(?i)([A-Z]:\\|\\\\)[^\r\n]*", "[路径已隐藏]");
        value = Regex.Replace(value, @"(?i)(API[_-]?KEY|ADMIN_KEY|JWT_SECRET|PASSWORD|TOKEN)\s*[:=]\s*[^\s\r\n]+", "$1=[已隐藏]");
        value = Regex.Replace(value, @"(?i)Bearer\s+[A-Za-z0-9._~-]+", "Bearer [已隐藏]");
        value = value.Replace(" at ", " [堆栈已隐藏] ");
        if (value.Length > 4096) value = value.Substring(0, 4096) + "…";
        return value;
    }

    sealed class UpdateInfo
    {
        public string Version;
        public string PackageUrl;
        public string Sha256;
        public long SizeBytes;
        public string ReleaseNotes;
    }

    void CheckForUpdates()
    {
        ThreadPool.QueueUserWorkItem(delegate
        {
            UpdateInfo info;
            if (!TryGetManifest(out info))
            {
                ShowMessage("当前无法检查更新，请稍后重试。", MessageBoxIcon.Information);
                return;
            }
            if (CompareVersions(info.Version, CurrentVersion) <= 0)
            {
                ShowMessage("当前已是最新版本。", MessageBoxIcon.Information);
                return;
            }
            string notes = string.IsNullOrWhiteSpace(info.ReleaseNotes) ? "本次版本包含稳定性与兼容性改进。" : info.ReleaseNotes.Trim();
            if (notes.Length > 600) notes = notes.Substring(0, 600) + "…";
            string prompt = "发现新版本 " + info.Version + "（当前 " + CurrentVersion + "）。\n\n" + notes + "\n\n是否下载并安装？";
            if (!AskUser(prompt)) return;

            string packagePath;
            if (!TryDownload(info, out packagePath))
            {
                ShowMessage("更新包下载或校验失败，未修改当前安装。", MessageBoxIcon.Warning);
                return;
            }
            if (!AskUser("更新包已下载并通过校验。安装时软件会自动关闭并重启，用户数据和授权不会被覆盖。\n\n现在安装？")) return;
            ui.Post(delegate { StartUpdater(info, packagePath); }, null);
        });
    }

    bool TryGetManifest(out UpdateInfo info)
    {
        info = null;
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var request = (HttpWebRequest)WebRequest.Create(ManifestUrl);
            request.Method = "GET";
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            request.UserAgent = "LaoyinPLC-Updater/" + CurrentVersion;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK) return false;
                {
                    string json = ReadManifestBody(response.GetResponseStream(), 1024 * 1024);
                    if (json == null) return false;
                    var data = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
                    if (data == null) return false;
                    string version = ReadString(data, "version");
                    string url = ReadString(data, "packageUrl");
                    string sha = ReadString(data, "sha256");
                    long size = ReadLong(data, "sizeBytes");
                    if (!IsSafeUpdateUrl(url) || !IsVersion(version) || sha.Length != 64 || size <= 0 || size > 250L * 1024L * 1024L) return false;
                    if (!IsHex(sha)) return false;
                    info = new UpdateInfo { Version = version, PackageUrl = url, Sha256 = sha.ToLowerInvariant(), SizeBytes = size, ReleaseNotes = ReadString(data, "releaseNotes") };
                    return true;
                }
            }
        }
        catch { return false; }
    }

    bool TryDownload(UpdateInfo info, out string packagePath)
    {
        packagePath = null;
        string dir = Path.Combine(Path.GetTempPath(), "老殷工控PLC助手", "updates", Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(dir);
            packagePath = Path.Combine(dir, "update.zip");
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var request = (HttpWebRequest)WebRequest.Create(info.PackageUrl);
            request.Method = "GET";
            request.Timeout = 30000;
            request.ReadWriteTimeout = 30000;
            request.UserAgent = "LaoyinPLC-Updater/" + CurrentVersion;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK) return false;
                long contentLength = response.ContentLength;
                if (contentLength > 0 && contentLength != info.SizeBytes) return false;
                if (contentLength > 250L * 1024L * 1024L) return false;
                using (var input = response.GetResponseStream())
                using (var output = new FileStream(packagePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[64 * 1024];
                    long total = 0;
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        total += read;
                        if (total > 250L * 1024L * 1024L) return false;
                        output.Write(buffer, 0, read);
                    }
                    if (total != info.SizeBytes) return false;
                }
            }
            using (var sha = SHA256.Create())
            using (var input = File.OpenRead(packagePath))
            {
                string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                if (actual != info.Sha256) return false;
            }
            return true;
        }
        catch { return false; }
    }

    void StartUpdater(UpdateInfo info, string packagePath)
    {
        try
        {
            string updater = Path.Combine(root, "老殷工控PLC助手更新器.exe");
            if (!File.Exists(updater))
            {
                ShowMessage("当前绿色版不支持在线更新，请下载最新完整绿色包。", MessageBoxIcon.Information);
                return;
            }
            string plan = Path.Combine(Path.GetDirectoryName(packagePath), "update-plan.json");
            var data = new Dictionary<string, object>();
            data["root"] = root;
            data["package"] = packagePath;
            data["sha256"] = info.Sha256;
            data["sizeBytes"] = info.SizeBytes;
            data["parentPid"] = Process.GetCurrentProcess().Id;
            File.WriteAllText(plan, new JavaScriptSerializer().Serialize(data), Encoding.UTF8);
            var psi = new ProcessStartInfo(updater, QuoteArg(plan));
            psi.WorkingDirectory = root;
            psi.UseShellExecute = true;
            Process.Start(psi);
            Shutdown();
        }
        catch
        {
            ShowMessage("更新准备失败，当前版本未修改。", MessageBoxIcon.Warning);
        }
    }

    bool AskUser(string message)
    {
        bool answer = false;
        using (var done = new ManualResetEvent(false))
        {
            ui.Post(delegate
            {
                try { answer = MessageBox.Show(message, "老殷工控PLC助手", MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes; }
                finally { done.Set(); }
            }, null);
            done.WaitOne();
        }
        return answer;
    }

    void ShowMessage(string message, MessageBoxIcon icon)
    {
        ui.Post(delegate { MessageBox.Show(message, "老殷工控PLC助手", MessageBoxButtons.OK, icon); }, null);
    }

    static string ReadString(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? Convert.ToString(value).Trim() : "";
    }

    static long ReadLong(Dictionary<string, object> data, string key)
    {
        object value;
        long result;
        return data.TryGetValue(key, out value) && value != null && long.TryParse(Convert.ToString(value), out result) ? result : 0;
    }

    static string ReadManifestBody(Stream input, int maxChars)
    {
        using (var reader = new StreamReader(input, Encoding.UTF8))
        {
            var body = new StringBuilder();
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (body.Length + read > maxChars) return null;
                body.Append(buffer, 0, read);
            }
            return body.ToString();
        }
    }

    static bool IsSafeUpdateUrl(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        bool trustedHost = string.Equals(uri.Host, "raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase) ||
                           string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase);
        return trustedHost && string.Equals(Path.GetExtension(uri.AbsolutePath), ".zip", StringComparison.OrdinalIgnoreCase);
    }

    static bool IsVersion(string value)
    {
        Version parsed;
        return Version.TryParse(value, out parsed) && parsed >= new Version(1, 0, 0);
    }

    static bool IsHex(string value)
    {
        for (int i = 0; i < value.Length; i++) if (!Uri.IsHexDigit(value[i])) return false;
        return true;
    }

    static int CompareVersions(string left, string right)
    {
        Version a;
        Version b;
        if (!Version.TryParse(left, out a) || !Version.TryParse(right, out b)) return 0;
        return a.CompareTo(b);
    }

    static string QuoteArg(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    void Shutdown()
    {
        try {
            var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/system/shutdown");
            req.Method = "POST";
            req.Timeout = 1500;
            req.Headers["X-Launcher-Token"] = shutdownToken;
            using (req.GetResponse()) { }
        } catch { }
        for (int i = 0; i < 20 && !server.HasExited; i++) Thread.Sleep(100);
        if (!server.HasExited) KillTree(server);
        BeginExit();
    }

    void BeginExit()
    {
        try { tray.Visible = false; tray.Dispose(); } catch { }
        ExitThread();
    }

    static bool IsOurApp()
    {
        try {
            var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/license");
            req.Timeout = 700;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return resp.StatusCode == HttpStatusCode.OK && reader.ReadToEnd().Contains("\"trial\":true");
        } catch { return false; }
    }

    static bool IsPortOpen()
    {
        try {
            var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/");
            req.Timeout = 500;
            using (req.GetResponse()) { return true; }
        } catch (WebException e) {
            return e.Status != WebExceptionStatus.ConnectFailure &&
                   e.Status != WebExceptionStatus.Timeout &&
                   e.Status != WebExceptionStatus.NameResolutionFailure;
        } catch { return false; }
    }

    static void KillTree(Process p)
    {
        try {
            Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + p.Id + " /T /F") {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            }).WaitForExit(5000);
        } catch { }
    }

    static void OpenBrowser(string url)
    {
        try { Process.Start(url); } catch { }
    }

    static void Fail(string root, string msg)
    {
        Fail(root, msg, BuildSafeDiagnostic(msg, -1, root, null));
    }

    static void Fail(string root, string msg, string diagnostic)
    {
        try { File.WriteAllText(Path.Combine(root, "启动日志.txt"), diagnostic, new UTF8Encoding(true)); } catch { }
        MessageBox.Show(msg, "老殷工控PLC助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
