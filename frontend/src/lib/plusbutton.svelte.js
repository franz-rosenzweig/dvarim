// The + button.
//
// Tapping it makes a to-do, which is the ordinary half. The other half is that
// the button can be picked up. It leaves its corner and goes with the finger;
// the list parts where it is held, to show the room the new to-do will take; and
// two dark targets come up at the bottom of the screen — the Inbox on the left,
// which swells as the button nears it and takes the to-do without leaving the
// list being read, and a cross in the corner the button came from, to put it
// back having done nothing. Inside a project it has one more skill: taken to the
// left margin, the room it has opened becomes a rule marked NEW HEADING, and
// letting go there puts a heading at that point in the list.
//
// The button keeps its click. Nothing is claimed until a finger has moved past
// the slop, and a claimed drag swallows the click that would otherwise follow,
// so a tap and a drag never both happen. That it never pans is said in CSS
// (touch-action:none on .fab): see lib/touch.js for why that has to be said.
import { app, createTodo, createHeading, createTodayHeading, fileInToday, reorderTo } from './store.svelte.js';
import { takeTouch, releaseTouch, swallowNextClick } from './touch.js';
import { partAt, closeGap } from './gap.js';

const SLOP = 8;
/** Held this long without moving and the button lifts where it stands. Long
 *  enough to be past an ordinary tap. */
const HOLD_MS = 220;
/** Within this of the Inbox's corner, it is the Inbox that is meant. */
const INBOX_REACH = 118;
/** Within this of the corner it came from, it is being put back. */
const CANCEL_REACH = 46;
/** A row's worth of room, opened where the to-do would land — one PLAIN row's
 *  worth. The new to-do has no project sub-line, so copying whatever happens to
 *  be next to the finger (a two-line row, or an open card) opens the wrong
 *  amount and the list jumps again when the real row lands. */
const GAP = 40;
let gapH = GAP;
function measureGap() {
  for (const r of document.querySelectorAll('.content .row')) {
    if (r.querySelector('.sub')) continue;
    const h = Math.round(r.getBoundingClientRect().height);
    if (h > 20) return h;
  }
  return GAP;
}
/** This close to the left edge it is a heading being made: in a project, or
 *  in Today outside This Evening, where it is a heading of Today's own. */
const HEADING_MARGIN = 58;
const headed = (at) => app.view.kind === 'project'
  || (app.view.kind === 'list' && app.view.id === 'today' && at.list.dataset.listTodayHeading !== undefined);

export const plus = $state({
  active: false,
  x: 0, y: 0,
  over: null,        // 'list' | 'heading' | 'inbox' | 'cancel' | null — what letting go would do
  dropping: false    // let go over the list: shrinking away while the card grows
});

let aimed = null;    // {list, rows, context, index}

/** Lists that order themselves, or hold what is finished: nothing is made there. */
const CLOSED = new Set(['logbook', 'trash']);

/**
 * Where a drop here would land: the list nearest the finger, and the midpoints
 * of the rows already in it — as a dragged to-do measures it (lib/dnd.svelte.js).
 *
 * Nearest, not under. Most of a screen is not rows: headings, the gaps between
 * sections, the title, the room under the last to-do, a heading with nothing in
 * it yet. Asking for the finger to be exactly over a row meant letting go a few
 * pixels off one did nothing at all, and an empty list could not be dropped
 * into. Between two sections the nearer one wins, so crossing a heading goes
 * from the first slot of the one below to the last slot of the one above. The
 * placeholder is not a row, so opening it under the finger does not change the
 * answer and the gap cannot chase itself.
 */
function aim(x, y) {
  const pane = document.querySelector('.content');
  if (!pane) return null;
  const view = pane.getBoundingClientRect();
  if (y < view.top || y > view.bottom) return null;
  let list = null;
  let best = Infinity;
  for (const l of pane.querySelectorAll('[data-drop-context]')) {
    if (!l.dataset.dropContext || CLOSED.has(l.dataset.dropContext)) continue;
    const box = l.getBoundingClientRect();
    if (box.bottom < view.top || box.top > view.bottom) continue;       // scrolled out of sight
    const d = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (d < best) { best = d; list = l; }
  }
  if (!list) return null;
  const rows = [...list.querySelectorAll('[data-todo-id]')];
  let index = 0;
  for (const r of rows) {
    const box = r.getBoundingClientRect();
    if (y > box.top + box.height / 2) index += 1;
  }
  return { list, rows, context: list.dataset.dropContext, index };
}

