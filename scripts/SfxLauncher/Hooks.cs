using System;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CadViewer
{
    /// <summary>
    /// 全局异常兜底：把崩溃写进 logs\host.log，避免"进程静默消失"这种没法查的状态。
    /// </summary>
    internal static class Hooks
    {
        internal static void Install()
        {
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => Report("ThreadException", e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Report("UnhandledException", e.ExceptionObject as Exception);
            TaskScheduler.UnobservedTaskException += (s, e) =>
            {
                Report("UnobservedTaskException", e.Exception);
                e.SetObserved();
            };
        }

        private static void Report(string kind, Exception ex)
        {
            try { Program.Log("!! " + kind + "\n" + ex); } catch { }
        }
    }
}
