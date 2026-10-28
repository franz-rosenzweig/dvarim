using System.Text;
using Microsoft.Web.WebView2.Core;

namespace Dvarim;

/// <summary>
/// The web app, served from inside Dvarim at https://dvarim-app.example/
/// (docs/BRIDGE.md, 1). A path that names a file in the build is that file; any
/// other path is index.html, so a reload on /today or /project/p7k3j9a2 comes back
/// to that screen. Nothing under /api/ needs an answer: in the app's own page the
/// engine answers them. Android's is FolderActivity's shouldInterceptRequest, at
/// https://appassets.androidplatform.net.
/// </summary>
/// <remarks>
/// WebView2 answers an https origin's requests from here, before any network;
/// .example is reserved (RFC 2606), so no real site can ever be at it.
/// </remarks>
sealed class AppScheme(string web, CoreWebView2Environment environment)
{
    public const string Origin = "https://dvarim-app.example";

    readonly string web = Path.TrimEndingDirectorySeparator(Path.GetFullPath(web));

    public void Attach(CoreWebView2 core)
    {
        core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += Answer;
    }

    void Answer(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var url)
            || !url.AbsoluteUri.StartsWith(Origin + "/", StringComparison.OrdinalIgnoreCase)) return;
        var path = Uri.UnescapeDataString(url.AbsolutePath);
        try
        {
            var file = Resolve(path);
            e.Response = Respond(200, File.ReadAllBytes(file), Mime(Path.GetExtension(file)));
        }
        catch (Exception x)
        {
            Log.Write($"could not answer {path}: {x.Message}");
            e.Response = Respond(500, Encoding.UTF8.GetBytes(x.Message), "text/plain; charset=utf-8");
        }
    }

    CoreWebView2WebResourceResponse Respond(int status, byte[] data, string mime) =>
        environment.CreateWebResourceResponse(new MemoryStream(data).AsRandomAccessStream(), status, status == 200 ? "OK" : "Error",
            $"Content-Type: {mime}\r\nCache-Control: no-cache");

    string Resolve(string path)
    {
        var index = Path.Join(web, "index.html");
        var rel = path.TrimStart('/');
        if (rel.Length == 0 || rel.Contains('\\')) return index;
        var candidate = Path.GetFullPath(Path.Join(web, rel.Replace('/', Path.DirectorySeparatorChar)));
        // inside the build, and a file: anything else is the app's own route
        return candidate.StartsWith(web + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(candidate) ? candidate : index;
    }

    public static string Mime(string extension) => extension.TrimStart('.').ToLowerInvariant() switch
    {
        "html" or "htm" => "text/html; charset=utf-8",
        "js" or "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" or "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" or "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
}
