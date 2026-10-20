// "Meet Dvarim": the tutorial project a new vault starts with (Store.open,
// `tutorial`), and that Settings → General makes again (Store.addTutorial).
// Every to-do in it is something to do rather than read, so it teaches by
// being used, and it is an ordinary project: one note, deleted like any other.
// The first to-do comes ticked, so the project's pie has started before
// anything else has.

export const TUTORIAL_PATH = 'Projects/Meet Dvarim.md';
export const TUTORIAL_ID = 'pmeetdvr';

/** The note, dated `today` (YYYY-MM-DD). Its ids are the same everywhere, so
 *  two devices that each started with it hold one project, not two, unless
 *  `freshId` (prefix => id) gives this copy ids of its own. */
export function tutorialText(today, freshId = null) {
  const text = template(today);
  if (!freshId) return text;
  return text.replace(TUTORIAL_ID, freshId('p')).replace(/meetdv\d\d/gu, () => freshId(''));
}

/** A tutorial as a new vault got it, not touched since: a device new to a
 *  vault that already has notes leaves one of these behind (webdav.js). */
export function isUntouchedTutorial(text) {
  const m = /^created: (\d{4}-\d{2}-\d{2})$/mu.exec(text || '');
  return !!m && text === template(m[1]);
}

function template(today) {
  return `---
id: pmeetdvr
type: project
status: open
created: ${today}
---
I made Dvarim so that my to-dos live in plain Markdown files I can open anywhere. This project is the tour, and every to-do in it is something to TRY rather than just read, so tick them off as you go. On a keyboard without ⌘, use Ctrl instead.

- [x] Find the tutorial 🆔 meetdv01 ✅ ${today}
    You already did this one.

## The basics
- [ ] Tick this box to complete a to-do 🆔 meetdv02
    That's the whole trick. Finished to-dos move to the Logbook, either right away or at the end of the day, which you can choose in Settings → General.
- [ ] Open this to-do to see what's inside 🆔 meetdv03
    Double-click it, or select it and press Enter. On a phone, tap it. Inside are its notes (like these), a checklist, tags, a date and a deadline. Press Esc to close it again.
- [ ] Work through this checklist 🆔 meetdv04
    A checklist is for small steps that don't need to be to-dos of their own. In an open to-do, ⌘⇧C adds one.
    - [ ] Open this to-do
    - [ ] Tick a step
    - [ ] Tick the last one
- [ ] Add a to-do of your own with ⌘N 🆔 meetdv05
    Or press the + button. On a phone you can drag the + into the list, and the new to-do lands right where you let go.

## Planning your day
- [ ] Drag this to-do onto Today in the sidebar 🆔 meetdv06
    Or select it and press ⌘T. Today is what you're doing today, and the order is yours, so drag things up and down until it reads right.
- [ ] Press ⌘E to move this into This Evening 🆔 meetdv07
    This Evening is the part of Today you can only get to later, and it sits at the bottom of Today with a moon.
- [ ] Press ⌘S and type "next Friday" 🆔 meetdv08
    That's the When popover, and it takes dates in plain words ("tomorrow", "in 3 days", "fri"). On a phone, swipe the to-do to the right to get the same thing. Anything with a later date waits in Upcoming until its day comes.
- [ ] Give this one a deadline with ⌘⇧D 🆔 meetdv09
    When is the day you plan to START something, and the deadline is the day it's DUE. A to-do shows up in Today on its deadline, even if you never scheduled it.
- [ ] Add a heading to Today 🆔 meetdv10
    In Today, press ⌘⇧N or use the ••• next to its title, then drag to-dos under it. It's handy for splitting the day into "Morning", "Calls" or "Errands".

## Your files
- [ ] Open this project as a note 🆔 meetdv11
    Press the ••• next to "Meet Dvarim" and choose "Edit the note itself". This is what Dvarim actually keeps: a plain Markdown file, which any text editor can read, and Settings → Data has a button that downloads all of them, so your to-dos are never stuck in here.
- [ ] Find anything with ⌘F 🆔 meetdv12
    Quick Find goes straight to any list, project, area, tag or to-do by name.
- [ ] Delete this project when you're done 🆔 meetdv13
    Use the ••• next to its name. It goes to the Trash like anything else, so nothing is lost if you change your mind.
`;
}
