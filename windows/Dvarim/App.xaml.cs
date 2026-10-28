using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Windows.AppNotifications;

namespace Dvarim;

/// <summary>
/// Dvarim for Windows: the web app in <c>frontend/</c>, on a copy of your to-dos
/// that it keeps on this PC and syncs with your server, on a folder you choose, or
/// on the server alone (docs/BRIDGE.md). The page is the whole interface; this
/// adds the window, the notification area's Today, Quick Entry from anywhere and
/// reminders. Android's shell is the model (android/shell/src/java/…).
/// </summary>
public partial class App : Application
{
    public static Options Options { get; internal set; } = Options.Parse([]);

    /// <summary>Settings, the page's own storage, the copies and the log: %LOCALAPPDATA%\Dvarim, or --data for the self-test.</summary>
    public static string DataDir { get; internal set; } = "";

    public static string Version { get; } =
        typeof(App).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0";

    public static App Instance { get; private set; } = null!;

    /// <summary>The windows' thread, for what arrives on another.</summary>
    public static DispatcherQueue? UI { get; private set; }

    /// <summary>Dvarim's window: hidden, not closed, when it is closed, so its page goes on answering.</summary>
    public static ShellWindow Main { get; private set; } = null!;

    public static bool Quitting { get; private set; }

    static Task<CoreWebView2Environment>? web;

    /// <summary>
    /// One WebView2 environment, its data beside the settings rather than beside the
    /// app, with Windows 11's thin scrollbars that widen under the pointer instead of
    /// a browser's.
    /// </summary>
    public static Task<CoreWebView2Environment> WebEnvironment =>
        web ??= CoreWebView2Environment.CreateWithOptionsAsync("", Path.Join(DataDir, "WebView2"),
            new CoreWebView2EnvironmentOptions { ScrollBarStyle = CoreWebView2ScrollbarStyle.FluentOverlay }).AsTask();

    /// <summary>The to-dos changed (op <c>changed</c>), or the page has just come up: the tray and reminders ask again.</summary>
    public static event Action? VaultChanged;

    public App()
    {
        InitializeComponent();
        Instance = this;
        // closing the window leaves Dvarim in the notification area: only Quit ends it
        DispatcherShutdownMode = DispatcherShutdownMode.OnExplicitShutdown;
        UnhandledException += (_, e) => Log.Write($"unhandled: {e.Exception}");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        UI = DispatcherQueue.GetForCurrentThread();
        // no white flash before the page has drawn, in a dark theme
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");
        Vault.Load();
        // before the launch is looked at: a reminder's button may be why Dvarim started
        Notifications.Start();
        var launch = AppInstance.GetCurrent().GetActivatedEventArgs();
        var note = launch.Kind == ExtendedActivationKind.AppNotification ? launch.Data as AppNotificationActivatedEventArgs : null;
        if (Options.SelfTest) SelfTest.Start();
        Main = ShellWindow.Open(show: !Options.Background && note == null);
        Tray.Start();
        Reminders.Start();
        if (note != null) Notifications.Invoked(note);
    }

    /// <summary>Dvarim opened again while running (Program.HandOver), or a reminder's notification pressed.</summary>
    public void HandedOver(AppActivationArguments e)
    {
        if (e.Kind == ExtendedActivationKind.AppNotification && e.Data is AppNotificationActivatedEventArgs note) Notifications.Invoked(note);
        else Main.ShowWindow();
    }

    public static void Changed() => VaultChanged?.Invoke();

    /// <summary>Quit Dvarim: the page's last writes on disk first, then the notification area and the rest.</summary>
    public static async void Quit()
    {
        if (Quitting) return;
        Quitting = true;
        try { await Main.FlushAsync().WaitAsync(TimeSpan.FromSeconds(3)); }
        catch (Exception e) { Log.Write($"quit: {e.Message}"); }
        Tray.Stop();
        Reminders.Stop();
        Notifications.Stop();
        Main.Close();
        Current.Exit();
    }
}
