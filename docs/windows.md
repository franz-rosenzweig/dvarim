<sub>[Dvarim docs](README.md) › Devices & sync</sub>

# The Windows app

The Windows app is Dvarim in a window of its own on your PC. Inside, it's the same web app as everywhere else, so everything in these docs works the same in it. Around it, the app adds what a browser tab can't do: Today in the notification area, Quick Entry from any app, and reminders as Windows notifications, even with the window closed. It runs on Windows 11, and on Windows 10 with the WebView2 Runtime, which recent Windows 10 has.

## Installing it

Download `Dvarim-…-Setup.exe` from the project's releases on GitHub and run it. It installs Dvarim for you alone, without asking for an administrator, puts it in the Start menu, and, unless you untick the box, starts it whenever you sign in to Windows, so reminders arrive and Quick Entry answers from the start. The app isn't signed, so the first time Windows says it comes from an unknown publisher: press **More info**, then **Run anyway**. The portable zip beside it is the same app, to unzip anywhere. How it's built is in [windows/README.md](../windows/README.md).

## Your to-dos on this PC

The first time it opens, Dvarim shows your server's own sign-in page in its window. Sign in, and the app sets itself up: it adds this PC to the server's devices (you'll see it in the web app's Settings → Sync, named after the PC, like "Nate-PC (Windows)"), keeps that device's token in Windows Credential Manager, and from then on keeps a copy of your to-dos on the PC and syncs it with the server a moment after each change, when the window comes back to the front, and every few minutes. It opens and works with no network, and what you do reaches the server once it's back. **Sign out** in Settings → Account sends what's left, takes the PC off the server's list, and moves the copy to the Recycle Bin.

The app opens the address it was built for. To use your own server, open **App Settings…** from the bar above the sign-in page, from the **File** menu, or from Dvarim's icon in the notification area, type its address under **Server**, and press **Use this server**. **Test** checks that a Dvarim answers there.

## Where your to-dos live

**App Settings** has three choices, and the first is the default:

- **On this PC, synced with the server**, as above.
- **On the server only.** The window is the server's page, as in a browser, which keeps the lists it has seen for when there's no network.
- **In a folder on this PC.** A folder you choose, like the Tasks folder of an Obsidian vault that Syncthing or OneDrive keeps in step. Dvarim reads and writes it itself, with no server, and when another app changes a file it's on screen a moment later. If nothing else syncs the folder, the web app's Settings → Sync can keep it in step with a Dvarim server or another WebDAV server (see [Sync](syncing.md)).

A Mac or a phone allows file names Windows doesn't: a name with `: * ? " < > |` in it, one that ends with a dot or a space, and a few Windows keeps for itself, like `CON` and `NUL`. If a project or an area has one, Dvarim on Windows says it can't save it under that name, and saves nothing halfway. Rename it, here or on the device it came from, and it saves.

## Today in the notification area

Dvarim's icon sits in the notification area, by the clock, with today's count when you point at it. Click it and Today opens above it, where the box beside a to-do completes it without opening the window. Right-click it for **Open Dvarim**, **Quick Entry**, **Settings** and **Quit Dvarim**. Closing the window, or **Ctrl+W**, puts it away and leaves Dvarim running there; **Quit Dvarim** ends it.

## Quick Entry

Press **Ctrl+Alt+Space** in any app and a small panel opens over what you're doing, with a line for the to-do and room for notes under it. Type it the way you'd say it, "Call the bank tomorrow 11am #phone !fri", and press **Enter**: it's saved to the Inbox, or to Today or Upcoming if you gave it a date, and you're back where you were. **Shift+Enter** starts a new line in the notes, and **Escape** closes the panel without saving. To use another shortcut, click the one in **App Settings** and press the one you want; it needs Ctrl, Alt or the Windows key. If another app already has it, App Settings says so, and Quick Entry is still in the icon's menu and the **File** menu.

## Reminders

A to-do's reminder arrives as a Windows notification with a **Complete** button, and clicking the notification opens that to-do. They arrive while Dvarim is running, which it is from the moment you sign in if **Start Dvarim when I sign in to Windows** is on in App Settings. A reminder missed while Dvarim wasn't running arrives when it starts, up to six hours late. **Remind me on this PC** turns them off, for instance if the server already sends you reminders over Signal, and **Send a test reminder** shows whether Windows is letting them through: its own notification settings and Do not disturb can hold them back.

## The window

The window looks like Windows 11's own apps: the to-dos run up under a translucent title bar that holds the menus, light or dark as Windows is. The menus are **File**, **Edit**, **To-Do**, **View** and **Help**, and each item shows its key, the one you'd press without the menu. **To-Do** has everything you can do to the to-dos you've chosen: **Complete**, **When…**, **Today**, **This Evening**, **Deadline…**, **Move…**, **Tags…**, **Repeat…** and the rest; **View** has the lists, from **Inbox** (Ctrl+1) to **Logbook** (Ctrl+6). **Alt** and a menu's first letter (F, E, T, V or H) opens it, and **Alt** on its own puts the keyboard on the menus. If you change a key in Settings → Keyboard, the menu shows the new one.

**Ctrl+Plus** and **Ctrl+Minus** make the text bigger and smaller, **Ctrl+0** brings it back to the usual size, and so does **Ctrl** with the mouse wheel. It's the same size as Settings → General → Text size.

Dvarim remembers where the window was, and **F11** makes it full screen; **F11** again, or **Esc** if a page went full screen by itself, brings the window back. Links in a to-do's notes open in your browser, and nothing but Dvarim ever loads in the window. Opening Dvarim again from the Start menu brings the running one forward. **File → App Settings…** opens the app's own Settings, and so does a link in the web app's Settings → Data.

## What isn't there yet

Your PC's own calendars. Windows only lets an app installed from a package read them, and since the old Mail and Calendar app was retired the new Outlook doesn't fill that store anyway. With the copy, or on the server only, Today and Upcoming show the calendars your server has (see [Calendars](calendars.md)); in a folder of your own, none.

<sub>Next: [Sync](syncing.md) →</sub>
