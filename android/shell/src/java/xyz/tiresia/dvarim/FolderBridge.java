package xyz.tiresia.dvarim;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The folder bridge of docs/BRIDGE.md, Android's half: the page's storage
 * messages answered from a Storage Access Framework tree, one at a time and in
 * the order sent (a single-thread executor), replies sent back by id through
 * window.__dvarimStorageReply. tools/bridge_sim.py is the reference; when they
 * differ, the document decides.
 *
 * Two things SAF cannot do that a real folder can, and what is done instead:
 *  - no atomic replace: a file is rewritten in place ("wt") and its size checked
 *    afterwards, so a write that went short is reported rather than trusted;
 *  - no change notifications: info() asks the page to rescan every 15 s while
 *    in front, and FolderActivity asks it to on every resume.
 *
 * Since phases 5 and 6 it also makes the page's sync requests (op http,
 * ShellHttp), reads the phone's calendars (ops calendars and events,
 * DeviceCalendars), and hears when the vault changed (op changed), which
 * FolderActivity answers by keeping the page's lists for reminders and the
 * widget (Local). Those run beside the queue, not in it: a slow server must
 * not hold up the folder, nor the folder a sync.
 */
final class FolderBridge {
    interface Reply { void ok(String resultJson); }

    static final Set<String> IGNORED = new HashSet<>(Arrays.asList(
            ".obsidian", ".trash", ".git", ".stfolder", ".stversions", "node_modules"));
    private static final String[] COLUMNS = {
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_SIZE};

    private final FolderActivity activity;
    private final WebView web;
    private final Uri tree;                  // a folder the person chose, or
    private final PlainFiles plain;          // the app's own copy (AppCopy)
    private final String rootId;
    private final ContentResolver cr;
    private final ExecutorService queue = Executors.newSingleThreadExecutor();   // one at a time, in order
    private final ExecutorService beside = Executors.newCachedThreadPool();     // http, alongside the files
    private final ExecutorService calendar = Executors.newSingleThreadExecutor(); // one ask for the permission at a time
    private final ExecutorService kept = Executors.newSingleThreadExecutor();     // Local, reminders, the widget
    private final Map<String, Doc> known = new HashMap<>();                       // path → document, from the last walk

    private static final class Doc {
        final String id, name;
        final boolean dir;
        final long mtime, size;

        Doc(String id, String name, boolean dir, long mtime, long size) {
            this.id = id; this.name = name; this.dir = dir; this.mtime = mtime; this.size = size;
        }
    }

    static final class BridgeError extends Exception {
        final String code;

        BridgeError(String code, String message) { super(message); this.code = code; }
    }

    FolderBridge(FolderActivity activity, WebView web, Uri tree) {
        this.activity = activity;
        this.web = web;
        this.tree = tree;
        this.plain = null;
        this.rootId = DocumentsContract.getTreeDocumentId(tree);
        this.cr = activity.getContentResolver();
    }

    /** On the copy the app keeps in a folder of its own and syncs (AppCopy). */
    FolderBridge(FolderActivity activity, WebView web, java.io.File copy) {
        this.activity = activity;
        this.web = web;
        this.tree = null;
        this.plain = new PlainFiles(copy);
        this.rootId = null;
        this.cr = activity.getContentResolver();
    }

    void close() {
        queue.shutdown();
        beside.shutdown();
        calendar.shutdown();
        kept.shutdown();
    }

