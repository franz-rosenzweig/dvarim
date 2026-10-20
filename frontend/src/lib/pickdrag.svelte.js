// Choosing a run of to-dos by running a finger down their circles.
//
// In selection mode each row has a circle at its right-hand end. Tapping one
// picks that row; but the point of the column is that a thumb can be drawn down
// it, and every circle it passes takes the state the first one was given — so
// twelve to-dos are one stroke, not twelve taps. Drawn back up, it lets go of
// what it overshot: the stroke is a range from where it began, not a trail.
//
// The circles say touch-action:none in CSS: this column is for painting, and a
// stroke down it must not scroll the list out from under the finger. The rest
// of the row still scrolls.
import { app, setSelected } from './store.svelte.js';
import { takeTouch, releaseTouch } from './touch.js';

export function pickDrag(node, id) {
  let current = id;
  let stroke = null;        // {state, before, ids, from, to}
  let pressedAt = 0;

  /** The rows as they stand on screen, in order, whichever list they are in. */
  const rowIds = () => [...document.querySelectorAll('.content [data-todo-id]')].map((r) => r.dataset.todoId);

  /** Everything between where the stroke began and where it is now takes its
   *  state; anything it has been over and left again goes back to what it was. */
  function paint(to) {
    const lo = Math.min(stroke.from, to);
    const hi = Math.max(stroke.from, to);
    const seenLo = Math.min(lo, stroke.lo);
    const seenHi = Math.max(hi, stroke.hi);
    for (let i = seenLo; i <= seenHi; i++) {
      const inside = i >= lo && i <= hi;
      setSelected(stroke.ids[i], inside ? stroke.state : stroke.before.has(stroke.ids[i]));
    }
    stroke.lo = seenLo;
    stroke.hi = seenHi;
    stroke.to = to;
  }

  function down(e) {
    if (!e.isPrimary || (e.button !== undefined && e.button !== 0)) return;
    if (!takeTouch('pick')) return;
    const ids = rowIds();
    const from = ids.indexOf(current);
    if (from < 0) return void releaseTouch('pick');
    stroke = { state: !app.selected.includes(current), before: new Set(app.selected), ids, from, to: from, lo: from, hi: from };
    pressedAt = Date.now();
    paint(from);
    try { node.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    if (navigator.vibrate) navigator.vibrate(4);
  }

  function move(e) {
    if (!stroke) return;
    // Whichever row is level with the finger: it need not stay on the circles.
    const probe = document.elementFromPoint(node.getBoundingClientRect().left + 4, e.clientY);
    const row = probe && probe.closest('[data-todo-id]');
    const to = row ? stroke.ids.indexOf(row.dataset.todoId) : -1;
    if (to < 0 || to === stroke.to) return;
    paint(to);
    if (navigator.vibrate) navigator.vibrate(4);
  }

  function end() {
    if (!stroke) return;
    stroke = null;
    releaseTouch('pick');
  }

  // A keyboard or a screen reader presses the button with no pointer at all;
  // a finger has already been dealt with by the time its click arrives.
  function click(e) {
    e.stopPropagation();
    if (Date.now() - pressedAt < 700) return;
    setSelected(current, !app.selected.includes(current));
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('click', click);
  return {
    update(next) { current = next; },
    destroy() {
      end();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      node.removeEventListener('click', click);
    }
  };
}
