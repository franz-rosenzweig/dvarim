#!/bin/zsh
# Re-apply Dvarim's own bits to the project bubblewrap generates.
#
# Bubblewrap writes the Android project from a template, so anything we change
# inside it is lost the next time it runs. This script puts it back. Run it
# after any `bubblewrap init` or `bubblewrap update`:
#
#   ./shell/apply.sh && bubblewrap build
#
# Idempotent: running it twice changes nothing. What it applies, and why:
#
#   src/            Our own sources and resources, copied over the generated
#                   tree: ShareActivity (the share target, which android-browser-
#                   helper's fallback drops), Theme.Dvarim (a WebView reads dark
#                   mode off its activity's theme, not off the system, and the
#                   generated one is dark), CookieKeeper (commits the session
#                   cookie when the app stops), NewTodoTile, and a monochrome
#                   launcher icon for Android 13's themed icons.
#   manifest        The components in manifest-additions.xml and the permissions
#                   in manifest-permissions.xml, plus three edits to the
#                   generated one: the share filter moves off the launcher, and
#                   the activity that renders the site gets our theme and is
#                   allowed to hear Back. LauncherActivity gets four of its
#                   own: Reminders.onLaunch, "Settings" in the launcher's
#                   long-press menu, the address in Server.java, and the
#                   hand-over to FolderActivity when the to-dos are in a folder.
#   web             frontend/dist, copied into assets/web/, which FolderActivity
#                   serves in folder mode. Without it there is no folder mode.
#   debug variant   A second applicationId, so a test build can be installed
#                   beside the real app without the release signing key. It is
#                   debuggable, so its WebView shows up in chrome://inspect, and
#                   it alone carries DevActivity (src/debug/), which opens a
#                   server on the development machine: see shell/dev.sh. It
#                   answers dvarim-debug://settings rather than dvarim://, so a
#                   phone with both builds opens the right one's settings.
#   signing         Reads android/keystore.properties, so ./shell/release.sh
#                   signs without anyone typing a password. Inert without it.
#   okhttp          The one library of our own: the folder bridge's http op
#                   (ShellHttp.java) sends WebDAV's PROPFIND and MKCOL, which
#                   HttpURLConnection refuses to.
set -euo pipefail
cd "${0:A:h}/.."

# macOS leaves a .DS_Store in any folder Finder has looked at, and bubblewrap's
# regenerate step deletes the files it knows about and then rmdirs the folder —
# which fails with ENOTEMPTY over a stray dotfile, having already emptied app/.
# Clearing them here means the next `bubblewrap update` finds a tree it can move.
find . -name .DS_Store -delete 2>/dev/null || true

PKG_DIR=app/src/main/java/xyz/tiresia/dvarim
MANIFEST=app/src/main/AndroidManifest.xml
[[ -d $PKG_DIR ]] || { echo "no generated project here: run bubblewrap init first" >&2; exit 1; }

cp -R shell/src/java/. app/src/main/java/
cp -R shell/src/res/. app/src/main/res/
mkdir -p app/src/debug && cp -R shell/src/debug/. app/src/debug/
echo "sources and resources copied"

# The web app, served from inside the APK when the to-dos are in a folder on the
# phone (FolderActivity). Without it the app is the server's window, as before.
if [[ -f ../frontend/dist/index.html ]]; then
    rm -rf app/src/main/assets/web && mkdir -p app/src/main/assets
    cp -R ../frontend/dist app/src/main/assets/web
    echo "web app bundled for folder mode"
else
    rm -rf app/src/main/assets/web
    echo "no web build: folder mode will be unavailable (cd frontend && npm ci && npm run build)"
fi

python3 - "$MANIFEST" app/src/main/java/xyz/tiresia/dvarim/Application.java app/build.gradle shell/manifest-additions.xml shell/manifest-permissions.xml app/src/main/java/xyz/tiresia/dvarim/LauncherActivity.java <<'PY'
import re, sys

manifest, application, gradle, additions, permissions, launcher = sys.argv[1:7]
THEME = '@style/Theme.Dvarim'
START, END = '        <!-- dvarim:shell -->', '        <!-- /dvarim:shell -->'
PSTART, PEND = '    <!-- dvarim:shell -->', '    <!-- /dvarim:shell -->'


