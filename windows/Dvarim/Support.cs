using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace Dvarim;

/// <summary>
/// The command line: nothing, for a person; --background when Windows starts Dvarim
/// at sign-in (the window stays put away); the self-test's switches for
/// windows/selftest.ps1.
/// </summary>
public sealed record Options(bool SelfTest, bool Background, string? Data, string? Folder, bool Copy, string? Server, string? Out, bool DevTools)
{
    public static Options Parse(string[] args)
    {
        string? Value(string name)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
        return new(args.Contains("--selftest"), args.Contains("--background"), Value("--data"), Value("--folder"), args.Contains("--copy"),
            Value("--server"), Value("--out"), args.Contains("--devtools"));
    }
}

/// <summary>dvarim.log, beside the settings: what went wrong where nobody saw it.</summary>
static class Log
{
    static readonly object Gate = new();

    public static void Write(string line)
    {
        System.Diagnostics.Debug.WriteLine(line);
        try
        {
            lock (Gate) File.AppendAllText(Path.Join(App.DataDir, "dvarim.log"), $"{DateTime.Now:O} {line}{Environment.NewLine}");
        }
        catch (Exception) { }
    }
}

/// <summary>The browser, for anything that is not the app. The self-test only notes it.</summary>
static class Outside
{
    public static readonly List<Uri> Opened = [];

    public static void Open(Uri url)
    {
        Opened.Add(url);
        if (!App.Options.SelfTest) _ = Windows.System.Launcher.LaunchUriAsync(url);
    }
}

/// <summary>
/// Starting with Windows: a value under HKCU\…\Run that opens Dvarim put away in the
/// notification area, so reminders arrive and Quick Entry answers from the moment
/// you sign in. The installer sets it when its box is ticked; Settings turns it on
/// and off. The value itself is the setting.
/// </summary>
static class Startup
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "Dvarim";

    static string Command => $"\"{Environment.ProcessPath}\" --background";

    public static bool On
    {
        get
        {
            try { return Registry.CurrentUser.OpenSubKey(Key)?.GetValue(Name) is string; }
            catch (Exception) { return false; }
        }
        set
        {
            if (App.Options.SelfTest) return;
            try
            {
                using var run = Registry.CurrentUser.CreateSubKey(Key);
                if (value) run.SetValue(Name, Command);
                else run.DeleteValue(Name, throwOnMissingValue: false);
            }
            catch (Exception e) { Log.Write($"starting with Windows: {e.Message}"); }
        }
    }

    /// <summary>Dvarim moved (a portable copy unzipped elsewhere, an update): the value follows it.</summary>
    public static void Refresh()
    {
        if (On && !App.Options.SelfTest) On = true;
    }
}

/// <summary>Windows 11's look for the small windows: rounded corners, and Win32 menus that follow the light or dark theme.</summary>
static class Look
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    // uxtheme's unnamed exports, which Windows' own apps and Notepad++ use for dark menus (Windows 10 1903 and later)
    [DllImport("uxtheme.dll", EntryPoint = "#135")]
    static extern int SetPreferredAppMode(int mode);

    [DllImport("uxtheme.dll", EntryPoint = "#133")]
    static extern bool AllowDarkModeForWindow(IntPtr window, bool allow);

    [DllImport("uxtheme.dll", EntryPoint = "#104")]
    static extern void RefreshImmersiveColorPolicyState();

    [DllImport("uxtheme.dll", EntryPoint = "#136")]
    static extern void FlushMenuThemes();

    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2;

    /// <summary>Rounded corners, as Windows 11's flyouts have; nothing on Windows 10.</summary>
    public static void Round(IntPtr window)
    {
        var round = DWMWCP_ROUND;
        _ = DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
    }

    /// <summary>The notification area's menu in the theme Windows is in, light or dark, rather than always light.</summary>
    public static void ThemedMenus(IntPtr owner)
    {
        try
        {
            SetPreferredAppMode(1);                  // AllowDark: follow the system
            AllowDarkModeForWindow(owner, true);
            RefreshImmersiveColorPolicyState();
            FlushMenuThemes();
        }
        catch (Exception e) { Log.Write($"menus' theme: {e.Message}"); }
    }

    /// <summary>The theme changed: the menus' with it.</summary>
    public static void ThemeChanged()
    {
        try
        {
            RefreshImmersiveColorPolicyState();
            FlushMenuThemes();
        }
        catch (Exception) { }
    }
}

/// <summary>The little JSON the window and the page pass each other.</summary>
static class J
{
    public static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue(out string? s) ? s : null;

    public static int Int(JsonNode? node) =>
        node is JsonValue v ? (v.TryGetValue(out int i) ? i : v.TryGetValue(out double d) ? (int)d : 0) : 0;

    public static bool Bool(JsonNode? node) => node is JsonValue v && v.TryGetValue(out bool b) && b;

    public static JsonObject Ok(JsonNode? value) => new() { ["ok"] = value };

    /// <summary>A string as a JavaScript (and JSON) literal.</summary>
    public static string Quote(string s) => JsonValue.Create(s)!.ToJsonString();
}

sealed class ShellError(string message) : Exception(message);
