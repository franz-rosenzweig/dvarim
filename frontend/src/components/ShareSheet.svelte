<script>
  /** What you see when Android shares something into Dvarim.
   *  One editable line, because the thing worth getting right is that you can
   *  fix the title and add a date before it lands, rather than finding a page
   *  title dumped in your Inbox later. */
  import { tick } from 'svelte';
  import * as api from '../lib/api.js';
  import { goList, toast } from '../lib/store.svelte.js';

  let { shared } = $props();          // {title, text, url}
  let text = $state('');
  let note = $state('');
  let busy = $state(false);
  let error = $state(null);
  let field = $state(null);

  // Pre-fill once. If this ran again — a background refresh, a prop reassigned —
  // it would wipe whatever you had just typed over the top of it.
  let filled = false;
  $effect(() => {
    if (filled) return;
    filled = true;
    // A share is usually a page title plus its link, or a lump of selected text.
    const title = (shared.title || '').trim();
    const body = (shared.text || '').trim();
    const url = (shared.url || '').trim();
    const looksLikeUrl = /^https?:\/\/\S+$/.test(body);
    text = title || (looksLikeUrl ? '' : body.split('\n')[0]) || url;
    const rest = [url && url !== text ? url : '', !looksLikeUrl && body && body !== text ? body : '']
      .filter(Boolean).join('\n\n');
    note = rest;
    if (!text && url) text = url;
  });
  $effect(() => { if (field) tick().then(() => { field.focus(); field.select?.(); }); });

  async function save() {
    const line = text.trim();
    if (!line || busy) return;
    busy = true; error = null;
    try {
      const todo = await api.quickAdd(line);
      if (note.trim()) await api.patchTodo(todo.id, { notes: note.trim() });
      history.replaceState(null, '', '/inbox');
      goList(todo.when ? 'today' : 'inbox');
      toast('Added to Dvarim');
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }

  function cancel() {
    history.replaceState(null, '', '/today');
    goList('today');
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={(e) => { e.preventDefault(); save(); }}>
    <h1>Add to Dvarim</h1>
    <label for="sh-title">To-do</label>
    <input id="sh-title" bind:value={text} bind:this={field} disabled={busy}
           placeholder="What is this?" autocomplete="off" />
    <p class="hint">Dates work here: “tomorrow 3pm”, “!friday” for a deadline, “#tag”.</p>
    {#if note}
      <label for="sh-note">Notes</label>
      <textarea id="sh-note" bind:value={note} rows="4" disabled={busy}></textarea>
    {/if}
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <div class="row">
      <button type="button" class="ghost" onclick={cancel} disabled={busy}>Cancel</button>
      <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Add'}</button>
    </div>
  </form>
</div>

<style>
  .wrap { position: fixed; inset: 0; display: grid; place-items: center; background: var(--page); padding: 16px; }
  .card {
    width: min(460px, 100%); display: flex; flex-direction: column; gap: 6px;
    background: var(--card); color: var(--text);
    border-radius: 12px; box-shadow: var(--shadow); padding: 22px 20px 18px;
  }
  h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
  label { font-size: 12px; color: var(--text2); margin-top: 6px; }
  input, textarea {
    font: inherit; font-size: 15px; color: var(--text); background: var(--main);
    border: 1px solid var(--hair); border-radius: 8px; padding: 8px 10px; resize: vertical;
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .hint { margin: 4px 0 0; font-size: 11.5px; color: var(--text3); }
  .err { margin: 6px 0 0; font-size: 12.5px; color: var(--dead); }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  button {
    font: inherit; font-size: 14px; font-weight: 500; color: #fff; background: var(--accent);
    border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer;
  }
  button.ghost { background: none; color: var(--text2); font-weight: 400; }
  button:disabled { opacity: .5; cursor: default; }
</style>
