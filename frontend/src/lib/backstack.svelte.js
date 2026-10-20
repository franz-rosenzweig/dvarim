// What Back does on a phone.
//
// Android has one gesture that every app answers: Back. With gesture
// navigation it is a swipe in from either edge of the screen, and the system
// takes that swipe before the page ever sees it — so the left edge cannot be
// ours to open the drawer with, and an app that ignores Back simply closes
// under the thumb that was reaching for the navigation.
//
// So on a phone the history is kept as a stack of depths, not of places:
//
//     0   the drawer is out                  (the Lists screen)
//     1   a list
//     2   a list with something open over it — a to-do's card, a popover,
//         Quick Find, a selection, Settings
//     3   …and one more for each further thing open over that
//
// Back takes one step down it: it closes what is open, then brings out the
// drawer, and from the drawer it leaves the app, because there is nothing under
// entry 0. Moving between lists replaces the entry rather than adding one, or
// Back would walk through every list visited instead of going anywhere useful.
//
// The app's state is the truth and history follows it: whatever opens or closes
// a layer, by whatever route, `sync` pushes or pops entries until the depth in
// history matches. Back is the one case that runs the other way.
import { app, useBackStack, closeSettings, closeSource, stopSelecting, viewPath } from './store.svelte.js';

/** Where the drawer exists at all; wider than this the sidebar is just there. */
const phone = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 720px)').matches;

let active = false;
let depth = 0;          // where history is
let travelling = 0;     // history.go() calls whose popstate has not arrived yet
let settle = null;

/** How deep we are: 0 the drawer, 1 a list, and one more for each thing open
 *  over it. Counting them, rather than lumping them into one "something is
 *  open" step, is what keeps a Back from having to push an entry back on: after
 *  a Back closes one of two open layers, history is already where it should be.
 *  And pushing from inside a popstate handler is the one thing Android's WebView
 *  cannot follow — the new entry never reaches its own back list, so the Back
 *  after that left the app instead of arriving here. */
const openLayers = () =>
  [app.settingsOpen, app.source, app.inboxSheet, app.popover || app.quickFind, app.selecting, app.expanded]
    .filter(Boolean).length;

const wanted = () => (app.root ? 0 : 1 + openLayers());

/** Put away whatever is on top — one thing, as Escape would. */
function closeTop() {
  if (app.settingsOpen) return closeSettings();
  if (app.source) return closeSource();
  if (app.inboxSheet) { app.inboxSheet = false; return; }
  if (app.popover || app.quickFind) { app.popover = null; app.quickFind = null; return; }
  if (app.selecting) return stopSelecting();
  if (app.expanded) {
    app.expanded = null;
    const el = document.activeElement;
    if (el && el !== document.body) el.blur();
  }
}

function entry(d) {
  // A snapshot: history keeps a structured clone, and a state proxy has none.
  return { ...(history.state || {}), view: $state.snapshot(app.view), depth: d };
}

/**
 * Where one of our own traversals has come to rest, make the entry say where
 * the app is.
 *
 * Every entry pushed for a layer carries the address of the list under it, so
 * stepping down lands on an entry that names the place the app was when that
 * layer opened. Usually that is still where it is. Not when the same moment
 * that closed the layer also moved the app: Convert to Project closes the card
 * and opens the project, and navigate() writes /project/… into the entry on
 * top — the card's — which is the one this then steps back off. The app showed
 * the project and the address still said /inbox, so a reload went back there.
 * The app's state is the truth; this is history following it.
 */
function land() {
  if (app.shared) return;                   // /share stays until the sheet is done (store.syncUrl)
  const path = viewPath(app.view);
  if (location.pathname !== path) history.replaceState(entry(depth), '', path);
}

/** Bring history to the depth the app is showing. */
export function sync() {
  if (!active || travelling) return;      // a traversal is in flight; it calls back here
  const want = wanted();
  if (want > depth) {
    while (depth < want) { depth += 1; history.pushState(entry(depth), ''); }
  } else if (want < depth) {
    travelling += 1;
    history.go(want - depth);
    depth = want;
    // A traversal with nowhere to go fires nothing. Do not wait for it forever,
    // or the next real Back would be taken for ours and swallowed.
    clearTimeout(settle);
    settle = setTimeout(() => { travelling = 0; land(); sync(); }, 600);
  }
}

/** A popstate. True if it was ours to handle. */
function onPop(e) {
  if (!active) return false;
  if (travelling) {
    travelling -= 1;
    if (!travelling) { clearTimeout(settle); land(); sync(); }
    return true;
  }
  const d = e.state && e.state.depth;
  if (typeof d !== 'number') return false;
  const was = depth;
  depth = d;
  if (d < was) {
    if (was >= 2) closeTop();               // something was open: Back closed it
    if (d === 0) { while (openLayers()) closeTop(); app.root = true; }
  } else if (d > was) {
    app.root = false;                       // Forward, where there is one
  }
  // Closing one layer may have left another showing; history goes back up to it.
  queueMicrotask(sync);
  return true;
}

export function installBackStack() {
  if (active || !phone() || typeof history === 'undefined') return;
  active = true;
  const d = history.state && history.state.depth;
  if (typeof d === 'number') depth = d;     // a reload part-way up the stack
  else { depth = 0; history.replaceState(entry(0), ''); }
  useBackStack(onPop);
  sync();
}
