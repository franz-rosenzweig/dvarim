/**
 * Dragging to-dos: reorder inside a list, or drop onto the sidebar to move,
 * schedule, complete or trash.
 *
 * Pointer events rather than HTML5 drag-and-drop, because the phone matters and
 * HTML5 dragging barely exists on touch. The cost is doing the ghost, the
 * insertion line and the autoscroll by hand; the gain is that the same code
 * works with a mouse, a trackpad and a thumb.
 *
 * On touch a drag starts after a long press, so the list still scrolls. With a
 * mouse it starts after a few pixels of movement, so a click is still a click.
 *
 * A lifted row has to be held against the browser, which would otherwise take
 * the first movement after the press for a scroll and cancel the pointer, and
 * against the system, whose own long press arrives a moment later with a
 * context menu: see lib/touch.js.
 */
import { app, selectOnly, moveTodo, setWhen, toggleComplete, deleteTodo, openPopover, reorderTo, fileInToday, todayHeadingOf,
         moveSelected, setWhenSelected, completeSelected, deleteSelected, moveToDayLocal } from './store.svelte.js';
import { claimTouch, takeTouch, releaseTouch, swallowNextClick } from './touch.js';
import { gapRect, closeGap } from './gap.js';

/** Touch-down to lift. 420ms read as "did that register?". This still sits
 *  clear of Android's own long press (~400-500ms), which the contextmenu guard
 *  below says no to. */
const TOUCH_HOLD_MS = 300;
const MOUSE_SLOP = 5;
const EDGE = 56;              // autoscroll band at the top and bottom of the list
const EDGE_SPEED = 14;
/** Settling onto the room and then going: the card slides in over 200-250ms
 *  with no overshoot, and the shadow and the slab fade together over the 120ms
 *  after that. The card is taken away at the end of the fade, not before it. */
const SETTLE_MS = 320;
const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const drag = $state({
  active: false,
  todo: null,
  x: 0, y: 0,
  context: null,        // the reorder context under the pointer
  list: null,           // …and the list itself: several on one screen share a context
  index: -1,            // where it would land
  target: null,         // {kind, id, label} of a sidebar target
  html: '',             // its contents, to draw the card with
  rect: null,           // the row as it lay when lifted: the phone shows it as a card
  grab: null,           // where in it the finger took hold
  span: 0,              // the room they need: every carried row's height
  gather: [],           // the others, flying into the one card at the lift
  settling: false,      // let go over a list: sliding onto the room it opened
});

let start = null;       // {x, y, todo, node, pointerId, timer}
let scrollTimer = null;

/** The gesture is over. What is still drawn of it is not — a card settling into
 *  its slot outlives the finger that put it there, and the next gesture must
 *  not have to wait for the animation. */
function letGo() {
  if (start?.timer) clearTimeout(start.timer);
  if (start?.press) clearTimeout(start.press);
  start?.node?.classList.remove('pressed');
  start = null;
  releaseTouch('drag');
}

function reset() {
  letGo();
  drag.active = false;
  drag.todo = null;
  drag.context = null;
  drag.list = null;
  drag.index = -1;
  drag.target = null;
  drag.rect = null;
  drag.grab = null;
  drag.span = 0;
  drag.gather = [];
  drag.html = '';
  drag.settling = false;
  if (scrollTimer) { cancelAnimationFrame(scrollTimer); scrollTimer = null; }
  document.body.classList.remove('dragging');
}

/** Rows call this: `use:draggable={todo}` */
/** A horizontal swipe has claimed the gesture (lib/swipe.svelte.js). It is not
 *  the beginning of a drag, so the long-press timer must not fire behind it. */
export function cancelPendingDrag() {
  if (!start) return;
  if (start.timer) clearTimeout(start.timer);
  // Through start.node, and before start goes: a swipe that took the gesture
  // must not leave the row grey behind it.
  if (start.press) clearTimeout(start.press);
  start.node?.classList.remove('pressed');
  if (!drag.active) start = null;
}