    /** From the page: a message now, its reply later (docs/BRIDGE.md, Transport). */
    @JavascriptInterface
    public void request(final int id, final String json) {
        JSONObject peek;
        try {
            peek = new JSONObject(json);
        } catch (JSONException e) {
            peek = null;
        }
        String op = peek == null || peek.optInt("v") != 1 ? "" : peek.optString("op");
        JSONObject args = peek == null || peek.optJSONObject("args") == null ? new JSONObject() : peek.optJSONObject("args");
        switch (op) {
            case "changed":
                send(id, "{\"ok\":null}");
                activity.runOnUiThread(activity::keepLists);
                return;
            case "http":
                beside.execute(() -> {
                    try {
                        // `session`: the app's sign-in, for what a token may not do
                        // (tokens, people), and only ever to the copy's own server
                        if (args.optBoolean("session")) {
                            if (!sameOrigin(args.optString("url"), Api.base(activity))) {
                                send(id, error("EACCES", "the sign-in goes only to " + Api.base(activity)));
                                return;
                            }
                            String cookie = Api.cookie(activity);
                            JSONObject headers = args.optJSONObject("headers") == null ? new JSONObject() : args.optJSONObject("headers");
                            if (cookie != null) headers.put("Cookie", cookie);
                            args.put("headers", headers);
                        }
                        send(id, new JSONObject().put("ok", ShellHttp.request(args)).toString());
                    } catch (ShellHttp.Refused e) {
                        send(id, error(e.code, e.getMessage()));
                    } catch (JSONException | RuntimeException e) {
                        send(id, error("EIO", String.valueOf(e.getMessage())));
                    }
                });
                return;
            case "calendars":
            case "events":
                calendar.execute(() -> {
                    try {
                        if (!activity.calendarAccess()) {
                            send(id, error("EACCES", "Dvarim may not read this phone's calendars. Allow it in Settings → Apps → Dvarim → Permissions → Calendar."));
                            return;
                        }
                        Object ok = "calendars".equals(op) ? DeviceCalendars.calendars(activity)
                                : DeviceCalendars.events(activity, args.optString("from"), args.optString("to"),
                                        args.isNull("calendars") ? null : args.optJSONArray("calendars"));
                        send(id, new JSONObject().put("ok", ok == null ? new JSONArray() : ok).toString());
                    } catch (SecurityException e) {
                        send(id, error("EACCES", "Dvarim may not read this phone's calendars. Allow it in Settings → Apps → Dvarim → Permissions → Calendar."));
                    } catch (IOException | JSONException | RuntimeException e) {
                        send(id, error("EIO", String.valueOf(e.getMessage())));
                    }
                });
                return;
            case "signOut":
                // the copy's page has synced what it had (AppCopy.signOut)
                if (plain == null) {
                    send(id, error("ENOSYS", "only a copy kept by the app signs out"));
                    return;
                }
                send(id, "{\"ok\":null}");
                activity.runOnUiThread(activity::signOut);
                return;
            default:
                break;
        }
        queue.execute(() -> {
            String reply;
            try {
                JSONObject msg = new JSONObject(json);
                if (msg.optInt("v") != 1) {
                    reply = error("EPROTO", "this app speaks protocol 1, not " + msg.opt("v"));
                } else if ("pick".equals(msg.optString("op"))) {
                    // the picker is the activity's; the reply goes when it closes
                    activity.runOnUiThread(() -> activity.pickFolder(result -> send(id, "{\"ok\":" + result + "}")));
                    return;
                } else if ("useServer".equals(msg.optString("op"))) {
                    send(id, "{\"ok\":null}");
                    activity.runOnUiThread(activity::useServer);
                    return;
                } else {
                    reply = new JSONObject().put("ok", answer(msg.optString("op"), msg.optJSONObject("args"))).toString();
                }
            } catch (BridgeError e) {
                reply = error(e.code, e.getMessage());
            } catch (SecurityException e) {
                reply = error("EACCES", tree == null ? "Dvarim may not use its own folder: " + e.getMessage()
                        : "Dvarim no longer has access to " + Folder.name(activity, tree)
                        + ". Choose the folder again: Settings → Data → Choose another folder.");
            } catch (JSONException e) {
                reply = error("EINVAL", "not a bridge message: " + e.getMessage());
            } catch (IOException | RuntimeException e) {
                reply = error("EIO", String.valueOf(e.getMessage()));
            }
            send(id, reply);
        });
    }

    /**
     * From the page, through FolderActivity.keepLists: `[[path, status, body], …]`,
     * the lists reminders and the widget read while the app is closed. Kept,
     * and then those two told. Off the page's thread, which waits for this.
     */
    @JavascriptInterface
    public void keep(final String json) {
        final android.content.Context app = activity.getApplicationContext();
        kept.execute(() -> {
            try {
                JSONArray all = new JSONArray(json);
                for (int i = 0; i < all.length(); i++) {
                    JSONArray one = all.getJSONArray(i);
                    int status = one.optInt(1);
                    if (status >= 200 && status < 300) Local.keep(app, one.getString(0), one.getString(2));
                }
                Reminders.sync(app);
                TodayWidget.refresh(app);
            } catch (IOException | JSONException e) {
                android.util.Log.w("Dvarim", "could not keep the folder's lists", e);
            }
        });
    }

