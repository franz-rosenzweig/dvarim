using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Dvarim.Core;
using Microsoft.Web.WebView2.Core;

namespace Dvarim;

/// <summary>
/// The to-dos kept on this PC and synced with the server: the default, as in the
/// Mac and Android apps (docs/BRIDGE.md, "Copy"). The page is the app's own, its
/// folder one of the app's own (Vault.CopyFolder), and the page's built-in sync
/// keeps that folder in step with the server's /dav with a token this PC was given.
/// So Dvarim opens with no network at all.
///
/// The one step that needs the server is the first: the person signs in on the
/// server's own page in Dvarim's window, whose cookie lands in WebView2's jar. The
/// app then borrows that session to make this PC its own token (POST /api/tokens
/// takes a session, never a token), keeps it in Credential Manager, and hands it
/// to the page in info's <c>sync</c>. As android/…/AppCopy.java and
/// CopySignInActivity.java.
/// </summary>
static class AppCopy
{
    static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,                 // the sign-in is WebView2's cookie, sent by hand
        AutomaticDecompression = DecompressionMethods.All,
    })
    { Timeout = TimeSpan.FromSeconds(15) };

    /// <summary>The server refused (409 for a name taken), as against not answering.</summary>
    sealed class Refused(int status, string message) : Exception(message)
    {
        public int Status { get; } = status;
    }

    /// <summary>The server's session cookie as WebView2 holds it, as a Cookie header; null with none.</summary>
    public static async Task<string?> Cookie(CoreWebView2 core, Uri server)
    {
        var cookies = await core.CookieManager.GetCookiesAsync(server.AbsoluteUri);
        return cookies.Count == 0 ? null : string.Join("; ", cookies.Select(c => $"{c.Name}={c.Value}"));
    }

    /// <summary>
    /// With a sign-in in the window and no copy yet: make this PC a token and keep it.
    /// True once there is a copy. Asked every few seconds while the sign-in is on screen,
    /// and whenever the server's page has loaded.
    /// </summary>
    public static async Task<bool> SetUpIfSignedIn(CoreWebView2 core)
    {
        if (Vault.Copy != null) return true;
        var server = Vault.Server;
        var cookie = await Cookie(core, server);
        if (cookie == null) return false;
        try
        {
            var auth = JsonNode.Parse(await Call(server, HttpMethod.Get, "/api/auth", null, cookie)) as JsonObject;
            if (!J.Bool(auth?["authenticated"])) return false;
            var who = CopyNames.PersonKey(auth?["person"]);
            var device = CopyNames.DeviceName(Dns.GetHostName());
            for (var n = 1; n <= 9; n++)
            {
                var name = CopyNames.DeviceName(device, n);
                try
                {
                    var made = JsonNode.Parse(await Call(server, HttpMethod.Post, "/api/tokens", new JsonObject { ["name"] = name }, cookie));
                    var token = J.Text(made?["token"]) ?? throw new Exception("the server made no token");
                    Vault.RecordCopy(who, name, token);
                    Log.Write($"keeping a copy on this PC for {who}, synced with {server.Host} as {name}");
                    return true;
                }
                catch (Refused e) when (e.Status == 409)
                {
                    // a name already taken: the next number
                }
            }
            Log.Write("could not set up the copy: every name for this PC is taken on the server");
        }
        catch (Exception e)
        {
            Log.Write($"could not set up the copy yet: {e.Message}");
        }
        return false;
    }

    /// <summary>
    /// The page has synced what it had and signs out (op signOut): the token goes from
    /// the server, the window's sign-in with it, and the copy from this PC, to the
    /// Recycle Bin. Then the window shows the server's sign-in again.
    /// </summary>
    public static async Task SignOut(CoreWebView2? core)
    {
        if (Vault.Copy is not { } copy) return;
        var server = Vault.Server;
        var cookie = core == null ? null : await Cookie(core, server);
        try { await Call(server, HttpMethod.Delete, "/api/tokens/" + Uri.EscapeDataString(copy.Device), null, cookie); }
        catch (Exception e) { Log.Write($"could not take this PC off the server's devices: {e.Message}"); }
        try { await Call(server, HttpMethod.Post, "/api/logout", new JsonObject(), cookie); }
        catch (Exception e) { Log.Write($"could not sign out on the server: {e.Message}"); }
        if (core != null)
            foreach (var c in await core.CookieManager.GetCookiesAsync(server.AbsoluteUri)) core.CookieManager.DeleteCookie(c);
        var folder = Vault.CopyFolder(copy);
        Vault.ForgetCopy();
        try
        {
            if (Directory.Exists(folder))
            {
                // the self-test's copy goes for good; a person's to the Recycle Bin, as the Mac's to the Trash
                if (App.Options.SelfTest) Directory.Delete(folder, recursive: true);
                else Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(folder,
                    Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            }
        }
        catch (Exception e) { Log.Write($"could not put the copy in the Recycle Bin: {e.Message}"); }
        Log.Write($"signed out of {server.Host}; the copy is gone from this PC");
    }

    /// <summary>
    /// One request to the server, as a program makes it: no Origin header, so the
    /// server's check against other sites lets it through, and the sign-in by hand.
    /// </summary>
    static async Task<string> Call(Uri server, HttpMethod method, string path, JsonNode? body, string? cookie)
    {
        using var request = new HttpRequestMessage(method, new Uri(server, path));
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        if (cookie != null) request.Headers.TryAddWithoutValidation("Cookie", cookie);
        if (body != null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await Client.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
            throw new Refused((int)response.StatusCode, $"{method} {path}: {(int)response.StatusCode} {text}");
        return text;
    }
}