export function draggable(node, todo) {
  let current = todo;

  function down(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('.cb, button, a, input, textarea, [contenteditable]')) return;
    if (current.status !== 'open' && !current.trashed) return;
    start = { x: e.clientX, y: e.clientY, todo: current, node, pointerId: e.pointerId, timer: null, press: null };
    if (e.pointerType === 'touch') {
      // A finger is answered in the frame it lands: a soft grey slab behind
      // the row, the same one that stays behind as the placeholder when it
      // lifts. A beat first, so a scroll flick does not flash it.
      start.press = setTimeout(() => node.classList.add('pressed'), 60);
      start.timer = setTimeout(() => { if (start) begin(e); }, TOUCH_HOLD_MS);
    }
  }

  function move(e) {
    if (!start || drag.active) return;
    if (e.pointerType === 'touch') {
      // a real scroll gesture cancels the pending press
      if (Math.abs(e.clientY - start.y) > 10 || Math.abs(e.clientX - start.x) > 10) reset();   // a scroll: the slab goes with it
      return;
    }
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOUSE_SLOP) begin(e);
  }

  function begin(e) {
    if (!start) return;
    if (start.timer) { clearTimeout(start.timer); start.timer = null; }
    if (!takeTouch('drag')) return void (start = null);
    // What you are moving is what is selected: it is left selected after the
    // drop, and a row that was never selected cannot be.
    if (!app.selected.includes(start.todo.id)) selectOnly(start.todo.id);
    drag.active = true;
    drag.todo = start.todo;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const box = node.getBoundingClientRect();
    drag.rect = { left: box.left, top: box.top, width: box.width, height: box.height };
    drag.grab = { dx: start.x - box.left, dy: start.y - box.top };
    // Measured before they are ghosted, which happens on the next render.
    const rows = carried(start.todo.id)
      .map((id) => document.querySelector(`[data-todo-id="${id}"]`))
      .filter(Boolean);
    drag.span = rows.reduce((h, r) => h + r.getBoundingClientRect().height, 0) || box.height;
    // The others do not simply vanish: they fly into the one card over about
    // a tenth of a second while they fade. Their look and their place are
    // taken here, before the list closes up around them.
    drag.gather = rows
      .filter((r) => r.dataset.todoId !== start.todo.id)
      .map((r) => {
        const b = r.getBoundingClientRect();
        return { id: r.dataset.todoId, left: b.left, top: b.top, width: b.width, height: b.height,
                 dx: box.left - b.left, dy: box.top - b.top, html: r.innerHTML };
      });
    setTimeout(() => { drag.gather = []; }, 160);
    // Selection mode ends when the group leaves the list, not when it lands:
    // the circles, the Done pill and the toolbar all go at the lift, and what
    // is being carried is the selection itself.
    app.selecting = false;
    drag.html = node.innerHTML;
    document.body.classList.add('dragging');
    try { node.setPointerCapture(start.pointerId); } catch { /* not fatal */ }
    if (navigator.vibrate) navigator.vibrate(8);
    update(e);
  }

  function over(e) {
    if (!drag.active) return;
    e.preventDefault();
    drag.x = e.clientX;
    drag.y = e.clientY;
    update(e);
    autoscroll();
  }

  async function up() {
    if (!drag.active) { reset(); return; }
    // The browser dispatches a click on the capturing row after the drop, and
    // that click would open the to-do that was just moved.
    swallowNextClick();
    const todo = drag.todo;
    const target = drag.target;
    const context = drag.context;
    const index = drag.index;
    const list = drag.list;
    const box = !target && context && index >= 0 && drag.grab && drag.rect ? gapRect() : null;
    if (!box || reduceMotion()) {
      reset();
      await drop(todo, target, context, index, list);
      return;
    }
    // The card does not vanish. It slides onto the room the list opened, and
    // only then do the shadow and the slab go. The gesture itself is over at
    // once — the finger is free for the next one — and only what is drawn
    // waits.
    letGo();
    drag.settling = true;
    // Straight down onto the slot: the row's column is where it came from and
    // where it is going, and the room's own margins are not the row's.
    drag.x = drag.rect.left + drag.grab.dx;
    drag.y = box.top + drag.grab.dy;
    // The write runs alongside, and the room stays open until it lands, so the
    // row arrives underneath before the card is taken away.
    try {
      await Promise.all([
        drop(todo, target, context, index, list),
        new Promise((done) => setTimeout(done, SETTLE_MS)),
      ]);
    } finally {
      // Whatever the write did, the card and the room go together: a throw
      // must not leave a card lying on the screen with no way to pick it up.
      closeGap(true);
      reset();
    }
  }

  // Ours from the moment it lifts; until then the list is free to scroll.
  const release = claimTouch(node, () => drag.active);
  // Android's long press lands ~80ms after ours and means "context menu".
  const menu = (e) => { if (drag.active || start?.timer) e.preventDefault(); };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointermove', over);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', reset);
  node.addEventListener('contextmenu', menu);
  return {
    update(next) { current = next; },
    destroy() {
      release();
      node.removeEventListener('contextmenu', menu);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointermove', over);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', reset);
    },
  };
}

