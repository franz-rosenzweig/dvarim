// The room a list makes for something about to land in it.
//
// No line is drawn where a dragged to-do will go; the rows move apart and
// leave a space the size of a row. This is that space: a real element put
// among the rows, so everything under it moves down by itself, animated from
// no height so the rows are seen to part rather than jump. Moving it closes
// the old place while the new one opens.
//
// It is not a [data-todo-id], so whoever is measuring rows to decide where the
// drop would land (lib/dnd.svelte.js, lib/plusbutton.svelte.js) does not count
// it, and the gap cannot chase itself around the list.
let gap = null;
let at = null;      // {list, before}

/** @param {HTMLElement|null} list  null closes it
 *  @param {Element|null} before  the row it goes above; null for the end
 *  @param {number} height
 *  @param {boolean} [now]  at full height at once, for room that is taking the
 *    place of something that has just left it
 *  @returns {HTMLElement|null} the gap, for whoever wants to dress it */
export function partAt(list, before, height = 46, now = false) {
  if (gap && at && at.list === list && at.before === before) return gap;
  closeGap();
  if (!list) return null;
  at = { list, before };
  gap = document.createElement('div');
  gap.className = 'listgap';
  gap.setAttribute('aria-hidden', 'true');
  // Between the rows, not inside one: each row lives in a wrapper that animates
  // the swap to its card (components/TodoItem.svelte), and the room has to open
  // beside that wrapper for everything below to move down with it.
  const ref = before ? before.closest('.titem') || before : null;
  if (ref && ref.parentNode) ref.parentNode.insertBefore(gap, ref);
  else list.appendChild(gap);
  const mine = gap;
  if (now) { mine.style.transition = 'none'; mine.style.height = `${height}px`; requestAnimationFrame(() => { mine.style.transition = ''; }); }
  else requestAnimationFrame(() => { if (gap === mine) mine.style.height = `${height}px`; });
  return gap;
}

/** Where the room is on the screen, for whatever is about to settle into it. */
export function gapRect() {
  return gap ? gap.getBoundingClientRect() : null;
}

/** @param {boolean} [now]  at once, when what it was for has arrived */
export function closeGap(now) {
  const old = gap;
  gap = null;
  at = null;
  if (!old) return;
  if (now) return void old.remove();
  old.style.height = '0px';
  setTimeout(() => old.remove(), 180);
}