def patch(path, fn):
    src = open(path).read()
    out = fn(src)
    if out is None:
        print(f'{path}: already done')
        return
    open(path, 'w').write(out)
    print(f'{path}: patched')


def share_target(xml):
    """The share filter belongs to ShareActivity now, not to the launcher."""
    if 'ShareActivity' in xml:
        return None
    send = re.search(r'\n\s*<intent-filter>\s*\n\s*<action android:name="android\.intent\.action\.SEND" />'
                     r'.*?</intent-filter>\n', xml, re.S)
    if not send:
        raise SystemExit('no SEND intent-filter found: has bubblewrap changed its template?')
    filter_xml = send.group(0).strip()
    xml = xml[:send.start()] + '\n' + xml[send.end():]
    activity = f'''
        <activity android:name=".ShareActivity"
            android:label="@string/appName"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:theme="{THEME}">
            {filter_xml}
        </activity>
'''
    return xml.replace('        <activity android:name="LauncherActivity"',
                       activity + '\n        <activity android:name="LauncherActivity"', 1)


def fallback_theme(xml):
    """The activity that actually renders the site. Left alone it inherits the
    application's dark, translucent theme, and the WebView renders dark."""
    name = 'com.google.androidbrowserhelper.trusted.WebViewFallbackActivity'
    hit = re.search(r'<activity android:name="%s"\n(\s*)' % re.escape(name), xml)
    if not hit:
        raise SystemExit('no WebViewFallbackActivity in the manifest: is fallbackType still "webview"?')
    if 'android:theme' in xml[hit.end():hit.end() + 200].split('/>')[0]:
        return None
    indent = hit.group(1)
    return xml[:hit.end()] + f'android:theme="{THEME}"\n{indent}' + xml[hit.end():]


def fallback_back(xml):
    """Let Back reach the page.

    From targetSdk 36 on Android 16 the system owns Back unless an app registers
    for it the new way: onBackPressed is not called and KEYCODE_BACK is not
    dispatched. android-browser-helper's WebViewFallbackActivity answers Back
    only in onKeyDown, so it never hears about it, and every Back — which with
    gesture navigation is every swipe in from either edge of the screen — closes
    the app instead of going back in the page. This is the opt-out Android
    documents for an activity that has not migrated; with it Back reaches the
    WebView's history, which is where lib/backstack.svelte.js is waiting."""
    name = 'com.google.androidbrowserhelper.trusted.WebViewFallbackActivity'
    hit = re.search(r'<activity android:name="%s"\n(\s*)' % re.escape(name), xml)
    if not hit:
        raise SystemExit('no WebViewFallbackActivity in the manifest: is fallbackType still "webview"?')
    if 'enableOnBackInvokedCallback' in xml[hit.end():hit.end() + 300].split('/>')[0]:
        return None
    indent = hit.group(1)
    return xml[:hit.end()] + f'android:enableOnBackInvokedCallback="false"\n{indent}' + xml[hit.end():]


def our_components(xml):
    """Everything in manifest-additions.xml, between markers so a second run
    replaces the block rather than stacking another copy on top of it."""
    block = START + '\n' + open(additions).read().rstrip('\n') + '\n' + END + '\n'
    old = re.search(re.escape(START) + r'.*?' + re.escape(END) + r'\n', xml, re.S)
    if old:
        return None if old.group(0) == block else xml[:old.start()] + block + xml[old.end():]
    return xml.replace('    </application>', block + '    </application>', 1)


def our_permissions(xml):
    """manifest-permissions.xml, above <application>, marked the same way."""
    block = PSTART + '\n' + open(permissions).read().rstrip('\n') + '\n' + PEND + '\n\n'
    old = re.search(re.escape(PSTART) + r'.*?' + re.escape(PEND) + r'\n\n', xml, re.S)
    if old:
        return None if old.group(0) == block else xml[:old.start()] + block + xml[old.end():]
    return xml.replace('    <application', block + '    <application', 1)


def launch_hook(java):
    """The app's front door: the one place with an Activity to ask for
    notifications from, and the right moment to catch up on everything else."""
    if 'Reminders.onLaunch' in java:
        return None
    return java.replace(
        '        super.onCreate(savedInstanceState);',
        '        super.onCreate(savedInstanceState);\n'
        '        // Ours: ask about notifications once, re-arm the reminder alarms,\n'
        '        // and refresh the widget now that the list is worth re-reading.\n'
        '        Reminders.onLaunch(this);', 1)