    /** From the page, through FolderActivity.drainOutbox: `[[id, status], …]`, how
     *  the ticks kept while the app was closed went. Done, or refused (deleted
     *  since, say), they are forgotten; one that failed waits for next time. */
    @JavascriptInterface
    public void sent(final String json) {
        final android.content.Context app = activity.getApplicationContext();
        kept.execute(() -> {
            try {
                JSONArray all = new JSONArray(json);
                Set<String> done = new HashSet<>();
                for (int i = 0; i < all.length(); i++) {
                    JSONArray one = all.getJSONArray(i);
                    int status = one.optInt(1);
                    if (status >= 200 && status < 500) done.add(one.getString(0));
                }
                Outbox.forgetSent(app, done);
            } catch (JSONException e) {
                android.util.Log.w("Dvarim", "could not read how the kept ticks went", e);
            }
        });
    }

    private void send(int id, String reply) {
        web.post(() -> web.evaluateJavascript(
                "window.__dvarimStorageReply(" + id + "," + JSONObject.quote(reply) + ")", null));
    }

    /** The same scheme, host and port. */
    static boolean sameOrigin(String a, String b) {
        Uri x = Uri.parse(a), y = Uri.parse(b);
        return x.getScheme() != null && x.getScheme().equalsIgnoreCase(y.getScheme())
                && x.getHost() != null && x.getHost().equalsIgnoreCase(y.getHost()) && port(x) == port(y);
    }

    private static int port(Uri u) {
        return u.getPort() != -1 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private static String error(String code, String message) {
        try {
            return new JSONObject().put("error", new JSONObject().put("code", code).put("message", message)).toString();
        } catch (JSONException e) {
            return "{\"error\":{\"code\":\"EIO\"}}";
        }
    }

    private Object answer(String op, JSONObject args) throws BridgeError, IOException, JSONException {
        if (args == null) args = new JSONObject();
        if (plain != null) {
            if (!"info".equals(op)) return plain.answer(op, args);
            // the app's own copy: named for what it is, and synced by the app's token
            JSONObject sync = AppCopy.syncInfo(activity);
            String host = sync == null ? "the server" : Uri.parse(sync.optString("address")).getHost();
            JSONObject info = new JSONObject().put("name", "This phone").put("detail", "Synced with " + host)
                    .put("canPick", true).put("canUseServer", true).put("pollSeconds", 0)
                    .put("http", true).put("calendars", true).put("changes", true);
            if (sync != null) info.put("sync", sync);
            return info;
        }
        switch (op) {
            case "list": return list();
            case "read": return orNull(read(path(args, "path")));
            case "readMany": {
                JSONArray paths = args.optJSONArray("paths");
                if (paths == null) throw new BridgeError("EINVAL", "paths must be a list");
                JSONArray out = new JSONArray();
                for (int i = 0; i < paths.length(); i++) out.put(orNull(read(check(paths.getString(i)))));
                return out;
            }
            case "write": {
                Object text = args.opt("text");
                if (!(text instanceof String)) throw new BridgeError("EINVAL", "text must be a string");
                return write(path(args, "path"), (String) text);
            }
            case "remove": remove(path(args, "path")); return JSONObject.NULL;
            case "move": move(path(args, "from"), path(args, "to")); return JSONObject.NULL;
            case "mkdir": dir(path(args, "path"), true); return JSONObject.NULL;
            case "removeDir": return removeDir(path(args, "path"));
            case "info":
                return new JSONObject().put("name", Folder.name(activity, tree)).put("detail", Folder.detail(activity, tree))
                        .put("canPick", true).put("canUseServer", true).put("pollSeconds", 15)
                        .put("http", true).put("calendars", true).put("changes", true);
            default: throw new BridgeError("ENOSYS", "no such operation: " + op);
        }
    }

    private static Object orNull(Object o) { return o == null ? JSONObject.NULL : o; }

    // ---- paths ----

    static String path(JSONObject args, String key) throws BridgeError {
        Object p = args.opt(key);
        if (!(p instanceof String)) throw new BridgeError("EINVAL", key + " must be a string");
        return check((String) p);
    }

    /** docs/BRIDGE.md, Paths: relative, '/'-separated, no empty, '.' or '..' segment. */
    static String check(String p) throws BridgeError {
        if (p.isEmpty() || p.startsWith("/") || p.contains("\\") || p.indexOf('\0') >= 0) throw bad(p);
        for (String seg : p.split("/", -1)) if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) throw bad(p);
        return p;
    }

