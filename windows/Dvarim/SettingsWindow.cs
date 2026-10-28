using System.Diagnostics;
using System.Runtime.InteropServices;
using Dvarim.Core;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using Windows.Storage.Pickers;
using Windows.System;
using Windows.UI.Core;
using WinRT.Interop;

namespace Dvarim;

/// <summary>
/// Dvarim's own settings: what belongs to this PC rather than to the to-dos, so the
/// page can't change it (a page served by a server is the wrong place to change which
/// server). Where the to-dos live and which server, Quick Entry's shortcut, starting
/// with Windows, reminders. The page's Settings › Data links here (dvarim://settings),
/// and so does the notification area's menu. Android's is SettingsActivity, the Mac's
/// Settings › This Mac and Where.
/// </summary>
sealed class SettingsWindow
{
    static SettingsWindow? open;
    public static bool IsOpen => open != null;

    readonly Window window;
    readonly IntPtr handle;
    readonly RadioButtons where = new();
    readonly TextBlock whereNote = new() { TextWrapping = TextWrapping.Wrap, Opacity = 0.75 };
    readonly TextBox server = new() { Header = "Server", PlaceholderText = ServerAddress.BuiltIn };
    readonly TextBlock serverNote = new() { TextWrapping = TextWrapping.Wrap, Opacity = 0.75 };
    readonly Button shortcut = new() { MinWidth = 160 };
    readonly TextBlock shortcutNote = new() { TextWrapping = TextWrapping.Wrap, Opacity = 0.75 };
    bool updating, listening;

    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    public static void ShowIt()
    {
        open ??= new SettingsWindow();
        open.window.Activate();
        SetForegroundWindow(open.handle);
    }

    /// <summary>For the self-test.</summary>
    public static void CloseIt() => open?.window.Close();

    SettingsWindow()
    {
        window = new Window { Title = "App Settings - Dvarim" };
        handle = WindowNative.GetWindowHandle(window);
        window.SystemBackdrop = new MicaBackdrop();
        var icon = Path.Join(AppContext.BaseDirectory, "Assets", "Dvarim.ico");
        if (File.Exists(icon)) window.AppWindow.SetIcon(icon);
        var scale = GetDpiForWindow(handle) / 96.0;
        var size = new SizeInt32((int)(600 * scale), (int)(760 * scale));
        var area = DisplayArea.GetFromWindowId(window.AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        window.AppWindow.MoveAndResize(new RectInt32(area.X + Math.Max(0, (area.Width - size.Width) / 2), area.Y + Math.Max(0, (area.Height - size.Height) / 2),
            size.Width, Math.Min(size.Height, area.Height)));
        window.Closed += (_, _) =>
        {
            if (listening) Tray.ResumeHotKey();
            Vault.Moved -= Fill;
            open = null;
        };
        window.Content = new ScrollViewer { Content = Build() };
        Vault.Moved += Fill;
        Fill();
    }

    static TextBlock Heading(string text) =>
        new() { Text = text, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], Margin = new Thickness(0, 12, 0, 0) };

