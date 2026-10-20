package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;

/**
 * Where the to-dos live, as a mode:
 *
 *  - "copy", the default: on this phone, in a folder of the app's own that the
 *    page keeps in step with the server (AppCopy). The page comes from inside
 *    the APK, so the app opens offline. Until the first sign-in there is no
 *    copy, and the app shows the server's page to sign in on
 *    (CopySignInActivity).
 *  - "server": on the server only, as the app always worked.
 *  - "folder": in a folder on this phone the person chose — a Syncthing folder,
 *    say — which the page reads and writes through FolderBridge
 *    (docs/BRIDGE.md). The folder is a Storage Access Framework tree: picked
 *    with ACTION_OPEN_DOCUMENT_TREE and the permission persisted, so it
 *    survives a reboot. If that permission is ever revoked, the bridge answers
 *    EACCES and the page says so; choosing the folder again gives it back.
 */
final class Folder {
    private static final String PREFS = "dvarim.vault";
    private static final String KEY_MODE = "mode";         // "copy" | "server" | "folder"; none is "copy"
    private static final String KEY_TREE = "tree";

    private Folder() {}

    /** The folder's tree URI, or null in server mode or if its permission has gone. */
    static Uri tree(Context context) {
        Uri uri = wanted(context) ? chosen(context) : null;
        return uri != null && granted(context, uri) ? uri : null;
    }

    static String mode(Context context) {
        return prefs(context).getString(KEY_MODE, "copy");
    }

    /** Whether a folder is the choice, whether or not it can be used. */
    static boolean wanted(Context context) {
        return "folder".equals(mode(context));
    }

    /** Whether a copy on this phone is the choice, set up yet or not. */
    static boolean wantsCopy(Context context) {
        return "copy".equals(mode(context)) && android.os.Build.VERSION.SDK_INT >= 24 && hasWebBundle(context);
    }

    /** The copy, if that is the choice and it is set up. */
    static java.io.File copy(Context context) {
        return wantsCopy(context) ? AppCopy.folder(context) : null;
    }

    /** The folder chosen last, in either mode: what Settings shows, and goes back to. */
    static Uri chosen(Context context) {
        String s = prefs(context).getString(KEY_TREE, null);
        return s == null ? null : Uri.parse(s);
    }

    /** Whether this app may still read and write that folder. */
    static boolean granted(Context context, Uri uri) {
        for (android.content.UriPermission grant : context.getContentResolver().getPersistedUriPermissions()) {
            if (grant.getUri().equals(uri) && grant.isReadPermission() && grant.isWritePermission()) return true;
        }
        return false;
    }

    /** Whether the to-dos are on this phone, in a chosen folder or the app's
     *  copy: FolderActivity's page answers, not the server. Needs Android 7
     *  (moveDocument); below that it is the server, as before. */
    static boolean isOn(Context context) {
        if (copy(context) != null) return true;
        return android.os.Build.VERSION.SDK_INT >= 24 && tree(context) != null && hasWebBundle(context);
    }

    /**
     * From LauncherActivity, before a Trusted Web Activity is started: the
     * to-dos on this phone are the web app from inside the APK, which only
     * FolderActivity can give its folder; a copy not yet set up is the
     * server's sign-in, in the app's own WebView. True if handed over.
     */
    static boolean handOff(android.app.Activity from, Uri launching) {
        Class<?> to = isOn(from) ? FolderActivity.class : wantsCopy(from) ? CopySignInActivity.class : null;
        if (to == null) return false;
        from.startActivity(new android.content.Intent(from, to).setData(launching));
        return true;
    }

    /** The built web app, which apply.sh copies into assets/web/. */
    static boolean hasWebBundle(Context context) {
        try {
            context.getAssets().open("web/index.html").close();
            return true;
        } catch (java.io.IOException e) {
            return false;
        }
    }

    /** After ACTION_OPEN_DOCUMENT_TREE: keep the grant, and use the folder. */
    static void use(Context context, Uri tree) {
        int flags = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        context.getContentResolver().takePersistableUriPermission(tree, flags);
        prefs(context).edit().putString(KEY_TREE, tree.toString()).putString(KEY_MODE, "folder").apply();
        Local.forget(context);                 // another folder's lists are not this one's
    }

    /** Back to the folder chosen last, whose grant is still held. */
    static void useChosen(Context context) {
        prefs(context).edit().putString(KEY_MODE, "folder").apply();
    }

    static void useServer(Context context) {
        prefs(context).edit().putString(KEY_MODE, "server").apply();
        Local.forget(context);
    }

    /** Back to a copy on this phone, from server-only or a folder. */
    static void useCopy(Context context) {
        prefs(context).edit().putString(KEY_MODE, "copy").apply();
        Local.forget(context);
    }

    /** "Tasks" — the folder's own name, for Settings. */
    static String name(Context context, Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        // "primary:Sync/Tasks" on the phone's own storage: the part after the last '/' or ':'
        int cut = Math.max(id.lastIndexOf('/'), id.lastIndexOf(':'));
        return cut >= 0 ? id.substring(cut + 1) : id;
    }

    /** "Sync › Tasks" — where it is, as far as the provider says. */
    static String detail(Context context, Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        int colon = id.indexOf(':');
        String path = colon >= 0 ? id.substring(colon + 1) : id;
        return path.replace("/", " › ");
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
