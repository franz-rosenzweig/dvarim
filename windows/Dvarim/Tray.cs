using System.Runtime.InteropServices;
using Dvarim.Core;

namespace Dvarim;

/// <summary>
/// Dvarim in the notification area, as the Mac's is in the menu bar: today's count
/// under the pointer, a click for Today (TodayWindow), a right-click for the rest.
/// Its window, never shown, also takes Quick Entry's shortcut from anywhere
/// (RegisterHotKey) and hears Windows ending the session. Win32, since WinUI has no
/// notification area of its own; on the windows' thread, whose message loop runs it.
/// </summary>
static class Tray
{
    delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass
    {
        public uint Size;
        public uint Style;
        public IntPtr Proc;
        public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background;
        public string? MenuName;
        public string ClassName;
        public IntPtr SmallIcon;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct NotifyIconData
    {
        public uint Size;
        public IntPtr Window;
        public uint Id;
        public uint Flags;
        public uint CallbackMessage;
        public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint TimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags;
        public Guid Item;
        public IntPtr BalloonIcon;
    }

    [DllImport("user32.dll", EntryPoint = "RegisterClassExW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern ushort RegisterClassEx(ref WindowClass windowClass);

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowEx(uint exStyle, string className, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")]
    static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool DestroyWindow(IntPtr window);

    [DllImport("kernel32.dll", EntryPoint = "GetModuleHandleW", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string? name);

    [DllImport("user32.dll", EntryPoint = "RegisterWindowMessageW", CharSet = CharSet.Unicode)]
    static extern uint RegisterWindowMessage(string name);

    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", CharSet = CharSet.Unicode)]
    static extern bool Shell_NotifyIcon(uint message, ref NotifyIconData data);

    [DllImport("user32.dll", EntryPoint = "LoadImageW", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);

    [DllImport("user32.dll", EntryPoint = "LoadIconW")]
    static extern IntPtr LoadIcon(IntPtr instance, IntPtr name);

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll")]
    static extern uint GetDpiForSystem();

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr window, int id);

    [DllImport("user32.dll")]
    static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", EntryPoint = "AppendMenuW", CharSet = CharSet.Unicode)]
    static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string? text);

    [DllImport("user32.dll")]
    static extern int TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr window, IntPtr parameters);

    [DllImport("user32.dll")]
    static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    const uint WM_NULL = 0x0000, WM_QUERYENDSESSION = 0x0011, WM_ENDSESSION = 0x0016, WM_CONTEXTMENU = 0x007B, WM_HOTKEY = 0x0312;
    const uint WM_APP = 0x8000, Callback = WM_APP + 1;
    const uint NIN_SELECT = 0x0400, NIN_KEYSELECT = 0x0401;
    const uint NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2, NIM_SETVERSION = 4, NOTIFYICON_VERSION_4 = 4;
    const uint NIF_MESSAGE = 0x1, NIF_ICON = 0x2, NIF_TIP = 0x4, NIF_SHOWTIP = 0x80;
    const uint WS_POPUP = 0x80000000;
    const uint MF_STRING = 0x0, MF_SEPARATOR = 0x800;
    const uint TPM_RIGHTBUTTON = 0x2, TPM_NONOTIFY = 0x80, TPM_RETURNCMD = 0x100;
    const uint IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10;
    const int SM_CXSMICON = 49, SM_CYSMICON = 50;
    const uint MOD_NOREPEAT = 0x4000;
    const int HotKeyId = 1;
    const int OpenItem = 1, QuickEntryItem = 2, SettingsItem = 3, QuitItem = 4;

    static WindowProc? proc;             // held here, or the collector takes it out from under Windows
    static IntPtr window, icon;
    static uint taskbarCreated;
    static bool added;
    static HotKey? registered;

    /// <summary>Whether the icon is in the notification area, for the self-test.</summary>
    public static bool Shown => added;

    /// <summary>The tip under the pointer, for the self-test.</summary>
    public static string Tip { get; private set; } = "Dvarim";

    public static void Start()
    {
        var instance = GetModuleHandle(null);
        proc = Proc;
        var windowClass = new WindowClass
        {
            Size = (uint)Marshal.SizeOf<WindowClass>(),
            Proc = Marshal.GetFunctionPointerForDelegate(proc),
            Instance = instance,
            ClassName = "Dvarim.Tray",
        };
        if (RegisterClassEx(ref windowClass) == 0) Log.Write($"tray: no window class ({Marshal.GetLastPInvokeError()})");
        // a top-level window, never shown: a message-only one never hears that Explorer restarted
        window = CreateWindowEx(0, windowClass.ClassName, "Dvarim", WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (window == IntPtr.Zero)
        {
            Log.Write($"tray: no window ({Marshal.GetLastPInvokeError()})");
            return;
        }
        taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        icon = LoadTrayIcon();
        Add();
        SetHotKey(Vault.QuickEntryKey);
        Startup.Refresh();
        TodayList.Updated += Update;
        App.VaultChanged += () => _ = TodayList.Refresh();
    }

    public static void Stop()
    {
        if (window == IntPtr.Zero) return;
        if (added)
        {
            var data = Data(0);
            Shell_NotifyIcon(NIM_DELETE, ref data);
            added = false;
        }
        UnregisterHotKey(window, HotKeyId);
        DestroyWindow(window);
        window = IntPtr.Zero;
        if (icon != IntPtr.Zero) DestroyIcon(icon);
    }

    static IntPtr LoadTrayIcon()
    {
        var dpi = GetDpiForSystem();
        var path = Path.Join(AppContext.BaseDirectory, "Assets", "Dvarim.ico");
        var loaded = File.Exists(path)
            ? LoadImage(IntPtr.Zero, path, IMAGE_ICON, GetSystemMetricsForDpi(SM_CXSMICON, dpi), GetSystemMetricsForDpi(SM_CYSMICON, dpi), LR_LOADFROMFILE)
            : IntPtr.Zero;
        return loaded != IntPtr.Zero ? loaded : LoadIcon(IntPtr.Zero, new IntPtr(32512));      // IDI_APPLICATION
    }

    static NotifyIconData Data(uint flags) => new()
    {
        Size = (uint)Marshal.SizeOf<NotifyIconData>(),
        Window = window,
        Id = 1,
        Flags = flags,
        CallbackMessage = Callback,
        Icon = icon,
        Tip = Tip,
        Info = "",
        InfoTitle = "",
    };

    static void Add()
    {
        var data = Data(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
        added = Shell_NotifyIcon(NIM_ADD, ref data);
        if (!added)
        {
            Log.Write("tray: the notification area didn't take the icon");
            return;
        }
        data.TimeoutOrVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIcon(NIM_SETVERSION, ref data);
    }

    /// <summary>Today's count under the pointer, as the Mac's beside the clock.</summary>
    static void Update()
    {
        var open = TodayList.OpenCount;
        Tip = TodayList.Problem != null ? "Dvarim" : open switch
        {
            0 => "Dvarim · nothing left for today",
            1 => "Dvarim · 1 to-do today",
            _ => $"Dvarim · {open} to-dos today",
        };
        if (!added) return;
        var data = Data(NIF_TIP | NIF_SHOWTIP);
        Shell_NotifyIcon(NIM_MODIFY, ref data);
    }

    // ---- Quick Entry's shortcut ----------------------------------------------------------

    /// <summary>Take this shortcut for Quick Entry, from any app. False if another app has it, keeping the one before.</summary>
    public static bool SetHotKey(HotKey key)
    {
        if (window == IntPtr.Zero) return false;
        UnregisterHotKey(window, HotKeyId);
        if (RegisterHotKey(window, HotKeyId, key.Modifiers | MOD_NOREPEAT, key.Key))
        {
            registered = key;
            return true;
        }
        Log.Write($"Quick Entry: {key} is taken ({Marshal.GetLastPInvokeError()})");
        if (registered is { } before && before != key) RegisterHotKey(window, HotKeyId, before.Modifiers | MOD_NOREPEAT, before.Key);
        else registered = null;
        return false;
    }

    /// <summary>While Settings listens for a new shortcut, the old one mustn't catch it first.</summary>
    public static void PauseHotKey()
    {
        if (window != IntPtr.Zero) UnregisterHotKey(window, HotKeyId);
    }

    public static void ResumeHotKey()
    {
        if (registered is { } key && window != IntPtr.Zero) RegisterHotKey(window, HotKeyId, key.Modifiers | MOD_NOREPEAT, key.Key);
    }

    /// <summary>The shortcut Quick Entry answers to, or null when another app holds it.</summary>
    public static HotKey? Registered => registered;

    // ---- the window's messages ------------------------------------------------------------

    static IntPtr Proc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (message == Callback)
            {
                // version 4: the event in the low word, and where the icon is in wParam
                var what = (uint)(lParam.ToInt64() & 0xFFFF);
                var x = (short)(wParam.ToInt64() & 0xFFFF);
                var y = (short)((wParam.ToInt64() >> 16) & 0xFFFF);
                if (what is NIN_SELECT or NIN_KEYSELECT) TodayWindow.Toggle(x, y);
                else if (what == WM_CONTEXTMENU) Menu(x, y);
                return IntPtr.Zero;
            }
            if (message == WM_HOTKEY && wParam.ToInt64() == HotKeyId)
            {
                QuickEntry.Toggle();
                return IntPtr.Zero;
            }
            if (message == taskbarCreated && taskbarCreated != 0)
            {
                Add();                                        // Explorer started again: the icon again
                return IntPtr.Zero;
            }
            if (message == WM_QUERYENDSESSION) return new IntPtr(1);
            if (message == WM_ENDSESSION)
            {
                if (wParam != IntPtr.Zero) App.Quit();       // signing out, a restart, or an installer updating Dvarim
                return IntPtr.Zero;
            }
        }
        catch (Exception e)
        {
            Log.Write($"tray: {e}");
        }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    static void Menu(int x, int y)
    {
        var menu = CreatePopupMenu();
        AppendMenu(menu, MF_STRING, OpenItem, "Open Dvarim");
        AppendMenu(menu, MF_STRING, QuickEntryItem, registered is { } key ? $"Quick Entry\t{key}" : "Quick Entry");
        AppendMenu(menu, MF_SEPARATOR, 0, null);
        AppendMenu(menu, MF_STRING, SettingsItem, "Settings…");
        AppendMenu(menu, MF_SEPARATOR, 0, null);
        AppendMenu(menu, MF_STRING, QuitItem, "Quit Dvarim");
        // or the menu stays up when you click elsewhere
        SetForegroundWindow(window);
        var chosen = TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_NONOTIFY | TPM_RETURNCMD, x, y, window, IntPtr.Zero);
        PostMessage(window, WM_NULL, IntPtr.Zero, IntPtr.Zero);
        DestroyMenu(menu);
        switch (chosen)
        {
            case OpenItem: App.Main.ShowWindow(); break;
            case QuickEntryItem: QuickEntry.Shared.Show(); break;
            case SettingsItem: SettingsWindow.ShowIt(); break;
            case QuitItem: App.Quit(); break;
        }
    }

    static bool AppendMenu(IntPtr menu, uint flags, int id, string? text) => AppendMenu(menu, flags, (UIntPtr)(uint)id, text);
}