    UIElement Build()
    {
        var page = new StackPanel { Padding = new Thickness(28, 20, 28, 28), Spacing = 12, MaxWidth = 640 };

        // ---- where the to-dos live
        page.Children.Add(Heading("Where your to-dos live"));
        where.Items.Add("On this PC, synced with the server");
        where.Items.Add("On the server only");
        where.Items.Add("In a folder on this PC");
        where.SelectionChanged += async (_, _) => await Choose(where.SelectedIndex);
        page.Children.Add(where);
        page.Children.Add(whereNote);
        var folder = new Button { Content = "Choose a folder…" };
        folder.Click += async (_, _) =>
        {
            if (await PickFolder() is { } chosen) Vault.UseFolder(chosen);
        };
        page.Children.Add(folder);

        // ---- the server
        var use = new Button { Content = "Use this server" };
        use.Click += (_, _) =>
        {
            if (ServerAddress.Parse(server.Text) is not { } url)
            {
                serverNote.Text = "That isn't a server's address. Type it whole, like dvarim.example.com, or https://… (plain http only to this PC, the local network or the tailnet).";
                return;
            }
            if (!ServerAddress.SameOrigin(url, Vault.Server)) Vault.SetServer(url);
        };
        var test = new Button { Content = "Test" };
        test.Click += async (_, _) => serverNote.Text = await Test(server.Text);
        var builtIn = new HyperlinkButton { Content = "Use the built-in address" };
        builtIn.Click += (_, _) => Vault.SetServer(null);
        var serverButtons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        serverButtons.Children.Add(use);
        serverButtons.Children.Add(test);
        serverButtons.Children.Add(builtIn);
        page.Children.Add(server);
        page.Children.Add(serverButtons);
        page.Children.Add(serverNote);

        // ---- this PC
        page.Children.Add(Heading("This PC"));
        page.Children.Add(new TextBlock { Text = "Quick Entry opens over any app with this shortcut. Click it, then press the one you want; it needs Ctrl, Alt or the Windows key.", TextWrapping = TextWrapping.Wrap });
        shortcut.Click += (_, _) => Listen(true);
        shortcut.PreviewKeyDown += TakeShortcut;
        shortcut.LostFocus += (_, _) => Listen(false);
        page.Children.Add(shortcut);
        page.Children.Add(shortcutNote);

        var startup = new ToggleSwitch { Header = "Start Dvarim when I sign in to Windows", IsOn = Startup.On };
        startup.Toggled += (_, _) => Startup.On = startup.IsOn;
        page.Children.Add(startup);

        var remind = new ToggleSwitch { Header = "Remind me on this PC", IsOn = Vault.RemindersOn };
        remind.Toggled += (_, _) => Vault.RemindersOn = remind.IsOn;
        page.Children.Add(remind);
        var testReminder = new Button { Content = "Send a test reminder" };
        testReminder.Click += (_, _) => Notifications.Test();
        page.Children.Add(testReminder);
        page.Children.Add(new TextBlock
        {
            Text = "Reminders arrive while Dvarim is running, in the notification area; starting with Windows keeps it there. "
                + "Windows' own notification settings and Do not disturb can hold them back. If the server already sends you reminders over Signal, turn one of them off.",
            TextWrapping = TextWrapping.Wrap, Opacity = 0.75,
        });

        // ---- about
        page.Children.Add(Heading("About"));
        page.Children.Add(new TextBlock { Text = $"Dvarim for Windows {App.Version}", IsTextSelectionEnabled = true });
        page.Children.Add(new TextBlock { Text = $"Settings, the copy and dvarim.log are in {App.DataDir}.", TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Opacity = 0.75 });
        var reveal = new HyperlinkButton { Content = "Open that folder" };
        reveal.Click += (_, _) => Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { App.DataDir }, UseShellExecute = false });
        page.Children.Add(reveal);
        return page;
    }

    /// <summary>Everything shown as it is now: after a choice here, or the page's.</summary>
    void Fill()
    {
        updating = true;
        where.SelectedIndex = Vault.Mode switch { "server" => 1, "folder" => 2, _ => 0 };
        updating = false;
        var copy = Vault.Mode == "copy" ? Vault.Copy : null;
        whereNote.Text = Vault.Mode switch
        {
            "folder" => Vault.Folder is { } f ? $"The folder {f}. Dvarim reads and writes it itself, and hears when Obsidian, Syncthing or OneDrive change it."
                : "No folder yet: choose one.",
            "server" => $"Every list is asked of {Vault.Server.Host} as you open it, and kept for when there's no network.",
            _ => copy != null
                ? $"A copy on this PC, synced with {Vault.Server.Host} a moment after each change, when the window comes back, and every few minutes. "
                  + $"This PC is “{copy.Device}” on the server{(copy.Who == "owner" ? "" : $", for {copy.Who}")}. Sign out in Dvarim's own Settings › Account."
                : $"Sign in to {Vault.Server.Host} in Dvarim's window, and Dvarim sets the copy up.",
        };
        server.Text = ServerAddress.Text(Vault.Server);
        serverNote.Text = Vault.ServerIsBuiltIn ? "The address Dvarim was built for." : "";
        ShowShortcut();
    }

    async Task Choose(int index)
    {
        if (updating || index < 0) return;
        switch (index)
        {
            case 0 when Vault.Mode != "copy": Vault.UseCopy(); break;
            case 1 when Vault.Mode != "server": Vault.UseServer(); break;
            case 2 when Vault.Mode != "folder":
                if (Vault.ChosenFolder is { } before && Directory.Exists(before)) Vault.UseFolder(before);
                else if (await PickFolder() is { } chosen) Vault.UseFolder(chosen);
                else Fill();                         // no folder: as it was
                break;
        }
    }

    async Task<string?> PickFolder()
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary, CommitButtonText = "Use This Folder" };
        picker.FileTypeFilter.Add("*");
        InitializeWithWindow.Initialize(picker, handle);
        var chosen = await picker.PickSingleFolderAsync();
        if (chosen == null) return null;
        if (string.IsNullOrEmpty(chosen.Path))
        {
            whereNote.Text = "That place isn't a folder Dvarim can read and write directly. Choose one on a drive, in OneDrive, or in Syncthing's folders.";
            return null;
        }
        return chosen.Path;
    }

    /// <summary>Is a Dvarim answering there? /api/health needs no sign-in, so a wrong answer means a wrong address.</summary>
    static async Task<string> Test(string typed)
    {
        if (ServerAddress.Parse(typed) is not { } url) return "That isn't a server's address.";
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var text = await client.GetStringAsync(new Uri(url, "/api/health"));
            return text.Contains("\"ok\"", StringComparison.Ordinal) ? $"Dvarim answers at {url.Host}." : $"Something answers at {url.Host}, but not a Dvarim.";
        }
        catch (Exception e)
        {
            return $"No answer from {url.Host}: {e.Message}";
        }
    }

    // ---- Quick Entry's shortcut ------------------------------------------------------------

    void ShowShortcut()
    {
        if (listening) return;
        var key = Vault.QuickEntryKey;
        shortcut.Content = key.ToString();
        shortcutNote.Text = Tray.Registered == key ? "" : $"Another app already uses {key}: Quick Entry is in the notification area's menu until you choose another.";
    }

    void Listen(bool on)
    {
        if (on == listening) return;
        listening = on;
        if (on)
        {
            // the shortcut in use mustn't catch the new one first
            Tray.PauseHotKey();
            shortcut.Content = "Press the new shortcut…";
            shortcutNote.Text = "Escape keeps the one you had.";
        }
        else
        {
            Tray.ResumeHotKey();
            ShowShortcut();
        }
    }

    void TakeShortcut(object sender, KeyRoutedEventArgs e)
    {
        if (!listening) return;
        e.Handled = true;
        if (e.Key == VirtualKey.Escape)
        {
            Listen(false);
            return;
        }
        // the modifiers alone are the start of a shortcut, not one
        if (e.Key is VirtualKey.Control or VirtualKey.Menu or VirtualKey.Shift or VirtualKey.LeftWindows or VirtualKey.RightWindows
            or VirtualKey.LeftControl or VirtualKey.RightControl or VirtualKey.LeftMenu or VirtualKey.RightMenu or VirtualKey.LeftShift or VirtualKey.RightShift) return;
        static bool Down(VirtualKey k) => InputKeyboardSource.GetKeyStateForCurrentThread(k).HasFlag(CoreVirtualKeyStates.Down);
        uint modifiers = 0;
        if (Down(VirtualKey.Control)) modifiers |= HotKey.Control;
        if (Down(VirtualKey.Menu)) modifiers |= HotKey.Alt;
        if (Down(VirtualKey.Shift)) modifiers |= HotKey.Shift;
        if (Down(VirtualKey.LeftWindows) || Down(VirtualKey.RightWindows)) modifiers |= HotKey.Win;
        var key = new HotKey(modifiers, (uint)e.Key);
        if (!key.IsUsable)
        {
            shortcutNote.Text = $"{key} won't do: a shortcut needs Ctrl, Alt or the Windows key, and a letter, a digit, Space or F1 to F12.";
            return;
        }
        listening = false;
        if (Tray.SetHotKey(key))
        {
            Vault.QuickEntryKey = key;
            ShowShortcut();
        }
        else
        {
            Tray.ResumeHotKey();
            ShowShortcut();
            shortcutNote.Text = $"Another app already uses {key}. Quick Entry stays on {Vault.QuickEntryKey}.";
        }
    }
}
