using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Dvarim.Core;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace Dvarim;

/// <summary>
/// Dvarim's window: a Mica title bar holding the menus (Menus), the way a Windows
/// 11 app has them, over the page, which draws everything else: from inside the app
/// with the copy or a folder behind it, or the server's. Closing it puts it away
/// rather than ending Dvarim, so the page goes on answering the notification area,
/// Quick Entry and reminders (window.dvarim.request), as the web-view Mac app's
/// hidden page did. Android's is FolderActivity with CopySignInActivity.
/// </summary>
public sealed partial class ShellWindow : Window
{
    public IntPtr Handle { get; }
    WebView2? web;
    FolderBridge? bridge;
    readonly Menus menus;
    bool started;
    bool shellFull, pageFull;             // full screen by F11 or the menu; by the page itself (the Fullscreen API)
    ulong opening;                        // the navigation to the page, whose failure is worth a word
    RectInt32 normal;                     // where the window is when it is neither maximised nor full screen
    DispatcherQueueTimer? signIn;          // asks every few seconds whether there is a sign-in to make the copy from
    bool settingUp;
    uint browserProcess;
    readonly DispatcherQueueTimer away;   // a sync round now and then while the window is put away
    TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    readonly Dictionary<int, TaskCompletionSource<(int Status, JsonNode? Body)>> waiting = new();
    int nextId = 1;
    string? pendingPath;                  // a reminder's to-do, asked for before there was a page to show it in

    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    const int DWMWA_CLOAK = 13;

    /// <param name="show">false when Dvarim starts with Windows, or for a reminder's button: the window is made, and put away at once</param>
    public static ShellWindow Open(bool show)
    {
        var window = new ShellWindow();
        if (!show)
        {
            // XAML loads a window's content only once it is shown: shown cloaked, so nobody
            // sees it, and put away as soon as the page has a place to load in
            var cloak = 1;
            _ = DwmSetWindowAttribute(window.Handle, DWMWA_CLOAK, ref cloak, sizeof(int));
            window.AppWindow.IsShownInSwitchers = false;
            window.Root.Loaded += (_, _) =>
            {
                window.AppWindow.Hide();
                var uncloak = 0;
                _ = DwmSetWindowAttribute(window.Handle, DWMWA_CLOAK, ref uncloak, sizeof(int));
                window.AppWindow.IsShownInSwitchers = true;
            };
        }
        window.Activate();
        return window;
    }

    ShellWindow()
    {
        InitializeComponent();
        Title = "Dvarim";
        Handle = WindowNative.GetWindowHandle(this);
        menus = new Menus(this, Menu);
        var icon = Path.Join(AppContext.BaseDirectory, "Assets", "Dvarim.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);
        MakeTitleBar();
        Place();
        AppWindow.Changed += (_, e) =>
        {
            if ((e.DidPositionChange || e.DidSizeChange) && AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Restored })
                normal = new RectInt32(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);
            if (e.DidSizeChange || e.DidPresenterChange)
            {
                FitTitleBar();
                FitTitleBarSoon();
            }
            if (e.DidPresenterChange) Presented();
        };
        // the close box puts the window away: Dvarim stays in the notification area
        AppWindow.Closing += (_, e) =>
        {
            if (App.Quitting) return;
            e.Cancel = true;
            HideWindow();
        };
        Root.Loaded += async (_, _) =>
        {
            FitTitleBar();
            FitTitleBarSoon();
            await StartAsync();
        };
        Activated += (_, e) =>
        {
            var active = e.WindowActivationState != WindowActivationState.Deactivated;
            // as any Windows title bar: dimmer while another window is in front
            TitleText.Opacity = AppIcon.Opacity = active ? 1 : 0.5;
            if (active) menus.Refresh();
        };
        Vault.Moved += Reload;
        away = DispatcherQueue.CreateTimer();
        away.Interval = TimeSpan.FromMinutes(5);
        away.Tick += (_, _) => { if (!AppWindow.IsVisible && Vault.Mode == "copy" && Vault.UsesBridge) _ = Local("sync"); };
        away.Start();
        Closed += (_, _) =>
        {
            SavePlace();
            Vault.Moved -= Reload;
            away.Stop();
            signIn?.Stop();
            Teardown();
        };
    }

