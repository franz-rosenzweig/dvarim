// The navigation, as a drawer.
//
// On a phone the sidebar used to be a screen of its own: tapping "Lists"
// replaced whatever you were reading with the list of lists, which makes the
// navigation look like the app rather than a way around it. A drawer says what
// it is — it slides over the page, stops short of the right edge so the page
// stays visible behind it, and goes away again.
//
// A strip down the left edge opens it; the scrim over the page closes it, and so
// does pushing the panel itself back where it came from.
//
// On a phone with gesture navigation the whole edge belongs to the system,
// which reads any swipe in from it as Back before the page sees it. The Android
// shell asks for a band of that edge back (EdgeGestures.java — the system lends
// 200dp of it, no more), and in that band the finger reaches here. So the same
// swipe means two things, told apart by how it is done: carried slowly, it
// drags the drawer out under the finger; flicked, it is Back, which is what a
// flick from the edge means everywhere else on the phone. Nothing is lost by
// getting it wrong — on a list with nothing open, Back brings the drawer out
// too (lib/backstack.svelte.js).
//
// The finger drives a --drawer custom property from 0 to 1; CSS does the rest,
// including the animation once the finger lets go.

import { takeTouch, releaseTouch } from './touch.js';

/** Below this the gesture is a tap, or a scroll, and not ours. */
const SLOP = 8;
/** A flick is judged on direction; anything slower on where it ended up. */
const FLICK_MS = 300;

const clamp = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * @param {HTMLElement} node
 * @param {{ opening: boolean, set: (open: boolean) => void, eager?: boolean, flick?: () => void }} opts
 *   flick: what a quick swipe means instead of dragging the drawer — Back, on
 *   the edge strip, where that is what a flick has always meant.
 *   eager: capture the pointer the moment it lands. Right for the strip, which
 *   the finger leaves at once; wrong for the panel, where a captured pointer
 *   would steal the click from whatever list was tapped.
 */
export function drawerDrag(node, opts) {
  let start = null;
  let frame = null;
  let width = 1;

  const at = (dx) => clamp(opts.opening ? dx / width : 1 + dx / width);

  function down(e) {
    if (!e.isPrimary) return;
    frame = node.closest('.app');
    if (!frame) return;
    const panel = frame.querySelector('.sidebar');
    width = (panel && panel.getBoundingClientRect().width) || 1;
    // The panel is only a drawer on a phone, and only closes while it is out.
    if (!opts.opening && !frame.classList.contains('root')) return;
    start = { x: e.clientX, y: e.clientY, at: Date.now(), dragging: false };
    // The strip is sixteen pixels wide and the finger leaves it immediately,
    // taking the pointermoves with it otherwise.
    if (opts.eager) try { node.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  }

  function move(e) {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.dragging) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      // Mostly vertical: the page wants to scroll, so let it.
      if (Math.abs(dy) > Math.abs(dx)) return void (start = null);
      if (!takeTouch('drawer')) return void (start = null);
      start.dragging = true;
      if (!opts.eager) try { node.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      frame.classList.add('dragging');
    }
    frame.style.setProperty('--drawer', String(at(dx)));
  }

  function end(e) {
    if (!start) return;
    const { dragging, x, at: began } = start;
    start = null;
    if (!dragging) return;          // a tap; the scrim's click handler has it
    releaseTouch('drawer');
    frame.classList.remove('dragging');
    frame.style.removeProperty('--drawer');
    const dx = e.clientX - x;
    const quick = Date.now() - began < FLICK_MS;
    // Flicked in from the edge: the phone's own gesture, so do what it does.
    if (quick && opts.flick && dx > SLOP) return opts.flick();
    opts.set(quick ? dx > 0 : at(dx) > 0.5);
  }

  function cancel() {
    if (!start) return;
    if (start.dragging) {
      releaseTouch('drawer');
      frame.classList.remove('dragging');
      frame.style.removeProperty('--drawer');
    }
    start = null;
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', cancel);

  return {
    update(next) { opts = next; },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', cancel);
    }
  };
}
