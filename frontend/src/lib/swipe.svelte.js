// Swiping a to-do on a phone.
//
// The row hardly moves. It gives by about the width of its own checkbox, and in
// the room that makes a small tab shows at its edge: yellow with a calendar on
// the left, for the When popover — let go and it opens; blue with a circle on
// the right, which puts the list into selection mode with that to-do already
// picked. That is the only route to multi-select without a keyboard:
// ⌘-click and Shift-click are all a thumb has otherwise, and a thumb has neither.
//
// A short travel is the point. A row that slides halfway across the screen says
// "this can be thrown away"; one that leans and shows a tab says "this does
// something", and the finger never has to go far enough to lose the list.
//
// Drag-to-reorder lives on the same row. On touch it waits for a long press
// (lib/dnd.svelte.js), so a swipe gets there first — and the moment this claims
// the gesture it cancels the pending drag, or the timer would fire behind it
// and the row would be dragged and swiped at once.
import { cancelPendingDrag } from './dnd.svelte.js';
import { openPopover, startSelecting, toggleSelected, app } from './store.svelte.js';
import { touchLayout, takeTouch, releaseTouch } from './touch.js';

/** Below this it is a tap, or the list scrolling past. */
const SLOP = 10;
/** The row gives this much and no more: the width of the tab it uncovers.
 *  40px on a 375px screen, a little over a tenth of the way across. */
const MAX = 40;
/** It moves at this fraction of the finger, so it feels held, not loose. */
const GIVE = 0.8;
/** Far enough to have meant it. Short, because it should read as a flick
 *  rather than a haul: past this the row eases on to its detent by itself and
 *  letting go acts, so the finger never has to travel the whole width of the
 *  tab. */
const ACT = 34;

export function swipeRow(node, todo) {
  let current = todo;
  let start = null;

  function down(e) {
    if (!e.isPrimary || (e.button !== undefined && e.button !== 0)) return;
    if (!touchLayout()) return;
    // The checkbox and the buttons in a row own their own taps.
    if (e.target.closest('.cb, button, a, input, textarea, [contenteditable]')) return;
    start = { x: e.clientX, y: e.clientY, claimed: false };
  }

  function move(e) {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.claimed) {
      if (Math.abs(dx) < SLOP) return;
      // Mostly vertical: the list wants to scroll, and it should.
      if (Math.abs(dy) > Math.abs(dx)) return void (start = null);
      if (!takeTouch('swipe')) return void (start = null);
      start.claimed = true;
      cancelPendingDrag();
      node.classList.add('swiping');
      try { node.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    }
    node.classList.toggle('swipe-right', dx > 0);
    node.classList.toggle('swipe-left', dx < 0);
    node.style.setProperty('--swipe', `${Math.max(-MAX, Math.min(MAX, dx * GIVE))}px`);
    // The tick a thumb feels when the tab is all the way out: let go now and
    // it happens. Once per crossing, not once per pixel.
    const armed = Math.abs(dx) >= ACT;
    if (armed !== start.armed) {
      start.armed = armed;
      node.classList.toggle('armed', armed);
      if (armed && navigator.vibrate) navigator.vibrate(6);
    }
  }

  function end(e) {
    if (!start) return;
    const { claimed, x } = start;
    start = null;
    if (!claimed) return;
    const dx = e.clientX - x;
    settle();
    if (dx >= ACT) {
      openPopover('when', { type: 'todo', id: current.id }, node, { swiped: true });
    } else if (dx <= -ACT) {
      // Already choosing? Then the swipe adds to the choice rather than
      // starting a new one.
      if (app.selecting) toggleSelected(current.id);
      else startSelecting(current.id);
    }
  }

  function settle() {
    releaseTouch('swipe');
    node.classList.remove('swiping', 'swipe-left', 'swipe-right', 'armed');
    node.style.removeProperty('--swipe');
  }

  function cancel() {
    if (!start) return;
    const claimed = start.claimed;
    start = null;
    if (claimed) settle();
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', cancel);

  return {
    update(next) { current = next; },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', cancel);
    }
  };
}
