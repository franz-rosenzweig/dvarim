using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dvarim.Core;
using Microsoft.UI.Dispatching;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Dvarim;

/// <summary>
/// A to-do's ⏰ as a Windows notification, with a Complete button; pressing the
/// notification opens the to-do. The reminders come from the page's Today and
/// Upcoming (ReminderPlan), asked again whenever the to-dos change and every quarter
/// of an hour, and they arrive while Dvarim is running, which it is from sign-in
/// when Settings says to start with Windows. An unpackaged app can't leave Windows a
/// notification for later, so one missed while Dvarim wasn't running comes when it
/// starts, up to six hours late, as Android's does after the phone was off.
/// </summary>
static class Reminders
{
    static readonly TimeSpan CatchUp = TimeSpan.FromHours(6);
    static List<Reminder> plan = [];
    static Dictionary<string, DateTime> fired = new();           // shown already: key → when it was due
    static DispatcherQueueTimer? tick, again;
    static bool asking, more;

    static string FiredFile => Path.Join(App.DataDir, "reminders.json");

    /// <summary>What is coming and what is due, as last worked out, for Settings and the self-test.</summary>
    public static IReadOnlyList<Reminder> Plan => plan;

    public static void Start()
    {
        try { fired = JsonSerializer.Deserialize<Dictionary<string, DateTime>>(File.ReadAllText(FiredFile)) ?? new(); }
        catch (Exception) { fired = new(); }
        App.VaultChanged += () => _ = Refresh();
        if (App.UI is not { } ui) return;
        tick = ui.CreateTimer();
        tick.Interval = TimeSpan.FromSeconds(15);
        tick.Tick += (_, _) => Due();
        tick.Start();
        // the server's page says nothing when the to-dos change, and a day turns over
        again = ui.CreateTimer();
        again.Interval = TimeSpan.FromMinutes(15);
        again.Tick += (_, _) => _ = Refresh();
        again.Start();
    }

    public static void Stop()
    {
        tick?.Stop();
        again?.Stop();
    }

    /// <summary>Today and Upcoming asked again, and the plan made from them.</summary>
    public static async Task Refresh()
    {
        if (asking)
        {
            more = true;
            return;
        }
        asking = true;
        try
        {
            var (s1, today) = await App.Main.Ask("GET", "/api/lists/today");
            var (s2, upcoming) = await App.Main.Ask("GET", "/api/lists/upcoming");
            if (s1 == 200) plan = ReminderPlan.From(today, s2 == 200 ? upcoming : null);
        }
        catch (Exception e)
        {
            Log.Write($"reminders: {e.Message}");
        }
        finally
        {
            asking = false;
        }
        Due();
        if (more)
        {
            more = false;
            await Refresh();
        }
    }

    /// <summary>Every reminder whose time has come, shown once; one more than six hours old is left alone.</summary>
    static void Due()
    {
        if (!Vault.RemindersOn) return;
        var now = DateTime.Now;
        var changed = false;
        foreach (var r in plan)
        {
            if (r.Due > now || now - r.Due > CatchUp || fired.ContainsKey(r.Key)) continue;
            Notifications.Show(r);
            fired[r.Key] = r.Due;
            changed = true;
        }
        if (!changed) return;
        foreach (var key in fired.Where(f => now - f.Value > TimeSpan.FromDays(2)).Select(f => f.Key).ToList()) fired.Remove(key);
        try { File.WriteAllText(FiredFile, JsonSerializer.Serialize(fired)); }
        catch (Exception e) { Log.Write($"reminders: {e.Message}"); }
    }
}

/// <summary>Windows notifications (the Windows App SDK's, which an unpackaged app may send), and what pressing one does.</summary>
static class Notifications
{
    static bool registered;

    /// <summary>The reminders handed to Windows, for the self-test; and why the last one wasn't, if it wasn't.</summary>
    public static readonly List<string> Sent = [];
    public static string? Problem { get; private set; }

    public static void Start()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, e) => App.UI?.TryEnqueue(() => Invoked(e));
            AppNotificationManager.Default.Register();
            registered = true;
        }
        catch (Exception e)
        {
            Problem = e.Message;
            Log.Write($"notifications: {e.Message}");
        }
    }

    /// <summary>Quitting: a notification pressed after this starts Dvarim again, rather than knocking on a process that's gone.</summary>
    public static void Stop()
    {
        try { if (registered) AppNotificationManager.Default.Unregister(); }
        catch (Exception e) { Log.Write($"notifications: {e.Message}"); }
    }

    public static void Show(Reminder r)
    {
        var builder = new AppNotificationBuilder()
            .AddArgument("action", "open")
            .AddArgument("id", r.Id)
            .AddText(r.Title);
        if (r.Sub.Length > 0) builder.AddText(r.Sub);
        builder.AddButton(new AppNotificationButton("Complete").AddArgument("action", "complete").AddArgument("id", r.Id));
        Send(builder, r.Key);
    }

    /// <summary>
    /// A notification with nothing behind it, from Settings: every part of the way from
    /// Dvarim to the screen is somebody else's to allow (Windows' notification settings,
    /// Do not disturb), and the only other way to find one off is a reminder that never came.
    /// </summary>
    public static void Test() =>
        Send(new AppNotificationBuilder()
            .AddArgument("action", "open")
            .AddText("Reminders reach this PC")
            .AddText("A to-do's reminder arrives like this, with a Complete button."), "test");

    static void Send(AppNotificationBuilder builder, string key)
    {
        try
        {
            var note = builder.BuildNotification();
            // the same reminder again replaces itself rather than stacking
            note.Tag = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
            note.Group = "reminders";
            AppNotificationManager.Default.Show(note);
            Sent.Add(key);
            Problem = null;
        }
        catch (Exception e)
        {
            Problem = e.Message;
            Log.Write($"notification {key}: {e.Message}");
        }
    }

    /// <summary>Pressed: Complete ticks the to-do off through the page; the rest opens it in the window.</summary>
    public static void Invoked(AppNotificationActivatedEventArgs e)
    {
        var args = e.Arguments;
        args.TryGetValue("action", out var action);
        args.TryGetValue("id", out var id);
        if (action == "complete" && !string.IsNullOrEmpty(id)) _ = TodayList.Complete(id, true);
        else App.Main.ShowWindow(string.IsNullOrEmpty(id) ? "/today" : "/todo/" + Uri.EscapeDataString(id));
    }
}