def settings_shortcut(java):
    """"Settings" in the launcher's long-press menu.

    The way into SettingsActivity that does not need the server: point the app
    at an address it cannot reach and the page never loads, so the link inside
    it never appears. It is registered rather than declared because
    res/xml/shortcuts.xml is generated from twa-manifest.json on every build."""
    if 'SettingsActivity.offerShortcut' in java:
        return None
    return java.replace(
        '        Reminders.onLaunch(this);',
        '        Reminders.onLaunch(this);\n'
        '        // Ours: "Settings" in the launcher\'s long-press menu.\n'
        '        SettingsActivity.offerShortcut(this);', 1)


def custom_server(java):
    """Open whichever server Settings chose; see Server.java.

    Two overrides, both on the one activity every way into the app goes
    through. getLaunchingUrl is where the address is swapped — the launcher's
    shortcuts and the app links in the manifest name the built-in host outright,
    because the build wrote them. launchTwa is about who renders it: a Trusted
    Web Activity is Chrome showing a site it has verified through Digital Asset
    Links, and only the built-in address carries that statement."""
    if 'Server.rebase' in java:
        return None
    tail = '        return uri;\n    }\n}\n'
    if not java.endswith(tail):
        raise SystemExit('LauncherActivity does not end in getLaunchingUrl: has bubblewrap changed its template?')
    return java[:-len(tail)] + \
        '        // Ours: whatever the launcher, a shortcut or an app link asked\n' \
        '        // for, it is a path on the server Settings chose.\n' \
        '        return Server.rebase(this, uri);\n' \
        '    }\n' \
        '\n' \
        '    /**\n' \
        '     * Ours: a server that is not the one the app was built for is rendered\n' \
        '     * by the WebView, never by a Trusted Web Activity.\n' \
        '     *\n' \
        '     * Only the built-in address has a Digital Asset Links statement about\n' \
        '     * it, so any other would open in Chrome with a URL bar across the top,\n' \
        '     * announcing itself as a browser. Worse, Chrome would hold the session\n' \
        '     * cookie, and the widget, the tile and the reminders all read theirs\n' \
        '     * out of the WebView\'s jar (Api.java): they would quietly stop working.\n' \
        '     * This is what the library itself does when it finds no browser at all.\n' \
        '     */\n' \
        '    @Override\n' \
        '    protected void launchTwa() {\n' \
        '        if (Server.isBuiltIn(this)) {\n' \
        '            super.launchTwa();\n' \
        '            return;\n' \
        '        }\n' \
        '        startActivity(com.google.androidbrowserhelper.trusted.WebViewFallbackActivity\n' \
        '                .createLaunchIntent(this, getLaunchingUrl(),\n' \
        '                        com.google.androidbrowserhelper.trusted.LauncherActivityMetadata\n' \
        '                                .parse(this)));\n' \
        '        finish();\n' \
        '    }\n' \
        '}\n'


def folder_handoff(java):
    """With the to-dos on the phone (a chosen folder, or the copy the app keeps)
    the app is the web app from inside the APK, in FolderActivity: neither a
    Trusted Web Activity nor the WebView fallback can give a page its folder
    (docs/BRIDGE.md). A copy not set up yet is the server's sign-in in the
    app's own WebView (CopySignInActivity). The launcher's shortcuts, the tile,
    the widget and the reminders all arrive here, so this one hand-over covers
    them, with the path they asked for; Folder.handOff decides where."""
    if 'Folder.handOff' in java:
        return None
    call = ('        // Ours: to-dos on this phone are the web app from inside the APK\n'
            '        // (Folder.handOff says where).\n'
            '        if (Folder.handOff(this, getLaunchingUrl())) {\n'
            '            finish();\n'
            '            return;\n'
            '        }\n')
    # a launcher patched before the copy: its hand-over, replaced
    old = re.search(r'        // Ours: to-dos in a folder on this phone are the web app from inside\n'
                    r'.*?        if \(Folder\.isOn\(this\)\) \{\n.*?\n        \}\n', java, re.S)
    if old:
        return java[:old.start()] + call + java[old.end():]
    head = '    protected void launchTwa() {\n'
    if java.count(head) != 1:
        raise SystemExit('LauncherActivity has no launchTwa override for the folder to go in front of')
    return java.replace(head, head + call, 1)


