// Keys for the lists the app draws with a keyed {#each}.
//
// A vault can hold the same id twice: a project file copied in Obsidian, a
// file renamed on one device while another edited it (the sync keeps both),
// a to-do copied rather than moved. The engine gives such a copy an id of its
// own (engine/src/store.js, _repairIds), but a list may still arrive with a
// repeat, and Svelte refuses to draw a list whose keys repeat: it drew none of
// the page. So a repeat is drawn too, under its id and its place among its
// twins, and every other item keeps its id as its key, as it always had.

/** `list` as [key, item] pairs, for `{#each keyed(list) as [rowKey, item] (rowKey)}`. */
export function keyed(list, id = (x) => x.id) {
  const seen = new Map();
  return (list || []).map((x) => {
    const k = String(id(x));
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return [n ? `${k}#${n}` : k, x];
  });
}
