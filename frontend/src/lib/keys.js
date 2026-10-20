// ONE keymap table. Edit `keys` here to rebind; the rest of the app dispatches on `id`.
// Combos: "Mod" = ⌘ on Mac, Ctrl elsewhere (metaKey OR ctrlKey). Letters match on the
// physical key (KeyN) so ⌘⌥N works even where Alt produces a special character.
// Note: browsers reserve some combos in a normal tab (Ctrl/⌘+N, +T, +W); they do work in
// the installed PWA on most platforms. Change the binding here if it bothers you.
export const KEYMAP = [
  { id: 'go.inbox',       keys: 'Mod+1',        label: 'Go to Inbox' },
  { id: 'go.today',       keys: 'Mod+2',        label: 'Go to Today' },
  { id: 'go.upcoming',    keys: 'Mod+3',        label: 'Go to Upcoming' },
  { id: 'go.anytime',     keys: 'Mod+4',        label: 'Go to Anytime' },
  { id: 'go.someday',     keys: 'Mod+5',        label: 'Go to Someday' },
  { id: 'go.logbook',     keys: 'Mod+6',        label: 'Go to Logbook' },
  { id: 'todo.new',       keys: 'Mod+N',        label: 'New to-do' },
  // These are the other way round to what you'd guess: File → New Heading is
  // ⇧⌘N and New Project is ⌥⌘N.
  { id: 'settings.open',  keys: 'Mod+,',        label: 'Settings' },
  { id: 'heading.new',    keys: 'Mod+Shift+N',  label: 'New heading (in a project or Today)' },
  { id: 'project.new',    keys: 'Mod+Alt+N',    label: 'New project' },
  { id: 'todo.complete',  keys: 'Mod+K',        label: 'Complete / reopen selected' },
  { id: 'todo.cancel',    keys: 'Mod+Alt+K',    label: 'Cancel selected' },
  { id: 'todo.when',      keys: 'Mod+S',        label: 'When…' },
  { id: 'todo.today',     keys: 'Mod+T',        label: 'Move to Today' },
  { id: 'todo.evening',   keys: 'Mod+E',        label: 'Move to This Evening' },
  { id: 'todo.anytime',   keys: 'Mod+R',        label: 'Move to Anytime (clear When)' },
  { id: 'todo.someday',   keys: 'Mod+O',        label: 'Move to Someday' },
  { id: 'todo.deadline',  keys: 'Mod+Shift+D',  label: 'Deadline…' },
  { id: 'todo.move',      keys: 'Mod+Shift+M',  label: 'Move to list…' },
  { id: 'todo.tags',      keys: 'Mod+Shift+T',  label: 'Tags…' },
  { id: 'todo.checklist', keys: 'Mod+Shift+C',  label: 'Add / focus checklist' },
  { id: 'todo.convert',   keys: 'Mod+Shift+P',  label: 'Convert to project' },
  { id: 'todo.repeat',    keys: 'Mod+Shift+R',  label: 'Repeat…' },
  { id: 'log.now',        keys: 'Mod+Shift+Y',  label: 'Log completed items' },
  { id: 'todo.duplicate', keys: 'Mod+D',        label: 'Duplicate' },
  { id: 'find',           keys: ['Mod+F', 'Mod+Shift+F'], label: 'Quick Find' },
  { id: 'sidebar.toggle', keys: 'Mod+/',        label: 'Show / hide the sidebar' },
  { id: 'todo.open',      keys: 'Enter',        label: 'Open selected to-do' },
  { id: 'escape',         keys: 'Escape',       label: 'Close editor / popover / clear selection' },
  { id: 'sel.up',         keys: ['ArrowUp', 'Shift+ArrowUp'],     label: 'Select previous (⇧ extends)' },
  { id: 'sel.down',       keys: ['ArrowDown', 'Shift+ArrowDown'], label: 'Select next (⇧ extends)' },
  { id: 'todo.moveUp',    keys: 'Mod+ArrowUp',  label: 'Move selected up' },
  { id: 'todo.moveDown',  keys: 'Mod+ArrowDown', label: 'Move selected down' },
  { id: 'todo.trash',     keys: ['Backspace', 'Delete'], label: 'Move to Trash' },
  { id: 'undo',           keys: 'Mod+Z',        label: 'Undo last action' },
  { id: 'todo.expand',    keys: 'Space',        label: 'Expand selected (nothing focused)' }
];