/** What is under the pointer: a sidebar target wins over a list. */
function update(e) {
  if (drag.settling) return;        // let go already; where it lands is settled
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;

  const t = el.closest('[data-drop-list], [data-drop-area], [data-drop-project], [data-drop-day]');
  if (t) {
    drag.target = targetOf(t);
    drag.context = null;
    drag.list = null;
    drag.index = -1;
    return;
  }
  drag.target = null;

  const list = listAt(el, e.clientY);
  if (!list) { drag.context = null; drag.list = null; drag.index = -1; return; }
  drag.context = list.dataset.dropContext;
  drag.list = list;
  drag.index = insertionIndex(list, e.clientY);
}

/**
 * The list a drop here goes into: the one under the pointer, or, when it is over
 * none — on a heading, in the space between two sections, under the last row —
 * the nearest one in the same pane, as the + button has it
 * (lib/plusbutton.svelte.js, aim). Asking for a list under the pointer left a
 * band across every heading where the list closed up again and letting go put
 * the row back where it came from, so a to-do carried from Today towards This
 * Evening dropped on the heading did nothing.
 */
function listAt(el, y) {
  const under = el.closest('[data-drop-context]');
  if (under) return under.dataset.dropContext ? under : null;
  const pane = el.closest('.content');
  if (!pane) return null;
  let list = null;
  let best = Infinity;
  for (const l of pane.querySelectorAll('[data-drop-context]')) {
    if (!l.dataset.dropContext) continue;
    const box = l.getBoundingClientRect();
    const d = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (d < best) { best = d; list = l; }
  }
  return list;
}

function targetOf(el) {
  const d = el.dataset;
  if (d.dropArea) return { kind: 'area', id: d.dropArea, label: el.textContent.trim() };
  if (d.dropProject) return { kind: 'project', id: d.dropProject, label: el.textContent.trim() };
  if (d.dropDay) return { kind: 'day', id: d.dropDay, label: d.dropDay };
  return { kind: 'list', id: d.dropList, label: el.textContent.trim() };
}

/** Everything that travels with a dragged to-do: the selection it is part of,
 *  or just itself. */
function carried(id) {
  return app.selected.length > 1 && app.selected.includes(id) ? [...app.selected] : [id];
}

/** The rows a drop is measured against: not the ones being carried. */
export function restingRows(list) {
  const moving = drag.todo ? carried(drag.todo.id) : [];
  return [...list.querySelectorAll('[data-todo-id]')].filter((r) => !moving.includes(r.dataset.todoId));
}

/** Where a drop would land, from the midpoints of the rows already there. */
function insertionIndex(list, y) {
  const rows = restingRows(list);
  let i = 0;
  for (const r of rows) {
    const box = r.getBoundingClientRect();
    if (y > box.top + box.height / 2) i += 1;
  }
  return i;
}

/** Scroll whichever pane the pointer is over: the list, or the sidebar, so a
 *  project below the fold is still reachable. */
function autoscroll() {
  if (scrollTimer) return;
  const step = () => {
    scrollTimer = null;
    if (!drag.active) return;
    const panes = [document.querySelector('.nav'), document.querySelector('.content')];
    for (const pane of panes) {
      if (!pane) continue;
      const box = pane.getBoundingClientRect();
      const inside = drag.x >= box.left && drag.x <= box.right;
      if (!inside) continue;
      if (drag.y < box.top + EDGE && pane.scrollTop > 0) pane.scrollTop -= EDGE_SPEED;
      else if (drag.y > box.bottom - EDGE && pane.scrollTop + pane.clientHeight < pane.scrollHeight) pane.scrollTop += EDGE_SPEED;
      else continue;
      scrollTimer = requestAnimationFrame(step);
      return;
    }
  };
  scrollTimer = requestAnimationFrame(step);
}

