using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

sealed class GreenContext : ApplicationContext
{
    const string BaseUrl = "http://localhost:3000";
    readonly string root;
    readonly string shutdownToken;
    readonly Process server;
    readonly NotifyIcon tray;

    GreenContext(string rootDir, Process child, string token)
    {
        root = rootDir;
        server = child;
        shutdownToken = token;
        tray = new NotifyIcon();
        tray.Icon = SystemIcons.Application;
        tray.Text = "老殷工控PLC助手";
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenBrowser(BaseUrl); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开工作台", null, delegate { OpenBrowser(BaseUrl); });
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
                Fail(root, FriendlyFailure(detail));
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

    static string FriendlyFailure(string detail)
    {
        if (detail.Contains("授权")) return detail.Split(new[] {'\r','\n'})[0];
        if (detail.Contains("端口")) return detail.Split(new[] {'\r','\n'})[0];
        return "启动失败，请联系软件管理员并提供启动日志。";
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
        try { File.WriteAllText(Path.Combine(root, "启动日志.txt"), msg, Encoding.UTF8); } catch { }
        MessageBox.Show(msg, "老殷工控PLC助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