    private static BridgeError bad(String p) { return new BridgeError("EINVAL", "not a path inside the vault: " + p); }

    private static String parentOf(String p) { int i = p.lastIndexOf('/'); return i < 0 ? "" : p.substring(0, i); }

    private static String nameOf(String p) { return p.substring(p.lastIndexOf('/') + 1); }

    // ---- the provider ----

    private Uri docUri(String id) { return DocumentsContract.buildDocumentUriUsingTree(tree, id); }

    private List<Doc> children(String parentId) {
        List<Doc> out = new ArrayList<>();
        try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId), COLUMNS, null, null, null)) {
            while (c != null && c.moveToNext()) {
                out.add(new Doc(c.getString(0), c.getString(1), Document.MIME_TYPE_DIR.equals(c.getString(2)),
                        c.isNull(3) ? 0 : c.getLong(3), c.isNull(4) ? 0 : c.getLong(4)));
            }
        }
        return out;
    }

    private Doc stat(String id) {
        try (Cursor c = cr.query(docUri(id), COLUMNS, null, null, null)) {
            if (c == null || !c.moveToFirst()) return null;
            return new Doc(c.getString(0), c.getString(1), Document.MIME_TYPE_DIR.equals(c.getString(2)),
                    c.isNull(3) ? 0 : c.getLong(3), c.isNull(4) ? 0 : c.getLong(4));
        }
    }

    /** The document at a path, or null: from the last walk if it is still there,
     *  else by walking the names down from the root. */
    private Doc find(String path) {
        if (path.isEmpty()) return new Doc(rootId, "", true, 0, 0);
        Doc hit = known.get(path);
        if (hit != null) {
            Doc now = stat(hit.id);
            if (now != null && now.name.equals(hit.name)) { known.put(path, now); return now; }
            known.remove(path);
        }
        String parentId = rootId, sofar = "";
        Doc doc = null;
        for (String seg : path.split("/")) {
            doc = null;
            for (Doc child : children(parentId)) if (child.name.equals(seg)) { doc = child; break; }
            if (doc == null) return null;
            sofar = sofar.isEmpty() ? seg : sofar + "/" + seg;
            known.put(sofar, doc);
            parentId = doc.id;
        }
        return doc;
    }

    /** The folder at a path, made if asked and missing. */
    private Doc dir(String path, boolean make) throws BridgeError, FileNotFoundException {
        Doc d = find(path);
        if (d != null) {
            if (!d.dir) throw new BridgeError("EEXIST", "a file is in the way: " + path);
            return d;
        }
        if (!make) return null;
        Doc parent = dir(parentOf(path), true);
        Uri made = DocumentsContract.createDocument(cr, docUri(parent.id), Document.MIME_TYPE_DIR, nameOf(path));
        Doc now = made == null ? null : stat(DocumentsContract.getDocumentId(made));
        if (now == null || !now.name.equals(nameOf(path))) throw new BridgeError("EIO", "could not make the folder " + path);
        known.put(path, now);
        return now;
    }

    // ---- the ops ----

    private JSONObject list() throws JSONException {
        JSONArray files = new JSONArray(), dirs = new JSONArray();
        known.clear();
        ArrayDeque<String[]> todo = new ArrayDeque<>();                  // {path, documentId}
        todo.add(new String[]{"", rootId});
        while (!todo.isEmpty()) {
            String[] at = todo.poll();
            for (Doc child : children(at[1])) {
                String p = at[0].isEmpty() ? child.name : at[0] + "/" + child.name;
                known.put(p, child);
                if (child.dir) {
                    dirs.put(p);
                    if (!IGNORED.contains(child.name)) todo.add(new String[]{p, child.id});   // listed, not looked inside
                } else {
                    files.put(p);
                }
            }
        }
        return new JSONObject().put("files", files).put("dirs", dirs);
    }

    private JSONObject read(String path) throws IOException, JSONException {
        Doc d = find(path);
        if (d == null || d.dir) return null;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (InputStream in = cr.openInputStream(docUri(d.id))) {
            if (in == null) return null;
            byte[] chunk = new byte[65536];
            for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
        } catch (FileNotFoundException e) {
            known.remove(path);
            return null;
        }
        // UTF-8, invalid bytes as U+FFFD; a BOM and \r\n are kept as they are
        return new JSONObject().put("text", new String(buf.toByteArray(), StandardCharsets.UTF_8)).put("mtime", d.mtime);
    }

    private JSONObject write(String path, String text) throws BridgeError, IOException, JSONException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);       // exactly these bytes: no BOM, no \r\n
        Doc d = find(path);
        if (d != null && d.dir) throw new BridgeError("EEXIST", "a folder is in the way: " + path);
        if (d == null) {
            Doc parent = dir(parentOf(path), true);
            // octet-stream, so the provider adds no extension of its own
            Uri made = DocumentsContract.createDocument(cr, docUri(parent.id), "application/octet-stream", nameOf(path));
            d = made == null ? null : stat(DocumentsContract.getDocumentId(made));
            if (d == null || !d.name.equals(nameOf(path))) {
                if (d != null) DocumentsContract.deleteDocument(cr, docUri(d.id));
                throw new BridgeError("EIO", "the folder would not take the name " + nameOf(path));
            }
        }
        try (OutputStream out = cr.openOutputStream(docUri(d.id), "wt")) {
            if (out == null) throw new BridgeError("EIO", "could not open " + path);
            out.write(bytes);
        }
        Doc now = stat(d.id);
        // SAF has no atomic replace: at least never trust a write that went short
        if (now == null || now.size != bytes.length) throw new BridgeError("EIO", "the write to " + path + " did not complete");
        known.put(path, now);
        return new JSONObject().put("mtime", now.mtime);
    }

    private void remove(String path) throws FileNotFoundException {
        Doc d = find(path);
        if (d != null && !d.dir) DocumentsContract.deleteDocument(cr, docUri(d.id));
        known.remove(path);
    }

    private void move(String from, String to) throws BridgeError, IOException {
        Doc a = find(from);
        if (a == null) throw new BridgeError("ENOENT", "not there: " + from);
        Doc b = find(to);
        if (b != null) {
            // a folder may take an empty folder's place, as rename(2) lets it; nothing else is replaced
            if (!(a.dir && b.dir && children(b.id).isEmpty())) throw new BridgeError("EEXIST", "already there: " + to);
            DocumentsContract.deleteDocument(cr, docUri(b.id));
        }
        Doc fromParent = dir(parentOf(from), false), toParent = dir(parentOf(to), true);
        Uri moved = docUri(a.id);
        if (!fromParent.id.equals(toParent.id)) {
            try {
                moved = DocumentsContract.moveDocument(cr, moved, docUri(fromParent.id), docUri(toParent.id));
            } catch (UnsupportedOperationException e) {
                moved = null;
            }
            if (moved == null) throw new BridgeError("EIO", "this folder's provider cannot move " + from);
        }
        if (!nameOf(from).equals(nameOf(to))) {
            moved = DocumentsContract.renameDocument(cr, moved, nameOf(to));
            Doc now = moved == null ? null : stat(DocumentsContract.getDocumentId(moved));
            if (now == null || !now.name.equals(nameOf(to))) throw new BridgeError("EIO", "could not rename " + from + " to " + nameOf(to));
        }
        // everything under either path is somewhere else now
        known.keySet().removeIf(k -> k.equals(from) || k.startsWith(from + "/") || k.equals(to) || k.startsWith(to + "/"));
    }

    private boolean removeDir(String path) throws FileNotFoundException {
        Doc d = find(path);
        if (d == null || !d.dir) return true;
        if (!children(d.id).isEmpty()) return false;
        DocumentsContract.deleteDocument(cr, docUri(d.id));
        known.remove(path);
        return true;
    }
}