/** What dropping actually does. */
async function drop(todo, target, context, index, list) {
  if (!todo) return;
  // Dragging a row that is part of a selection drags the whole selection, which
  // is what makes multi-select worth having.
  const group = app.selected.length > 1 && app.selected.includes(todo.id);
  const n = app.selected.length;
  if (target && group) {
    if (target.kind === 'area') return moveSelected({ areaId: target.id }, `${n} moved to ${target.label}`);
    if (target.kind === 'project') return moveSelected({ projectId: target.id }, `${n} moved to ${target.label}`);
    if (target.kind === 'day') return setWhenSelected({ when: target.id, evening: false, someday: false }, `${n} rescheduled`);
    switch (target.id) {
      case 'inbox':   return moveSelected({ inbox: true }, `${n} moved to Inbox`);
      case 'today':   return setWhenSelected({ when: app.state?.today || todayISO(), evening: false, someday: false }, `${n} moved to Today`);
      case 'anytime': return setWhenSelected({ when: null, evening: false, someday: false }, `${n} moved to Anytime`);
      case 'someday': return setWhenSelected({ when: null, evening: false, someday: true }, `${n} moved to Someday`);
      case 'logbook': return completeSelected();
      case 'trash':   return deleteSelected();
      default: break;
    }
  }
  if (target) {
    if (target.kind === 'area') return moveTodo(todo.id, { areaId: target.id }, `Moved to ${target.label}`);
    if (target.kind === 'project') return moveTodo(todo.id, { projectId: target.id }, `Moved to ${target.label}`);
    if (target.kind === 'day') {
      return setWhen(todo.id, { when: target.id, evening: false, someday: false }, null);
    }
    switch (target.id) {
      case 'inbox':    return moveTodo(todo.id, { inbox: true }, 'Moved to Inbox');
      case 'today':    return setWhen(todo.id, { when: app.state?.today || todayISO(), evening: false, someday: false }, 'Moved to Today');
      case 'anytime':  return setWhen(todo.id, { when: null, evening: false, someday: false }, 'Moved to Anytime');
      case 'someday':  return setWhen(todo.id, { when: null, evening: false, someday: true }, 'Moved to Someday');
      case 'logbook':  return toggleComplete(todo.id);
      case 'trash':    return deleteTodo(todo.id);
      // Upcoming needs a date, so ask rather than guess
      case 'upcoming': return openPopover('when', { type: 'todo', id: todo.id },
                                          document.querySelector('[data-drop-list="upcoming"]'));
      default: return;
    }
  }
  if (!(context && index >= 0)) return;
  // The rows it was dropped between, in the list it was dropped in. An index
  // alone is not enough where one section is shown as several lists (Today
  // grouped by project), and a name is not enough to find the list again.
  const moving = group ? [...app.selected] : [todo.id];
  const ids = (l) => (l ? [...l.querySelectorAll('[data-todo-id]')].map((r) => r.dataset.todoId) : []);
  const resting = ids(list).filter((id) => !moving.includes(id));
  const near = { beforeId: resting[index] || null, afterId: resting[index - 1] || null };

  // Between Today and This Evening the to-do has to change, not only move.
  const evening = list?.dataset.listEvening;
  if (evening !== undefined && (evening === 'true') !== !!todo.evening) {
    const when = app.state?.today || todayISO();
    if (group) await setWhenSelected({ when, evening: evening === 'true', someday: false }, null);
    else await setWhen(todo.id, { when, evening: evening === 'true', someday: false }, null);
  }

  // Under one of Today's own headings, or out from under one, it is filed there
  // as well as put there. This Evening says nothing about headings: a to-do
  // keeps its heading through the evening and is back under it next morning.
  const th = list?.dataset.listTodayHeading;
  if (th !== undefined) {
    const to = th || null;
    const filing = moving.filter((id) => todayHeadingOf(id) !== to);
    if (filing.length) await fileInToday(filing, to);
  }

  // A day in Upcoming is a day as well as a list: dropping into one moves the
  // to-do to that day and then puts it where it was dropped, which is two
  // things, as Today and This Evening above are.
  const listWhen = list?.dataset.listWhen;
  if (context.startsWith('upcoming:') && listWhen) {
    const wrong = (t) => t.when !== listWhen || t.someday || t.evening;
    if (group) {
      for (const id of moving) moveToDayLocal(id, listWhen);
      await setWhenSelected({ when: listWhen, evening: false, someday: false }, null);
    } else if (wrong(todo)) {
      moveToDayLocal(todo.id, listWhen);
      await setWhen(todo.id, { when: listWhen, evening: false, someday: false }, null);
    }
  }

  if (!group) return reorderTo(todo.id, context, index, near);
  // A group lands together, in the order it was in, where one would have: each
  // goes in just above whatever row the drop was above.
  const ordered = [...document.querySelectorAll('.content [data-todo-id]')].map((r) => r.dataset.todoId).filter((id) => moving.includes(id));
  let after = near.afterId;
  for (const id of ordered) {
    await reorderTo(id, context, index, { beforeId: near.beforeId, afterId: after });
    after = id;
  }
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
