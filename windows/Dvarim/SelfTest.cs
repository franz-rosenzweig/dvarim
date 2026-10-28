using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Dvarim.Core;

namespace Dvarim;

/// <summary>
/// The self-test (windows/selftest.ps1): the real app with nobody at the keyboard,
/// checked from inside the page and from outside it. Two runs:
/// <list type="bullet">
/// <item>--folder: a scratch folder. The bridge's conformance checks in the page, a
/// change from outside, Quick Entry, the notification area's Today and a tick there,
/// reminders, and the page's way to the app's own settings.</item>
/// <item>--copy --server: a Dvarim server the script started on this PC. The sign-in on
/// the server's page, the token made from it and kept in Credential Manager, the
/// copy synced both ways, http with the app's session, and signing out.</item>
/// </list>
/// The results go to --out, and the exit code says whether every check held. The
/// Mac's is mac/Native/SelfTest*.swift, Android's tools/phone/.
/// </summary>
static class SelfTest
{
    sealed record Check(string Name, bool Ok, string Detail);
    static readonly List<Check> Checks = [];
    static readonly object Gate = new();
    static int calls;

    public static void Start()
    {
        // never longer than three minutes, whatever hangs
        _ = Task.Delay(TimeSpan.FromMinutes(3)).ContinueWith(_ => Finish("it took more than three minutes"));
    }

    static void Add(string name, bool ok, string detail = "")
    {
        lock (Gate) Checks.Add(new Check(name, ok, detail));
    }

    public static async Task Run(ShellWindow window)
    {
        try
        {
            if (App.Options.Copy) await Copy(window);
            else await Folder(window);
            Finish();
        }
        catch (Exception e)
        {
            Finish(e.ToString());
        }
    }

    // ---- on a folder ------------------------------------------------------------------

