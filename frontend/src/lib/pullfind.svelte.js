// Pull the list down to search it.
//
// Quick Find sits above the top of the list rather than behind a button, so
// you reach it the way you reach the top of anything on a phone: by pulling.
// The button in the corner stays — this is the gesture for people who already
// know it is there.
//
// Only from a standstill at the very top, and only downwards: anywhere else the
// list is scrolling and the pull would fight it. A magnifier comes down with
// the list, grey; past the mark it turns blue, and that is the whole interface:
// let go while it is blue and Quick Find opens.
import { cancelPendingDrag } from './dnd.svelte.js';
import { openQuickFind } from './store.svelte.js';
import { claimTouch, touchLayout, takeTouch, releaseTouch } from './touch.js';

const SLOP = 8;
/** Far enough down to have meant it: the magnifier turns blue here. */
const ACT = 62;
/** However hard you pull. */
const MAX = 104;
/** The list gives a little less than the finger asks, so it feels weighted. */
const RESIST = 0.62;

export function pullFind(node) {
  let start = null;
  // The magnifier is a sibling of the list, not a child, and a custom property
  // only travels down: both have to read it from the pane they share.
  const pane = () => node.closest('.main') || node;

  function set(px) {
    pane().style.setProperty('--pull', `${px}px`);
    pane().style.setProperty('--pullp', String(Math.min(1, px / ACT)));
    // Grey while it is only being looked at, blue once letting go will search:
    // the one thing a pull has to say is which side of the line the finger is.
    const armed = px >= ACT;
    if (armed !== pane().classList.contains('armed')) {
      pane().classList.toggle('armed', armed);
      if (armed && navigator.vibrate) navigator.vibrate(6);
    }
  }

  function clear() {
    releaseTouch('pull');
    pane().classList.remove('pulling', 'armed');
    pane().style.removeProperty('--pull');
    pane().style.removeProperty('--pullp');
  }

  function down(e) {
    if (!e.isPrimary || !touchLayout()) return;
    if (node.scrollTop > 0) return;          // the list is somewhere else
    // Not from inside an open to-do: dragging down through its notes is reading
    // them, or selecting text, and used to open Quick Find over the top.
    if (e.target.closest('.card, input, textarea, [contenteditable]')) return;
    start = { x: e.clientX, y: e.clientY, claimed: false, captured: false, touch: e.pointerType === 'touch' };
  }

  /** Is this pull ours? Asked by the pointer, and asked again by the touch
   *  guard, which has to answer on the very first movement: a browser sends
   *  that only once the finger is clear of its own slop, so by then the
   *  direction is already plain and waiting for ours would lose the gesture. */
  function claims(x, y) {
    if (!start) return false;
    if (start.claimed) return true;
    const dy = y - start.y;
    const dx = x - start.x;
    if (dy <= 0 || Math.abs(dx) > dy) {
      // Upwards or sideways: not ours, and never will be for this gesture.
      if (dy < -SLOP || Math.abs(dx) > SLOP) start = null;
      return false;
    }
    if (dy < SLOP && !start.touch) return false;
    if (!takeTouch('pull')) return void (start = null), false;
    start.claimed = true;
    cancelPendingDrag();
    pane().classList.add('pulling');
    return true;
  }

  function move(e) {
    if (!claims(e.clientX, e.clientY)) return;
    if (!start.captured) {
      start.captured = true;
      try { node.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    }
    set(Math.max(0, Math.min(MAX, (e.clientY - start.y) * RESIST)));
  }

  function end(e) {
    if (!start) return;
    const { claimed, y } = start;
    start = null;
    if (!claimed) return;
    clear();
    if ((e.clientY - y) * RESIST >= ACT) openQuickFind();
  }

  function cancel() {
    if (start && start.claimed) clear();
    start = null;
  }

  const release = claimTouch(node, (e) => claims(e.touches[0].clientX, e.touches[0].clientY));

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', cancel);

  return {
    destroy() {
      release();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', cancel);
    }
  };
}
