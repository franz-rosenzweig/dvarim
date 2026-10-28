using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using WinRT.Interop;

namespace Dvarim;

/// <summary>
/// Today, as the page has it (GET /api/lists/today through window.dvarim.request),
/// for the notification area's count and list, kept up to date on every change the
/// page reports (op changed) and whenever the page comes up.
/// </summary>
static class TodayList
{
    /// <summary>The last answer: {date, events, items, projects}.</summary>
    public static JsonObject? Last { get; private set; }

    /// <summary>Why there is no list, in words for the window: not signed in, no page yet.</summary>
    public static string? Problem { get; private set; } = "Dvarim is opening…";

    public static event Action? Updated;

    static bool asking, again;

    public static IEnumerable<JsonObject> Items => (Last?["items"] as JsonArray ?? new JsonArray()).OfType<JsonObject>();

    public static int OpenCount => Items.Count(t => J.Text(t["status"]) == "open");

    public static async Task Refresh()
    {
        if (asking)
        {
            again = true;
            return;
        }
        asking = true;
        try
        {
            var (status, body) = await App.Main.Ask("GET", "/api/lists/today");
            if (status == 200 && body is JsonObject list)
            {
                Last = list;
                Problem = null;
            }
            else
            {
                Problem = status == 401 ? "Sign in, in Dvarim's window, to see Today here." : $"Today didn't come ({status}).";
            }
        }
        catch (Exception e)
        {
            Problem = "Today isn't here yet: Dvarim's page hasn't answered.";
            Log.Write($"today: {e.Message}");
        }
        finally
        {
            asking = false;
        }
        Updated?.Invoke();
        if (again)
        {
            again = false;
            await Refresh();
        }
    }

    /// <summary>A tick, or one taken back, from the notification area or a reminder's Complete.</summary>
    public static async Task<bool> Complete(string id, bool on)
    {
        try
        {
            var (status, _) = await App.Main.Ask("POST", $"/api/todos/{Uri.EscapeDataString(id)}/complete", new JsonObject { ["on"] = on });
            if (status is >= 200 and < 300)
            {
                await Refresh();
                return true;
            }
            Log.Write($"complete {id}: {status}");
        }
        catch (Exception e)
        {
            Log.Write($"complete {id}: {e.Message}");
        }
        return false;
    }
}

/// <summary>
/// Today in a small window over the notification area, where a to-do can be ticked
/// off without opening Dvarim, as the Mac's menu bar list. It goes when you click
/// elsewhere.
/// </summary>
sealed class TodayWindow
{
    static TodayWindow? shared;
    readonly Window window;
    readonly IntPtr handle;
    readonly StackPanel rows = new() { Spacing = 2 };
    readonly TextBlock date = new() { Opacity = 0.7 };
    DateTime hidden;

    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    public static bool IsShown => shared?.window.AppWindow.IsVisible == true;

    /// <summary>From a click on the icon at (x, y): shown beside it, or put away if it was up.</summary>
    public static void Toggle(int x, int y)
    {
        shared ??= new TodayWindow();
        // the click that put it away (it went when the icon was pressed) mustn't bring it back
        if (IsShown || DateTime.UtcNow - shared.hidden < TimeSpan.FromMilliseconds(400))
        {
            shared.window.AppWindow.Hide();
            return;
        }
        shared.Show(x, y);
        _ = TodayList.Refresh();
    }

    TodayWindow()
    {
        window = new Window { Title = "Dvarim · Today" };
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
            window.AppWindow.Hide();
        };
        window.Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated && window.AppWindow.IsVisible)
            {
                hidden = DateTime.UtcNow;
                window.AppWindow.Hide();
            }
        };

        var title = new TextBlock { Text = "Today", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] };
        var head = new StackPanel { Spacing = 0 };
        head.Children.Add(title);
        head.Children.Add(date);

        var open = new Button { Content = "Open Dvarim" };
        open.Click += (_, _) =>
        {
            window.AppWindow.Hide();
            App.Main.ShowWindow("/today");
        };
        var add = new Button { Content = "New To-Do…" };
        add.Click += (_, _) =>
        {
            window.AppWindow.Hide();
            QuickEntry.Shared.Show();
        };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        buttons.Children.Add(open);
        buttons.Children.Add(add);

        var root = new Grid { Padding = new Thickness(16), RowSpacing = 12 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var scroller = new ScrollViewer { Content = rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(head, 0);
        Grid.SetRow(scroller, 1);
        Grid.SetRow(buttons, 2);
        root.Children.Add(head);
        root.Children.Add(scroller);
        root.Children.Add(buttons);
        window.Content = root;

        TodayList.Updated += Fill;
        Fill();
    }

    void Show(int x, int y)
    {
        var scale = GetDpiForWindow(handle) / 96.0;
        var size = new SizeInt32((int)(340 * scale), (int)(460 * scale));
        var area = DisplayArea.GetFromPoint(new PointInt32(x, y), DisplayAreaFallback.Nearest).WorkArea;
        // above the icon, its right edge at the icon, inside the screen's work area
        var left = Math.Clamp(x - size.Width + (int)(24 * scale), area.X + 8, area.X + area.Width - size.Width - 8);
        var top = Math.Clamp(y - size.Height - (int)(12 * scale), area.Y + 8, area.Y + area.Height - size.Height - 8);
        window.AppWindow.MoveAndResize(new RectInt32(left, top, size.Width, size.Height));
        window.Activate();
        SetForegroundWindow(handle);
    }

    void Fill()
    {
        rows.Children.Clear();
        date.Text = DateTime.Now.ToString("dddd d MMMM", CultureInfo.CurrentCulture);
        if (TodayList.Problem is { } problem && TodayList.Last == null)
        {
            rows.Children.Add(new TextBlock { Text = problem, TextWrapping = TextWrapping.Wrap, Opacity = 0.7 });
            return;
        }
        var items = TodayList.Items.ToList();
        if (items.Count == 0)
        {
            rows.Children.Add(new TextBlock { Text = "Nothing for today.", Opacity = 0.7 });
            return;
        }
        var evening = false;
        foreach (var todo in items)
        {
            if (J.Bool(todo["evening"]) && !evening)
            {
                evening = true;
                rows.Children.Add(new TextBlock { Text = "This Evening", Margin = new Thickness(0, 10, 0, 2), Opacity = 0.7, FontSize = 12 });
            }
            rows.Children.Add(Row(todo));
        }
    }

    static UIElement Row(JsonObject todo)
    {
        var id = J.Text(todo["id"]) ?? "";
        var sub = J.Text(todo["projectName"]) is { Length: > 0 } project ? project : J.Text(todo["areaName"]) ?? "";
        var text = new StackPanel();
        text.Children.Add(new TextBlock { Text = J.Text(todo["title"]) ?? "", TextWrapping = TextWrapping.Wrap });
        if (sub.Length > 0) text.Children.Add(new TextBlock { Text = sub, FontSize = 12, Opacity = 0.6 });
        var box = new CheckBox { Content = text, IsChecked = J.Text(todo["status"]) != "open", MinWidth = 0 };
        box.Checked += async (_, _) => await TodayList.Complete(id, true);
        box.Unchecked += async (_, _) => await TodayList.Complete(id, false);
        return box;
    }
}
