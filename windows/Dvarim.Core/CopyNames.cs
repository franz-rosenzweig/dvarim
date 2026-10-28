using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Dvarim.Core;

/// <summary>
/// The names the copy goes by (docs/BRIDGE.md, "Copy"): whose copy, the device
/// it syncs as, and the folder it is kept in. The same rules as
/// android/…/AppCopy.java and mac/Native/Account.swift, so a person has one
/// name on every device.
/// </summary>
public static class CopyNames
{
    /// <summary>
    /// Whose copy, as the page keys them (frontend/src/lib/backend.js, personKey):
    /// "owner" for the server's owner, otherwise the account's id, lowercased.
    /// </summary>
    public static string PersonKey(JsonNode? person)
    {
        if (person is not JsonObject p) return "owner";
        if (p["owner"] is not JsonValue o || !o.TryGetValue(out bool owner) || owner) return "owner";
        var key = (Text(p["uid"]) ?? Text(p["name"]) ?? "").Trim().ToLowerInvariant();
        return key.Length == 0 ? "owner" : key;
    }

    /// <summary>
    /// "Nate-PC (Windows)": the PC's name and which app, in the characters the
    /// server allows a device (server/src/app.js: letters, digits, spaces and
    /// . _ ' ’ ( ) -, up to 40), with room left for " 9".
    /// </summary>
    public static string DeviceName(string? computer)
    {
        var b = new StringBuilder();
        foreach (var rune in (computer ?? "").EnumerateRunes())
        {
            var ok = Rune.IsLetterOrDigit(rune) || " ._'’()-".Contains(rune.ToString(), StringComparison.Ordinal);
            b.Append(ok ? rune.ToString() : " ");
        }
        var name = string.Join(' ', b.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
        if (name.Length > 24) name = name[..24].Trim();
        return $"{(name.Length == 0 ? "PC" : name)} (Windows)";
    }

    /// <summary>The n-th name to try: the name, then "… 2", "… 3", while the server says one is taken.</summary>
    public static string DeviceName(string baseName, int n) => n <= 1 ? baseName : $"{baseName} {n}";

    /// <summary>The copy's folder: &lt;copies&gt;\&lt;host[-port]&gt;\&lt;who&gt;, as Android's files/copies/&lt;host&gt;/&lt;who&gt;/.</summary>
    public static string Folder(string copies, Uri server, string who)
    {
        var host = (server.Host.Length == 0 ? "server" : server.Host) + (server.IsDefaultPort ? "" : "-" + server.Port.ToString(CultureInfo.InvariantCulture));
        return Path.Join(copies, Safe(host), Safe(who));
    }

    /// <summary>A name for a folder: no / \ : or other character Windows refuses, and never a leading dot.</summary>
    public static string Safe(string s)
    {
        var cleaned = string.Concat(s.Select(c => "/\\:*?\"<>|".Contains(c) || c < ' ' ? '-' : c)).Trim().TrimEnd('.');
        if (cleaned.Length == 0) return "_";
        return cleaned.StartsWith('.') ? "_" + cleaned[1..] : cleaned;
    }

    static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue(out string? s) ? s : null;
}

/// <summary>
/// Which Dvarim the app talks to: the address the app was built for, or one typed
/// in its Settings. An origin, "https://host[:port]", with no path: the web app
/// owns its routes. As android/…/Server.java, except that plain http is allowed to
/// this PC, the local network and the tailnet, as the bridge's http op is.
/// </summary>
public static class ServerAddress
{
    public const string BuiltIn = "https://dvarim.tiresia.xyz";

    /// <summary>What someone typed, as an origin, or null if it is not one. A bare "dvarim.example.com" is https.</summary>
    public static Uri? Parse(string? typed)
    {
        var text = (typed ?? "").Trim();
        if (text.Length == 0) return null;
        if (!text.Contains("://", StringComparison.Ordinal)) text = "https://" + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var url) || url.Host.Length == 0) return null;
        if (url.Scheme == "http" && !IsPrivateName(url.Host)) return null;
        if (url.Scheme is not ("https" or "http")) return null;
        return new Uri(url.GetLeftPart(UriPartial.Authority));
    }

    /// <summary>An origin as a person writes it: no trailing slash.</summary>
    public static string Text(Uri origin) => origin.GetLeftPart(UriPartial.Authority);

    /// <summary>A name that is this PC, the local network or the tailnet without asking DNS.</summary>
    public static bool IsPrivateName(string host)
    {
        var name = host.Trim('[', ']').ToLowerInvariant();
        if (name == "localhost" || name.EndsWith(".localhost", StringComparison.Ordinal) || name.EndsWith(".ts.net", StringComparison.Ordinal)) return true;
        return IPAddress.TryParse(name, out var ip) && ShellHttp.IsPrivate(ip.GetAddressBytes());
    }

    /// <summary>The same scheme, host and port.</summary>
    public static bool SameOrigin(Uri a, Uri b) =>
        string.Equals(a.Scheme, b.Scheme, StringComparison.OrdinalIgnoreCase)
        && string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase) && a.Port == b.Port;
}