    static async Task Folder(ShellWindow window)
    {
        var folder = Vault.Folder ?? throw new Exception("no folder: run it with --folder");
        Add("folder mode", Vault.Mode == "folder" && Vault.UsesBridge, folder);

        var kind = await Until(window, "window.__dvarimLocal ? window.__dvarimLocal.kind : null", TimeSpan.FromSeconds(60));
        Add("the page started on the folder", J.Text(kind) == "device", kind?.ToJsonString() ?? "it never started");
        var agent = J.Text(await window.Evaluate("navigator.userAgent")) ?? "";
        Add("the user agent names the shell", agent.Contains($"Dvarim/{App.Version} (Windows shell)"), agent);

        var info = (await Bridge(window, "info"))?["ok"];
        Add("info names the folder, says it is watched, and offers http and changed",
            J.Text(info?["detail"]) == folder && J.Int(info?["pollSeconds"]) == 0 && J.Bool(info?["http"]) && J.Bool(info?["changes"]) && info?["sync"] == null,
            info?.ToJsonString() ?? "");

        // the bridge's conformance checks (docs/BRIDGE.md, "Checking a shell"), in the page, over the bridge
        var conformance = await window.Evaluate("window.__dvarimLocal.conformance()");
        foreach (var result in (conformance?["results"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            Add($"conformance: {J.Text(result["name"])}", J.Bool(result["ok"]), J.Text(result["error"]) ?? $"{result["ms"]} ms");
        Add("conformance as a whole", J.Bool(conformance?["ok"]), conformance == null ? "no answer" : "");

        var route = J.Text(await window.Evaluate("fetch('/project/p7k3j9a2').then(async (r) => `${r.status} ${(await r.text()).includes('<script')}`)"));
        Add("any path that isn't a file is the app, so a reload stays on its screen", route == "200 true", route ?? "");

        // a change from outside reaches the page
        var before = FolderBridge.Nudges;
        var inbox = Path.Join(folder, "Inbox.md");
        await File.AppendAllTextAsync(inbox, "\n- [ ] Written from outside\n");
        var told = await Until(() => FolderBridge.Nudges > before, TimeSpan.FromSeconds(5));
        var seen = await Until(window, "window.dvarim.request('GET', '/api/lists/inbox').then((r) => r.body.items.some((t) => t.title === 'Written from outside'))", TimeSpan.FromSeconds(10));
        Add("a change from another app reaches the page", told && J.Bool(seen), $"told {FolderBridge.Nudges - before} times, in the Inbox: {seen?.ToJsonString()}");

        // Quick Entry, through the page, into the file
        var changedBefore = FolderBridge.ChangedOps;
        var (saved, problem) = await QuickEntry.Add("Bought on Windows #selftest", "A note under it");
        Add("Quick Entry saves a line through the page", saved, problem);
        Add("it lands in the folder's Markdown", await Until(() => Markdown(folder).Contains("Bought on Windows"), TimeSpan.FromSeconds(5)));
        Add("the page tells the app the to-dos changed (op changed)", await Until(() => FolderBridge.ChangedOps > changedBefore, TimeSpan.FromSeconds(5)),
            $"{FolderBridge.ChangedOps - changedBefore} times");

        // the notification area: Today's count, the list, a tick
        await QuickEntry.Add("Water the plants today", null);
        var listed = await Until(() => TodayList.Items.Any(t => J.Text(t["title"]) == "Water the plants"), TimeSpan.FromSeconds(8));
        Add("the notification area's Today has a to-do made for today", listed, TodayList.Problem ?? string.Join(", ", TodayList.Items.Select(t => J.Text(t["title"]))));
        Add("the icon is in the notification area, today's count under the pointer", Tray.Shown && Tray.Tip.Contains("today"), $"{(Tray.Shown ? "shown" : "not shown")}: {Tray.Tip}");
        if (TodayList.Items.FirstOrDefault(t => J.Text(t["title"]) == "Water the plants") is { } plants && J.Text(plants["id"]) is { } id)
        {
            var ticked = await TodayList.Complete(id, true);
            Add("ticking it off there completes it in the file", ticked && await Until(() => Markdown(folder).Contains("[x] Water the plants"), TimeSpan.FromSeconds(5)));
        }

        // reminders: one whose time came two minutes ago, and one for later
        var now = DateTime.Now;
        if (now.TimeOfDay > TimeSpan.FromMinutes(5) && now.TimeOfDay < TimeSpan.FromHours(23.4))
        {
            await QuickEntry.Add($"Self-test reminder @{now.AddMinutes(-2):HH:mm}", null);
            await QuickEntry.Add($"Self-test later @{now.AddMinutes(30):HH:mm}", null);
            Reminder? due = null, later = null;
            await Until(() =>
            {
                due = Reminders.Plan.FirstOrDefault(r => r.Title == "Self-test reminder");
                later = Reminders.Plan.FirstOrDefault(r => r.Title == "Self-test later");
                return due != null && later != null;
            }, TimeSpan.FromSeconds(10));
            Add("reminders come from Today and Upcoming, on this PC's clock", due != null && later != null,
                string.Join(", ", Reminders.Plan.Select(r => $"{r.Title} at {r.Due:HH:mm}")));
            var shown = due != null && await Until(() => Notifications.Sent.Contains(due.Key), TimeSpan.FromSeconds(5));
            Add("a reminder whose time has come is handed to Windows as a notification", shown, Notifications.Problem ?? "");
            Add("one for later waits for its time", later != null && !Notifications.Sent.Contains(later.Key));
        }
        else Add("reminders (not tried: too near midnight for today's)", true);

        // the window: Windows 11's title bar, holding the menus, named for where the to-dos are
        var titles = string.Join(", ", window.MenuTitles);
        Add("the title bar holds File, Edit, To-Do, View and Help", titles == "File, Edit, To-Do, View, Help" && window.ExtendsContentIntoTitleBar, titles);
        Add("the window is named for its folder", window.Title == $"{Path.GetFileName(folder)} - Dvarim", window.Title);
        window.MenuBarMenus.Refresh();
        Add("the menus show the page's own keys", await Until(() => window.MenuBarMenus.KeyOf("todo.today") == "Ctrl+T" && window.MenuBarMenus.KeyOf("go.inbox") == "Ctrl+1",
            TimeSpan.FromSeconds(5)), $"To-Do › Today {window.MenuBarMenus.KeyOf("todo.today")}, View › Inbox {window.MenuBarMenus.KeyOf("go.inbox")}");
        window.Run("go.upcoming");
        var went = J.Text(await Until(window, "location.pathname === '/upcoming' ? location.pathname : ''", TimeSpan.FromSeconds(5)));
        Add("a menu item runs the page's command (View › Upcoming)", went == "/upcoming", went ?? "");

        // the text's size: Ctrl and + / - / 0, and Ctrl with the wheel, go to the page's own text size
        const string size = "Number(localStorage.getItem('dvarim.textScale')) || 100";
        var usual = J.Int(await window.Evaluate(size));
        var ratio = (await window.Evaluate("window.devicePixelRatio"))?.ToJsonString();
        window.Key("=", "Equal", 0xBB, 2);
        var bigger = J.Int(await Until(window, $"({size}) > {usual} ? ({size}) : 0", TimeSpan.FromSeconds(3)));
        Add("Ctrl and + makes the text bigger", bigger == usual + 5, $"{usual}% to {bigger}%");
        window.Key("-", "Minus", 0xBD, 2);
        var smaller = J.Int(await Until(window, $"({size}) < {bigger} ? ({size}) : 0", TimeSpan.FromSeconds(3)));
        Add("Ctrl and - makes it smaller", smaller == usual, $"{bigger}% to {smaller}%");
        await window.Wheel(-120, 2);
        var wheeled = J.Int(await Until(window, $"({size}) > {smaller} ? ({size}) : 0", TimeSpan.FromSeconds(3)));
        Add("Ctrl and the mouse wheel make it bigger", wheeled == smaller + 5, $"{smaller}% to {wheeled}%");
        var css = J.Text(await window.Evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()"));
        Add("the page's text follows (--text-scale)", css == (wheeled / 100.0).ToString(System.Globalization.CultureInfo.InvariantCulture), css ?? "");
        window.Key("0", "Digit0", 0x30, 2);
        var reset = J.Int(await Until(window, $"({size}) === 100 ? 100 : 0", TimeSpan.FromSeconds(3)));
        Add("Ctrl+0 is the usual size again", reset == 100, $"{wheeled}% to {reset}%");
        var after = (await window.Evaluate("window.devicePixelRatio"))?.ToJsonString();
        Add("and the browser itself never zoomed the window", window.Core?.Settings.IsZoomControlEnabled == true && after == ratio, $"devicePixelRatio {ratio} then {after}");

        // full screen, in and out, and never a window left without its title bar
        window.ToggleFullScreen();
        Add("F11 makes the window full screen, without the title bar", window.IsFullScreen && !window.TitleShown);
        window.ToggleFullScreen();
        Add("F11 again brings the window and its title bar back", !window.IsFullScreen && window.TitleShown);
        await window.Evaluate("document.documentElement.requestFullscreen().then(() => true)", gesture: true);
        var pageFull = await Until(() => window.IsFullScreen && !window.TitleShown, TimeSpan.FromSeconds(3));
        Add("the page's own full screen fills the screen too", pageFull);
        // the way Moshe's got stuck: the menu's Full Screen while the page was full screen
        window.ToggleFullScreen();
        var restored = await Until(() => !window.IsFullScreen && window.TitleShown, TimeSpan.FromSeconds(3));
        var pageOut = J.Bool(await Until(window, "!document.fullscreenElement", TimeSpan.FromSeconds(3)));
        Add("View › Full Screen then takes both out, title bar and all", restored && pageOut,
            $"window {(window.IsFullScreen ? "full screen" : "normal")}, title bar {(window.TitleShown ? "shown" : "hidden")}, page {(pageOut ? "out" : "still full screen")}");

        // the page's Settings › Data has the way to the app's own settings, dvarim://settings
        var href = J.Text(await window.Evaluate("""
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              window.dvarim.run('settings.open');
              for (let i = 0; i < 40 && !document.querySelector('.sheet'); i++) await wait(100);
              const pane = [...document.querySelectorAll('.panes button')].find((b) => /data/i.test(b.textContent));
              if (!pane) return 'no Data pane';
              pane.click();
              for (let i = 0; i < 20 && !document.querySelector('a.native'); i++) await wait(100);
              const a = document.querySelector('a.native');
              return a ? a.getAttribute('href') : 'no link';
            })()
            """));
        Add("the page's Settings › Data links to the app's own settings", href == "dvarim://settings", href ?? "");
        await window.Evaluate("(document.querySelector('a.native') || { click() {} }).click(), true");
        Add("following it opens Dvarim's Settings window, not a browser", await Until(() => SettingsWindow.IsOpen, TimeSpan.FromSeconds(5)));
        SettingsWindow.CloseIt();

        // nothing but the app ever loads in the window
        await window.Evaluate("location.assign('https://example.com/elsewhere'), true");
        await Task.Delay(1000);
        Add("a link elsewhere opens in the browser, not in the window",
            window.Source?.AbsoluteUri.StartsWith(AppScheme.Origin, StringComparison.Ordinal) == true
            && Outside.Opened.Any(u => u.AbsoluteUri == "https://example.com/elsewhere"),
            window.Source?.AbsoluteUri ?? "");

        // the window's close box puts it away, and the page goes on answering
        window.HideWindow();
        var (status, _) = await window.Ask("GET", "/api/lists/today");
        Add("with the window put away, the page still answers", !window.IsShown && status == 200, $"{status}");
        window.ShowWindow("/today");
        Add("and it comes back", window.IsShown);
    }

    // ---- the copy, with a server ---------------------------------------------------------

    static async Task Copy(ShellWindow window)
    {
        var server = Vault.Server;
        var serverText = ServerAddress.Text(server);
        var password = Environment.GetEnvironmentVariable("DVARIM_SELFTEST_PASSWORD") ?? throw new Exception("no DVARIM_SELFTEST_PASSWORD");
        Add("copy mode, with no copy yet: the server's sign-in", Vault.Mode == "copy" && Vault.SigningIn, serverText);

        var flagged = await Until(window,
            $"location.origin === {J.Quote(serverText)} && !!window.__dvarimShell && window.__dvarimShell.copy === true && typeof window.DvarimShell.postMessage === 'function' && !window.DvarimStorage",
            TimeSpan.FromSeconds(30));
        Add("the server's page, told the app keeps the copy, and with no folder bridge", J.Bool(flagged), window.Source?.AbsoluteUri ?? "");

        // signing in on the server's page, as a person would there
        var login = "fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: "
            + J.Quote(password) + " }) }).then((r) => r.status)";
        var signedIn = (await window.Evaluate(login))?.ToJsonString();
        Add("signing in on the server's page", signedIn == "200", signedIn ?? "");

        var made = await Until(() => Vault.Copy != null, TimeSpan.FromSeconds(20));
        var copy = Vault.Copy;
        Add("the app makes this PC a token from that sign-in", made && copy != null, copy == null ? "" : $"as “{copy.Device}”, for {copy.Who}");
        if (copy == null) return;
        var token = Vault.Token(copy) ?? "";
        var settingsFile = Path.Join(App.DataDir, "settings.json");
        Add("the token is in Credential Manager, not in the settings", token.StartsWith("dvt_", StringComparison.Ordinal) && !File.ReadAllText(settingsFile).Contains(token),
            token.Length == 0 ? "no token" : "");
        var copyFolder = Vault.CopyFolder(copy);
        Add("the copy has a folder of its own", Directory.Exists(copyFolder), copyFolder);

        var kind = await Until(window, $"location.origin === {J.Quote(AppScheme.Origin)} && window.__dvarimLocal ? window.__dvarimLocal.kind : null", TimeSpan.FromSeconds(60));
        Add("the window reloads into the app's own page, on the copy", J.Text(kind) == "device", window.Source?.AbsoluteUri ?? "");

        var info = (await Bridge(window, "info"))?["ok"];
        var sync = info?["sync"];
        Add("info hands the page the sync: this server, this PC's token, set up by the app",
            J.Text(sync?["kind"]) == "dvarim" && J.Text(sync?["address"]) == serverText && J.Text(sync?["token"]) == token && J.Bool(sync?["app"]) && J.Text(info?["name"]) == "This PC",
            info == null ? "no info" : J.Text(info["detail"]) ?? "");

        // both ways: what the server had arrives, and a line typed here reaches it
        Add("the server's to-dos arrive in the copy", await Until(() => Markdown(copyFolder).Contains("Seeded on the server"), TimeSpan.FromSeconds(40)));
        var (saved, problem) = await QuickEntry.Add("Made on Windows", null);
        Add("Quick Entry saves to the copy", saved && await Until(() => Markdown(copyFolder).Contains("Made on Windows"), TimeSpan.FromSeconds(5)), problem);
        await window.Local("sync");
        Add("and the copy's sync takes it to the server",
            await Until(async () => (await Server(server, token, "/api/lists/inbox")).Text.Contains("Made on Windows"), TimeSpan.FromSeconds(40)));

        // http with the app's own sign-in: to its server, and nowhere else
        var withSession = (await Bridge(window, "http", new JsonObject { ["url"] = serverText + "/api/tokens", ["method"] = "GET", ["headers"] = new JsonObject(), ["session"] = true }))?["ok"];
        Add("http with session: true carries the app's sign-in to its server (the devices list)",
            J.Int(withSession?["status"]) == 200 && (J.Text(withSession?["body"]) ?? "").Contains(copy.Device), $"{J.Int(withSession?["status"])}");
        var without = (await Bridge(window, "http", new JsonObject { ["url"] = serverText + "/api/tokens", ["method"] = "GET", ["headers"] = new JsonObject() }))?["ok"];
        Add("and without it, no sign-in goes", J.Int(without?["status"]) is 401 or 403, $"{J.Int(without?["status"])}");
        var elsewhere = await Bridge(window, "http", new JsonObject { ["url"] = $"{server.Scheme}://{server.Host}:9/api/tokens", ["method"] = "GET", ["headers"] = new JsonObject(), ["session"] = true });
        Add("the sign-in goes to no other server", J.Text(elsewhere?["error"]?["code"]) == "EACCES", elsewhere?.ToJsonString() ?? "");
        var bearer = (await Bridge(window, "http", new JsonObject
        {
            ["url"] = serverText + "/api/auth", ["method"] = "GET", ["headers"] = new JsonObject { ["Authorization"] = $"Bearer {token}" },
        }))?["ok"];
        Add("the token signs the page's requests in (Authorization: Bearer)", (J.Text(bearer?["body"]) ?? "").Contains("\"authenticated\":true"), J.Text(bearer?["body"]) ?? "");

        // signing out: the token goes from the server and from here, and the copy with it
        var target = $"Dvarim sync token {copy.Server} {copy.Who}";
        var signOut = await Bridge(window, "signOut");
        Add("signOut is answered", signOut?["error"] == null, signOut?.ToJsonString() ?? "");
        var gone = await Until(() => Vault.Copy == null && !Directory.Exists(copyFolder) && Credentials.Read(target) == null, TimeSpan.FromSeconds(20));
        Add("signing out forgets the copy: the token from Credential Manager, the folder from this PC", gone);
        var revoked = await Server(server, token, "/api/auth");
        Add("and the token no longer works on the server", !revoked.Text.Contains("\"authenticated\":true"), revoked.Text);
        var back = await Until(window, $"location.origin === {J.Quote(serverText)} && !!window.__dvarimShell", TimeSpan.FromSeconds(30));
        Add("the window is back at the server's sign-in", J.Bool(back), window.Source?.AbsoluteUri ?? "");
    }

    // ---- helpers -----------------------------------------------------------------------------

    /// <summary>One bridge message from the page, as the page sends it (window.DvarimStorage), and its reply.</summary>
    static async Task<JsonNode?> Bridge(ShellWindow window, string op, JsonObject? args = null)
    {
        var id = 900000 + Interlocked.Increment(ref calls);
        var message = new JsonObject { ["v"] = 1, ["op"] = op, ["args"] = args ?? new JsonObject() }.ToJsonString();
        var script = "new Promise((resolve) => { const before = window.__dvarimStorageReply; "
            + "window.__dvarimStorageReply = (rid, reply) => { if (rid === " + id + ") { window.__dvarimStorageReply = before; resolve(reply); } else if (before) before(rid, reply); }; "
            + "window.DvarimStorage.request(" + id + ", " + J.Quote(message) + "); })";
        return await window.Evaluate(script);
    }

    static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>A GET to the server with the token, as another program would; the status and the body.</summary>
    static async Task<(int Status, string Text)> Server(Uri server, string token, string path)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(server, path));
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            using var response = await Client.SendAsync(request);
            return ((int)response.StatusCode, await response.Content.ReadAsStringAsync());
        }
        catch (Exception e)
        {
            return (0, e.Message);
        }
    }

    /// <summary>Every to-do file in a folder, read together, as another app might have them open.</summary>
    static string Markdown(string folder)
    {
        var all = new StringBuilder();
        try
        {
            foreach (var file in Directory.EnumerateFiles(folder, "*.md", SearchOption.AllDirectories))
            {
                if (file.Contains($"{Path.DirectorySeparatorChar}.dvarim{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;
                using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                all.AppendLine(reader.ReadToEnd());
            }
        }
        catch (Exception) { }
        return all.ToString();
    }

    /// <summary>The expression's value once it is truthy, or its last value when the time runs out.</summary>
    static async Task<JsonNode?> Until(ShellWindow window, string expression, TimeSpan within)
    {
        var end = DateTime.UtcNow + within;
        JsonNode? value = null;
        while (DateTime.UtcNow < end)
        {
            try { value = await window.Evaluate(expression); }
            catch (Exception) { value = null; }
            if (value != null && value.ToJsonString() is not ("false" or "0" or "\"\"" or "null")) return value;
            await Task.Delay(250);
        }
        return value;
    }

    static async Task<bool> Until(Func<bool> condition, TimeSpan within)
    {
        var end = DateTime.UtcNow + within;
        while (DateTime.UtcNow < end)
        {
            if (condition()) return true;
            await Task.Delay(100);
        }
        return condition();
    }

    static async Task<bool> Until(Func<Task<bool>> condition, TimeSpan within)
    {
        var end = DateTime.UtcNow + within;
        while (DateTime.UtcNow < end)
        {
            if (await condition()) return true;
            await Task.Delay(500);
        }
        return await condition();
    }

    static void Finish(string? problem = null)
    {
        Check[] checks;
        lock (Gate)
        {
            if (problem != null) Checks.Add(new Check("the self-test ran to the end", false, problem));
            checks = [.. Checks];
        }
        var ok = checks.Length > 0 && checks.All(c => c.Ok);
        var report = new JsonObject
        {
            ["ok"] = ok,
            ["version"] = App.Version,
            ["mode"] = App.Options.Copy ? "copy" : "folder",
            ["checks"] = new JsonArray(checks.Select(c => (JsonNode?)new JsonObject { ["name"] = c.Name, ["ok"] = c.Ok, ["detail"] = c.Detail }).ToArray()),
        };
        try
        {
            if (App.Options.Out is { } path)
                File.WriteAllText(path, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        }
        catch (Exception e) { Log.Write($"self-test results: {e.Message}"); }
        Environment.Exit(ok ? 0 : 1);
    }
}
