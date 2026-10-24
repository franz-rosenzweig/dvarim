// Telling the engine that a touch belongs to the page.
//
// A touchscreen browser decides within the first few pixels whether a finger is
// scrolling, and once it has decided, the page gets one `pointercancel` and
// nothing more: the finger keeps moving and no handler ever hears about it.
// Every gesture here has to win that argument before it can do anything else.
//
// Where the answer never changes it is said in CSS, with `touch-action` — a row
// never pans sideways, the plus button never pans at all (see "Touch" in
// app.css). This is for where it depends on the moment: the top of a list
// pulled downwards, a row that has been held long enough to lift. That takes a
// touchmove listener that is not passive, and it has to act on the FIRST
// touchmove. Let that one through and scrolling has begun; every later one
// arrives marked not cancelable.
//
// Synthesized PointerEvents in a desktop browser skip this arbitration
// entirely, which is how four gestures once shipped that no finger could
// finish. They can only be tried on a touchscreen: android/shell/dev.sh.

/**
 * @param {HTMLElement} node
 * @param {(e: TouchEvent) => boolean} mine  true while the gesture is ours
 * @returns {() => void} undo
 */
export function claimTouch(node, mine) {
  const guard = (e) => { if (e.cancelable && mine(e)) e.preventDefault(); };
  node.addEventListener('touchmove', guard, { passive: false });
  return () => node.removeEventListener('touchmove', guard);
}

// One finger, one gesture.
//
// A row can be swiped, lifted and scrolled; the list under it can be pulled
// down; all of them start with the same finger landing in the same place, and
// each used to decide on its own whether the movement was meant for it. Two of
// them could say yes — holding a row at the top of a list and dragging it down
// both lifted the row and pulled the list out from under it. So a gesture takes
// the touch before it acts, and nothing else can until it lets go.
let owner = null;

/** True if the touch is now `who`'s: it was free, or already theirs. */
export function takeTouch(who) {
  if (owner && owner !== who) return false;
  owner = who;
  return true;
}

export function releaseTouch(who) {
  if (owner === who) owner = null;
}

/** The layouts, as app.css draws them; the queries here and there must agree.
 *  The phone layout is a narrow screen, or a finger on anything short of a
 *  tablet on its side; touch is any screen a finger drives, phone or tablet.
 *  `(pointer: coarse)` follows the primary pointer, so a mouse or a trackpad,
 *  a tablet's in DeX among them, brings the desk back. */
export const PHONE_MQ = '(max-width: 720px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 559px)';
export const TOUCH_MQ = '(max-width: 720px), (pointer: coarse)';

const matches = (q) => typeof matchMedia !== 'undefined' && matchMedia(q).matches;

/** The phone layout: the drawer, the full-screen card, popovers as panels. */
export const phoneLayout = () => matches(PHONE_MQ);

/** Where the phone's gestures are armed: wherever a finger drives, which is
 *  where app.css styles what they draw — the tabs, the circles, the lifted
 *  card, the parting list. On a tablet on its side that is the desk's two
 *  panes, with all of them. */
export const touchLayout = () => matches(TOUCH_MQ);

/** A pointerup is followed by a click, and a drag is not a click: catch the next
 *  one on the way down, before it reaches whatever it landed on. A same-node
 *  listener would be too late — at the target, listeners run in registration
 *  order, and the element's own was registered first. */
export function swallowNextClick() {
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
    document.removeEventListener('click', swallow, true);
  };
  document.addEventListener('click', swallow, true);
  // If no click follows — a cancelled gesture, say — do not lie in wait.
  setTimeout(() => document.removeEventListener('click', swallow, true), 400);
}
