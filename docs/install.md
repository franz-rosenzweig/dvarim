<sub>[Dvarim docs](README.md) › Getting started</sub>

# Install

Installing Dvarim means two things: a place for the to-dos to live, and the apps you open them with. For most people the place is a Dvarim server, one Docker container pointed at a folder, and the apps are the web app it serves plus the Mac and Android apps if you want them. My own copy runs at **dvarim.tiresia.xyz**, behind my password, so to use Dvarim yourself you run your own. It takes about ten minutes.

There are no downloads or app-store builds. The server is built from this repository with Docker, and the Mac and Android apps are built from it too, on a Mac and with the Android tools.

## 1. The server

The short version, on any machine with Docker:

```bash
git clone https://github.com/franz-rosenzweig/dvarim.git
cd dvarim
docker build -t dvarim .
mkdir -p "$HOME/Tasks" "$HOME/.dvarim-secrets"
docker run -d --name dvarim --restart unless-stopped \
  --user "$(id -u):$(id -g)" -p 8420:8420 \
  -v "$HOME/Tasks:/data" -v "$HOME/.dvarim-secrets:/secrets" \
  -e DVARIM_AUTH_FILE=/secrets/auth.json -e TZ=Europe/London \
  dvarim
docker exec -it dvarim node server/src/cli.js set-password
```

`$HOME/Tasks` is the folder your to-dos will live in. It can be empty, or a folder inside your Obsidian vault. Set `TZ` to where you are, because it decides when "today" begins. Then open `http://localhost:8420` and sign in with the password you just set. [Your own server](server.md) has the rest: HTTPS, calendars, reminders, and keeping it running.

## 2. On the web

Open your server's address in any browser and sign in. That's the whole app: every list, the to-do card, Quick Find, the keyboard shortcuts and Settings. A session lasts 30 days.

You can also install it as an app from the browser, which gives it its own window and icon:

- **Chrome or Edge on the desktop**: the install icon at the right of the address bar.
- **Safari on the Mac**: **File → Add to Dock**.
- **Chrome on Android**: the menu, then **Add to Home screen**. Chrome only offers a real install over HTTPS, so put the server behind HTTPS first (see [Your own server](server.md)).

The installed app opens instantly, because the app itself is cached on the device, and so does a plain browser tab. Either way the page keeps a full copy of your to-dos on the device and syncs it with the server, which means every list and every change works when the server can't be reached, even a list you haven't opened there before. A strip at the top says you're offline, and what you did reaches the server by itself once it's back. [Settings](settings.md#data) has the details.

## 3. The Mac app

The Mac app is a native app with Dvarim's own engine inside it, plus the things only a Mac app can do: Quick Entry on ⌃Space from any app, Today in the menu bar, a Dock badge, notifications, and Shortcuts. [The Mac app](mac.md) has all of it. It needs macOS 26 or newer.

The easy way is Homebrew. Every release puts a ready-made app on [the Releases page](https://github.com/franz-rosenzweig/dvarim/releases), and my tap installs it:

```bash
brew install --cask franz-rosenzweig/tap/dvarim
```

`brew upgrade` brings it up to each new release. It isn't notarized by Apple, so the cask clears the quarantine flag that would otherwise make macOS refuse to open it.

To build it yourself you need the Command Line Tools (`xcode-select --install`), XcodeGen (`brew install xcodegen`) and Node. Xcode itself is optional.

```bash
git clone https://github.com/franz-rosenzweig/dvarim.git
cd dvarim/frontend && npm ci           # esbuild, which bundles the engine into the app
cd ../mac && ./build-native.sh         # build-native/Dvarim.app
cp -R build-native/Dvarim.app /Applications/ && open /Applications/Dvarim.app
```

Keep the app in `/Applications`, because macOS only lets an app there ask for notifications. Then open **Dvarim → Settings… → Where**, give it your server's address, and choose where your to-dos live. The default, **On this Mac, synced with the server**, keeps a copy of them on the Mac, so the app opens and works with no network: sign in once in the Dvarim window and it sets itself up. **On the server only** asks the server for every list, and **In a folder on this Mac** works on a folder, like the Tasks folder of your vault, with no server at all. The menu bar, the badge and Quick Entry use the same to-dos and the same sign-in as the window.

The app carries its own copy of the engine inside it, so a new server alone doesn't change it: update the app too, with `brew upgrade` or by building it again.

The full notes, including signing and the self-test, are in [the Mac build notes](https://github.com/franz-rosenzweig/dvarim/blob/master/mac/README.md).

## 4. The Android app

The Android app is the web app in its own window, with a Today widget, sharing into Dvarim from any app, reminders that arrive with the app closed, and a New To-Do tile. [The Android app](android.md) has all of it.

The easy way is the APK on [the Releases page](https://github.com/franz-rosenzweig/dvarim/releases). To have it update by itself, install [Obtainium](https://github.com/ImranR98/Obtainium), add `https://github.com/franz-rosenzweig/dvarim`, and it installs each new release over the last. The ready-made app is set up for my server, so long-press its icon, choose **Settings** and give it your server's address.

To build your own, which is also how the system comes to trust the app for your server's links, it's built with Google's Bubblewrap, and because it has to prove it belongs to your server, it needs a little setup on both sides:

1. Make a signing key with `keytool` and keep it safe, because a new key means a new app.
2. Tell your server the key's SHA-256 fingerprint and the app's package name (`DVARIM_ANDROID_FINGERPRINT` and `DVARIM_ANDROID_PACKAGE`), so it publishes `/.well-known/assetlinks.json`.
3. Put your server's address in `android/twa-manifest.json` (`host` and the shortcut addresses), since it points at my server out of the box.
4. Build the web app first (`frontend/build.sh`), so the phone app carries a copy for working on a folder. Then, with Bubblewrap installed (`npm install -g @bubblewrap/cli`), in `android/`: `bubblewrap init --manifest https://your-server/manifest.webmanifest`, then `./shell/apply.sh` and `bubblewrap build`, and `adb install app-release-signed.apk`.

The server has to be on HTTPS for the phone. Sign in once when the app first opens, and from then on it keeps a copy of your to-dos on the phone, synced with the server, so it opens and works with no network. Long-press the app's icon and choose **Settings** to change the server address later, turn the phone's reminders on or off, or choose where your to-dos live: **On this phone, synced with the server** (the default), **On the server only**, or **In a folder on this phone**. Like the Mac app, it carries the web app inside it, so build it again when you update. The details, and what to do when Bubblewrap misbehaves, are in [the Android build notes](https://github.com/franz-rosenzweig/dvarim/blob/master/android/README.md).

## Without a server

If you'd rather not run a server at all, the Mac and Android apps can work straight on a folder on the device: **In a folder on this Mac** in the Mac app's settings, and **In a folder on this phone** in the Android app's. Something has to move that folder between your devices, Syncthing or iCloud Drive for example, or the app's own sync with any WebDAV server, like Nextcloud. [Sync](syncing.md) explains both. A browser can also keep a vault of its own (Settings → Data → **Keep a vault in this browser instead…**), but that one is experimental, and it lives in the browser's storage, so clearing the site's data would delete it.

## What to do first

Once it's running, look in the sidebar for "Meet Dvarim". A new, empty folder starts with it: a short project where every to-do is something to try, and you can delete it when you're done. Settings → General → **Show the tutorial again** brings it back. After that, press ⌘N (or the **+** at the bottom) in the Inbox and type your first to-do. Then read [The lists](lists.md), which explains where things go from there.

<sub>Next: [The lists](lists.md) →</sub>
