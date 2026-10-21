using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

namespace CadViewer
{
    internal static class Program
    {
        internal const string Version = "0.2.1";
        internal const string AppFolder = "CADViewer-" + Version + "-win64";

        internal static string BaseDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CADViewer", Version);
            }
        }

        internal static string AppDir { get { return Path.Combine(BaseDir, AppFolder); } }
        internal static string LogDir { get { return Path.Combine(BaseDir, "logs"); } }

        internal static void Log(string msg)
        {
            try
            {
                Directory.CreateDirectory(LogDir);
                File.AppendAllText(Path.Combine(LogDir, "host.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + msg + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            Hooks.Install();
            Log("=== 启动 pid=" + Environment.ProcessId + " args=" + string.Join(" ", args));

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { Application.SetHighDpiMode(HighDpiMode.PerMonitorV2); } catch (Exception ex) { Log("SetHighDpiMode 失败: " + ex.Message); }

            bool reinstall = false;
            string initialFile = null;
            foreach (string a in args)
            {
                if (string.Equals(a, "--reinstall", StringComparison.OrdinalIgnoreCase)) { reinstall = true; continue; }
                if (!a.StartsWith("-") && File.Exists(a)) initialFile = Path.GetFullPath(a);
            }

            if (reinstall)
            {
                try { if (Directory.Exists(BaseDir)) Directory.Delete(BaseDir, true); Log("--reinstall：已删除 " + BaseDir); }
                catch (Exception ex) { Log("--reinstall 删除失败: " + ex.Message); }
            }

            try
            {
                if (!File.Exists(Path.Combine(AppDir, "start.bat")))
                {
                    Log("首次运行，开始解压到 " + BaseDir);
                    ExtractPayload();
                    Log("解压完成");
                }
                else
                {
                    Log("已解压，跳过解压步骤");
                }
            }
            catch (Exception ex)
            {
                Log("解压失败: " + ex);
                MessageBox.Show(
                    "解压安装包失败：\n" + ex.Message +
                    "\n\n可用 --reinstall 参数重新运行本程序再试一次。",
                    "CADViewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                Application.Run(new MainForm(initialFile));
                Log("=== 正常退出 ===");
            }
            catch (Exception ex)
            {
                Log("Application.Run 抛出: " + ex);
                MessageBox.Show("程序异常退出：\n" + ex.Message, "CADViewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>首次运行：把内嵌的便携包解压到 %LOCALAPPDATA%\CADViewer\&lt;version&gt;。</summary>
        private static void ExtractPayload()
        {
            Directory.CreateDirectory(BaseDir);

            Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
            if (res == null)
            {
                throw new InvalidOperationException("exe 内没有内嵌安装包（构建时缺少 PayloadPath）。");
            }

            string tmp = Path.Combine(Path.GetTempPath(), "cadviewer-" + Guid.NewGuid().ToString("N") + ".zip");
            try
            {
                using (res)
                using (FileStream outFs = File.Create(tmp))
                {
                    res.CopyTo(outFs);
                }
                ZipFile.ExtractToDirectory(tmp, BaseDir, true);
            }
            finally
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            }
        }
    }
}
