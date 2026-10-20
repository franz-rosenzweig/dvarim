<script>
  /**
   * What dropping the + button on the Inbox opens: a to-do that goes to the
   * Inbox without leaving the list being read. It is a card at the top of the
   * screen over a dimmed page — a title, notes, "Inbox" to say where it is
   * going, and Save.
   *
   * Nothing is created until Save. The title is parsed the way Quick Entry and
   * the share sheet parse theirs, so "call the bank tomorrow #errand" works.
   */
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import * as api from '../lib/api.js';
  import { toast, toastError } from '../lib/store.svelte.js';

  let { onclose } = $props();
  let title = $state('');
  let notes = $state('');
  let busy = $state(false);
  let field = $state(null);

  // Here the keyboard is wanted: the sheet exists to be typed into.
  $effect(() => { if (field) tick().then(() => field.focus()); });

  async function save() {
    const line = title.trim();
    if (busy) return;
    if (!line) return onclose();
    busy = true;
    try {
      const todo = await api.quickAdd(line);
      if (notes.trim()) await api.patchTodo(todo.id, { notes: notes.trim() });
      toast(todo.when ? 'Added to Dvarim' : 'Added to Inbox');
      onclose();
    } catch (e) {
      toastError(e);
    } finally {
      busy = false;
    }
  }

  function onkeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); }
    if (e.key === 'Enter' && !e.shiftKey && e.target === field) { e.preventDefault(); save(); }
  }
</script>

<div class="sheetscrim" onclick={onclose} role="presentation"></div>
<!-- Escape and Enter are caught here as they bubble up from the fields; a
     form cannot be given a dialog's role to say so. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="inboxsheet" onsubmit={(e) => { e.preventDefault(); save(); }} {onkeydown} aria-label="New To-Do in the Inbox">
  <button type="button" class="x" aria-label="Cancel" onclick={onclose}><Icon name="x" /></button>
  <div class="line">
    <span class="box" aria-hidden="true"></span>
    <input bind:this={field} bind:value={title} placeholder="New To-Do" autocomplete="off" enterkeyhint="done" disabled={busy} />
  </div>
  <textarea bind:value={notes} placeholder="Notes" rows="3" disabled={busy}></textarea>
  <div class="foot">
    <span class="where"><Icon name="inbox" /> Inbox</span>
    <button type="submit" class="save" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </div>
</form>

<style>
  .sheetscrim { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,.36); animation: dim .18s ease-out; }
  .inboxsheet {
    position: absolute; z-index: 21; left: 10px; right: 10px;
    top: calc(env(safe-area-inset-top) + 10px);
    background: var(--card, var(--main)); color: var(--text);
    border-radius: 12px; box-shadow: 0 12px 36px rgba(10,10,20,.35); overflow: hidden;
    animation: drop .22s cubic-bezier(.2,.9,.25,1);
  }
  @keyframes drop { from { transform: translateY(-24px); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes dim { from { opacity: 0; } to { opacity: 1; } }
  .line { display: flex; align-items: center; gap: 12px; padding: 16px 44px 4px 16px; }
  .box { width: 20px; height: 20px; border-radius: 5px; border: 1.5px solid var(--check); flex: none; }
  input, textarea { font: inherit; color: var(--text); background: none; border: 0; outline: none; width: 100%; min-width: 0; }
  input { font-size: 16.5px; font-weight: 500; }
  textarea { display: block; resize: none; padding: 4px 16px 10px 48px; font-size: 14.5px; color: var(--text2); }
  input::placeholder, textarea::placeholder { color: var(--text3); }
  .x { position: absolute; right: 4px; top: 4px; width: 44px; height: 44px; display: grid; place-items: center; color: var(--text3); }
  .x :global(svg) { width: 16px; height: 16px; }
  .foot { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 8px 16px; background: var(--hover); }
  .where { display: flex; align-items: center; gap: 7px; color: var(--text2); font-size: 13.5px; }
  .where :global(svg) { width: 16px; height: 16px; }
  .save { background: var(--accent); color: #fff; font-weight: 600; font-size: 14px; border-radius: 7px; height: 32px; padding: 0 16px; }
  .save:disabled { opacity: .5; }
</style>
