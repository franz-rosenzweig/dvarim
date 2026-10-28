using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Dvarim.Core;

/// <summary>
/// The bridge's <c>http</c> op (docs/BRIDGE.md): one request made by the shell for
/// the page's built-in sync, so a WebDAV server that answers no page from another
/// origin (Nextcloud, most) can still be reached. No cookies, no cache, no
/// redirects, 30 seconds. Only https, and plain http only to this PC, the local
/// network or the tailnet. Android's is android/…/ShellHttp.java, the Mac's mac/Shared/ShellHTTP.swift.
/// </summary>
public static class ShellHttp
{
    static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,      // a redirect comes back to the page as the 3xx it is
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,
    })
    { Timeout = TimeSpan.FromSeconds(30) };

    /// <summary>The op's reply: <c>{ok: {status, headers, body}}</c>, or an error. An HTTP error status is an ordinary reply; only no answer at all is EIO.</summary>
    public static async Task<JsonObject> Answer(JsonObject args)
    {
        var address = Text(args["url"]);
        if (!Uri.TryCreate(address, UriKind.Absolute, out var url) || url.Host.Length == 0)
            return FolderFiles.Failure("EINVAL", $"not a web address: {address}");
        try
        {
            switch (url.Scheme)
            {
                case "https":
                    break;
                case "http":
                    if (!await IsPrivate(url.Host))
                        return FolderFiles.Failure("EINVAL", $"{url.Host} needs an https address: plain http goes only to this PC, the local network or the tailnet");
                    break;
                default:
                    return FolderFiles.Failure("EINVAL", $"not a web address: {address}");
            }
            using var request = new HttpRequestMessage(new HttpMethod(Text(args["method"]) is { Length: > 0 } m ? m : "GET"), url);
            if (Text(args["body"]) is { } body) request.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));
            if (args["headers"] is JsonObject headers)
                foreach (var (name, value) in headers)
                {
                    var v = Text(value) ?? value?.ToJsonString() ?? "";
                    if (request.Headers.TryAddWithoutValidation(name, v)) continue;
                    // Content-Type and the rest belong to the body
                    request.Content ??= new ByteArrayContent([]);
                    request.Content.Headers.TryAddWithoutValidation(name, v);
                }
            using var response = await Client.SendAsync(request);
            var fields = new JsonObject();
            foreach (var (name, values) in response.Headers.Concat(response.Content.Headers)) fields[name] = string.Join(", ", values);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            return new JsonObject
            {
                ["ok"] = new JsonObject { ["status"] = (int)response.StatusCode, ["headers"] = fields, ["body"] = Encoding.UTF8.GetString(bytes) },
            };
        }
        catch (Exception e)
        {
            return FolderFiles.Failure("EIO", $"could not reach {url.Host}: {e.Message}");
        }
    }

    static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue(out string? s) ? s : null;

    /// <summary>Whether every address the name has is this PC's, the local network's or the tailnet's.</summary>
    public static async Task<bool> IsPrivate(string host)
    {
        var name = host.Trim('[', ']').ToLowerInvariant();
        if (name == "localhost" || name.EndsWith(".localhost", StringComparison.Ordinal)) return true;
        IPAddress[] addresses;
        try { addresses = IPAddress.TryParse(name, out var literal) ? new[] { literal } : await Dns.GetHostAddressesAsync(name); }
        catch (Exception) { return false; }
        return addresses.Length > 0 && addresses.All(a => IsPrivate(a.GetAddressBytes()));
    }

    /// <summary>
    /// Loopback, RFC 1918, link-local, and 100.64/10 where Tailscale puts its
    /// devices; for IPv6 loopback, fc00::/7 (the tailnet's fd7a:115c:a1e0::/48
    /// among them), link-local, and an IPv4 address written as IPv6.
    /// </summary>
    public static bool IsPrivate(byte[] a)
    {
        if (a.Length == 4)
            return a[0] == 127 || a[0] == 10 || (a[0] == 172 && a[1] is >= 16 and <= 31) || (a[0] == 192 && a[1] == 168)
                || (a[0] == 169 && a[1] == 254) || (a[0] == 100 && a[1] is >= 64 and <= 127);
        if (a.Length != 16) return false;
        if (a.Take(15).All(b => b == 0) && a[15] == 1) return true;
        if ((a[0] & 0xfe) == 0xfc || (a[0] == 0xfe && (a[1] & 0xc0) == 0x80)) return true;
        if (a.Take(10).All(b => b == 0) && a[10] == 0xff && a[11] == 0xff) return IsPrivate(a[12..]);
        return false;
    }
}
