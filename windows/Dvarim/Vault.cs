using System.Text.Json;
using Dvarim.Core;

namespace Dvarim;

/// <summary>
/// Where the to-dos live, as the three choices in Settings (android/…/Folder.java,
/// mac/Native/Account.swift's Mode):
/// <list type="bullet">
/// <item>"copy", the default: on this PC, in a folder of the app's own that the page
/// keeps in step with the server (AppCopy). The page is the app's own, so it opens
/// with no network. Until the first sign-in there is no copy, and the window shows
/// the server's page to sign in on.</item>
/// <item>"server": on the server only, its page and all.</item>
/// <item>"folder": a folder on this PC the person chose, the Tasks folder of a vault
/// Syncthing or OneDrive keeps in step, read and written through FolderBridge.</item>
/// </list>
/// Kept in settings.json beside the page's own data; the copy's token is in
/// Credential Manager, never here.
/// </summary>
static class Vault
{
    internal sealed class Settings
    {
        public string Mode { get; set; } = "copy";
        public string? Folder { get; set; }
        public string? Server { get; set; }
        public CopyRecord? Copy { get; set; }
        public int[]? Window { get; set; }                    // x, y, width, height, maximised
        public string QuickEntryKey { get; set; } = HotKey.Default.ToString();
        public string? ShortcutTakenTold { get; set; }        // the shortcut a notification last said another app holds
        public bool Reminders { get; set; } = true;
    }

    /// <summary>The copy: which server, whose, and the name this PC syncs as there.</summary>
    internal sealed class CopyRecord
    {
        public string Server { get; set; } = "";
        public string Who { get; set; } = "owner";
        public string Device { get; set; } = "";
    }

    static Settings settings = new();
    static string SettingsFile => Path.Join(App.DataDir, "settings.json");