def keep_cookies(java):
    if 'CookieKeeper' in java:
        return None
    return java.replace(
        '      super.onCreate();',
        '      super.onCreate();\n'
        '      // Commit the session cookie when the app stops; see CookieKeeper.\n'
        '      registerActivityLifecycleCallbacks(new CookieKeeper());', 1)


def edge_gestures(java):
    """Reserve a band of the left edge from the system's Back gesture, so the
    drawer can be pulled out by hand; see EdgeGestures.java."""
    if 'EdgeGestures' in java:
        return None
    return java.replace(
        '      super.onCreate();',
        '      super.onCreate();\n'
        '      // Keep a band of the left edge for ourselves; see EdgeGestures.\n'
        '      registerActivityLifecycleCallbacks(new EdgeGestures());', 1)


def ime_insets(java):
    """Shorten the window when the keyboard opens, so the page can see it;
    see ImeInsets.java."""
    if 'ImeInsets' in java:
        return None
    return java.replace(
        '      super.onCreate();',
        '      super.onCreate();\n'
        '      // Let the page know the keyboard is there; see ImeInsets.\n'
        '      registerActivityLifecycleCallbacks(new ImeInsets());', 1)


def dev_build(java):
    if 'DevBuild' in java:
        return None
    return java.replace(
        '      super.onCreate();',
        '      super.onCreate();\n'
        '      // Test builds open their WebView to chrome://inspect; see DevBuild.\n'
        '      DevBuild.onCreate(this);', 1)


def okhttp(gradle):
    """OkHttp beside android-browser-helper, for ShellHttp.java."""
    if 'com.squareup.okhttp3:okhttp' in gradle:
        return None
    hit = re.search(r"( *)implementation 'com\.google\.androidbrowserhelper:androidbrowserhelper:[^']*'\n", gradle)
    if not hit:
        sys.exit("apply.sh: no androidbrowserhelper dependency in app/build.gradle to put OkHttp beside")
    pad = hit.group(1)
    return (gradle[:hit.end()]
            + f"{pad}// the folder bridge's http op sends PROPFIND and MKCOL (ShellHttp.java)\n"
            + f"{pad}implementation 'com.squareup.okhttp3:okhttp:4.12.0'\n"
            + gradle[hit.end():])


def signing(gradle):
    """Sign from a file git ignores rather than a prompt.

    `bubblewrap build` asks for the password every time and, when signing fails,
    prints the whole apksigner command — password and all — into the terminal.
    With keystore.properties present Gradle signs on its own and nothing echoes.
    Without it the block is inert and the APK comes out unsigned."""
    if 'keystore.properties' in gradle:
        return None
    hit = re.search(r'( *)buildTypes \{\n', gradle)
    if not hit:
        raise SystemExit('no buildTypes block: has bubblewrap changed its template?')
    pad = hit.group(1)
    block = (
        f"{pad}// See keystore.properties.example. keyPassword falls back to\n"
        f"{pad}// storePassword, which is how the key was made — one answer to give,\n"
        f"{pad}// not two that can drift apart.\n"
        f"{pad}signingConfigs {{\n"
        f"{pad}    release {{\n"
        f"{pad}        def secrets = rootProject.file('keystore.properties')\n"
        f"{pad}        if (secrets.exists()) {{\n"
        f"{pad}            def props = new Properties()\n"
        f"{pad}            secrets.withInputStream {{ props.load(it) }}\n"
        f"{pad}            storeFile rootProject.file(props.getProperty('storeFile', 'android.keystore'))\n"
        f"{pad}            storePassword props.getProperty('storePassword')\n"
        f"{pad}            keyAlias props.getProperty('keyAlias', 'dvarim')\n"
        f"{pad}            keyPassword props.getProperty('keyPassword', props.getProperty('storePassword'))\n"
        f"{pad}        }}\n"
        f"{pad}    }}\n"
        f"{pad}}}\n")
    gradle = gradle[:hit.start()] + block + gradle[hit.start():]
    return gradle.replace(
        f"{pad}    release {{\n{pad}        minifyEnabled true\n",
        f"{pad}    release {{\n{pad}        minifyEnabled true\n"
        f"{pad}        if (rootProject.file('keystore.properties').exists()) signingConfig signingConfigs.release\n", 1)


