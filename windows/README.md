# Dvarim for Windows

A native shell around the web app in `frontend/`, which stays the whole
interface, as in the Android app (`android/README.md`). The shell gives the page
somewhere to keep the to-dos (docs/BRIDGE.md), a window, and what a page can't
do: Today in the notification area, Quick Entry from any app, and reminders as
Windows notifications. C# and WinUI 3 (Windows App SDK 1.8), with the page in
WebView2; unpackaged and self-contained.

- **Where the to-dos live**, as in the Mac and Android apps, chosen in the app's
  own Settings:
  - **On this PC, synced with the server**, the default. The first run shows the
    server's own sign-in page in Dvarim's window. Once you've signed in, the shell
    uses that session to make this PC a device token (`POST /api/tokens`, named
    "<PC> (Windows)", "… 2" if that's taken), keeps it in Windows Credential
    Manager, and opens the app's own page on a folder of its own,
    `%LOCALAPPDATA%\Dvarim\Copies\<host>\<who>\`. The page's built-in sync keeps
    that folder in step with the server's `/dav`, with the token (`info.sync`).
    Signing out (the page's Settings › Account) syncs what's left, revokes the
    token, signs out and moves the copy to the Recycle Bin.
  - **On the server only**: the server's page, as in a browser.
  - **In a folder on this PC**: the Tasks folder of a vault that Syncthing or
    OneDrive keeps in step, read and written by the page through the bridge, with
    a FileSystemWatcher telling it within about 0.3 s when another app changes it.
- **The bridge** is docs/BRIDGE.md with Android's transport, which the page already
  speaks: `window.DvarimStorage.request(id, json)`, answered by
  `window.__dvarimStorageReply`, over WebView2's web messages. Every file op;
  `info`, `pick` and `useServer`; `http` (made by the shell, so a WebDAV server needs
  no CORS; with `session: true` the shell's own sign-in goes along, to the copy's
  server and no other); `changed`; and `signOut`. Not `calendars` or `events`: an
  unpackaged app can't read Windows' calendars (below). The page is served from
  inside the app at `https://dvarim-app.example/`; the server's page in copy mode is
  told `window.__dvarimShell = { copy: true }`, and `window.DvarimShell.postMessage`
  takes its `useCopy`.
- **Windows' own rules for names**: a name Windows can't keep (one with `: * ? " < > |`,
  one ending in a dot or a space, `CON`, `NUL` and the rest) is refused as `EINVAL`
  with a message that says so. A file another app holds open is waited for, then
  written in place if it can't be replaced; a junction or link out of the folder is
  refused like `..`.
- **The window** has Windows 11's look: the page runs up under a Mica title bar that
  holds the icon, the menus and the window's name ("Tasks - Dvarim", for the folder
  or the server), with the system's own caption buttons and Snap Layouts, light or
  dark with the theme, and thin Fluent scrollbars in the page. It is put away, not
  closed, by its close box or Ctrl+W: Dvarim stays in the notification area and its
  page goes on answering, as the web-view Mac app's hidden page did. Only the app ever
  loads in it; a link elsewhere opens in the browser, and `dvarim://settings` (the
  page's Settings › Data) opens the app's own Settings.
- **The menus**: File, Edit, To-Do (the Mac's Items menu: everything you can do to the
  chosen to-dos), View and Help. Alt and a menu's letter opens it, Alt alone puts the
  keyboard on the menu bar, and Escape gives it back to the page. Each item runs the
  page's own command by its id (`window.dvarim.run`), and shows the key the page has
  for it now (`window.dvarim.commands()`), so Settings › Keyboard's changes show there
  too; Undo, Cut, Copy, Paste and Select All press their keys in the page. The
  right-click menu loses the browser's items (Back, Reload, Save as, Print…).
- **Text size**: Ctrl+Plus, Ctrl+Minus, Ctrl+0 and Ctrl with the mouse wheel change
  the page's own text size (Settings › General › Text size), as View › Text Size does;
  the browser never zooms the whole window.
- **Full screen**: F11 or View › Full Screen, and the page's own full screen, are one
  state: out is out, whichever way it came in, and the title bar is there exactly when
  the window isn't full screen. A word at the top says which key gets out.
- **The notification area**: today's count under the pointer; a click shows Today,
  where a to-do can be ticked off; a right-click has Open, Quick Entry, Settings and
  Quit. They ask the page (`window.dvarim.request`), which answers from the copy or
  the folder, or from the server, and hear of every change through op `changed`.
- **Quick Entry**: Ctrl+Alt+Space from any app (Settings changes it; the Mac's
  ⌃Space is Ctrl+Space, which switches the keyboard's language on Chinese, Japanese
  and Korean layouts). Return saves through `POST /api/quick-add`, Shift+Return is a
  new line in the notes, Escape closes, and the app you were in has the keyboard back.
- **Reminders**: a Windows notification with **Complete**; pressing it opens the
  to-do. They come from Today and Upcoming and arrive while Dvarim runs, which it does
  from sign-in when "Start Dvarim when I sign in" is on (the installer's box, or
  Settings). An unpackaged app can't leave Windows a notification for later, so one
  missed while Dvarim wasn't running comes when it starts, up to six hours late.
- **One Dvarim**: opening it again brings the running one forward.

The page needed three small things of its own for Windows: `frontend/src/lib/shell.js`
knows the user agent `Dvarim/<version> (Windows shell)` (`IN_WINDOWS_SHELL`), so
Settings › Data offers the app's own settings; `window.dvarim.textSize(step)`, the
text size for Ctrl+Plus and the rest; and `window.__dvarimLocal.sync()`, so the shell
can run a sync round while its window is put away, when the page's own timers don't.

## Build it

On GitHub: every push that touches `windows/`, `frontend/`, `engine/` or `server/`
runs the Windows workflow (`.github/workflows/windows.yml`), and the run keeps the
installer, a portable zip, and the self-test's results and logs. A tag
`windows-vX.Y.Z` also makes the release.

On a Windows PC with Node 22, the .NET 10 SDK, Python, and (for the installer)
Inno Setup 6:

```powershell
windows\build.ps1            # build\Dvarim is the app; build\out the installer
```

The installer is for one person and needs no administrator: it copies the app to
`%LOCALAPPDATA%\Programs\Dvarim`. Settings, the page's own storage, the copy and
`dvarim.log` are in `%LOCALAPPDATA%\Dvarim`; the copy's token and the sign-in it
was made from are in Credential Manager (Windows Credentials, "Dvarim sync token …"
and "Dvarim sign-in …"). The sign-in is kept because while the window shows the
app's own page, WebView2 may leave the server's cookie out of what it lists, and the
devices list and signing out need it. The app isn't signed, so Windows says
the publisher is unknown the first time: More info › Run anyway. The build is about
180 MB, most of it the Windows App SDK's own parts (its AI and ML libraries among
them, which Dvarim doesn't use); trimming them is for later.

## Test it

```powershell
dotnet run --project windows\Tests     # the folder code, against tools\bridge_sim.py too, and the rest of Dvarim.Core
windows\selftest.ps1                   # the built app, on a scratch folder and in copy mode against a server
```

The tests run every file op of docs/BRIDGE.md on a scratch folder, the Windows
edges (the names, a junction out, a file held open, a read-only file, renames by
case), and a list of messages through both `FolderFiles` and the reference, answer
for answer; then the copy's names, the server's address, reminders from Today and
Upcoming, the Quick Entry shortcut, and Credential Manager.

The self-test runs the real app with `--selftest`, with no dialog for anyone to
answer, twice:

- **On a scratch folder**: the bridge's conformance checks in the page; `info`; a
  file written from outside reaching the page; Quick Entry saving to the Markdown and
  the page reporting `changed`; Today in the notification area, its count, and a tick
  there completing the to-do in the file; a reminder whose time came handed to Windows
  and one for later waiting; the title bar's five menus and the window's name, the
  menus showing the page's own keys and running its commands; Ctrl+Plus, Ctrl+Minus,
  Ctrl+0 and Ctrl with the wheel changing the page's text size and never the browser's
  zoom; full screen by F11 and by the page, and out again from both at once with the
  title bar back; the page's Settings › Data link opening the app's Settings; a link
  elsewhere going to the browser; and the page still answering with the window put away.
  The keys and the wheel are sent through DevTools into the page, which shows the page
  and the shell handle them, but not that a real key gets past WebView2 to the page.
- **In copy mode**, against the real server (`server/`) started on the runner by
  `windows\tools\test-server.mjs` on a scratch folder with a password made for the
  run: the server's sign-in page with `__dvarimShell`; signing in there; the token
  made from that session, and the session itself, kept in Credential Manager, not in
  the settings; the window reloading into the copy; `info.sync`; a to-do from the
  server arriving in the copy and one made with Quick Entry reaching the server;
  `http` with the session to its server and to no other, and with the token; and
  signing out, which revokes the token, forgets it, the session and the copy, goes
  back to the sign-in, and leaves that page signed out with no second copy made.

What only a person can check: the window, its title bar and menus, the notification
area's icon, its menu and its Today list as they look and feel; real keys (Alt and a
letter, Ctrl+Plus, F11) reaching the page; Quick Entry's shortcut from another app and
the keyboard going back to it; a reminder's notification on screen and its buttons;
the folder picker; the installer and starting at sign-in; and a real sign-in on your
own server.