    public static void Load()
    {
        try { settings = JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsFile)) ?? new(); }
        catch (Exception) { settings = new(); }
        // the self-test's own
        if (App.Options.Server is { } server && ServerAddress.Parse(server) is { } url) settings.Server = ServerAddress.Text(url);
        if (App.Options.Folder is { } folder)
        {
            settings.Folder = Path.GetFullPath(folder);
            settings.Mode = "folder";
        }
        else if (App.Options.Copy) settings.Mode = "copy";
    }

    static void Save()
    {
        try { File.WriteAllText(SettingsFile, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true })); }
        catch (Exception e) { Log.Write($"settings: {e.Message}"); }
    }

    public static string Mode => settings.Mode is "server" or "folder" ? settings.Mode : "copy";

    /// <summary>The server: the one typed in Settings, else the one the app was built for.</summary>
    public static Uri Server => ServerAddress.Parse(settings.Server) ?? new Uri(ServerAddress.BuiltIn);

    public static bool ServerIsBuiltIn => settings.Server is not { Length: > 0 } || ServerAddress.Parse(settings.Server) == null;

    /// <summary>The folder chosen, whatever the mode, if it is still there.</summary>
    public static string? Folder => settings.Folder is { Length: > 0 } f && Directory.Exists(f) ? f : null;

    public static string? ChosenFolder => settings.Folder;

    /// <summary>The folder was chosen once and has gone (a drive not plugged in, a folder moved).</summary>
    public static bool FolderMissing => Mode == "folder" && settings.Folder is { Length: > 0 } && Folder == null;

    /// <summary>The built web app beside Dvarim.exe (the project copies frontend/dist there as web/).</summary>
    public static string? WebBundle { get; } =
        File.Exists(Path.Join(AppContext.BaseDirectory, "web", "index.html")) ? Path.Join(AppContext.BaseDirectory, "web") : null;

    // ---- the copy ----------------------------------------------------------------------

    static string TokenName(CopyRecord c) => $"Dvarim sync token {c.Server} {c.Who}";

    static string SignInName(CopyRecord c) => $"Dvarim sign-in {c.Server} {c.Who}";

    /// <summary>The copy, if it is for the server in use and its token is there.</summary>
    public static CopyRecord? Copy =>
        settings.Copy is { } c && ServerAddress.Parse(c.Server) is { } s && ServerAddress.SameOrigin(s, Server) && Token(c) != null ? c : null;

    public static string? Token(CopyRecord c)
    {
        try { return Credentials.Read(TokenName(c)); }
        catch (Exception e) { Log.Write($"Credential Manager: {e.Message}"); return null; }
    }

    /// <summary>
    /// The server's sign-in the copy was set up with (a Cookie header), kept beside its
    /// token: WebView2 may leave the server's cookies out while the window shows the
    /// app's own page (AppCopy.Session), and the devices list and signing out need it.
    /// </summary>
    public static string? SignIn(CopyRecord c)
    {
        try { return Credentials.Read(SignInName(c)); }
        catch (Exception e) { Log.Write($"Credential Manager: {e.Message}"); return null; }
    }

    public static string CopiesDir => Path.Join(App.DataDir, "Copies");

    public static string CopyFolder(CopyRecord c) => CopyNames.Folder(CopiesDir, ServerAddress.Parse(c.Server) ?? Server, c.Who);

    /// <summary>After the first sign-in: the token and the sign-in kept, and the copy recorded. Throws if Windows won't keep the token.</summary>
    public static void RecordCopy(string who, string device, string token, string signIn)
    {
        var c = new CopyRecord { Server = ServerAddress.Text(Server), Who = who, Device = device };
        Credentials.Write(TokenName(c), $"{who}@{Server.Host}", token);
        try { Credentials.Write(SignInName(c), $"{who}@{Server.Host}", signIn, "Dvarim for Windows: the sign-in on the server, for this PC's devices list and signing out"); }
        catch (Exception e) { Log.Write($"Credential Manager: {e.Message}"); }
        settings.Copy = c;
        Save();
        Directory.CreateDirectory(CopyFolder(c));
    }

    /// <summary>The copy forgotten: its token from Credential Manager, and the record. AppCopy moves the folder.</summary>
    public static void ForgetCopy()
    {
        if (settings.Copy is { } c)
        {
            try
            {
                Credentials.Delete(TokenName(c));
                Credentials.Delete(SignInName(c));
            }
            catch (Exception e) { Log.Write($"Credential Manager: {e.Message}"); }
        }
        settings.Copy = null;
        Save();
    }

    // ---- what the window shows ---------------------------------------------------------

    /// <summary>The folder the page works on, through the bridge: the copy, or the folder chosen. Null for the server's page.</summary>
    public static string? BridgeFolder =>
        WebBundle == null ? null
        : Mode == "copy" && Copy is { } c ? CopyFolder(c)
        : Mode == "folder" ? Folder
        : null;

    public static bool UsesBridge => BridgeFolder != null;

    /// <summary>Copy is the choice and there is none yet: the server's page, to sign in on.</summary>
    public static bool SigningIn => Mode == "copy" && WebBundle != null && Copy == null;

    /// <summary>The page, served from inside the app (AppScheme).</summary>
    public static Uri AppStart { get; } = new(AppScheme.Origin + "/");

    public static Uri StartUri => UsesBridge ? AppStart : Server;

    /// <summary>A page the app treats as its own: from inside the app, or the server's.</summary>
    public static bool IsOurs(Uri url) => ServerAddress.SameOrigin(url, AppStart) || ServerAddress.SameOrigin(url, Server);

    /// <summary>Where the to-dos are, for Settings and the tray.</summary>
    public static string Describe() => Mode switch
    {
        "folder" => Folder ?? (settings.Folder is { Length: > 0 } f ? $"{f} (not found)" : "no folder chosen"),
        "server" => $"on {Server.Host}",
        _ => Copy is { } c ? $"on this PC, synced with {Server.Host}" : $"waiting for you to sign in to {Server.Host}",
    };

    /// <summary>The place moved (another mode, folder or server): the window loads again.</summary>
    public static event Action? Moved;

    public static void UseFolder(string path)
    {
        settings.Folder = path;
        settings.Mode = "folder";
        Save();
        Moved?.Invoke();
    }

    public static void UseServer()
    {
        settings.Mode = "server";
        Save();
        Moved?.Invoke();
    }

    public static void UseCopy()
    {
        settings.Mode = "copy";
        Save();
        Moved?.Invoke();
    }

    /// <summary>Another server: its own copy, its own sign-in.</summary>
    public static void SetServer(Uri? url)
    {
        settings.Server = url == null ? null : ServerAddress.Text(url);
        Save();
        Moved?.Invoke();
    }

    /// <summary>The copy was just made or forgotten: the window loads again, on it or on the sign-in.</summary>
    public static void Reload() => Moved?.Invoke();

    // ---- this PC's own settings -----------------------------------------------------------

    public static HotKey QuickEntryKey
    {
        get => HotKey.Parse(settings.QuickEntryKey) ?? HotKey.Default;
        set { settings.QuickEntryKey = value.ToString(); Save(); }
    }

    /// <summary>The shortcut a notification last said another app holds: said once for it, not at every start.</summary>
    public static string? ShortcutTakenTold
    {
        get => settings.ShortcutTakenTold;
        set
        {
            if (settings.ShortcutTakenTold == value) return;
            settings.ShortcutTakenTold = value;
            Save();
        }
    }

    public static bool RemindersOn
    {
        get => settings.Reminders;
        set { settings.Reminders = value; Save(); }
    }

    public static int[]? WindowPlace
    {
        get => settings.Window;
        set { settings.Window = value; Save(); }
    }
}
