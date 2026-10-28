using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Dvarim;

/// <summary>
/// One Dvarim at a time. It lives in the notification area once its window is
/// closed, so opening it again from the Start menu, or a second sign-in's
/// autostart, must bring that one forward rather than start another on the same
/// folder: the second hands its launch to the first and leaves. A self-test with
/// a --data of its own is an app of its own.
/// </summary>
public static class Program
{
    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string? name);

    [DllImport("kernel32.dll")]
    static extern bool SetEvent(IntPtr handle);

    [DllImport("ole32.dll")]
    static extern uint CoWaitForMultipleObjects(uint flags, uint timeout, uint count, IntPtr[] handles, out uint index);

    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(uint processId);

    [STAThread]
    static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        App.Options = Options.Parse(args);
        App.DataDir = App.Options.Data ?? Path.Join(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Dvarim");
        Directory.CreateDirectory(App.DataDir);

        var key = AppInstance.FindOrRegisterForKey("Dvarim-" + Hash(Path.GetFullPath(App.DataDir)));
        if (!key.IsCurrent)
        {
            HandOver(key);
            return 0;
        }
        // a later launch, handed over: on the window's thread, once there is one
        key.Activated += (_, e) => App.UI?.TryEnqueue(() => App.Instance.HandedOver(e));

        Application.Start(_ =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
        });
        return 0;
    }

    /// <summary>This launch, to the Dvarim already running, which may then come to the front.</summary>
    static void HandOver(AppInstance first)
    {
        var args = AppInstance.GetCurrent().GetActivatedEventArgs();
        try { AllowSetForegroundWindow(first.ProcessId); } catch (Exception) { }
        var done = CreateEvent(IntPtr.Zero, true, false, null);
        _ = Task.Run(() =>
        {
            try { first.RedirectActivationToAsync(args).AsTask().Wait(TimeSpan.FromSeconds(10)); }
            catch (Exception) { }
            SetEvent(done);
        });
        // waiting so, rather than blocking, lets COM go on answering this STA thread
        _ = CoWaitForMultipleObjects(0, 0xFFFFFFFF, 1, [done], out _);
    }

    static string Hash(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s.ToLowerInvariant())))[..16];
}
