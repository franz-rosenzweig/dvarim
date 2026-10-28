// The tests of windows/Dvarim.Core: every file op of docs/BRIDGE.md on a scratch
// folder; the Windows edges (names Windows refuses, a junction out of the folder,
// a file another app holds open, a read-only file, case); the same ops through
// tools/bridge_sim.py, the reference, compared answer for answer; and the copy's
// names, the server's address, reminders, the Quick Entry shortcut and
// Credential Manager.
//
//   dotnet run --project windows/Tests [-- --repo PATH]
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Dvarim.Core;

var failures = 0;
var scratch = new List<string>();

void Check(bool ok, string what, string detail = "")
{
    Console.WriteLine($"{(ok ? "ok  " : "FAIL")}  {what}{(ok || detail.Length == 0 ? "" : $"  ({detail})")}");
    if (!ok) failures++;
}

string Scratch()
{
    var dir = Path.Join(Path.GetTempPath(), "dvarim-tests-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(dir);
    scratch.Add(dir);
    return dir;
}

JsonObject Args(params (string Key, JsonNode? Value)[] pairs)
{
    var o = new JsonObject();
    foreach (var (k, v) in pairs) o[k] = v;
    return o;
}

string? Code(JsonObject reply) => reply["error"]?["code"]?.GetValue<string>();
string? TextOf(JsonObject reply) => reply["ok"]?["text"]?.GetValue<string>();
HashSet<string> Strings(JsonNode? list) => (list as JsonArray ?? new JsonArray()).Select(n => n!.GetValue<string>()).ToHashSet();

var repo = args.SkipWhile(a => a != "--repo").Skip(1).FirstOrDefault() ?? FindRepo();

try
{
    var root = Scratch();
    var f = new FolderFiles(root);

    // ---- write and read: exactly the bytes, a BOM and \r\n kept, names as written
    var texts = new (string Name, string Text)[]
    {
        ("Inbox.md", "- [ ] Call Dana 🆔 aa11bb22\n"), ("Windows.md", "- [ ] Windows\r\n- [ ] line endings\r\n"), ("bom.md", "\uFEFF# With a BOM\n"),
        ("\u05E9\u05DC\u05D5\u05DD.md", "\u05E9\u05DC\u05D5\u05DD\n"), ("Caf\u00E9.md", "Caf\u00E9\n"), ("party \U0001F389.md", "\U0001F389\n"),
        ("a & b #1 50%.md", "&\n"), ("it's (really).md", "'\n"), (".hidden.md", "hidden\n"), ("no extension", "none\n"),
    };
    foreach (var (name, text) in texts)
    {
        var w = f.Answer("write", Args(("path", "Areas/" + name), ("text", text)));
        Check(w["ok"]?["mtime"] != null, $"write {name}", w.ToJsonString());
        var disk = File.ReadAllBytes(Path.Join(root, "Areas", name));
        Check(disk.SequenceEqual(Encoding.UTF8.GetBytes(text)), $"{name} holds exactly the bytes written");
        Check(TextOf(f.Answer("read", Args(("path", "Areas/" + name)))) == text, $"read {name} back as written");
    }
    var many = f.Answer("readMany", Args(("paths", new JsonArray("Areas/Inbox.md", "Areas/nothing.md", "Areas/bom.md"))));
    var answers = many["ok"] as JsonArray;
    Check(answers is { Count: 3 } && answers[1] == null && answers[0]?["text"]?.GetValue<string>() == "- [ ] Call Dana 🆔 aa11bb22\n", "readMany answers each path in order, null for none");
    Check(f.Answer("read", Args(("path", "Areas/nothing.md")))["ok"] == null && Code(f.Answer("read", Args(("path", "Areas/nothing.md")))) == null,
        "read of no such file is null, not an error");
    Check(f.Answer("read", Args(("path", "Areas")))["ok"] == null, "read of a folder is null");
    File.WriteAllBytes(Path.Join(root, "Areas", "latin1.md"), new byte[] { 0x43, 0x61, 0x66, 0xE9, 0x0A });
    Check(TextOf(f.Answer("read", Args(("path", "Areas/latin1.md")))) == "Caf\uFFFD\n", "a file that isn't UTF-8 reads with a replacement character");

    // ---- list: everything, empty folders too; .dvarim yes; inside .git no; our temporary files never
    File.WriteAllText(Path.Join(root, "Areas", ".0123.dvarim-tmp"), "half");
    Directory.CreateDirectory(Path.Join(root, ".git", "objects"));
    File.WriteAllText(Path.Join(root, ".git", "objects", "ab"), "x");
    Directory.CreateDirectory(Path.Join(root, ".dvarim"));
    File.WriteAllText(Path.Join(root, ".dvarim", "state.json"), "{}");
    Directory.CreateDirectory(Path.Join(root, "Empty"));
    var list = f.Answer("list", new JsonObject())["ok"]!;
    var files = Strings(list["files"]);
    var dirs = Strings(list["dirs"]);
    Check(files.Contains("Areas/Caf\u00E9.md") && files.Contains("Areas/\u05E9\u05DC\u05D5\u05DD.md"), "list gives names as they were written (NFC)");
    Check(files.Contains(".dvarim/state.json"), "list includes .dvarim/");
    Check(dirs.Contains(".git") && !dirs.Contains(".git/objects") && !files.Contains(".git/objects/ab"), "list names .git but doesn't look inside");
    Check(dirs.Contains("Empty") && dirs.Contains("Areas"), "list includes empty folders");
    Check(!files.Any(p => p.EndsWith(".dvarim-tmp")), "list leaves out temporary files");
    Check(list is JsonObject { Count: 2 }, "list answers files and dirs, as docs/BRIDGE.md has it", list.ToJsonString().Length > 200 ? "" : list.ToJsonString());

    // ---- move
    f.Answer("write", Args(("path", "Areas/draft.md"), ("text", "d")));
    Check(f.Answer("move", Args(("from", "Areas/draft.md"), ("to", "Archive/2026/draft.md"))).ContainsKey("ok")
        && File.Exists(Path.Join(root, "Archive", "2026", "draft.md")) && !File.Exists(Path.Join(root, "Areas", "draft.md")),
        "move a file, making the folders it goes to");
    f.Answer("write", Args(("path", "Areas/taken.md"), ("text", "t")));
    Check(Code(f.Answer("move", Args(("from", "Areas/Inbox.md"), ("to", "Areas/taken.md")))) == "EEXIST"
        && File.ReadAllText(Path.Join(root, "Areas", "taken.md")) == "t", "move onto a file is EEXIST, with nothing changed");
    Check(Code(f.Answer("move", Args(("from", "Areas/gone.md"), ("to", "Areas/here.md")))) == "ENOENT", "move from nothing is ENOENT");
    f.Answer("write", Args(("path", "Group/one.md"), ("text", "1")));
    f.Answer("mkdir", Args(("path", "Renamed")));
    Check(f.Answer("move", Args(("from", "Group"), ("to", "Renamed"))).ContainsKey("ok") && File.Exists(Path.Join(root, "Renamed", "one.md")),
        "a folder may take an empty folder's place");
    f.Answer("write", Args(("path", "Full/two.md"), ("text", "2")));
    Check(Code(f.Answer("move", Args(("from", "Renamed"), ("to", "Full")))) == "EEXIST", "a folder may not take a full folder's place");
    f.Answer("write", Args(("path", "Areas/lower.md"), ("text", "l")));
    f.Answer("move", Args(("from", "Areas/lower.md"), ("to", "Areas/Lower.md")));
    var afterCase = Strings(f.Answer("list", new JsonObject())["ok"]!["files"]);
    Check(afterCase.Contains("Areas/Lower.md") && !afterCase.Contains("Areas/lower.md"), "a rename by case alone is a rename, not a clash");
    f.Answer("move", Args(("from", "Renamed"), ("to", "renamed")));
    Check(Strings(f.Answer("list", new JsonObject())["ok"]!["dirs"]).Contains("renamed"), "a folder renamed by case alone");

    // ---- remove, mkdir, removeDir
    Check(f.Answer("remove", Args(("path", "Areas/never.md"))).ContainsKey("ok"), "remove of nothing is quiet");
    f.Answer("remove", Args(("path", "Areas/taken.md")));
    Check(!File.Exists(Path.Join(root, "Areas", "taken.md")), "remove a file");
    f.Answer("remove", Args(("path", "Full")));
    Check(Directory.Exists(Path.Join(root, "Full")), "remove leaves a folder alone");
    f.Answer("mkdir", Args(("path", "A/B/C")));
    Check(Directory.Exists(Path.Join(root, "A", "B", "C")) && f.Answer("mkdir", Args(("path", "A/B"))).ContainsKey("ok"), "mkdir makes the parents, and is quiet if there");
    Check(f.Answer("removeDir", Args(("path", "A")))["ok"]?.GetValue<bool>() == false, "removeDir of a full folder is false");
    Check(f.Answer("removeDir", Args(("path", "A/B/C")))["ok"]?.GetValue<bool>() == true && !Directory.Exists(Path.Join(root, "A", "B", "C")), "removeDir of an empty folder");
    Check(f.Answer("removeDir", Args(("path", "Nowhere")))["ok"]?.GetValue<bool>() == true, "removeDir of nothing is true");
    Check(Code(f.Answer("mkdir", Args(("path", "Areas/Inbox.md/inside")))) == "EEXIST", "a file where a folder should be is EEXIST");

    // ---- paths the bridge refuses
    foreach (var bad in new[] { "", "/abs.md", "a/../b.md", "../out.md", "a\\b.md", "a//b.md", "./a.md", "a/", "C:/x.md", "a:b.md",
                                "con.md", "CON", "nul.txt", "lpt1", "trailing.", "trailing ", "tab\there.md", "what?.md", "quote\".md" })
        Check(Code(f.Answer("read", Args(("path", bad)))) == "EINVAL", $"refuses the path \"{bad.Replace("\t", "\\t")}\"");
    Check(Code(f.Answer("write", Args(("path", "x.md")))) == "EINVAL", "write without text is EINVAL");
    Check(Code(f.Answer("frobnicate", new JsonObject())) == "ENOSYS", "an op it doesn't know is ENOSYS");

    // ---- a junction out of the folder: followed, and refused
    var outside = Scratch();
    File.WriteAllText(Path.Join(outside, "secret.txt"), "secret");
    var link = Path.Join(root, "link");
    using (var mk = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{outside}\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true })!)
        mk.WaitForExit();
    if (Directory.Exists(link))
    {
        Check(Code(f.Answer("read", Args(("path", "link/secret.txt")))) == "EINVAL", "a read through a junction out of the folder is refused");
        Check(Code(f.Answer("write", Args(("path", "link/new.md"), ("text", "x")))) == "EINVAL" && !File.Exists(Path.Join(outside, "new.md")),
            "a write through a junction out of the folder is refused, and nothing lands outside");
        var linked = f.Answer("list", new JsonObject())["ok"]!;
        Check(Strings(linked["dirs"]).Contains("link") && !Strings(linked["files"]).Any(p => p.StartsWith("link/")), "list names a junction but doesn't follow it");
    }
    else Check(false, "make a junction to test with", "mklink /J failed");

    // ---- a file another app holds open
    f.Answer("write", Args(("path", "held.md"), ("text", "one")));
    var held = Path.Join(root, "held.md");
    using (new FileStream(held, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))      // may be written, not replaced
    {
        var w = f.Answer("write", Args(("path", "held.md"), ("text", "two")));
        Check(w.ContainsKey("ok") && TextOf(f.Answer("read", Args(("path", "held.md")))) == "two", "a file held open (without delete sharing) is written in place", w.ToJsonString());
    }
    using (new FileStream(held, FileMode.Open, FileAccess.Read, FileShare.Read))           // may not be written at all
    {
        var w = f.Answer("write", Args(("path", "held.md"), ("text", "three")));
        Check(Code(w) == "EACCES", "a file locked by another app is EACCES, with a message", w.ToJsonString());
    }
    Check(!Strings(f.Answer("list", new JsonObject())["ok"]!["files"]).Any(p => p.EndsWith(".dvarim-tmp")), "no temporary file is left behind");

    // ---- a read-only file
    f.Answer("write", Args(("path", "ro.md"), ("text", "ro")));
    var ro = Path.Join(root, "ro.md");
    File.SetAttributes(ro, FileAttributes.ReadOnly);
    var roWrite = f.Answer("write", Args(("path", "ro.md"), ("text", "changed")));
    Check(Code(roWrite) == "EACCES" && File.ReadAllText(ro) == "ro", "a read-only file is EACCES, and unchanged", roWrite.ToJsonString());
    File.SetAttributes(ro, FileAttributes.Normal);

    // ---- info
    var info = f.Answer("info", new JsonObject())["ok"]!;
    Check(info["name"]?.GetValue<string>() == Path.GetFileName(root) && info["pollSeconds"]?.GetValue<int>() == 0 && info["canPick"]?.GetValue<bool>() == true,
        "info names the folder and says the shell watches it");
    Check(info["http"]?.GetValue<bool>() == true && info["changes"]?.GetValue<bool>() == true && info["calendars"]?.GetValue<bool>() == false,
        "info offers http and wants changed, and has no calendars");

    // ---- the http op's address rules
    Check(ShellHttp.IsPrivate([100, 91, 202, 11]) && ShellHttp.IsPrivate([192, 168, 1, 2]) && ShellHttp.IsPrivate([127, 0, 0, 1]), "tailnet, LAN and loopback addresses are private");
    Check(!ShellHttp.IsPrivate([8, 8, 8, 8]) && !ShellHttp.IsPrivate([100, 128, 0, 1]), "public addresses are not");
    Check(ShellHttp.IsPrivate(System.Net.IPAddress.Parse("fd7a:115c:a1e0::1").GetAddressBytes())
        && ShellHttp.IsPrivate(System.Net.IPAddress.Parse("::1").GetAddressBytes())
        && ShellHttp.IsPrivate(System.Net.IPAddress.Parse("::ffff:10.0.0.1").GetAddressBytes())
        && !ShellHttp.IsPrivate(System.Net.IPAddress.Parse("2001:db8::1").GetAddressBytes()), "IPv6: the tailnet, loopback and mapped IPv4");
    Check(await ShellHttp.IsPrivate("localhost") && await ShellHttp.IsPrivate("app.localhost"), "localhost is private");
    var plain = await ShellHttp.Answer(Args(("url", "http://example.com/"), ("method", "GET")));
    Check(Code(plain) == "EINVAL", "plain http to the internet is refused");

    // ---- the reference: the same messages through tools/bridge_sim.py
    CrossCheck();

    // ---- the copy's names (android/…/AppCopy.java, mac/Native/Account.swift)
    Check(CopyNames.PersonKey(null) == "owner" && CopyNames.PersonKey(JsonNode.Parse("""{"name":"Nate","owner":true}""")) == "owner",
        "the server's owner keeps the copy called owner");
    Check(CopyNames.PersonKey(JsonNode.Parse("""{"name":"Dana","owner":false,"uid":"U7Q2"}""")) == "u7q2"
        && CopyNames.PersonKey(JsonNode.Parse("""{"name":"Dana Levi","owner":false}""")) == "dana levi",
        "someone else's copy is called by their account's id, else their name, lowercased");
    Check(CopyNames.PersonKey(JsonNode.Parse("""{"name":"Dana"}""")) == "owner", "a person with no word on being the owner is the owner, as backend.js has it");
    Check(CopyNames.DeviceName("Nate-PC") == "Nate-PC (Windows)" && CopyNames.DeviceName("") == "PC (Windows)", "the device is named for the PC");
    var odd = CopyNames.DeviceName("DESKTOP/ÉTÉ:9!@#  very-long-name-for-a-computer");
    Check(System.Text.RegularExpressions.Regex.IsMatch(CopyNames.DeviceName(odd, 9), @"^[\p{L}\p{N} ._'’()-]{1,40}$"), "a device name is one the server takes, even with \" 9\"", CopyNames.DeviceName(odd, 9));
    Check(CopyNames.DeviceName("Nate-PC (Windows)", 1) == "Nate-PC (Windows)" && CopyNames.DeviceName("Nate-PC (Windows)", 2) == "Nate-PC (Windows) 2", "a name taken: the next number");
    Check(CopyNames.Folder(@"C:\D\Copies", new Uri("https://dvarim.example.com"), "owner") == @"C:\D\Copies\dvarim.example.com\owner"
        && CopyNames.Folder(@"C:\D\Copies", new Uri("http://127.0.0.1:8421"), "dana levi") == @"C:\D\Copies\127.0.0.1-8421\dana levi",
        "the copy's folder is <host[-port]>\\<who>");
    Check(CopyNames.Safe(".hidden") == "_hidden" && CopyNames.Safe("a:b/c") == "a-b-c" && CopyNames.Safe("") == "_", "folder names are safe");

    // ---- the server's address (android/…/Server.java)
    Check(ServerAddress.Parse("dvarim.example.com")?.AbsoluteUri == "https://dvarim.example.com/", "a bare name is https");
    Check(ServerAddress.Parse(" https://dvarim.example.com:443/today?x=1 ")?.AbsoluteUri == "https://dvarim.example.com/", "the path goes, and :443 with it");
    Check(ServerAddress.Parse("https://dvarim.example.com:8443")?.AbsoluteUri == "https://dvarim.example.com:8443/", "another port stays");
    Check(ServerAddress.Parse("http://dvarim.example.com") == null, "plain http to the internet is refused");
    Check(ServerAddress.Parse("http://127.0.0.1:8421") != null && ServerAddress.Parse("http://100.91.202.11") != null && ServerAddress.Parse("http://morten.tail1234.ts.net") != null,
        "plain http to this PC, the local network or the tailnet is allowed");
    Check(ServerAddress.Parse("") == null && ServerAddress.Parse("ftp://x.example") == null && ServerAddress.Parse("https://") == null, "what isn't an address is null");
    Check(ServerAddress.Text(new Uri("https://dvarim.example.com/")) == "https://dvarim.example.com", "an origin is written without a slash");
    Check(ServerAddress.SameOrigin(new Uri("https://A.example/x"), new Uri("https://a.example:443/")) && !ServerAddress.SameOrigin(new Uri("https://a.example"), new Uri("https://a.example:8443")),
        "the same origin: scheme, host and port");

    // ---- reminders from Today and Upcoming
    var todayJson = JsonNode.Parse("""
        {"date":"2026-10-27","items":[
          {"id":"aa11bb22","title":"Call Dana","status":"open","when":"2026-10-27","reminder":"15:00","projectName":"Annual report","areaName":"Work"},
          {"id":"cc33dd44","title":"Done already","status":"done","when":"2026-10-27","reminder":"09:00"},
          {"id":"ee55ff66","title":"No reminder","status":"open","when":"2026-10-27","reminder":null},
          {"id":"gg77hh88","title":"Left from yesterday","status":"open","when":"2026-10-26","reminder":"18:30","projectName":null,"areaName":"Home"}
        ]}
        """);
    var upcomingJson = JsonNode.Parse("""
        {"days":[
          {"date":"2026-10-27","items":[{"id":"aa11bb22","title":"Call Dana","status":"open","when":"2026-10-27","reminder":"15:00"}]},
          {"date":"2026-10-29","items":[{"id":"ii99jj00","title":"Dentist","status":"open","when":"2026-10-29","reminder":"08:15"}]}
        ]}
        """);
    var plan = ReminderPlan.From(todayJson, upcomingJson);
    Check(plan.Count == 3, "the open to-dos with a reminder, from today on, each once", string.Join(", ", plan.Select(r => r.Key)));
    Check(plan.Count == 3 && plan[0].Key == "gg77hh88@2026-10-26T18:30" && plan[1].Due == new DateTime(2026, 10, 27, 15, 0, 0, DateTimeKind.Local) && plan[2].Title == "Dentist",
        "in order, at the to-do's own day and time on this PC's clock");
    Check(plan.Count == 3 && plan[1].Sub == "Annual report" && plan[0].Sub == "Home" && plan[2].Sub == "", "under the title, the project, else the area");
    Check(ReminderPlan.Local("2026-02-30", "10:00") == null && ReminderPlan.Local("2026-10-27", "25:00") == null, "a date or time that isn't one is no reminder");
    Check(ReminderPlan.From(null, null).Count == 0, "nothing kept, no reminders");

    // ---- Quick Entry's shortcut
    Check(HotKey.Parse("Ctrl+Alt+Space") == HotKey.Default && HotKey.Default.ToString() == "Ctrl+Alt+Space", "Ctrl+Alt+Space, both ways");
    Check(HotKey.Parse("win + shift + n") is { } wsn && wsn.ToString() == "Shift+Win+N" && HotKey.Parse("Ctrl+F9")?.Key == 0x78, "other shortcuts, written the one way");
    Check(HotKey.Parse("Shift+A") == null && HotKey.Parse("Space") == null && HotKey.Parse("Ctrl+Alt") == null && HotKey.Parse("Ctrl+Tab") == null && HotKey.Parse("Ctrl+A+B") == null,
        "a shortcut needs Ctrl, Alt or Win and one key it knows");

    // ---- Credential Manager
    var target = "Dvarim tests " + Guid.NewGuid().ToString("N");
    try
    {
        Credentials.Write(target, "owner", "dvt_test-token-\u05D0");
        Check(Credentials.Read(target) == "dvt_test-token-\u05D0", "a token kept in Credential Manager comes back");
        Credentials.Write(target, "owner", "dvt_second");
        Check(Credentials.Read(target) == "dvt_second", "keeping it again replaces it");
        Credentials.Delete(target);
        Check(Credentials.Read(target) == null, "and once forgotten, it's gone");
        Credentials.Delete(target);
        Check(true, "forgetting what isn't there is quiet");
    }
    catch (Exception e)
    {
        Check(false, "Credential Manager keeps the token", e.Message);
        try { Credentials.Delete(target); } catch (Exception) { }
    }
}
finally
{
    foreach (var dir in scratch)
        try { Directory.Delete(dir, recursive: true); } catch (Exception) { }
}