## The pieces

| file | |
| --- | --- |
| `Dvarim/Program.cs` | Main: one Dvarim at a time, a second launch handed to the first |
| `Dvarim/App.xaml.cs` | the app: launching, the WebView2 environment, quitting |
| `Dvarim/Vault.cs` | where the to-dos live, and this PC's settings |
| `Dvarim/ShellWindow.xaml.cs` | the window: the title bar, the page, the messages both ways, links out, full screen, the copy's sign-in |
| `Dvarim/Menus.cs` | the menus in the title bar, and what their items call |
| `Dvarim/AppCopy.cs` | the copy: the token from the sign-in, and signing out |
| `Dvarim/FolderBridge.cs` | docs/BRIDGE.md's messages, in order, and the watcher |
| `Dvarim/AppScheme.cs` | `https://dvarim-app.example/`: the web app from inside Dvarim |
| `Dvarim/Scripts.cs` | what goes into the page before its own scripts |
| `Dvarim/Tray.cs`, `TodayWindow.cs` | the notification area, Today, and Quick Entry's shortcut |
| `Dvarim/QuickEntry.cs` | Quick Entry |
| `Dvarim/Reminders.cs` | reminders and Windows notifications |
| `Dvarim/SettingsWindow.cs` | the app's own Settings |
| `Dvarim/SelfTest.cs` | the self-test |
| `Dvarim.Core/FolderFiles.cs` | every file op of docs/BRIDGE.md on the Windows file system |
| `Dvarim.Core/ShellHttp.cs` | the bridge's `http` op |
| `Dvarim.Core/CopyNames.cs`, `ReminderPlan.cs`, `HotKey.cs`, `Credentials.cs` | the copy's names and the server's address; reminders from the lists; the shortcut; Credential Manager |
| `Tests/Program.cs` | the tests of Dvarim.Core |
| `tools/test-server.mjs` | the server the self-test signs in to |

Later: this PC's calendars (Windows keeps its appointment store for packaged apps
with the `appointments` capability, and since Mail and Calendar was retired the new
Outlook doesn't fill it, so it would want a route of its own); a count on the
taskbar icon; a menu bar built from `window.dvarim.commands()`; "Add to Dvarim" from
other apps' Share; more than one window; signing; an ARM64 build; updates from the
releases; a smaller download.
