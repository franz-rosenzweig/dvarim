// The sidebar put away, on a desk.
//
// The sidebar can be swiped shut with two fingers, or toggled with ⌘/, so
// that a list can sit in a narrow window beside something else; with it gone
// you get around by Quick Find. A two-finger swipe on a trackpad reaches a page
// as wheel events that are mostly sideways, so the gesture can live here and
// work in any browser as well as in the Mac app, which adds only the menu item
// (View ▸ Hide Sidebar) and leaves the rest to this.
//
// Leftwards over the sidebar puts it away. Rightwards from the strip of window
// where it used to be brings it back — not from anywhere, because in the Mac app
// a rightward swipe anywhere else is WebKit's Back.
//
// A phone has the drawer instead (lib/drawer.svelte.js); this does nothing there.
import { app, toggleSlim } from './store.svelte.js';

/** Sideways travel, in wheel pixels, that counts as meaning it. */
const ACT = 60;
/** A swipe is over when the wheel has been quiet this long. */
const QUIET_MS = 180;
/** How much of the left of the window answers when the sidebar is away. */
const RETURN_STRIP = 140;

const wide = () => typeof matchMedia !== 'undefined' && matchMedia('(min-width: 721px)').matches;

export function slimSwipe(node) {
  let sum = 0;
  let fired = false;
  let quiet = null;

  function wheel(e) {
    if (!wide() || e.ctrlKey) return;                       // ctrl+wheel is a pinch
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // the list scrolling
    const overSidebar = !!e.target.closest('.sidebar');
    const closing = !app.slim && overSidebar && e.deltaX > 0;
    const opening = app.slim && e.clientX < RETURN_STRIP && e.deltaX < 0;
    if (!closing && !opening && !fired) return;
    // Ours, so not also the browser's: in the Mac app this same swipe would
    // otherwise go Back as well.
    e.preventDefault();
    clearTimeout(quiet);
    quiet = setTimeout(() => { sum = 0; fired = false; }, QUIET_MS);
    if (fired) return;                                      // one toggle per swipe; the rest is momentum
    sum += e.deltaX;
    if (Math.abs(sum) >= ACT) { fired = true; toggleSlim(); }
  }

  node.addEventListener('wheel', wheel, { passive: false });
  return { destroy() { node.removeEventListener('wheel', wheel); clearTimeout(quiet); } };
}