Console.WriteLine(failures == 0 ? "\nall passed" : $"\n{failures} failed");
return failures == 0 ? 0 : 1;

void CrossCheck()
{
    if (repo == null || !File.Exists(Path.Join(repo, "tools", "bridge_sim.py"))) { Console.WriteLine("skip  the reference: no tools/bridge_sim.py (--repo)"); return; }
    // what both answer alike on Windows: not a folder onto an empty one (Python's rename can't
    // replace a folder there) nor a rename by case (the reference sees a clash), which the tests above cover
    var messages = new JsonArray(
        Msg("mkdir", ("path", "Areas/Work")),
        Msg("write", ("path", "Areas/Work/Launch.md"), ("text", "# Launch\n\n- [ ] Book the room 🆔 aa11bb22\n")),
        Msg("write", ("path", "Areas/\u05E9\u05DC\u05D5\u05DD.md"), ("text", "- [ ] \u05E9\u05DC\u05D5\u05DD\r\n")),
        Msg("write", ("path", "Inbox.md"), ("text", "\uFEFF- [ ] bom")),
        Msg("read", ("path", "Areas/Work/Launch.md")),
        Msg("read", ("path", "Areas/missing.md")),
        Msg("readMany", ("paths", new JsonArray("Areas/Work/Launch.md", "nope.md", "Areas/\u05E9\u05DC\u05D5\u05DD.md", "Inbox.md"))),
        Msg("move", ("from", "Areas/Work/Launch.md"), ("to", "Areas/b.md")),
        Msg("move", ("from", "Areas/missing.md"), ("to", "Areas/c.md")),
        Msg("write", ("path", "Areas/c.md"), ("text", "c")),
        Msg("move", ("from", "Areas/b.md"), ("to", "Areas/c.md")),
        Msg("move", ("from", "Areas/b.md"), ("to", "Elsewhere/Deeper/b.md")),
        Msg("removeDir", ("path", "Areas")),
        Msg("removeDir", ("path", "Areas/Work")),
        Msg("remove", ("path", "Areas/c.md")),
        Msg("remove", ("path", "Areas/c.md")),
        Msg("removeDir", ("path", "Nowhere")),
        Msg("mkdir", ("path", ".dvarim/conflicts")),
        Msg("read", ("path", "../outside.md")),
        Msg("read", ("path", "a/./b.md")),
        Msg("list"),
        Msg("frobnicate"));

    var mine = new JsonArray();
    var f = new FolderFiles(Scratch());
    foreach (var m in messages) mine.Add(f.Answer(m!["op"]!.GetValue<string>(), m["args"]?.DeepClone() as JsonObject ?? new JsonObject()));

    var reference = Scratch();
    var ops = Path.Join(Scratch(), "ops.json");
    File.WriteAllText(ops, messages.ToJsonString(), new UTF8Encoding(false));
    var code = "import sys, json\nsys.path.insert(0, sys.argv[3])\nimport bridge_sim as b\nfrom pathlib import Path\n"
        + "f = b.Folder(Path(sys.argv[1]))\nops = json.load(open(sys.argv[2], encoding='utf-8'))\n"
        + "print(json.dumps([b.answer(f, m, {}) for m in ops], ensure_ascii=False))";
    var start = new ProcessStartInfo("python") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8 };
    // -X utf8 rather than PYTHONIOENCODING, which -I ignores: or Python writes Hebrew in the Windows code page
    foreach (var a in new[] { "-X", "utf8", "-I", "-c", code, reference, ops, Path.Join(repo, "tools") }) start.ArgumentList.Add(a);
    string output, errors;
    try
    {
        using var python = Process.Start(start)!;
        output = python.StandardOutput.ReadToEnd();
        errors = python.StandardError.ReadToEnd();
        python.WaitForExit();
    }
    catch (System.ComponentModel.Win32Exception) { Console.WriteLine("skip  the reference: no python"); return; }
    // Windows' stand-in that offers Python from the Store, rather than Python
    if (output.Trim().Length == 0 && errors.Contains("Microsoft Store")) { Console.WriteLine("skip  the reference: no python"); return; }
    if (JsonNode.Parse(output.Trim().Length > 0 ? output : "null") is not JsonArray theirs) { Check(false, "the reference answered", errors.Trim()); return; }

    for (var i = 0; i < messages.Count; i++)
    {
        var a = Normal(mine[i]);
        var b = Normal(theirs[i]);
        Check(a == b, $"same answer as the reference: {messages[i]!["op"]} {messages[i]!["args"]?.ToJsonString() ?? ""}", $"mine {a}, the reference's {b}");
    }
}