/**
 * What a to-do has to be to belong in the list it was dropped into. The view
 * alone does not say: Anytime shows a project's to-dos under that project, every
 * day in Upcoming is its own list, This Evening is part of Today.
 */
function belonging(at) {
  const c = at.context;
  const d = at.list.dataset;
  const extra = {};
  if (c.startsWith('heading:')) { extra.headingId = c.slice(8); extra.projectId = extra.headingId.split(':')[0]; }
  else if (c.startsWith('project:')) { extra.projectId = c.slice(8); extra.headingId = null; }
  else if (c.startsWith('area:')) extra.areaId = c.slice(5);
  else if (c === 'inbox') extra.inbox = true;
  if (d.listWhen) extra.when = d.listWhen;
  if (d.listEvening === 'true') extra.evening = true;
  return extra;
}

/** In these the file's order is the order shown, so the to-do can be made in
 *  its place in one go. Today, Anytime and Someday keep their order apart from
 *  the files, and there it has to be made and then put (the same two steps a
 *  drag takes); Upcoming orders itself by date. */
const fileOrdered = (c) => c === 'inbox' || /^(heading|project|area):/.test(c);

/** Part the list at `at`, closing wherever it was parted before. */
function part(at, heading) {
  aimed = at;
  if (!at) return void closeGap();
  const gap = partAt(at.list, at.rows[at.index] || null, gapH);
  if (gap) gap.classList.toggle('heading', !!heading);
}

/** Where in the project a heading dropped at `at` goes, in the API's terms: at
 *  a to-do, and what is below it in that section comes under the new heading. */
function headingPosition(at) {
  const id = (row) => row && row.dataset.todoId;
  if (at.index > 0) return { after: id(at.rows[at.index - 1]) };
  if (at.rows.length) return { before: id(at.rows[0]) };
  return undefined;
}

function reset() {
  releaseTouch('plus');
  plus.active = false;
  plus.over = null;
  aimed = null;
}

