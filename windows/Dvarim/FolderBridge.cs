using System.Text.Json.Nodes;
using System.Threading.Channels;
using Dvarim.Core;

namespace Dvarim;

/// <summary>
/// The folder bridge of docs/BRIDGE.md, Windows' half: the page's storage messages
/// answered from the folder, one at a time and in the order sent; the page told
/// when someone else (Obsidian, Syncthing, OneDrive) changes the folder; and, beside
/// the queue, the ops that aren't files: <c>http</c> for the sync and for what only
/// the server can answer, <c>changed</c> for the notification area and reminders,
/// and <c>signOut</c> for the copy. The transport is Android's,
/// window.DvarimStorage.request(id, json) answered by window.__dvarimStorageReply,
/// over WebView2's web messages (Scripts.Shell). Android's is
/// android/…/FolderBridge.java.
/// </summary>
sealed class FolderBridge : IDisposable
{
    public FolderFiles Files { get; }
    readonly Channel<(int Id, string Op, JsonObject Args)> queue =
        Channel.CreateUnbounded<(int Id, string Op, JsonObject Args)>(new UnboundedChannelOptions { SingleReader = true });
    readonly Action<int, JsonObject> reply;
    readonly Host host;
    readonly Timer settle;
    FileSystemWatcher? watcher;

    /// <summary>What the bridge asks of the window it is in.</summary>
    public sealed record Host(
        Func<JsonObject> Info,                       // op info
        Action<int, string> Asked,                   // pick, useServer and signOut: the window's to do, replying when it can
        Action Changed,                              // op changed: the notification area and reminders ask again
        Action Nudge,                                // the folder changed under the page
        Func<Uri, Task<string?>> SessionCookie,      // the app's sign-in, for http with session: true
        Uri? Server);                                // the only server that sign-in goes to: the copy's

    /// <summary>How many times the page has been told the folder changed, for the self-test.</summary>
    public static int Nudges;

    /// <summary>How many <c>changed</c> and <c>http</c> ops the pages have sent, for the self-test.</summary>
    public static int ChangedOps, HttpOps;

    /// <param name="reply">sends a reply to the page, from any thread</param>
    public FolderBridge(string root, Action<int, JsonObject> reply, Host host)
    {
        Files = new FolderFiles(root);
        this.reply = reply;
        this.host = host;
        settle = new Timer(_ =>
        {
            Interlocked.Increment(ref Nudges);
            host.Nudge();
        });
        _ = Task.Run(Pump);
    }

    /// <summary>One message from the page, as Android's transport sends it: an id and the message's JSON.</summary>
    public void Receive(int id, string json)
    {
        JsonObject? message = null;
        try { message = JsonNode.Parse(json) as JsonObject; }
        catch (Exception) { }
        if (J.Text(message?["op"]) is not { } op)
        {
            reply(id, FolderFiles.Failure("EINVAL", "not a bridge message"));
            return;
        }
        var version = J.Int(message!["v"]);
        if (version != 1)
        {
            reply(id, FolderFiles.Failure("EPROTO", $"this app speaks protocol 1, not {version}"));
            return;
        }
        var args = message["args"] as JsonObject ?? new JsonObject();
        switch (op)
        {
            case "pick":
            case "useServer":
            case "signOut":
                host.Asked(id, op);
                break;
            case "info":
                reply(id, J.Ok(host.Info()));
                break;
            case "changed":
                // nothing waits for it (docs/BRIDGE.md): the reply at once, the lists asked again after
                Interlocked.Increment(ref ChangedOps);
                reply(id, J.Ok(null));
                host.Changed();
                break;
            case "http":
                // Not a file operation, so beside the queue rather than in it: a
                // slow server must not hold up the folder, nor the folder a sync.
                Interlocked.Increment(ref HttpOps);
                _ = Task.Run(async () => reply(id, await Http(args)));
                break;
            case "calendars":
            case "events":
                reply(id, FolderFiles.Failure("ENOSYS", "Dvarim for Windows doesn't read this PC's calendars yet; the server's calendars show with the copy"));
                break;
            default:
                queue.Writer.TryWrite((id, op, args));
                break;
        }
    }

    /// <summary>
    /// Op http. With <c>session: true</c> the app's own sign-in goes with it, for what a
    /// token may not do (the server's devices and people), and only ever to the
    /// copy's own server.
    /// </summary>
    async Task<JsonObject> Http(JsonObject args)
    {
        try
        {
            if (J.Bool(args["session"]))
            {
                args.Remove("session");
                if (host.Server is not { } server || !Uri.TryCreate(J.Text(args["url"]), UriKind.Absolute, out var url) || !ServerAddress.SameOrigin(url, server))
                    return FolderFiles.Failure("EACCES", $"the sign-in goes only to {(host.Server == null ? "the copy's server" : ServerAddress.Text(host.Server))}");
                var headers = args["headers"] as JsonObject ?? new JsonObject();
                if (await host.SessionCookie(server) is { } cookie) headers["Cookie"] = cookie;
                args["headers"] = headers;
            }
            return await ShellHttp.Answer(args);
        }
        catch (Exception e)
        {
            return FolderFiles.Failure("EIO", e.Message);
        }
    }

    async Task Pump()
    {
        await foreach (var (id, op, args) in queue.Reader.ReadAllAsync())
        {
            JsonObject answer;
            try { answer = Files.Answer(op, args); }
            catch (Exception e) { answer = FolderFiles.Failure("EIO", e.Message); }
            reply(id, answer);
        }
    }

    // ---- someone else writes the folder -------------------------------------------

    public void StartWatching()
    {
        if (watcher != null) return;
        try
        {
            watcher = new FileSystemWatcher(Files.Root)
            {
                IncludeSubdirectories = true,
                InternalBufferSize = 64 * 1024,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            watcher.Created += Changed;
            watcher.Changed += Changed;
            watcher.Deleted += Changed;
            watcher.Renamed += Changed;
            // more at once than Windows could list (a big sync): say so anyway
            watcher.Error += (_, e) =>
            {
                Log.Write($"watching {Files.Root}: {e.GetException().Message}");
                Soon();
            };
            watcher.EnableRaisingEvents = true;
        }
        catch (Exception e)
        {
            Log.Write($"cannot watch {Files.Root}: {e.Message}");
        }
    }

    /// <summary>Signing out is about to take the copy's folder away: nothing to watch, and nothing to tell the page.</summary>
    public void StopWatching()
    {
        watcher?.Dispose();
        watcher = null;
    }

    void Changed(object sender, FileSystemEventArgs e)
    {
        var name = e.Name ?? "";
        // our own temporary files, and what goes on inside .git and the rest the page never reads
        if (name.EndsWith(FolderFiles.TempSuffix, StringComparison.Ordinal)) return;
        if (name.Split(Path.DirectorySeparatorChar).Any(FolderFiles.Ignored.Contains)) return;
        Soon();
    }

    /// <summary>
    /// About a third of a second after the last change, as the Mac's FSEvents latency
    /// was. Our own writes come back this way too; the page debounces and compares
    /// contents, so telling it is harmless (docs/BRIDGE.md, 3).
    /// </summary>
    void Soon() => settle.Change(300, Timeout.Infinite);

    public void Dispose()
    {
        watcher?.Dispose();
        watcher = null;
        queue.Writer.TryComplete();
        settle.Dispose();
    }
}
