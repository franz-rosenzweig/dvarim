<sub>[Dvarim docs](README.md) › Getting started</sub>

# How I use it

This page is about my own day with Dvarim: where the to-dos live, how they get in, and what I look at when. I built it for exactly this routine, so if you're wondering why something works the way it does, the answer is usually somewhere on this page.

## Why the files matter to me

I know what I want from a to-do app: a Today list, This Evening, the difference between the day I'll start something and the day it's due, and never being asked a question when I'm only trying to get a thought out of my head. What bothered me about every one I tried was where the to-dos lived. Everything else I write lives in Obsidian, in my vault ("Synergathan"), as plain Markdown files that I own and that sync to every device I have, and my to-dos were the one thing locked inside somebody else's database.

So Dvarim keeps them in a Tasks folder inside the vault. Each area is a folder, each project is a file and each to-do is a line, and Obsidian sees all of it like any other note. The app runs on my own server at home, in one Docker container, and Syncthing carries the vault to my Mac and my phone, which means the same files are everywhere and nothing sits in a cloud I don't control. Basically, instead of a to-do app with an export button, I have my to-dos as files, with a very good app on top of them.

## Getting things in

Most of what goes in arrives by the shortest way I could make. At my desk I press ⌃Space wherever I am, type a line and press Return, and it's in the Inbox without the app ever coming forward. If the line says "tomorrow 3pm" or "#home", the server reads that and the to-do gets its date and its tag.

Away from the desk, I send a message to my Signal bot, something like "remind me to call the bank tomorrow at 11", and it turns that into one quick-entry line and posts it to Dvarim's quick-add, which means the to-do lands with the date and the reminder already set. If Dvarim can't be reached, the bot keeps the text in that day's daily note so nothing is lost, and tells me so.

On the phone there's the Today widget on the home screen, and when I come across something worth doing in another app, I share it into Dvarim and get a small sheet where I can fix the wording and add a date before it lands. The blue plus at the bottom of every list does the rest.

## My day

The list I live in is Today. My calendars come from my own Radicale server, so the day's appointments sit at the top of Today, and the to-dos for the day sit under them. Anything I can only do later goes to This Evening with ⌘E. Every to-do in Today should be the next step of something, and one habit I took from The Organised Writer is one next step per project. Dvarim helps with that: when a project has more than one to-do in Today, a quiet line at the bottom of the list says which project and how many.

The rest of the week lives in Upcoming. I decide when I'll start a thing, not only when it's due, and Dvarim keeps those two dates apart: "When" is the day it shows up in Today, and "Deadline" is the day it has to be finished. Whatever I might do one day goes to Someday, which keeps them out of Today and Upcoming until I go looking for them.

## Editing in both places

Because the to-dos are files, I can work on them in Obsidian too, right next to the notes they belong to. Whatever I change there shows up in the app a moment later, and the reverse. When I'm in the app and want the raw text, the project's ••• menu has **Edit the note itself**, which opens the actual file right there.

## If you want the same

If you live in Obsidian and want your to-dos there too, as files, start with [Install](install.md). It's one container on any machine you have, and the Mac and Android apps are built from this repository. If you get stuck, feel free to ask me.

<sub>Next: [Install](install.md) →</sub>
