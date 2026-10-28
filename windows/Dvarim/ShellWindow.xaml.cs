using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Dvarim.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace Dvarim;

/// <summary>
/// Dvarim's window: the page, which draws everything, from inside the app with the
/// copy or a folder behind it, or the server's. Closing it puts it away rather than
/// ending Dvarim, so the page goes on answering the notification area, Quick Entry
/// and reminders (window.dvarim.request), as the web-view Mac app's hidden page did.
/// Android's is FolderActivity with CopySignInActivity.
/// </summary>
public sealed partial class ShellWindow : Window
{
    public IntPtr Handle { get; }
    WebView2? web;
    FolderBridge? bridge;
    bool started;
    ulong opening;                        // the navigation to the page, whose failure is worth a word
    RectInt32 normal;                     // where the window is when it is neither maximised nor full screen
    DispatcherQueueTimer? signIn;          // asks every few seconds whether there is a sign-in to make the copy from
    bool settingUp;
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
        var icon = Path.Join(AppContext.BaseDirectory, "Assets", "Dvarim.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);
        Place();
        AppWindow.Changed += (_, e) =>
        {
            if ((e.DidPositionChange || e.DidSizeChange) && AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Restored })
                normal = new RectInt32(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);
        };
        // the close box puts the window away: Dvarim stays in the notification area
        AppWindow.Closing += (_, e) =>
        {
            if (App.Quitting) return;
            e.Cancel = true;
            HideWindow();
        };
        Root.Loaded += async (_, _) => await StartAsync();
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

    // ---- showing and putting away ---------------------------------------------------------

    /// <summary>The window to the front, at <paramref name="path"/> (/todo/aa11bb22, /today) if given.</summary>
    public void ShowWindow(string? path = null)
    {
        if (path != null) Go(path);
        AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter) presenter.Restore();
        Activate();
        SetForegroundWindow(Handle);
        web?.Focus(FocusState.Programmatic);
    }

    public void HideWindow()
    {
        SavePlace();
        if (AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) FullScreen(false);
        AppWindow.Hide();
    }

    public bool IsShown => AppWindow.IsVisible;

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
        Grid.SetRow(view, 1);
        Root.Children.Add(view);
        web = view;
        await view.EnsureCoreWebView2Async(environment);
        var core = view.CoreWebView2;
        var settings = core.Settings;
        settings.AreBrowserAcceleratorKeysEnabled = false;   // Ctrl+F, Ctrl+P, Ctrl+R… are the page's keys, not the browser's
        settings.IsStatusBarEnabled = false;
        settings.IsZoomControlEnabled = false;               // the page has its own (Settings › General › Text size)
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
        core.ContainsFullScreenElementChanged += (_, _) => FullScreen(core.ContainsFullScreenElement);
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
        Grid.SetRow(panel, 1);
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
        var settings = new Button { Content = "Settings…" };
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
                try { done.TrySetResult(web?.CoreWebView2 is { } core ? await AppCopy.Cookie(core, server) : null); }
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
                    case "fullScreen": FullScreen(AppWindow.Presenter.Kind != AppWindowPresenterKind.FullScreen); break;
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
                    await AppCopy.SignOut(web?.CoreWebView2);
                    Vault.Reload();
                    break;
            }
        });
    }

    /// <summary>An expression in the page, a promise awaited, the value as JSON (for the self-test).</summary>
    public async Task<JsonNode?> Evaluate(string expression)
    {
        var core = web?.CoreWebView2 ?? throw new InvalidOperationException("no page yet");
        var json = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate",
            new JsonObject { ["expression"] = expression, ["awaitPromise"] = true, ["returnByValue"] = true }.ToJsonString());
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

    /// <summary>The page's right-click menu, without what belongs to a browser: spelling suggestions, cut, copy and paste stay.</summary>
    void OnContextMenuRequested(CoreWebView2 sender, CoreWebView2ContextMenuRequestedEventArgs e)
    {
        var items = e.MenuItems;
        for (var i = items.Count - 1; i >= 0; i--)
            if (Unwanted.Contains(items[i].Name)) items.RemoveAt(i);
        // and no separator left at an end or beside another
        for (var i = items.Count - 1; i >= 0; i--)
            if (items[i].Kind == CoreWebView2ContextMenuItemKind.Separator
                && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator))
                items.RemoveAt(i);
    }

    public void FullScreen(bool on) =>
        AppWindow.SetPresenter(on ? AppWindowPresenterKind.FullScreen : AppWindowPresenterKind.Overlapped);

    static string Unreachable(string place, string why)
    {
        static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;");
        return $$"""
            <!doctype html><meta charset="utf-8"><style>
            body{font:14px "Segoe UI Variable Text","Segoe UI",sans-serif;color:#555;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}
            @media (prefers-color-scheme:dark){body{color:#bbb;background:#202020} }
            h1{font-size:18px;font-weight:600;color:inherit}
            </style><div><h1>Dvarim could not open {{Esc(place)}}</h1><p>{{Esc(why)}}</p>
            <p>Another server, or a folder on this PC: Settings, from Dvarim's icon in the notification area.</p></div>
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
        if (App.Options.SelfTest || !AppWindow.IsVisible || AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) return;
        var maximised = AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized };
        Vault.WindowPlace = [normal.X, normal.Y, normal.Width, normal.Height, maximised ? 1 : 0];
    }
}
