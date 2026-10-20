// CADViewer 单文件启动器（唯一职责：把内嵌的便携包解压到用户目录，然后启动 start.bat）
//
// 为什么不做“真·内存运行”：cadcraft-cli 是独立 exe，Node 的 worker 线程也要真实文件，
// 全部必须落盘；所以这里采用“首次运行解压一次，之后直接复用”的做法。
//
// 消息保持 ASCII：避免不同终端代码页下的乱码。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

internal static class Program
{
    // 与 release/CADViewer-<version>-win64.zip 内部顶层目录一致
    private const string Version = "0.1.0";
    private const string AppFolder = "CADViewer-" + Version + "-win64";

    private static int Main(string[] args)
    {
        try
        {
            string baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CADViewer",
                Version);
            string appDir = Path.Combine(baseDir, AppFolder);
            string marker = Path.Combine(appDir, "start.bat");

            bool reinstall = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "--reinstall", StringComparison.OrdinalIgnoreCase)) reinstall = true;
            }

            if (reinstall && Directory.Exists(baseDir))
            {
                Console.WriteLine("Removing previous extraction: " + baseDir);
                try { Directory.Delete(baseDir, true); }
                catch (Exception ex) { Console.Error.WriteLine("WARN: could not fully remove: " + ex.Message); }
            }

            if (!File.Exists(marker))
            {
                Console.WriteLine("CADViewer " + Version);
                Console.WriteLine("First run: extracting to");
                Console.WriteLine("  " + baseDir);
                Console.WriteLine("About 225 MB, this takes a few seconds...");
                Console.WriteLine();

                Directory.CreateDirectory(baseDir);

                Assembly asm = Assembly.GetExecutingAssembly();
                Stream res = asm.GetManifestResourceStream("payload.zip");
                if (res == null)
                {
                    Console.Error.WriteLine("ERROR: embedded payload not found. This exe was built without PayloadPath.");
                    return 2;
                }

                string tmpZip = Path.Combine(Path.GetTempPath(), "cadviewer-" + Guid.NewGuid().ToString("N") + ".zip");
                try
                {
                    using (res)
                    using (FileStream outFs = File.Create(tmpZip))
                    {
                        res.CopyTo(outFs);
                    }
                    ZipFile.ExtractToDirectory(tmpZip, baseDir, true);
                }
                finally
                {
                    try { if (File.Exists(tmpZip)) File.Delete(tmpZip); } catch { }
                }

                Console.WriteLine("Extraction done.");
            }
            else
            {
                Console.WriteLine("CADViewer " + Version + " (already extracted)");
            }

            if (!File.Exists(marker))
            {
                Console.Error.WriteLine("ERROR: start.bat missing after extraction: " + marker);
                Console.Error.WriteLine("Try running this exe again with --reinstall");
                Pause();
                return 3;
            }

            Console.WriteLine("Starting... (close the CADViewer console window to stop the server)");
            Process.Start(new ProcessStartInfo
            {
                FileName = marker,
                WorkingDirectory = appDir,
                UseShellExecute = true,
            });
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR: " + ex.Message);
            Pause();
            return 1;
        }
    }

    private static void Pause()
    {
        try
        {
            if (!Console.IsInputRedirected)
            {
                Console.WriteLine();
                Console.WriteLine("Press any key to exit...");
                Console.ReadKey(true);
            }
        }
        catch { }
    }
}
