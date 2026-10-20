package xyz.tiresia.dvarim;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;

/**
 * The bridge's file operations (docs/BRIDGE.md) on a plain folder of the app's
 * own, for the copy the app keeps and syncs with the server (AppCopy). Unlike a
 * Storage Access Framework tree this is a real file system, so a write is
 * atomic (a temporary file, then rename(2), which File.renameTo is on
 * Android) and a move is one rename. java.io only: java.nio.file is API 26.
 */
final class PlainFiles {
    private final File root;

    PlainFiles(File root) {
        this.root = root;
    }

    /** One file operation's result, as FolderBridge.answer returns it. */
    Object answer(String op, JSONObject args) throws FolderBridge.BridgeError, IOException, JSONException {
        switch (op) {
            case "list": return list();
            case "read": return orNull(read(FolderBridge.path(args, "path")));
            case "readMany": {
                JSONArray paths = args.optJSONArray("paths");
                if (paths == null) throw new FolderBridge.BridgeError("EINVAL", "paths must be a list");
                JSONArray out = new JSONArray();
                for (int i = 0; i < paths.length(); i++) out.put(orNull(read(FolderBridge.check(paths.getString(i)))));
                return out;
            }
            case "write": {
                Object text = args.opt("text");
                if (!(text instanceof String)) throw new FolderBridge.BridgeError("EINVAL", "text must be a string");
                return write(FolderBridge.path(args, "path"), (String) text);
            }
            case "remove": remove(FolderBridge.path(args, "path")); return JSONObject.NULL;
            case "move": move(FolderBridge.path(args, "from"), FolderBridge.path(args, "to")); return JSONObject.NULL;
            case "mkdir": dir(FolderBridge.path(args, "path")); return JSONObject.NULL;
            case "removeDir": return removeDir(FolderBridge.path(args, "path"));
            default: throw new FolderBridge.BridgeError("ENOSYS", "no such operation: " + op);
        }
    }

    private static Object orNull(Object o) { return o == null ? JSONObject.NULL : o; }

    private File at(String path) { return new File(root, path); }

    private JSONObject list() throws JSONException {
        JSONArray files = new JSONArray(), dirs = new JSONArray();
        ArrayDeque<String> todo = new ArrayDeque<>();
        todo.add("");
        while (!todo.isEmpty()) {
            String p = todo.poll();
            File[] children = (p.isEmpty() ? root : at(p)).listFiles();
            if (children == null) continue;
            Arrays.sort(children);
            for (File child : children) {
                String rel = p.isEmpty() ? child.getName() : p + "/" + child.getName();
                if (child.isDirectory()) {
                    dirs.put(rel);
                    if (!FolderBridge.IGNORED.contains(child.getName())) todo.add(rel);   // listed, not looked inside
                } else if (!child.getName().startsWith(".dvarim-tmp-")) {
                    files.put(rel);
                }
            }
        }
        return new JSONObject().put("files", files).put("dirs", dirs);
    }

    private JSONObject read(String path) throws IOException, JSONException {
        File f = at(path);
        if (!f.isFile()) return null;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(f)) {
            byte[] chunk = new byte[65536];
            for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
        } catch (FileNotFoundException e) {
            return null;
        }
        byte[] bytes = buf.toByteArray();
        // UTF-8, invalid bytes as U+FFFD; a BOM and \r\n are kept as they are
        return new JSONObject().put("text", new String(bytes, StandardCharsets.UTF_8)).put("mtime", f.lastModified());
    }

    private JSONObject write(String path, String text) throws FolderBridge.BridgeError, IOException, JSONException {
        File f = at(path);
        if (f.isDirectory()) throw new FolderBridge.BridgeError("EEXIST", "a folder is in the way: " + path);
        File parent = f.getParentFile();
        if (parent != null) {
            if (parent.isFile()) throw new FolderBridge.BridgeError("EEXIST", "a file is in the way: " + path);
            if (!parent.isDirectory() && !parent.mkdirs()) throw new FolderBridge.BridgeError("EIO", "could not make the folder for " + path);
        }
        File tmp = new File(parent, ".dvarim-tmp-" + f.getName() + "-" + System.nanoTime());
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));      // exactly these bytes: no BOM, no \r\n
            out.getFD().sync();
        }
        if (!tmp.renameTo(f)) {
            tmp.delete();
            throw new FolderBridge.BridgeError("EIO", "the write to " + path + " did not complete");
        }
        return new JSONObject().put("mtime", f.lastModified());
    }

    private void remove(String path) {
        File f = at(path);
        if (f.isFile()) f.delete();
    }

    private void move(String from, String to) throws FolderBridge.BridgeError {
        File a = at(from), b = at(to);
        if (!a.exists()) throw new FolderBridge.BridgeError("ENOENT", "not there: " + from);
        if (b.exists()) {
            // a folder may take an empty folder's place, as rename(2) lets it; nothing else is replaced
            String[] inside = b.list();
            if (!(a.isDirectory() && b.isDirectory() && inside != null && inside.length == 0)) {
                throw new FolderBridge.BridgeError("EEXIST", "already there: " + to);
            }
            b.delete();
        }
        File parent = b.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new FolderBridge.BridgeError("EIO", "could not make the folder for " + to);
        }
        if (!a.renameTo(b)) throw new FolderBridge.BridgeError("EIO", "could not move " + from + " to " + to);
    }

    private void dir(String path) throws FolderBridge.BridgeError {
        File d = at(path);
        if (d.isFile()) throw new FolderBridge.BridgeError("EEXIST", "a file is in the way: " + path);
        if (!d.isDirectory() && !d.mkdirs()) throw new FolderBridge.BridgeError("EIO", "could not make the folder " + path);
    }

    private boolean removeDir(String path) {
        File d = at(path);
        if (!d.isDirectory()) return true;
        String[] inside = d.list();
        if (inside != null && inside.length > 0) return false;
        return d.delete();
    }

    /** Everything under the folder, and the folder: a copy signed out of. */
    static void delete(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) delete(c);
        f.delete();
    }
}
