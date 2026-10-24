/**
 * What a right-click on a to-do offers: what the keyboard can do to it, for a
 * mouse. In a browser, which has no menu bar, it is the only mouse route to
 * Cancel, Duplicate, Convert and Delete.
 *
 * A row inside a larger selection speaks for the whole selection, as it does
 * when it is dragged; any other row is selected first. Not under a thumb: a
 * long press there lifts the row (lib/dnd.svelte.js). A pen's side button and
 * a mouse on a touchscreen still get it.
 */
import { app, selectOnly, openMenu, openPopover, toggleComplete, cancelTodo, duplicateTodo, convertTodo, deleteTodo,
         completeSelected, cancelSelected, duplicateSelected, deleteSelected } from './store.svelte.js';
import { touchLayout } from './touch.js';
import { lastPointerType } from './pen.js';

export function rowMenu(e, todo) {
  if (touchLayout() && !['pen', 'mouse'].includes(e.pointerType || lastPointerType())) return;
  e.preventDefault();
  const group = app.selected.length > 1 && app.selected.includes(todo.id);
  if (!group) selectOnly(todo.id);
  // A point rather than an element: the menu, and whatever it opens, come up
  // where the pointer is.
  const y = e.clientY - 8, x = e.clientX;
  const at = { getBoundingClientRect: () => ({ top: y, bottom: y, left: x, right: x, width: 0, height: 0 }) };
  const target = { type: 'todo', id: todo.id };
  const open = todo.status === 'open';
  openMenu(at, [
    { label: 'When…', icon: 'cal', action: () => openPopover('when', target, at) },
    { label: 'Move…', icon: 'arrow', action: () => openPopover('move', target, at) },
    { label: 'Tags…', icon: 'tagic', action: () => openPopover('tags', target, at) },
    { label: 'Deadline…', icon: 'flag', action: () => openPopover('deadline', target, at) },
    !group && { label: 'Repeat…', icon: 'repeat', action: () => openPopover('repeat', target, at) },
    { sep: true },
    group ? { label: 'Complete', action: completeSelected }
          : { label: open ? 'Complete' : 'Reopen', action: () => toggleComplete(todo.id) },
    (group || open) && { label: 'Mark as Canceled', action: () => (group ? cancelSelected() : cancelTodo(todo.id)) },
    { label: 'Duplicate', action: () => (group ? duplicateSelected() : duplicateTodo(todo.id)) },
    !group && open && { label: 'Convert to Project', icon: 'proj', action: () => convertTodo(todo.id) },
    { sep: true },
    { label: 'Delete', icon: 'trash', danger: true, action: () => (group ? deleteSelected() : deleteTodo(todo.id)) },
  ], group ? `${app.selected.length} to-dos` : undefined);
}
