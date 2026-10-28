using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using Windows.System;
using Windows.UI.Core;
using WinRT.Interop;

namespace Dvarim;

/// <summary>
/// Quick Entry: a title and its notes, over whatever you are working in, from
/// Ctrl+Alt+Space (Settings changes it), gone again on Return or Escape, and the app
/// you were in has the keyboard back. The page reads the line as quick-add does
/// everywhere (POST /api/quick-add): a date phrase, !deadline, @reminder, #tags. The
/// Mac's is mac/Native/Shell/QuickEntry.swift.
/// </summary>
sealed class QuickEntry
{
    static QuickEntry? shared;
    public static QuickEntry Shared => shared ??= new QuickEntry();

    readonly Window window;
    readonly IntPtr handle;
    readonly TextBox title = new() { PlaceholderText = "New To-Do", FontSize = 18 };
    readonly TextBox notes = new() { PlaceholderText = "Notes", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 72 };
    readonly TextBlock hint = new() { FontSize = 12, Opacity = 0.7, TextWrapping = TextWrapping.Wrap };
    IntPtr returnTo;
    bool busy;

    const string Hint = "Return to save · Shift+Return for a new line in the notes · tomorrow 3pm · !friday for a deadline · @9am to be reminded · #tag";

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out PointInt32 point);

    public bool IsShown => window.AppWindow.IsVisible;

    public static void Toggle()
    {
        if (Shared.IsShown) Shared.Close();
        else Shared.Show();
    }

    QuickEntry()
    {
        window = new Window { Title = "Dvarim · Quick Entry" };
        handle = WindowNative.GetWindowHandle(window);
        window.SystemBackdrop = new DesktopAcrylicBackdrop();
        if (window.AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.SetBorderAndTitleBar(true, false);
            presenter.IsResizable = false;
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
            presenter.IsAlwaysOnTop = true;
        }
        window.AppWindow.IsShownInSwitchers = false;
        window.AppWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            Close();
        };

        var root = new StackPanel { Padding = new Thickness(18, 14, 18, 14), Spacing = 8 };
        root.Children.Add(title);
        root.Children.Add(notes);
        root.Children.Add(hint);
        window.Content = root;
        hint.Text = Hint;

        title.PreviewKeyDown += Keys;
        notes.PreviewKeyDown += Keys;
    }

    /// <summary>Return saves, from the notes too, where Shift+Return starts a new line; Escape closes without saving.</summary>
    void Keys(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Escape)
        {
            e.Handled = true;
            Close();
        }
        else if (e.Key == VirtualKey.Enter && !InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(CoreVirtualKeyStates.Down))
        {
            e.Handled = true;
            _ = Save();
        }
    }

    /// <summary>On the screen the pointer is on, a little above the middle, with the keyboard.</summary>
    public void Show(string text = "", string note = "")
    {
        var front = GetForegroundWindow();
        returnTo = front == handle || front == App.Main.Handle ? IntPtr.Zero : front;
        title.Text = text;
        notes.Text = note;
        hint.Text = Hint;
        busy = false;
        var scale = GetDpiForWindow(handle) / 96.0;
        var size = new SizeInt32((int)(560 * scale), (int)(196 * scale));
        GetCursorPos(out var pointer);
        var area = DisplayArea.GetFromPoint(pointer, DisplayAreaFallback.Primary).WorkArea;
        window.AppWindow.MoveAndResize(new RectInt32(area.X + (area.Width - size.Width) / 2, area.Y + (int)(area.Height * 0.28), size.Width, size.Height));
        window.Activate();
        SetForegroundWindow(handle);
        window.DispatcherQueue.TryEnqueue(() => title.Focus(FocusState.Programmatic));
    }

    /// <summary>Put away, and the keyboard back to the app you were in.</summary>
    public void Close()
    {
        window.AppWindow.Hide();
        if (returnTo != IntPtr.Zero) SetForegroundWindow(returnTo);
        returnTo = IntPtr.Zero;
    }

    async Task Save()
    {
        var line = title.Text.Trim();
        if (line.Length == 0 || busy) return;
        busy = true;
        title.IsEnabled = notes.IsEnabled = false;
        var (ok, problem) = await Add(line, notes.Text);
        title.IsEnabled = notes.IsEnabled = true;
        busy = false;
        if (ok)
        {
            title.Text = notes.Text = "";
            Close();
        }
        else
        {
            hint.Text = problem;
            title.Focus(FocusState.Programmatic);
        }
    }

    /// <summary>
    /// One line of quick entry, to the Inbox (or wherever its words say), through the
    /// page: on this PC's copy or folder it is saved at once, and the copy syncs it a
    /// moment later. With the server only and no network it can't be, and says so.
    /// </summary>
    public static async Task<(bool Ok, string Problem)> Add(string line, string? note)
    {
        var body = new JsonObject { ["text"] = line };
        if (!string.IsNullOrWhiteSpace(note)) body["notes"] = note.Trim();
        try
        {
            var (status, answer) = await App.Main.Ask("POST", "/api/quick-add", body, TimeSpan.FromSeconds(20));
            if (status is >= 200 and < 300) return (true, "");
            var why = J.Text(answer?["error"]) ?? $"the answer was {status}";
            return (false, status == 401 ? "Not saved: sign in, in Dvarim's window, first." : $"Not saved: {why}.");
        }
        catch (Exception e)
        {
            Log.Write($"quick entry: {e.Message}");
            return (false, Vault.UsesBridge ? "Not saved: Dvarim's page didn't answer. Try again in a moment." : "Not saved: the server can't be reached. Try again once it can.");
        }
    }
}