static JsonObject Msg(string op, params (string Key, JsonNode? Value)[] pairs)
{
    var args = new JsonObject();
    foreach (var (k, v) in pairs) args[k] = v;
    return new JsonObject { ["v"] = 1, ["op"] = op, ["args"] = args };
}

// An answer with what may differ taken out: mtimes, the words of an error (its code stays), the order of a listing.
static string Normal(JsonNode? reply)
{
    var copy = reply?.DeepClone();
    if (copy is JsonObject o)
    {
        if (o["error"] is JsonObject e) e.Remove("message");
        if (o["ok"] is JsonObject ok && ok.ContainsKey("files"))
            foreach (var key in new[] { "files", "dirs" })
                ok[key] = new JsonArray((ok[key] as JsonArray ?? new JsonArray()).Select(n => n!.GetValue<string>()).Order(StringComparer.Ordinal).Select(s => (JsonNode?)s).ToArray());
    }
    Strip(copy);
    return copy?.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }) ?? "null";
}

static void Strip(JsonNode? node)
{
    if (node is JsonObject o)
    {
        o.Remove("mtime");
        foreach (var (_, v) in o.ToList()) Strip(v);
    }
    else if (node is JsonArray a) foreach (var v in a) Strip(v);
}

static string? FindRepo()
{
    for (var dir = new DirectoryInfo(Environment.CurrentDirectory); dir != null; dir = dir.Parent)
        if (File.Exists(Path.Join(dir.FullName, "tools", "bridge_sim.py"))) return dir.FullName;
    return null;
}