    async Task StartAsync()
    {
        if (started) return;
        started = true;
        if (Vault.Mode == "folder" && Vault.Folder == null && !App.Options.SelfTest)
        {
            // the folder has gone, or was never chosen: ask for one, or back to the copy
            if (await ChooseFolderAsync() is { } folder) Vault.UseFolder(folder);
            else Vault.UseCopy();
            return;                           // Vault.Moved makes the page
        }
        if (web == null) await MakeWebViewAsync();
        if (App.Options.SelfTest) await SelfTest.Run(this);
    }

    // ---- the title bar ---------------------------------------------------------------

    /// <summary>
    /// The page's window runs to the top under Mica, as Windows 11's own apps do: the
    /// icon, the menus and the window's name in one row, the system's own caption
    /// buttons (and their Snap Layouts) at the right of it.
    /// </summary>
    void MakeTitleBar()
    {
        SystemBackdrop = new MicaBackdrop();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(DragArea);
        var bar = AppWindow.TitleBar;
        bar.PreferredHeightOption = TitleBarHeightOption.Tall;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        PaintCaptionButtons();
        Root.ActualThemeChanged += (_, _) => PaintCaptionButtons();
        var png = Vault.WebBundle == null ? null : Path.Join(Vault.WebBundle, "icons", "icon-192.png");
        if (png != null && File.Exists(png)) AppIcon.Source = new BitmapImage(new Uri(png));
    }

    /// <summary>The caption buttons in the theme's colours, light or dark, as the system's own title bars have them.</summary>
    void PaintCaptionButtons()
    {
        var dark = Root.ActualTheme == ElementTheme.Dark;
        var bar = AppWindow.TitleBar;
        var ink = dark ? Colors.White : Colors.Black;
        bar.ButtonForegroundColor = ink;
        bar.ButtonHoverForegroundColor = ink;
        bar.ButtonPressedForegroundColor = ink;
        bar.ButtonHoverBackgroundColor = dark ? ColorHelper.FromArgb(0x15, 0xFF, 0xFF, 0xFF) : ColorHelper.FromArgb(0x09, 0, 0, 0);
        bar.ButtonPressedBackgroundColor = dark ? ColorHelper.FromArgb(0x0B, 0xFF, 0xFF, 0xFF) : ColorHelper.FromArgb(0x06, 0, 0, 0);
        bar.ButtonInactiveForegroundColor = dark ? ColorHelper.FromArgb(0x5D, 0xFF, 0xFF, 0xFF) : ColorHelper.FromArgb(0x5C, 0, 0, 0);
    }

    /// <summary>Room for the caption buttons, which the system draws over the row.</summary>
    void FitTitleBar()
    {
        // A minimised window has no caption buttons to measure, and Windows fails
        // when asked, inside its own event, which takes the app down (Daf's and
        // Moshe's self-tests found it): nothing to fit then, nor while put away or
        // full screen.
        if (!AppWindow.IsVisible || IsFullScreen || IsMinimised) return;
        try
        {
            var scale = Root.XamlRoot?.RasterizationScale ?? GetDpiForWindow(Handle) / 96.0;
            int left = AppWindow.TitleBar.LeftInset, right = AppWindow.TitleBar.RightInset;
            // A window just shown, or on its way back from minimised, can report no
            // caption buttons for a moment: keep the room there was rather than none.
            if (scale <= 0 || (left <= 0 && right <= 0)) return;
            LeftPad.Width = new GridLength(Math.Max(0, left / scale));
            RightPad.Width = new GridLength(Math.Max(0, right / scale));
        }
        catch (Exception e) { Log.Write($"title bar: {e.Message}"); }
    }

