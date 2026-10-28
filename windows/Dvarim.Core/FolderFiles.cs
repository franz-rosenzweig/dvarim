using System.Text;
using System.Text.Json.Nodes;

namespace Dvarim.Core;

/// <summary>
/// The to-dos' folder itself: every file op of docs/BRIDGE.md §2 on the Windows
/// file system. No state but the root, so it is safe on the bridge's queue.
/// tools/bridge_sim.py is the reference, and when they differ the document
/// decides. Android's is android/…/PlainFiles.java and FolderBridge.java.
/// </summary>
public sealed class FolderFiles
{
    public static readonly HashSet<string> Ignored = [".obsidian", ".trash", ".git", ".stfolder", ".stversions", "node_modules"];
    public const string TempSuffix = ".dvarim-tmp";

    /// <summary>UTF-8 both ways: no byte-order mark added on writing; on reading, invalid bytes become U+FFFD and a BOM is kept.</summary>
    static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false);

    static readonly char[] NotInNames = ['<', '>', ':', '"', '|', '?', '*'];
    static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    public string Root { get; }
    public string Name { get; }
    readonly string realRoot;

    public FolderFiles(string root)
    {
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        Name = Path.GetFileName(Root) is { Length: > 0 } name ? name : Root;
        realRoot = Win32.FinalPath(Root) ?? Root;
    }

    public sealed class BridgeError(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    public static JsonObject Failure(string code, string message) =>
        new() { ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    static JsonObject Ok(JsonNode? value) => new() { ["ok"] = value };

    /// <summary>One message's reply: <c>{ok}</c>, or <c>{error: {code, message}}</c> with a message a person can act on.</summary>
    public JsonObject Answer(string op, JsonObject args)
    {
        try
        {
            switch (op)
            {
                case "list": return Ok(List());
                case "read": return Ok(Read(Text(args, "path")));
                case "readMany":
                    if (args["paths"] is not JsonArray paths) throw new BridgeError("EINVAL", "paths must be a list");
                    var many = new JsonArray();
                    foreach (var p in paths)
                        many.Add(Read(p is JsonValue v && v.TryGetValue(out string? s) ? s : throw new BridgeError("EINVAL", "paths must be strings")));
                    return Ok(many);
                case "write":
                    return Ok(Write(Text(args, "path"), Utf8.GetBytes(Text(args, "text"))));
                case "remove": Remove(Text(args, "path")); return Ok(null);
                case "move": Move(Text(args, "from"), Text(args, "to")); return Ok(null);
                case "mkdir": Mkdir(Text(args, "path")); return Ok(null);
                case "removeDir": return Ok(RemoveDir(Text(args, "path")));
                case "info": return Ok(Info());
                default: throw new BridgeError("ENOSYS", $"no such operation: {op}");
            }
        }
        catch (BridgeError e) { return Failure(e.Code, e.Message); }
        catch (UnauthorizedAccessException e) { return Failure("EACCES", Denied(e.Message)); }
        catch (IOException e)
        {
            var code = Win32.CodeFor(e.HResult & 0xFFFF);
            return Failure(code, code switch { "EACCES" => Denied(e.Message), "ENOSPC" => "the disk is full", _ => e.Message });
        }
        catch (Exception e) { return Failure("EIO", e.Message); }
    }

    string Denied(string why) =>
        $"Dvarim may not change {Name}: {why} Check that the file isn't read-only or open in another app, "
        + "and that you may write to the folder (File Explorer › Properties › Security).";

    static string Text(JsonObject args, string key) =>
        args[key] is JsonValue v && v.TryGetValue(out string? s) ? s : throw new BridgeError("EINVAL", $"{key} must be a string");

    /// <summary>
    /// What Settings → Data shows for a folder the person chose. The watcher says
    /// when the folder changes, so the page needn't poll; the shell makes the sync's
    /// requests and hears every change, for the tray, reminders and Quick Entry.
    /// </summary>
    public JsonObject Info() => new()
    {
        ["name"] = Name, ["detail"] = Root,
        ["canPick"] = true, ["canUseServer"] = true,
        ["pollSeconds"] = 0, ["http"] = true, ["calendars"] = false, ["changes"] = true,
    };

    // ---- paths -------------------------------------------------------------------

    /// <summary>A path in the folder as a full path inside the root, or EINVAL (docs/BRIDGE.md, Paths).</summary>
    public string Full(string path)
    {
        var segments = path.Split('/');
        if (path.Length == 0 || path[0] == '/' || path.Contains('\\') || path.Contains('\0')
            || segments.Any(s => s is "" or "." or ".."))
            throw new BridgeError("EINVAL", $"not a path inside the folder: {path}");
        foreach (var segment in segments) CheckName(segment);
        var full = Path.Join(Root, path.Replace('/', Path.DirectorySeparatorChar));
        // and still inside once every link and junction along it is followed
        if (!Inside(Win32.Resolve(full)))
            throw new BridgeError("EINVAL", $"outside the folder: {path}");
        return full;
    }

    /// <summary>A name Windows can keep, or EINVAL saying why not: a Mac or a phone allows names Windows doesn't.</summary>
    static void CheckName(string name)
    {
        string? why = null;
        if (name.IndexOfAny(NotInNames) >= 0 || name.Any(c => c < ' ')) why = "it has one of < > : \" | ? *";
        else if (name.EndsWith('.') || name.EndsWith(' ')) why = "it ends with a dot or a space";
        else if (Reserved.Contains(name.Split('.')[0].TrimEnd())) why = "Windows keeps that name for itself";
        if (why != null) throw new BridgeError("EINVAL", $"Windows can't use “{name}” as a name: {why}");
    }

    bool Inside(string real)
    {
        if (string.Equals(real, realRoot, StringComparison.OrdinalIgnoreCase)) return true;
        var prefix = Path.EndsInDirectorySeparator(realRoot) ? realRoot : realRoot + Path.DirectorySeparatorChar;
        return real.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    static string Parent(string path) => path.Contains('/') ? path[..path.LastIndexOf('/')] : "";

    // ---- the ops -----------------------------------------------------------------

    public JsonObject List()
    {
        if (!Directory.Exists(Root)) throw new BridgeError("EACCES", $"cannot read {Name}: it isn't there any more");
        var files = new JsonArray();
        var dirs = new JsonArray();
        // hidden and system entries too: Syncthing marks .stfolder hidden, and .dvarim must be listed
        var options = new EnumerationOptions { AttributesToSkip = 0, IgnoreInaccessible = true, RecurseSubdirectories = false };
        var pending = new Stack<(string Full, string Rel)>();
        pending.Push((Root, ""));
        while (pending.Count > 0)
        {
            var (dir, rel) = pending.Pop();
            foreach (var entry in new DirectoryInfo(dir).EnumerateFileSystemInfos("*", options))
            {
                var path = rel.Length == 0 ? entry.Name : rel + "/" + entry.Name;
                if (entry is DirectoryInfo folder)
                {
                    dirs.Add(path);
                    // listed, not looked inside: the folders the page never reads, and a link
                    // or junction to a folder, which may lead out of the folder
                    if (!Ignored.Contains(entry.Name) && folder.LinkTarget == null) pending.Push((folder.FullName, path));
                }
                else if (!entry.Name.EndsWith(TempSuffix, StringComparison.Ordinal))
                {
                    files.Add(path);
                }
            }
        }
        return new JsonObject { ["files"] = files, ["dirs"] = dirs };
    }

    public JsonObject? Read(string path)
    {
        var full = Full(path);
        var data = Load(full);
        return data == null ? null : new JsonObject { ["text"] = Utf8.GetString(data), ["mtime"] = Mtime(full) };
    }

    static byte[]? Load(string full)
    {
        if (Directory.Exists(full)) return null;
        return Retry(() =>
        {
            try
            {
                // beside whoever else has it open: Obsidian, Syncthing, a backup
                using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var copy = new MemoryStream();
                stream.CopyTo(copy);
                return copy.ToArray();
            }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        });
    }

    public JsonObject Write(string path, byte[] data)
    {
        var full = Full(path);
        MakeDirectories(Parent(path));
        if (Directory.Exists(full)) throw new BridgeError("EEXIST", $"a folder is where the file should be: {path}");
        // exactly these bytes, atomically: written beside it under a name of
        // our own, then moved over it
        var temp = Path.Join(Path.GetDirectoryName(full), "." + Guid.NewGuid().ToString("N") + TempSuffix);
        try
        {
            File.WriteAllBytes(temp, data);
            var error = Win32.Move(temp, full, replace: true);
            // Another app has the file open and won't let it be replaced (some editors,
            // a backup or a virus scan): write over it in place rather than lose the change.
            if (error != 0 && !(Win32.Busy(error) && Overwrite(full, data))) throw Fail(error, "save", path);
        }
        finally
        {
            try { if (File.Exists(temp)) File.Delete(temp); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return new JsonObject { ["mtime"] = Mtime(full) };
    }

    static bool Overwrite(string full, byte[] data)
    {
        try
        {
            using var stream = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            stream.Write(data);
            return true;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    public void Remove(string path)
    {
        var full = Full(path);
        // a file; quiet if it isn't there
        if (Directory.Exists(full) || !File.Exists(full)) return;
        Retry(() => { File.Delete(full); return 0; });
    }

    public void Move(string from, string to)
    {
        var a = Full(from);
        var b = Full(to);
        var fromIsDir = Kind(a) ?? throw new BridgeError("ENOENT", $"not there: {from}");
        if (Kind(b) is { } toIsDir && !Win32.SameFile(a, b))
        {
            // A folder may take an empty folder's place, as rename(2) lets it;
            // nothing else is replaced. NTFS ignores case, so "draft.md" to
            // "Draft.md" finds the file itself at `to`: that is a rename of one
            // file, not a clash.
            var empty = toIsDir && !Directory.EnumerateFileSystemEntries(b).Any();
            if (!(fromIsDir && empty)) throw new BridgeError("EEXIST", $"already there: {to}");
            Directory.Delete(b);
        }
        MakeDirectories(Parent(to));
        var error = Win32.Move(a, b, replace: false);
        if (error != 0) throw Fail(error, "move", to);
    }

    public void Mkdir(string path)
    {
        Full(path);
        MakeDirectories(path);
    }

    public bool RemoveDir(string path)
    {
        var full = Full(path);
        if (!Directory.Exists(full)) return true;
        if (Directory.EnumerateFileSystemEntries(full).Any()) return false;
        Retry(() => { Directory.Delete(full); return 0; });
        return true;
    }

    /// <summary>True for a folder, false for a file, null for nothing there.</summary>
    static bool? Kind(string full) => Directory.Exists(full) ? true : File.Exists(full) ? false : null;

    /// <summary>Every folder along <c>path</c>, made where missing, each under its name as given.</summary>
    void MakeDirectories(string path)
    {
        if (path.Length == 0) return;
        var so = Root;
        foreach (var part in path.Split('/'))
        {
            so = Path.Join(so, part);
            if (Directory.Exists(so)) continue;
            if (File.Exists(so)) throw new BridgeError("EEXIST", $"a file is where a folder should be: {Path.GetRelativePath(Root, so).Replace('\\', '/')}");
            Directory.CreateDirectory(so);
        }
    }

    BridgeError Fail(int error, string what, string path)
    {
        var code = Win32.CodeFor(error);
        var why = Win32.Message(error);
        return new BridgeError(code, code switch
        {
            "EACCES" => $"Dvarim may not {what} {path} in {Name}: {why}. Check that it isn't read-only, or open in another app that holds on to it.",
            "ENOSPC" => "the disk is full",
            _ => $"could not {what} {path}: {why}",
        });
    }

    /// <summary>Again, a little later, while another app (a virus scan, the search indexer, Syncthing) has the file for a moment.</summary>
    static T Retry<T>(Func<T> f)
    {
        for (var i = 0; ; i++)
        {
            try { return f(); }
            catch (IOException e) when (i < 5 && Win32.Busy(e.HResult & 0xFFFF)) { Thread.Sleep(15 << i); }
        }
    }

    static double Mtime(string full) => Ms(File.GetLastWriteTimeUtc(full));

    static double Ms(DateTime utc) => (utc - DateTime.UnixEpoch).TotalMilliseconds;
}