export function plusButton(node) {
  let start = null;

  function down(e) {
    if (!e.isPrimary || (e.button !== undefined && e.button !== 0)) return;
    const box = node.getBoundingClientRect();
    const frame = (node.closest('.main') || document.body).getBoundingClientRect();
    start = {
      x: e.clientX, y: e.clientY, claimed: false, timer: null,
      // Held by the point it was picked up at, not snapped to its middle.
      dx: box.left + box.width / 2 - e.clientX,
      dy: box.top + box.height / 2 - e.clientY,
      home: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      inbox: { x: frame.left + 39, y: box.top + box.height / 2 }
    };
    gapH = measureGap();
    if (e.pointerType === 'touch') start.timer = setTimeout(() => claim(e), HOLD_MS);
  }

  /** The button is ours now. It lifts where it stands: the disc springs up in
   *  its own corner and the targets come out before anything moves. */
  function claim(e) {
    if (!start || start.claimed) return;
    if (start.timer) { clearTimeout(start.timer); start.timer = null; }
    if (!takeTouch('plus')) return void (start = null);
    start.claimed = true;
    start.left = false;
    plus.active = true;
    plus.x = start.home.x;
    plus.y = start.home.y;
    try { node.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function move(e) {
    if (!start) return;
    if (!start.claimed) {
      if (Math.abs(e.clientX - start.x) < SLOP && Math.abs(e.clientY - start.y) < SLOP) return;
      claim(e);
      if (!start || !start.claimed) return;
    }
    const x = e.clientX + start.dx;
    const y = e.clientY + start.dy;
    const was = plus.over;
    // It has to have gone somewhere before coming home counts as putting it back.
    if (Math.hypot(x - start.home.x, y - start.home.y) > CANCEL_REACH * 1.6) start.left = true;
    if (Math.hypot(x - start.inbox.x, y - start.inbox.y) < INBOX_REACH) plus.over = 'inbox';
    else if (start.left && Math.hypot(x - start.home.x, y - start.home.y) < CANCEL_REACH) plus.over = 'cancel';
    else plus.over = null;

    let at = null;
    if (!plus.over && start.left) {
      at = aim(Math.max(e.clientX, HEADING_MARGIN + 24), e.clientY);
      if (at) plus.over = headed(at) && x < HEADING_MARGIN ? 'heading' : 'list';
    }
    part(at, plus.over === 'heading');
    // Over a target the button goes to it, the way a magnet takes a pin.
    plus.x = plus.over === 'inbox' ? start.inbox.x : plus.over === 'cancel' ? start.home.x : x;
    plus.y = plus.over === 'inbox' ? start.inbox.y : plus.over === 'cancel' ? start.home.y : y;
    if (plus.over !== was && (plus.over === 'inbox' || plus.over === 'cancel') && navigator.vibrate) navigator.vibrate(6);
  }

  async function end() {
    if (!start) return;
    const { claimed, left, timer } = start;
    if (timer) clearTimeout(timer);
    start = null;
    if (!claimed) return;             // a plain tap; the click handler has it
    const over = plus.over;
    const at = aimed;
    reset();
    swallowNextClick();
    // Picked up and put straight back down without going anywhere. That is the
    // tap it would have been — and the click is swallowed, so make it here.
    if (!left) { closeGap(); return void (await createTodo()); }
    // The sheet that takes it (components/InboxSheet.svelte); nothing exists yet.
    if (over === 'inbox') { closeGap(true); app.inboxSheet = true; return; }
    if (over === 'heading' && at) {
      // createHeading leaves the new heading being edited, so the keyboard
      // comes up on its name.
      if (app.view.kind === 'project') await createHeading(app.view.id, 'New Heading', headingPosition(at));
      else {
        // In Today: after the heading it was let go under (first, above them
        // all), and what was below that point there comes under the new one.
        const under = at.list.dataset.listTodayHeading;
        const below = at.rows.slice(at.index).map((r) => r.dataset.todoId);
        await createTodayHeading('New Heading', under ? { after: under } : 'top', below);
      }
      return void closeGap(true);
    }
    if (over !== 'list' || !at) {
      closeGap();
      // Over the page but with no list to aim at — an empty view — it is the
      // plain new to-do a tap would have made, not nothing.
      if (over === null && plus.y < (document.querySelector('.content')?.getBoundingClientRect().bottom || 0)
          && !CLOSED.has(app.view.id)) await createTodo();
      return;
    }
    // Made, put where it was dropped, and only then shown: in Today the order
    // is todayIndex in state.json rather than the order of the file, so
    // position.after would land it after the right line in the wrong ordering.
    // This is the same two-step a drag does. The gap stays open until the card
    // is in it, so the list does not close and open again.
    plus.dropping = true;
    const id = (row) => (row ? row.dataset.todoId : null);
    const near = { beforeId: id(at.rows[at.index]), afterId: id(at.rows[at.index - 1]) };
    const extra = belonging(at);
    app.fromPlus = true;              // the next card to open grows out of where the button was
    if (fileOrdered(at.context)) {
      // One trip: made where it goes. Above a list's first row "top" would mean
      // the top of the file's section, which is not always here, so that case
      // is said by its neighbour afterwards.
      extra.position = near.afterId ? { after: near.afterId } : 'top';
      const made = await createTodo(extra);
      if (made && !near.afterId && near.beforeId) await reorderTo(made.id, at.context, 0, near);
    } else {
      const under = at.list.dataset.listTodayHeading;
      await createTodo(extra, {
        place: async (todo) => {
          if (under) await fileInToday([todo.id], under);
          return reorderTo(todo.id, at.context, at.index, near);
        }
      });
    }
    closeGap(true);
    plus.dropping = false;
    setTimeout(() => { app.fromPlus = false; }, 400);
  }

  function cancel() {
    if (start?.timer) clearTimeout(start.timer);
    if (start && start.claimed) { reset(); closeGap(); }
    start = null;
  }

  // Android's own long press lands at about half a second and means "context
  // menu"; the WebView answers it by cancelling the pointer, and the pointerup
  // that would have made the to-do never arrives. Ours is 220ms, so by then the
  // button is already ours to keep. (lib/dnd.svelte.js says the same thing for
  // a held row.)
  const menu = (e) => { if (start) e.preventDefault(); };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', menu);

  return {
    destroy() {
      if (start?.timer) clearTimeout(start.timer);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('contextmenu', menu);
    }
  };
}