    /// <summary>Again once Windows has finished moving the window: what it reports mid-way may not be the end of it.</summary>
    void FitTitleBarSoon() =>
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, FitTitleBar);

    /// <summary>The room kept for the caption buttons, and what Windows says they take, for the self-test.</summary>
    public double CaptionRoom => RightPad.Width.Value;
    public int CaptionInset => AppWindow.TitleBar.RightInset;

    /// <summary>Minimise the window and bring it back, as a person would, for the self-test.</summary>
    public async Task MinimiseAndRestore()
    {
        if (AppWindow.Presenter is not OverlappedPresenter presenter) return;
        presenter.Minimize();
        await Task.Delay(700);
        presenter.Restore();
        await Task.Delay(700);
    }

    public bool IsMinimised => AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized };

    /// <summary>
    /// The window's name, in the title bar and the taskbar, as Windows names a document's
    /// window: where the to-dos are, then Dvarim. The folder's name, or the server's.
    /// </summary>
    void NameWindow()
    {
        var where = Vault.SigningIn ? "Sign in"
            : Vault.Mode == "folder" && Vault.Folder is { } folder ? Path.GetFileName(Path.TrimEndingDirectorySeparator(folder))
            : Vault.Server.Host;
        Title = TitleText.Text = string.IsNullOrEmpty(where) ? "Dvarim" : $"{where} - Dvarim";
    }

    public IEnumerable<string> MenuTitles => menus.Titles;

    internal Menus MenuBarMenus => menus;

    // ---- showing and putting away ---------------------------------------------------------

    /// <summary>The window to the front, at <paramref name="path"/> (/todo/aa11bb22, /today) if given.</summary>
    public void ShowWindow(string? path = null)
    {
        if (path != null) Go(path);
        AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter) presenter.Restore();
        Activate();
        SetForegroundWindow(Handle);
        FocusPage();
    }

    public void HideWindow()
    {
        if (IsFullScreen) ToggleFullScreen();
        SavePlace();
        AppWindow.Hide();
    }

    public bool IsShown => AppWindow.IsVisible;

    /// <summary>The keyboard to the page: after a menu, so typing goes on where it was.</summary>
    public void FocusPage() => web?.Focus(FocusState.Programmatic);

    /// <summary>One of the page's own addresses, in the page there is now.</summary>
    public void Go(string path)
    {
        if (Vault.SigningIn || !path.StartsWith('/')) return;
        if (web?.CoreWebView2 is not { } core)
        {
            pendingPath = path;
            return;
        }
        core.Navigate(PageOrigin + path);
    }

    static string PageOrigin => Vault.UsesBridge ? AppScheme.Origin : ServerAddress.Text(Vault.Server);

    // ---- the page --------------------------------------------------------------------

    /// <summary>
    /// The web view for where the to-dos are now: the page from inside the app with the
    /// copy or a folder behind it, or the server's page. Made again when that changes.
    /// </summary>
    async Task MakeWebViewAsync()
    {
        NameWindow();
        CoreWebView2Environment environment;
        try { environment = await App.WebEnvironment; }
        catch (Exception e)
        {
            Log.Write($"no WebView2: {e}");
            Problem("Dvarim needs the Microsoft Edge WebView2 Runtime",
                "It comes with Windows 11 and recent Windows 10. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703, then open Dvarim again.");
            return;
        }
        var view = new WebView2();
        Grid.SetRow(view, 2);
        Root.Children.Add(view);
        web = view;
        await view.EnsureCoreWebView2Async(environment);
        var core = view.CoreWebView2;
        // a page made again may get a browser process of its own, its cookies behind the last one's (AppCopy.session)
        if (browserProcess != 0 && core.BrowserProcessId != browserProcess)
            Log.Write($"WebView2 started another browser process for the page ({browserProcess}, now {core.BrowserProcessId})");
        browserProcess = core.BrowserProcessId;
        var settings = core.Settings;
        settings.AreBrowserAcceleratorKeysEnabled = false;   // Ctrl+F, Ctrl+P, Ctrl+R… are the page's keys, not the browser's
        settings.IsStatusBarEnabled = false;
        // Zoom control stays on: off, WebView2 keeps Ctrl+Plus and Ctrl+Minus from the
        // page. Scripts.Shell turns them, and Ctrl and the wheel, into the page's own
        // text size (View › Text Size), so the browser never zooms the whole window.
        settings.IsPinchZoomEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.AreDevToolsEnabled = App.Options.DevTools || App.Options.SelfTest;
        // lets the page tell it is inside the shell (docs/BRIDGE.md, 1): it shows the app's own settings
        settings.UserAgent = $"{settings.UserAgent} Dvarim/{App.Version} (Windows shell)";

        var folder = Vault.BridgeFolder;
        var signingIn = Vault.SigningIn;
        var copy = Vault.Mode == "copy" ? Vault.Copy : null;
        var origins = new List<string> { AppScheme.Origin, ServerAddress.Text(Vault.Server) };
        await core.AddScriptToExecuteOnDocumentCreatedAsync(Scripts.Shell(origins, folder != null, signingIn));
        core.WebMessageReceived += OnMessage;
        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += OnNewWindowRequested;
        core.LaunchingExternalUriScheme += OnExternalScheme;
        core.ProcessFailed += OnProcessFailed;
        core.ContextMenuRequested += OnContextMenuRequested;
        core.ContainsFullScreenElementChanged += (_, _) =>
        {
            pageFull = core.ContainsFullScreenElement;
            ApplyFullScreen();
        };
        if (folder != null)
        {
            new AppScheme(Vault.WebBundle!, environment).Attach(core);
            bridge = new FolderBridge(folder, Reply, new FolderBridge.Host(
                Info: () => Info(copy),
                Asked: Asked,
                Changed: () => DispatcherQueue.TryEnqueue(App.Changed),
                Nudge: Nudge,
                SessionCookie: CookieFor,
                Server: copy != null ? Vault.Server : null));
            bridge.StartWatching();
        }
        ShowSignInBar(signingIn);
        if (signingIn) WatchForSignIn();
        var start = pendingPath != null && !signingIn ? PageOrigin + pendingPath : Vault.StartUri.AbsoluteUri;
        pendingPath = null;
        core.Navigate(start);
    }

    /// <summary>Where the to-dos are moved (another mode, folder or server, or the copy made or gone): the page again.</summary>
    public async void Reload()
    {
        if (!started) return;                 // StartAsync makes the first
        Teardown();
        try { await MakeWebViewAsync(); }
        catch (Exception e) { Log.Write($"reload: {e}"); }
        App.Changed();
    }

    void Teardown()
    {
        signIn?.Stop();
        bridge?.Dispose();
        bridge = null;
        foreach (var w in waiting.Values) w.TrySetException(new ShellError("the page went away"));
        waiting.Clear();
        ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        // a page that was full screen goes with its web view
        if (pageFull)
        {
            pageFull = false;
            ApplyFullScreen();
        }
        if (web == null) return;
        Root.Children.Remove(web);
        try { web.Close(); } catch (Exception) { }
        web = null;
    }

    /// <summary>Where the window shows something instead of the page.</summary>
    void Problem(string title, string text)
    {
        var panel = new StackPanel { Spacing = 12, Margin = new Thickness(48), MaxWidth = 560, VerticalAlignment = VerticalAlignment.Center };
        panel.Children.Add(new TextBlock { Text = title, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        Grid.SetRow(panel, 2);
        Root.Children.Add(panel);
    }

    public Uri? Source => web?.Source;

    public CoreWebView2? Core => web?.CoreWebView2;

    /// <summary>What op info says (docs/BRIDGE.md): for the copy, where it syncs; for a folder, which one.</summary>
    JsonObject Info(Vault.CopyRecord? copy)
    {
        if (copy == null) return bridge?.Files.Info() ?? new JsonObject();
        return new JsonObject
        {
            ["name"] = "This PC",
            ["detail"] = $"Synced with {Vault.Server.Host}",
            ["canPick"] = true, ["canUseServer"] = true, ["pollSeconds"] = 0,
            ["http"] = true, ["calendars"] = false, ["changes"] = true,
            ["sync"] = new JsonObject
            {
                ["kind"] = "dvarim", ["address"] = ServerAddress.Text(Vault.Server), ["token"] = Vault.Token(copy) ?? "", ["app"] = true,
            },
        };
    }

    // ---- the copy's first sign-in -------------------------------------------------------

    void ShowSignInBar(bool on)
    {
        SignInBar.IsOpen = on;
        if (!on) return;
        SignInBar.Title = "Sign in to keep your to-dos on this PC";
        SignInBar.Message = $"Dvarim keeps a copy of them here, synced with {Vault.Server.Host}, so it works with no network. Another server, or a folder instead:";
        var settings = new Button { Content = "App Settings…" };
        settings.Click += (_, _) => SettingsWindow.ShowIt();
        SignInBar.ActionButton = settings;
    }

    /// <summary>Signing in on the page swaps its screen rather than loading another, so ask every few seconds too.</summary>
    void WatchForSignIn()
    {
        signIn?.Stop();
        signIn = DispatcherQueue.CreateTimer();
        signIn.Interval = TimeSpan.FromSeconds(3);
        signIn.Tick += (_, _) => _ = TrySetUp();
        signIn.Start();
    }

    async Task TrySetUp()
    {
        if (settingUp || !Vault.SigningIn || web?.CoreWebView2 is not { } core) return;
        settingUp = true;
        try
        {
            if (await AppCopy.SetUpIfSignedIn(core))
            {
                signIn?.Stop();
                Vault.Reload();                    // the app's own page, on the copy
            }
        }
        catch (Exception e) { Log.Write($"setting up the copy: {e.Message}"); }
        finally { settingUp = false; }
    }

    Task<string?> CookieFor(Uri server)
    {
        var done = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!DispatcherQueue.TryEnqueue(async () =>
            {
                try { done.TrySetResult(await AppCopy.Session(web?.CoreWebView2, server)); }
                catch (Exception e) { done.TrySetException(e); }
            }))
            done.TrySetResult(null);
        return done.Task;
    }

    // ---- messages between the page and the window --------------------------------------

    void OnMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // only the app's own page, never anything else loaded into the window
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) || !Vault.IsOurs(source)) return;
        JsonObject? message;
        try { message = JsonNode.Parse(e.WebMessageAsJson) as JsonObject; }
        catch (Exception) { return; }
        if (message == null) return;
        switch (J.Text(message["channel"]))
        {
            case "storage" when bridge != null && source.AbsoluteUri.StartsWith(AppScheme.Origin + "/", StringComparison.OrdinalIgnoreCase):
                bridge.Receive(J.Int(message["id"]), J.Text(message["json"]) ?? "");
                break;
            case "shell":
                // the page asking the app (lib/shell.js askShell): "Keep a full copy on this device"
                try
                {
                    if (J.Text((JsonNode.Parse(J.Text(message["json"]) ?? "{}") as JsonObject)?["type"]) == "useCopy") Vault.UseCopy();
                }
                catch (Exception) { }
                break;
            case "ready":
                ready.TrySetResult();
                App.Changed();
                break;
            case "answer":
                if (waiting.Remove(J.Int(message["id"]), out var w))
                {
                    if (J.Text(message["error"]) is { } error) w.TrySetException(new ShellError(error));
                    else w.TrySetResult((J.Int(message["status"]), message["body"]?.DeepClone()));
                }
                break;
            case "window":
                switch (J.Text(message["what"]))
                {
                    case "hide": HideWindow(); break;
                    case "fullScreen": ToggleFullScreen(); break;
                    case "menu": menus.Open(J.Text(message["letter"])); break;      // Alt, or Alt and a menu's letter
                }
                break;
        }
    }

    /// <summary>A message to the page, from any thread.</summary>
    public void Post(JsonObject message)
    {
        var json = message.ToJsonString();
        DispatcherQueue.TryEnqueue(() =>
        {
            try { web?.CoreWebView2?.PostWebMessageAsJson(json); }
            catch (Exception e) { Log.Write($"post: {e.Message}"); }
        });
    }

    void Reply(int id, JsonObject answer) => Post(new JsonObject { ["channel"] = "storage", ["id"] = id, ["reply"] = answer });

    void Nudge() => DispatcherQueue.TryEnqueue(() =>
        _ = web?.CoreWebView2?.ExecuteScriptAsync("window.__dvarimFilesChanged && window.__dvarimFilesChanged()"));

    /// <summary>
    /// Any API route, answered by whoever answers the page: the engine on this PC's
    /// copy or folder, or the server (window.dvarim.request, lib/shell.js). How the
    /// notification area, Quick Entry and reminders get and change the to-dos.
    /// On the window's thread.
    /// </summary>
    public async Task<(int Status, JsonNode? Body)> Ask(string method, string path, JsonNode? body = null, TimeSpan? within = null)
    {
        var limit = within ?? TimeSpan.FromSeconds(30);
        await ready.Task.WaitAsync(limit);
        return await Send(new JsonObject { ["channel"] = "ask", ["method"] = method, ["path"] = path, ["body"] = body?.DeepClone() }, limit);
    }

    /// <summary>window.__dvarimLocal's flush or sync, where the to-dos are on this PC.</summary>
    public async Task Local(string what, TimeSpan? within = null)
    {
        if (!ready.Task.IsCompleted) return;
        try { await Send(new JsonObject { ["channel"] = "local", ["what"] = what }, within ?? TimeSpan.FromSeconds(30)); }
        catch (Exception e) { Log.Write($"{what}: {e.Message}"); }
    }

    /// <summary>Quitting: the page's last writes on disk.</summary>
    public Task FlushAsync() => Local("flush", TimeSpan.FromSeconds(3));

    /// <summary>window.dvarim.commands(): every command, its label and its key now; null before the page has them.</summary>
    public async Task<JsonArray?> Commands()
    {
        if (!ready.Task.IsCompleted) return null;
        var (_, body) = await Send(new JsonObject { ["channel"] = "commands" }, TimeSpan.FromSeconds(5));
        return body as JsonArray;
    }

    /// <summary>One of the page's commands by its id (lib/keys.js), with the keyboard back in the page.</summary>
    public void Run(string command)
    {
        FocusPage();
        _ = web?.CoreWebView2?.ExecuteScriptAsync($"window.dvarim && window.dvarim.run({J.Quote(command)})");
    }

    /// <summary>The text a step bigger (1) or smaller (-1), or the usual size (0): the page's own (Settings › General › Text size).</summary>
    public void TextSize(int step)
    {
        FocusPage();
        Post(new JsonObject { ["channel"] = "textSize", ["step"] = step });
    }

    async Task<(int Status, JsonNode? Body)> Send(JsonObject message, TimeSpan within)
    {
        var id = nextId++;
        var answer = new TaskCompletionSource<(int Status, JsonNode? Body)>(TaskCreationOptions.RunContinuationsAsynchronously);
        waiting[id] = answer;
        message["id"] = id;
        try
        {
            web?.CoreWebView2?.PostWebMessageAsJson(message.ToJsonString());
            return await answer.Task.WaitAsync(within);
        }
        finally { waiting.Remove(id); }
    }

    /// <summary>
    /// A key pressed in the page as if on the keyboard (DevTools' Input domain), so
    /// Undo, Cut, Copy, Paste and Select All in the menu do just what their keys do.
    /// <paramref name="modifiers"/>: 1 Alt, 2 Ctrl, 8 Shift.
    /// </summary>
    public async void Key(string key, string code, int virtualKey, int modifiers)
    {
        if (web?.CoreWebView2 is not { } core) return;
        FocusPage();
        try
        {
            foreach (var type in new[] { "rawKeyDown", "keyUp" })
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", new JsonObject
                {
                    ["type"] = type, ["modifiers"] = modifiers, ["key"] = key, ["code"] = code,
                    ["windowsVirtualKeyCode"] = virtualKey, ["nativeVirtualKeyCode"] = virtualKey,
                }.ToJsonString());
        }
        catch (Exception e) { Log.Write($"key {code}: {e.Message}"); }
    }

    /// <summary>The mouse wheel turned over the page (DevTools' Input domain), for the self-test.</summary>
    public async Task Wheel(double deltaY, int modifiers)
    {
        if (web?.CoreWebView2 is not { } core) return;
        await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", new JsonObject
        {
            ["type"] = "mouseWheel", ["x"] = 300, ["y"] = 300, ["deltaX"] = 0, ["deltaY"] = deltaY, ["modifiers"] = modifiers,
        }.ToJsonString());
    }

    /// <summary>The bridge's pick, useServer and signOut: the window's to do; the reply goes first, or when the picker closes.</summary>
    void Asked(int id, string op)
    {
        DispatcherQueue.TryEnqueue(async () =>
        {
            switch (op)
            {
                case "pick":
                {
                    var chosen = await ChooseFolderAsync();
                    Reply(id, J.Ok(new JsonObject { ["changed"] = chosen != null }));
                    if (chosen != null) Vault.UseFolder(chosen);
                    break;
                }
                case "useServer":
                    Reply(id, J.Ok(null));
                    Vault.UseServer();
                    break;
                case "signOut":
                    if (Vault.Mode != "copy" || Vault.Copy == null)
                    {
                        Reply(id, FolderFiles.Failure("ENOSYS", "only a copy kept by the app signs out"));
                        break;
                    }
                    Reply(id, J.Ok(null));
                    bridge?.StopWatching();
                    await AppCopy.SignOut(web?.CoreWebView2);
                    Vault.Reload();
                    break;
            }
        });
    }

    /// <summary>An expression in the page, a promise awaited, the value as JSON (for the self-test); <paramref name="gesture"/> as if a person had clicked.</summary>
    public async Task<JsonNode?> Evaluate(string expression, bool gesture = false)
    {
        var core = web?.CoreWebView2 ?? throw new InvalidOperationException("no page yet");
        var json = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate",
            new JsonObject { ["expression"] = expression, ["awaitPromise"] = true, ["returnByValue"] = true, ["userGesture"] = gesture }.ToJsonString());
        var result = JsonNode.Parse(json);
        if (result?["exceptionDetails"] is { } problem)
            throw new Exception(problem["exception"]?["description"]?.ToString() ?? problem.ToJsonString());
        return result?["result"]?["value"]?.DeepClone();
    }

    // ---- what loads in the window ---------------------------------------------------------

    /// <summary>
    /// The window only ever shows the app. dvarim://settings (Settings › Data in the page)
    /// is the app's own settings; a link anywhere else opens in the browser.
    /// </summary>
    void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs e)
    {
        Uri.TryCreate(e.Uri, UriKind.Absolute, out var target);
        if (target != null && (Vault.IsOurs(target) || target.Scheme is "about" or "data"))
        {
            opening = e.NavigationId;
            if (ready.Task.IsCompleted) ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
            return;
        }
        e.Cancel = true;
        if (target?.Scheme is "dvarim" or "dvarim-debug") SettingsWindow.ShowIt();
        // and a file dropped where the page didn't take it isn't opened in place of the app
        else if (target?.Scheme is "http" or "https" or "mailto") Outside.Open(target);
    }

    void OnExternalScheme(CoreWebView2 sender, CoreWebView2LaunchingExternalUriSchemeEventArgs e)
    {
        e.Cancel = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) && target.Scheme is "dvarim" or "dvarim-debug") SettingsWindow.ShowIt();
        else if (target?.Scheme is "mailto") Outside.Open(target);
    }

    void OnNavigationCompleted(CoreWebView2 sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (Vault.SigningIn && e.IsSuccess) _ = TrySetUp();
        if (e.IsSuccess || e.NavigationId != opening || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
        var place = Vault.UsesBridge ? "the app's own page" : Vault.Server.Host;
        Log.Write($"could not open {place}: {e.WebErrorStatus}");
        sender.NavigateToString(Unreachable(place, e.WebErrorStatus.ToString()));
    }

    /// <summary>window.open and target=_blank: the browser, or for the app's own pages this window.</summary>
    void OnNewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var target)) return;
        if (target.Scheme is "dvarim" or "dvarim-debug") SettingsWindow.ShowIt();
        else if (Vault.IsOurs(target)) sender.Navigate(target.AbsoluteUri);
        else if (target.Scheme is "http" or "https" or "mailto") Outside.Open(target);
    }

    void OnProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log.Write($"the page's process failed: {e.ProcessFailedKind}");
        // WebView2's page process went away (memory, a crash): bring the page back;
        // the whole browser gone: a web view again
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited) sender.Reload();
        else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) DispatcherQueue.TryEnqueue(Reload);
    }

    static readonly HashSet<string> Unwanted =
        ["back", "forward", "reload", "saveAs", "print", "createQrCode", "share", "webCapture", "openLinkInNewWindow", "saveLinkAs", "copyLinkToHighlight"];

    /// <summary>
    /// The right-click menu WebView2 would show, without what belongs to a browser:
    /// spelling suggestions, Cut, Copy and Paste stay. A to-do's own menu is the
    /// page's (a right-click on a row), so nothing of the app's needs adding here.
    /// </summary>
    void OnContextMenuRequested(CoreWebView2 sender, CoreWebView2ContextMenuRequestedEventArgs e)
    {
        var items = e.MenuItems;
        for (var i = items.Count - 1; i >= 0; i--)
            if (Unwanted.Contains(items[i].Name)) items.RemoveAt(i);
        Tidy(items);
    }

    /// <summary>No separator left at an end of the menu, or beside another.</summary>
    static void Tidy(IList<CoreWebView2ContextMenuItem> items)
    {
        for (var i = items.Count - 1; i >= 0; i--)
            if (items[i].Kind == CoreWebView2ContextMenuItemKind.Separator
                && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator))
                items.RemoveAt(i);
    }

    // ---- full screen ---------------------------------------------------------------------

    public bool IsFullScreen => AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
    public bool TitleShown => TitleRow.Visibility == Visibility.Visible;

    /// <summary>
    /// F11 and View › Full Screen. Out of full screen is out, whichever way it came:
    /// the page's own full screen too, so nothing is left half-way.
    /// </summary>
    public void ToggleFullScreen()
    {
        if (shellFull || pageFull || IsFullScreen)
        {
            shellFull = false;
            if (pageFull) _ = web?.CoreWebView2?.ExecuteScriptAsync("document.fullscreenElement && document.exitFullscreen()");
            pageFull = false;
        }
        else shellFull = true;
        ApplyFullScreen();
    }

    /// <summary>One state from the two ways in: full screen while either wants it, the title bar exactly when not.</summary>
    void ApplyFullScreen()
    {
        var want = shellFull || pageFull;
        if (want != IsFullScreen) AppWindow.SetPresenter(want ? AppWindowPresenterKind.FullScreen : AppWindowPresenterKind.Overlapped);
        Presented();
        if (want) Hint(pageFull && !shellFull ? "Press Esc to exit full screen" : "Press F11 to exit full screen");
    }

    /// <summary>
    /// The presenter changed, by us or by Windows (Win+↓ takes a window out of full
    /// screen): the title bar follows what the window really is.
    /// </summary>
    void Presented()
    {
        if (!IsFullScreen && (shellFull || pageFull))
        {
            shellFull = false;
            if (pageFull) _ = web?.CoreWebView2?.ExecuteScriptAsync("document.fullscreenElement && document.exitFullscreen()");
            pageFull = false;
        }
        TitleRow.Visibility = IsFullScreen ? Visibility.Collapsed : Visibility.Visible;
    }

    Border? hint;
    DispatcherQueueTimer? hintTimer;

    /// <summary>A word at the top for three seconds, as Windows' browsers say how to leave full screen.</summary>
    void Hint(string text)
    {
        if (hint != null) Root.Children.Remove(hint);
        hint = new Border
        {
            Background = new SolidColorBrush(ColorHelper.FromArgb(0xE6, 0x2B, 0x2B, 0x2B)),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(16, 10, 16, 10),
            Margin = new Thickness(0, 24, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Top,
            IsHitTestVisible = false,
            Child = new TextBlock { Text = text, Foreground = new SolidColorBrush(Colors.White) },
        };
        Grid.SetRowSpan(hint, 3);
        Root.Children.Add(hint);
        var shown = hint;
        hintTimer?.Stop();
        hintTimer = DispatcherQueue.CreateTimer();
        hintTimer.Interval = TimeSpan.FromSeconds(3);
        hintTimer.IsRepeating = false;
        hintTimer.Tick += (_, _) =>
        {
            Root.Children.Remove(shown);
            if (hint == shown) hint = null;
        };
        hintTimer.Start();
    }

    static string Unreachable(string place, string why)
    {
        static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;");
        return $$"""
            <!doctype html><meta charset="utf-8"><style>
            body{font:14px "Segoe UI Variable Text","Segoe UI",sans-serif;color:#555;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}
            @media (prefers-color-scheme:dark){body{color:#bbb;background:#202020} }
            h1{font-size:18px;font-weight:600;color:inherit}
            </style><div><h1>Dvarim could not open {{Esc(place)}}</h1><p>{{Esc(why)}}</p>
            <p>Another server, or a folder on this PC: File › App Settings.</p></div>
            """;
    }

    // ---- choosing a folder ---------------------------------------------------------------

    /// <summary>The folder picker. Null if cancelled.</summary>
    public async Task<string?> ChooseFolderAsync()
    {
        if (App.Options.SelfTest) return null;
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary, CommitButtonText = "Use This Folder" };
        picker.FileTypeFilter.Add("*");
        InitializeWithWindow.Initialize(picker, Handle);
        var folder = await picker.PickSingleFolderAsync();
        if (folder == null) return null;
        if (string.IsNullOrEmpty(folder.Path))
        {
            await Tell("Dvarim needs a folder on this PC", "That place isn't a folder Dvarim can read and write directly. Choose one on a drive, in OneDrive, or in Syncthing's folders.");
            return null;
        }
        return folder.Path;
    }

    public async Task Tell(string title, string text)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Root.XamlRoot,
            Title = title,
            Content = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
            CloseButtonText = "OK",
        };
        await dialog.ShowAsync();
    }

    // ---- where the window is ------------------------------------------------------------------

    /// <summary>Where it was last time, else in the middle of the screen.</summary>
    void Place()
    {
        var scale = GetDpiForWindow(Handle) / 96.0;
        if (Vault.WindowPlace is [var x, var y, var w, var h, var maximised]
            && w > 200 && h > 200 && DisplayArea.GetFromRect(new RectInt32(x, y, w, h), DisplayAreaFallback.None) != null)
        {
            normal = new RectInt32(x, y, w, h);
            AppWindow.MoveAndResize(normal);
            if (maximised == 1 && AppWindow.Presenter is OverlappedPresenter presenter) presenter.Maximize();
            return;
        }
        var size = new SizeInt32((int)(1180 * scale), (int)(780 * scale));
        AppWindow.Resize(size);
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        AppWindow.Move(new PointInt32(area.X + Math.Max(0, (area.Width - size.Width) / 2), area.Y + Math.Max(0, (area.Height - size.Height) / 2)));
        normal = new RectInt32(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);
    }

    void SavePlace()
    {
        if (App.Options.SelfTest || !AppWindow.IsVisible || IsFullScreen) return;
        var maximised = AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized };
        Vault.WindowPlace = [normal.X, normal.Y, normal.Width, normal.Height, maximised ? 1 : 0];
    }
}