def settings_scheme(gradle):
    """Which scheme opens SettingsActivity, per build.

    The web app's link out to it is a dvarim://settings URL, and a test build
    installed beside the real app answered that too: tapping the link in either
    raised an "Open with Dvarim / Dvarim dev" chooser. This is the same rule
    the FileProvider authority below already follows — a second copy of the app
    gets a second name for everything the system resolves by name."""
    if 'settingsScheme' in gradle:
        return None
    hit = re.search(r'( *)resValue "string", "launchUrl", launchUrl\n', gradle)
    if not hit:
        raise SystemExit('no launchUrl resValue: has bubblewrap changed its template?')
    pad = hit.group(1)
    gradle = (gradle[:hit.end()]
              + f'\n{pad}// The scheme that opens SettingsActivity; see manifest-additions.xml.\n'
                f'{pad}manifestPlaceholders = [settingsScheme: "dvarim"]\n'
              + gradle[hit.end():])
    hit = re.search(r'( *)resValue "string", "launcherName", twaManifest.launcherName \+ " dev"\n', gradle)
    if not hit:
        raise SystemExit('no debug launcherName: has the debug variant moved?')
    pad = hit.group(1)
    return (gradle[:hit.end()]
            + f'{pad}manifestPlaceholders = [settingsScheme: "dvarim-debug"]\n'
            + gradle[hit.end():])


def debug_variant(gradle):
    """Install a test build beside the real one, without the release key."""
    if 'applicationIdSuffix' in gradle:
        return None
    hit = re.search(r'( *)release \{\n *minifyEnabled true\n *\}\n', gradle)
    if not hit:
        raise SystemExit('no release buildType found: has bubblewrap changed its template?')
    pad = hit.group(1)
    block = (f'{pad}debug {{\n'
             f'{pad}    applicationIdSuffix ".debug"\n'
             f'{pad}    // A second copy needs its own FileProvider authority, or the\n'
             f'{pad}    // install fails with INSTALL_FAILED_CONFLICTING_PROVIDER.\n'
             f'{pad}    resValue "string", "providerAuthority", twaManifest.applicationId + \'.debug.fileprovider\'\n'
             f'{pad}    // It sits in the launcher beside the real one, with the same icon: it\n'
             f'{pad}    // has to say which it is, or there are just "two Dvarims".\n'
             f'{pad}    resValue "string", "appName", twaManifest.name + " dev"\n'
             f'{pad}    resValue "string", "launcherName", twaManifest.launcherName + " dev"\n'
             f'{pad}}}\n')
    return gradle[:hit.end()] + block + gradle[hit.end():]


def debug_name(gradle):
    """The same, for a project whose debug variant was written before it had a name."""
    if '" dev"' in gradle:
        return None
    hit = re.search(r"( *)resValue \"string\", \"providerAuthority\", twaManifest.applicationId \+ '.debug.fileprovider'\n", gradle)
    if not hit:
        return None
    pad = hit.group(1)
    block = (f'{pad}// It sits in the launcher beside the real one, with the same icon: it\n'
             f'{pad}// has to say which it is, or there are just "two Dvarims".\n'
             f'{pad}resValue "string", "appName", twaManifest.name + " dev"\n'
             f'{pad}resValue "string", "launcherName", twaManifest.launcherName + " dev"\n')
    return gradle[:hit.end()] + block + gradle[hit.end():]


patch(manifest, share_target)
patch(manifest, fallback_theme)
patch(manifest, fallback_back)
patch(manifest, our_components)
patch(manifest, our_permissions)
patch(launcher, launch_hook)
patch(launcher, settings_shortcut)
patch(launcher, custom_server)
patch(launcher, folder_handoff)
patch(application, keep_cookies)
patch(application, edge_gestures)
patch(application, ime_insets)
patch(application, dev_build)
patch(gradle, okhttp)
patch(gradle, debug_variant)
patch(gradle, settings_scheme)
patch(gradle, debug_name)
patch(gradle, signing)
PY