const NAMED = { ' ': 'space', spacebar: 'space', esc: 'escape', del: 'delete' };

function keyFromEvent(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'Space') return 'space';
  const k = (e.key || '').toLowerCase();
  return NAMED[k] || k;
}

function parseCombo(str) {
  const parts = str.split('+');
  const key = parts.pop().toLowerCase();
  return {
    key,
    mod: parts.includes('Mod'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt')
  };
}

// Rebindings from Settings -> Keyboard, kept on the server so they follow you
// between devices. An id present with null means "no key at all".
let OVERRIDES = {};
export function setKeyOverrides(map) { OVERRIDES = map && typeof map === 'object' ? map : {}; }

/** The combos actually in force for an action: the override if there is one. */
export function bindingsFor(id) {
  if (Object.prototype.hasOwnProperty.call(OVERRIDES, id)) {
    const v = OVERRIDES[id];
    return v == null || v === '' ? [] : [].concat(v);
  }
  const b = KEYMAP.find((x) => x.id === id);
  return b ? [].concat(b.keys) : [];
}

/** Which action, if any, already answers to this combo. */
export function actionUsing(combo, exceptId) {
  const probe = parseCombo(combo);
  for (const b of KEYMAP) {
    if (b.id === exceptId) continue;
    for (const c of bindingsFor(b.id)) {
      const p = parseCombo(c);
      if (p.key === probe.key && p.mod === probe.mod && p.shift === probe.shift && p.alt === probe.alt) return b.id;
    }
  }
  return null;
}

const DISPLAY_KEY = {
  space: 'Space', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  enter: 'Enter', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', tab: 'Tab',
};
const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'capslock', 'contextmenu']);

/** A KeyboardEvent as a combo string, or null if it is only a modifier. */
export function comboFromEvent(e) {
  const k = keyFromEvent(e);
  if (MODIFIER_KEYS.has(k)) return null;
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(DISPLAY_KEY[k] || (k.length === 1 ? k.toUpperCase() : k));
  return parts.join('+');
}

/** A rough grouping, so the list reads like a menu rather than a dump. */
export function groupOf(id) {
  if (id.startsWith('go.')) return 'Go to';
  if (['todo.new', 'project.new', 'heading.new'].includes(id)) return 'Create';
  if (['todo.when', 'todo.today', 'todo.evening', 'todo.anytime', 'todo.someday', 'todo.deadline'].includes(id)) return 'Scheduling';
  if (['sel.up', 'sel.down', 'todo.moveUp', 'todo.moveDown', 'todo.open', 'todo.expand'].includes(id)) return 'Selection';
  if (id.startsWith('todo.')) return 'Selected to-do';
  return 'App';
}

/** Returns the action id matching a KeyboardEvent, or null. */
export function matchKey(e) {
  const k = keyFromEvent(e);
  const mod = e.metaKey || e.ctrlKey;
  for (const b of KEYMAP) {
    for (const combo of bindingsFor(b.id)) {
      const c = parseCombo(combo);
      if (c.key === k && c.mod === mod && c.shift === e.shiftKey && c.alt === e.altKey) return b.id;
    }
  }
  return null;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** One combo, written the way this platform writes it: ⇧⌘K, or Ctrl+Shift+K.
 *  Mac modifiers go in Apple's order, ⌃⌥⇧⌘ — which is what every Mac menu
 *  prints. Only ⌥⇧⌘ can appear here, because Mod already means ⌘. */
export function comboLabel(combo) {
  if (!combo) return '';
  const c = parseCombo(combo);
  const names = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
                  enter: '↩', escape: 'Esc', space: 'Space', backspace: '⌫',
                  delete: 'Del', tab: '⇥', ',': ',' };
  const key = names[c.key] || c.key.toUpperCase();
  if (IS_MAC) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`;
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

/** The label for an action's first binding, for menus and tooltips. */
export function keyLabel(id) {
  return comboLabel(bindingsFor(id)[0]);
}

/** True when the keyboard focus is in a text field (so plain keys must not be captured). */
export function isEditing(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
