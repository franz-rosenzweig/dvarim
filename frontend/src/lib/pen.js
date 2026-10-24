// The pen, and the hand that holds it.
//
// A stylus (an S Pen, say) is a pointer of its own kind, `pointerType: 'pen'`,
// and most of the app already treats it as the precise pointer it is: hovering
// shows what a mouse would, pressing and moving lifts a row at once with no
// long press (lib/dnd.svelte.js), a tap opens a to-do. What the page has to do
// itself is ignore the hand. Writing or tapping with a pen, the palm rests on
// the glass, and every touch it makes would scroll the list or tap a row.
//
// The rule: while a pen is near the screen (hovering above it or touching it,
// and for a moment after it lifts) a finger's touches are not the page's to
// act on. A contact as big as a palm never is. A pen's own touches always
// pass. The Android shell drops the same touches before they reach the page,
// which also stops the scrolling the page cannot see coming; this is the same
// rule in the page, for the browser and for a shell that does not.

/** How long after the pen was last near the screen the hand still counts as resting. */
const NEAR_MS = 600;
/** A contact this wide or tall, in CSS pixels, is a palm or the side of a hand. */
const PALM_PX = 40;

let penAt = -Infinity;
let lastType = '';
const rejected = new Set();      // pointers of a palm, whatever they do next

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A pen is on the screen or just above it. */
export const penNear = () => now() - penAt < NEAR_MS;

/** What the last pointer to press was: 'mouse', 'pen' or 'touch'. A contextmenu
 *  event does not always say, and a menu is right for a pen's side button or a
 *  mouse, wrong for a finger's long press. */
export const lastPointerType = () => lastType;

const big = (w, h) => w > PALM_PX || h > PALM_PX;

function sawPen(e) {
  if (e.pointerType === 'pen') penAt = now();
}

/** Installed once, on the window, in the capture phase, so it hears every
 *  pointer before anything in the page does. */
export function installPen(win = window) {
  if (!win || win.__dvarimPen) return;
  win.__dvarimPen = true;
  const opt = { capture: true, passive: true };
  win.addEventListener('pointerover', sawPen, opt);
  win.addEventListener('pointermove', (e) => {
    sawPen(e);
    if (rejected.has(e.pointerId)) e.stopImmediatePropagation();
  }, { capture: true });
  win.addEventListener('pointerdown', (e) => {
    sawPen(e);
    lastType = e.pointerType || '';
    if (e.pointerType === 'touch' && (penNear() || big(e.width, e.height))) {
      rejected.add(e.pointerId);
      e.stopImmediatePropagation();
    }
  }, { capture: true });
  for (const type of ['pointerup', 'pointercancel']) {
    win.addEventListener(type, (e) => {
      sawPen(e);
      if (!rejected.has(e.pointerId)) return;
      rejected.delete(e.pointerId);
      e.stopImmediatePropagation();
    }, { capture: true });
  }
  // The browser's own answers to a touch: a scroll, and the click that follows
  // a tap. Calling preventDefault on the touch stops both. A pen's own touches
  // say `touchType: 'stylus'` and are left alone.
  const palmTouch = (e) => {
    const fingers = [...e.changedTouches].filter((t) => t.touchType !== 'stylus');
    if (!fingers.length || fingers.length < e.changedTouches.length) return false;
    return penNear() || fingers.some((t) => big((t.radiusX || 0) * 2, (t.radiusY || 0) * 2));
  };
  win.addEventListener('touchstart', (e) => {
    if (palmTouch(e) && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  win.addEventListener('touchmove', (e) => {
    if (palmTouch(e) && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
}

/** For tests: forget the pen. */
export function resetPen() {
  penAt = -Infinity;
  lastType = '';
  rejected.clear();
}
