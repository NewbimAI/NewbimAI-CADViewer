using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CadViewer
{
    /// <summary>
    /// 桌面窗口：内含 WebView2，背后由包内的 node.exe 跑本机服务。
    /// 关窗即杀掉服务进程树，不留后台残留。
    /// </summary>
    internal sealed class MainForm : Form
    {
        private readonly WebView2 _web = new WebView2();
        private readonly Label _status = new Label();
        private readonly string _logPath;
        private readonly string _initialFile;
        private readonly object _logLock = new object();
        private Process _server;
        private int _port;

        internal MainForm(string initialFile)
        {
            _initialFile = initialFile;
            _logPath = Path.Combine(Program.LogDir, "server.log");
            Directory.CreateDirectory(Program.LogDir);

            Text = "CADViewer";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1280, 860);
            MinimumSize = new Size(900, 600);
            BackColor = Color.White;
            TrySetIcon();

            MenuStrip menu = BuildMenu();
            Controls.Add(menu);
            MainMenuStrip = menu;

            _status.Dock = DockStyle.Fill;
            _status.TextAlign = ContentAlignment.MiddleCenter;
            _status.Font = new Font("Microsoft YaHei UI", 10f);
            _status.Text = "正在启动…";
            Controls.Add(_status);

            _web.Dock = DockStyle.Fill;
            _web.Visible = false;
            Controls.Add(_web);

            Shown += async (s, e) => await StartAsync();
            FormClosing += (s, e) => StopServer();
            Program.Log("MainForm 构造完成");
        }

        /// <summary>窗口图标直接用 exe 内嵌的图标（csproj 的 ApplicationIcon）。</summary>
        private void TrySetIcon()
        {
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception ex) { Program.Log("设置窗口图标失败: " + ex.Message); }
        }

        private MenuStrip BuildMenu()
        {
            MenuStrip menu = new MenuStrip();

            ToolStripMenuItem file = new ToolStripMenuItem("文件(&F)");
            file.DropDownItems.Add(new ToolStripMenuItem("打开数据目录", null, (s, e) => OpenFolder(Path.Combine(Program.AppDir, "data"))));
            file.DropDownItems.Add(new ToolStripMenuItem("打开日志目录", null, (s, e) => OpenFolder(Program.LogDir)));
            file.DropDownItems.Add(new ToolStripSeparator());
            file.DropDownItems.Add(new ToolStripMenuItem("退出", null, (s, e) => Close()));

            ToolStripMenuItem view = new ToolStripMenuItem("视图(&V)");
            view.DropDownItems.Add(new ToolStripMenuItem("刷新", null, (s, e) => Reload()));

            ToolStripMenuItem help = new ToolStripMenuItem("帮助(&H)");
            help.DropDownItems.Add(new ToolStripMenuItem("关于", null, (s, e) => ShowAbout()));

            menu.Items.Add(file);
            menu.Items.Add(view);
            menu.Items.Add(help);
            return menu;
        }

        private async Task StartAsync()
        {
            try
            {
                Program.Log("StartAsync: 端口选择前");
                _port = GetFreePort();
                Program.Log("StartAsync: 端口 " + _port);

                StartServer(_port);
                Program.Log("StartAsync: 服务进程已启动，等待健康检查");

                if (!await WaitHealthyAsync(_port, TimeSpan.FromSeconds(90)))
                {
                    throw new Exception("本地服务在 90 秒内没有就绪。\n\n日志：" + _logPath);
                }
                Program.Log("StartAsync: 健康检查通过");

                _status.Text = "正在初始化界面…";

                string runtime;
                try { runtime = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
                catch (Exception ex) { runtime = "不可用: " + ex.GetType().Name + " " + ex.Message; }
                Program.Log("WebView2 运行时: " + runtime);

                string userDataFolder = Path.Combine(Program.BaseDir, "WebView2");
                Directory.CreateDirectory(userDataFolder);

                Program.Log("CreateAsync 开始");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                Program.Log("CreateAsync 完成");

                Program.Log("EnsureCoreWebView2Async 开始");
                await _web.EnsureCoreWebView2Async(env);
                Program.Log("EnsureCoreWebView2Async 完成");

                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
                };

                string url = "http://127.0.0.1:" + _port + "/";
                if (!string.IsNullOrEmpty(_initialFile))
                {
                    url += "?open=" + Uri.EscapeDataString(_initialFile);
                }
                Program.Log("Navigate: " + url);
                _web.Source = new Uri(url);

                _status.Visible = false;
                _web.Visible = true;
                _web.BringToFront();
                Program.Log("StartAsync: 完成，界面已显示");
            }
            catch (Exception ex)
            {
                Program.Log("StartAsync 失败: " + ex);
                MessageBox.Show("启动失败：\n" + ex.Message + "\n\n详细日志：" + Path.Combine(Program.LogDir, "host.log"),
                    "CADViewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void StartServer(int port)
        {
            string node = Path.Combine(Program.AppDir, "node", "node.exe");
            string serverDir = Path.Combine(Program.AppDir, "server");
            if (!File.Exists(node)) throw new Exception("缺少 node\\node.exe。请用 --reinstall 重新解压。");
            if (!File.Exists(Path.Combine(serverDir, "index.js"))) throw new Exception("缺少 server\\index.js。请用 --reinstall 重新解压。");

            ProcessStartInfo psi = new ProcessStartInfo(node, "index.js")
            {
                WorkingDirectory = serverDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };
            psi.Environment["PORT"] = port.ToString();

            _server = new Process { StartInfo = psi };
            _server.OutputDataReceived += (s, e) => AppendLog(e.Data);
            _server.ErrorDataReceived += (s, e) => AppendLog(e.Data);
            _server.Start();
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            AppendLog("--- CADViewer 启动，端口 " + port + " ---");
        }

        private void AppendLog(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            try
            {
                lock (_logLock) File.AppendAllText(_logPath, line + Environment.NewLine);
            }
            catch { }
        }

        private static async Task<bool> WaitHealthyAsync(int port, TimeSpan timeout)
        {
            using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) })
            {
                DateTime deadline = DateTime.UtcNow + timeout;
                while (DateTime.UtcNow < deadline)
                {
                    try
                    {
                        using (HttpResponseMessage res = await client.GetAsync("http://127.0.0.1:" + port + "/api/health"))
                        {
                            if (res.IsSuccessStatusCode) return true;
                        }
                    }
                    catch { }
                    await Task.Delay(400);
                }
                return false;
            }
        }

        private static int GetFreePort()
        {
            TcpListener listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
            listener.Start();
            int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private void StopServer()
        {
            try
            {
                if (_server != null && !_server.HasExited)
                {
                    AppendLog("--- 关闭窗口，停止服务 ---");
                    _server.Kill(true);
                }
            }
            catch { }
            try { _server?.Dispose(); } catch { }
            _server = null;
        }

        private void Reload()
        {
            try { _web.CoreWebView2?.Reload(); } catch { }
        }

        private static void OpenFolder(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("打不开目录：\n" + ex.Message, "CADViewer", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void ShowAbout()
        {
            MessageBox.Show(
                "CADViewer " + Program.Version + "\n\n" +
                "本地 DWG / DXF 看图与统计工具。\n" +
                "图纸只在本机转换与渲染，不上传任何服务器。\n\n" +
                "许可：AGPL-3.0-only\n" +
                "商业许可：nbimgpt@163.com\n\n" +
                "安装位置：\n" + Program.AppDir,
                "关于 CADViewer", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
