using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

namespace Dvarim;

/// <summary>
/// The menus in the title bar, the set a Windows app has: File, Edit, To-Do (what
/// the Mac app's Items menu holds: everything you can do to the chosen to-dos),
/// View and Help. Alt and a menu's letter opens it, as anywhere in Windows. Each
/// item runs the page's own command by its id (window.dvarim.run, lib/shell.js),
/// so a key rebound in Settings › Keyboard still runs from the menu; the keys the
/// items show come from window.dvarim.commands() when a menu is pressed open, so
/// they are the ones in force. Cut, Copy, Paste, Select All and Undo press their
/// keys in the page instead, so they do just what the keys do, in a text field too.
/// </summary>
sealed class Menus
{
    readonly ShellWindow owner;
    readonly MenuBar bar;
    readonly List<(MenuFlyoutItem Item, string Command)> pageItems = [];
    MenuFlyoutItem? quickEntry;

    public Menus(ShellWindow owner, MenuBar bar)
    {
        this.owner = owner;
        this.bar = bar;
        Build();
        foreach (var top in bar.Items)
            top.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, _) => Refresh()), handledEventsToo: true);
        // Escape on the menu bar itself: back to the page, as from any title bar
        bar.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) => { if (e.Key == VirtualKey.Escape) owner.FocusPage(); }), handledEventsToo: true);
    }

    /// <summary>Each item's key as the page has it now (Settings › Keyboard can rebind any), and Quick Entry's.</summary>
    public async void Refresh()
    {
        if (quickEntry != null) quickEntry.KeyboardAcceleratorTextOverride = Tray.Registered?.ToString() ?? "";
        JsonArray? commands;
        try { commands = await owner.Commands(); }
        catch (Exception) { return; }
        if (commands == null) return;
        var keys = commands.OfType<JsonObject>().ToDictionary(c => J.Text(c["id"]) ?? "", c => J.Text(c["combo"]));
        foreach (var (item, command) in pageItems)
            if (keys.TryGetValue(command, out var combo)) item.KeyboardAcceleratorTextOverride = Label(combo);
    }

    /// <summary>"Mod+Shift+T" as Windows writes it: Ctrl+Shift+T.</summary>
    public static string Label(string? combo)
    {
        if (string.IsNullOrEmpty(combo)) return "";
        var parts = combo.Split('+');
        var key = parts[^1].ToLowerInvariant() switch
        {
            "arrowup" => "Up", "arrowdown" => "Down", "arrowleft" => "Left", "arrowright" => "Right",
            "escape" => "Esc", "delete" => "Del", "backspace" => "Backspace", "enter" => "Enter", "space" => "Space",
            "" => "+",
            var k when k.Length == 1 => k.ToUpperInvariant(),
            var k => char.ToUpperInvariant(k[0]) + k[1..],
        };
        var mods = parts[..^1];
        return string.Join('+', new[] { mods.Contains("Mod") ? "Ctrl" : null, mods.Contains("Alt") ? "Alt" : null, mods.Contains("Shift") ? "Shift" : null, key }.OfType<string>());
    }

    /// <summary>Alt and a letter (F, E, T, V, H) opens that menu; Alt alone puts the keyboard on the menu bar.</summary>
    public void Open(string? letter)
    {
        if (letter == null)
        {
            bar.Items.FirstOrDefault()?.Focus(FocusState.Keyboard);
            return;
        }
        var top = bar.Items.FirstOrDefault(m => string.Equals(m.AccessKey, letter, StringComparison.OrdinalIgnoreCase));
        if (top == null) return;
        Refresh();
        top.Focus(FocusState.Keyboard);
        if (FrameworkElementAutomationPeer.CreatePeerForElement(top) is IExpandCollapseProvider menu) menu.Expand();
    }

    void Build()
    {
        // ---- File
        var file = Top("File", "F");
        Page(file, "New To-Do", "todo.new");
        Page(file, "New Heading", "heading.new");
        Page(file, "New Project", "project.new");
        quickEntry = Shell(file, "Quick Entry…", () => QuickEntry.Shared.Show());
        Line(file);
        Page(file, "Log Completed Items", "log.now");
        Line(file);
        Page(file, "Settings", "settings.open");
        Shell(file, "App Settings…", SettingsWindow.ShowIt);
        Line(file);
        Shell(file, "Close Window", owner.HideWindow, "Ctrl+W");
        Shell(file, "Quit Dvarim", App.Quit);

        // ---- Edit
        var edit = Top("Edit", "E");
        Native(edit, "Undo", "Ctrl+Z", "z", 0x5A);
        Line(edit);
        Native(edit, "Cut", "Ctrl+X", "x", 0x58);
        Native(edit, "Copy", "Ctrl+C", "c", 0x43);
        Native(edit, "Paste", "Ctrl+V", "v", 0x56);
        Native(edit, "Select All", "Ctrl+A", "a", 0x41);
        Line(edit);
        Page(edit, "Quick Find…", "find");
        Page(edit, "Duplicate", "todo.duplicate");
        Page(edit, "Move to Trash", "todo.trash");

        // ---- To-Do: the Mac's Items menu
        var todo = Top("To-Do", "T");
        Page(todo, "Open", "todo.open");
        Page(todo, "Complete", "todo.complete");
        Page(todo, "Cancel", "todo.cancel");
        Line(todo);
        Page(todo, "When…", "todo.when");
        Page(todo, "Today", "todo.today");
        Page(todo, "This Evening", "todo.evening");
        Page(todo, "Anytime", "todo.anytime");
        Page(todo, "Someday", "todo.someday");
        Page(todo, "Deadline…", "todo.deadline");
        Line(todo);
        Page(todo, "Move…", "todo.move");
        Page(todo, "Tags…", "todo.tags");
        Page(todo, "Checklist", "todo.checklist");
        Page(todo, "Repeat…", "todo.repeat");
        Page(todo, "Convert to Project", "todo.convert");
        Line(todo);
        Page(todo, "Move Up", "todo.moveUp");
        Page(todo, "Move Down", "todo.moveDown");

        // ---- View: the lists, and how the window shows them
        var view = Top("View", "V");
        Page(view, "Inbox", "go.inbox");
        Page(view, "Today", "go.today");
        Page(view, "Upcoming", "go.upcoming");
        Page(view, "Anytime", "go.anytime");
        Page(view, "Someday", "go.someday");
        Page(view, "Logbook", "go.logbook");
        Line(view);
        Page(view, "Show or Hide the Sidebar", "sidebar.toggle");
        var size = Sub(view, "Text Size");
        Shell(size.Items, "Bigger", () => owner.TextSize(1), "Ctrl+Plus");
        Shell(size.Items, "Smaller", () => owner.TextSize(-1), "Ctrl+Minus");
        Shell(size.Items, "Usual Size", () => owner.TextSize(0), "Ctrl+0");
        Line(view);
        Shell(view, "Full Screen", owner.ToggleFullScreen, "F11");

        // ---- Help
        var help = Top("Help", "H");
        Shell(help, "Dvarim Help", () => Outside.Open(new Uri("https://github.com/franz-rosenzweig/dvarim/blob/master/docs/README.md")));
        Shell(help, "The Windows App", () => Outside.Open(new Uri("https://github.com/franz-rosenzweig/dvarim/blob/master/docs/windows.md")));
        Line(help);
        Shell(help, "About Dvarim", async () => await owner.Tell("Dvarim", $"Version {App.Version}, for Windows.\nhttps://github.com/franz-rosenzweig/dvarim"));
    }

    // ---- the kinds of item -----------------------------------------------------------------

    IList<MenuFlyoutItemBase> Top(string title, string accessKey)
    {
        var menu = new MenuBarItem { Title = title, AccessKey = accessKey };
        bar.Items.Add(menu);
        return menu.Items;
    }

    static MenuFlyoutSubItem Sub(IList<MenuFlyoutItemBase> into, string text)
    {
        var sub = new MenuFlyoutSubItem { Text = text };
        into.Add(sub);
        return sub;
    }

    static void Line(IList<MenuFlyoutItemBase> into) => into.Add(new MenuFlyoutSeparator());

    /// <summary>An item that runs one of the page's commands by its id; its key comes from the page (Refresh).</summary>
    void Page(IList<MenuFlyoutItemBase> into, string text, string command)
    {
        var item = new MenuFlyoutItem { Text = text, KeyboardAcceleratorTextOverride = Label(Default(command)) };
        item.Click += (_, _) => owner.Run(command);
        into.Add(item);
        pageItems.Add((item, command));
    }

    /// <summary>An item that presses its key in the page (Undo, Cut, Copy, Paste, Select All): what the key does, it does.</summary>
    void Native(IList<MenuFlyoutItemBase> into, string text, string key, string letter, int virtualKey)
    {
        var item = new MenuFlyoutItem { Text = text, KeyboardAcceleratorTextOverride = key };
        item.Click += (_, _) => owner.Key(letter, "Key" + letter.ToUpperInvariant(), virtualKey, 2);
        into.Add(item);
    }

    /// <summary>An item that is the shell's own: Quick Entry, the app's settings, the window, help.</summary>
    MenuFlyoutItem Shell(IList<MenuFlyoutItemBase> into, string text, Action act, string? key = null)
    {
        var item = new MenuFlyoutItem { Text = text };
        if (key != null) item.KeyboardAcceleratorTextOverride = key;
        item.Click += (_, _) =>
        {
            owner.FocusPage();
            act();
        };
        into.Add(item);
        return item;
    }

    /// <summary>The page's own key for a command, until the page says otherwise (frontend/src/lib/keys.js).</summary>
    static string? Default(string command) => command switch
    {
        "go.inbox" => "Mod+1", "go.today" => "Mod+2", "go.upcoming" => "Mod+3", "go.anytime" => "Mod+4", "go.someday" => "Mod+5", "go.logbook" => "Mod+6",
        "todo.new" => "Mod+N", "settings.open" => "Mod+,", "heading.new" => "Mod+Shift+N", "project.new" => "Mod+Alt+N",
        "todo.complete" => "Mod+K", "todo.cancel" => "Mod+Alt+K", "todo.when" => "Mod+S", "todo.today" => "Mod+T", "todo.evening" => "Mod+E",
        "todo.anytime" => "Mod+R", "todo.someday" => "Mod+O", "todo.deadline" => "Mod+Shift+D", "todo.move" => "Mod+Shift+M",
        "todo.tags" => "Mod+Shift+T", "todo.checklist" => "Mod+Shift+C", "todo.convert" => "Mod+Shift+P", "todo.repeat" => "Mod+Shift+R",
        "log.now" => "Mod+Shift+Y", "todo.duplicate" => "Mod+D", "find" => "Mod+F", "sidebar.toggle" => "Mod+/", "todo.open" => "Enter",
        "todo.moveUp" => "Mod+ArrowUp", "todo.moveDown" => "Mod+ArrowDown", "todo.trash" => "Backspace",
        _ => null,
    };

    /// <summary>The menus' titles, for the self-test.</summary>
    public IEnumerable<string> Titles => bar.Items.Select(m => m.Title);

    /// <summary>The key each page item shows, for the self-test.</summary>
    public string KeyOf(string command) => pageItems.FirstOrDefault(p => p.Command == command).Item?.KeyboardAcceleratorTextOverride ?? "";
}
