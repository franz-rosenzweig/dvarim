using System.Globalization;
using System.Text.Json.Nodes;

namespace Dvarim.Core;

/// <summary>A reminder: which to-do, what it says, and when, in this PC's own time.</summary>
public sealed record Reminder(string Key, string Id, string Title, string Sub, DateTime Due);

/// <summary>
/// The reminders in the page's Today and Upcoming (GET /api/lists/today and
/// /upcoming): every open to-do with a ⏰, from today on. A reminder is "15:00"
/// against the to-do's own When, and means three in the afternoon where this PC
/// is, so the two are put together in this PC's time zone, never the server's.
/// As android/…/Reminders.java and Local.java.
/// </summary>
public static class ReminderPlan
{
    public static List<Reminder> From(JsonNode? today, JsonNode? upcoming)
    {
        var all = new List<Reminder>();
        var seen = new HashSet<string>();
        void Take(JsonNode? items)
        {
            foreach (var todo in (items as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                if (One(todo) is { } r && seen.Add(r.Key)) all.Add(r);
        }
        Take(today?["items"]);
        var day = Text(today?["date"]) ?? "";
        foreach (var d in (upcoming?["days"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            if (string.CompareOrdinal(Text(d["date"]) ?? "", day) > 0) Take(d["items"]);
        all.Sort((a, b) => a.Due.CompareTo(b.Due));
        return all;
    }

    static Reminder? One(JsonObject todo)
    {
        if (Text(todo["status"]) != "open") return null;
        var id = Text(todo["id"]) ?? "";
        var when = Text(todo["when"]) ?? "";
        var at = Text(todo["reminder"]) ?? "";
        if (id.Length == 0 || when.Length == 0 || at.Length == 0) return null;
        if (Local(when, at) is not { } due) return null;
        var sub = Text(todo["projectName"]) is { Length: > 0 } project ? project : Text(todo["areaName"]) ?? "";
        return new Reminder($"{id}@{when}T{at}", id, Text(todo["title"]) ?? "", sub, due);
    }

    /// <summary>"2026-09-20" and "15:00" as that moment on this PC's clock, or null.</summary>
    public static DateTime? Local(string when, string at) =>
        DateTime.TryParseExact($"{when} {at}", "yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var due)
            ? DateTime.SpecifyKind(due, DateTimeKind.Local) : null;

    static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue(out string? s) ? s : null;
}
