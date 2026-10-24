<script>
  /** The actual Markdown behind a project or area, editable.
   *
   *  This is the database, not a view of it, so the editor is deliberately
   *  plain and deliberately careful: it remembers the file it loaded, refuses
   *  to overwrite an edit made in Obsidian while it was open, and reports what
   *  the app made of the result after saving. */
  import { tick } from 'svelte';
  import * as api from '../lib/api.js';
  import { app, closeSource, refresh, toast } from '../lib/store.svelte.js';

  let { path } = $props();
  let text = $state('');
  let sha = $state(null);
  let loaded = $state(false);
  let saving = $state(false);
  let error = $state(null);
  let warning = $state(null);
  let info = $state(null);
  let conflict = $state(null);      // {text, sha} that is actually on disk
  let area = $state(null);
  let original = $state('');

  let dirty = $derived(loaded && text !== original);

  $effect(() => {
    if (loaded) return;
    api.readFile(path)
      .then((f) => {
        text = f.text; original = f.text; sha = f.sha; area = area; loaded = true;
        info = `${f.kind === 'other' ? 'Not managed by Dvarim' : f.kind} · ${f.bytes} bytes`;
      })
      .catch((e) => { error = e.message; loaded = true; });
  });
  $effect(() => { if (area && loaded) tick().then(() => area.focus()); });

  async function save() {
    if (saving || !dirty) return;
    saving = true; error = null; warning = null; conflict = null;
    try {
      const r = await api.writeFile(path, text, sha);
      sha = r.sha; original = text;
      warning = r.warning;
      info = `Saved · ${r.kind} · ${r.todos} to-do${r.todos === 1 ? '' : 's'}`;
      await refresh();
      if (!r.warning) toast('Saved');
    } catch (e) {
      if (e.status === 409 && e.data) {
        conflict = { text: e.data.text, sha: e.data.sha };
        error = 'This file changed in Obsidian while you had it open. Nothing was written.';
      } else {
        error = e.message;
      }
    } finally {
      saving = false;
    }
  }

  function takeTheirs() {
    text = conflict.text; original = conflict.text; sha = conflict.sha;
    conflict = null; error = null;
    info = 'Reloaded from disk';
  }
  async function overwrite() {
    sha = conflict.sha; conflict = null; error = null;
    await save();
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && !dirty) { e.stopPropagation(); closeSource(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); save(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
  }
  function close() {
    if (dirty && !window.confirm('You have unsaved changes. Close anyway?')) return;
    closeSource();
  }
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label="Note source" tabindex="-1" onkeydown={onKeydown}>
  <header>
    <div class="who">
      <span class="p">{path}</span>
      {#if info}<span class="meta">{info}</span>{/if}
    </div>
    <div class="acts">
      <button class="ghost" onclick={close}>Close</button>
      <button onclick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
    </div>
  </header>

  {#if error}
    <p class="err" role="alert">{error}</p>
    {#if conflict}
      <p class="err">
        <button class="mini" onclick={takeTheirs}>Load what is on disk</button>
        <button class="mini danger" onclick={overwrite}>Overwrite it with mine</button>
      </p>
    {/if}
  {/if}
  {#if warning}<p class="warn">{warning}</p>{/if}

  {#if loaded}
    <textarea bind:value={text} bind:this={area} spellcheck="false"
              autocomplete="off" autocapitalize="off" aria-label="Markdown source"></textarea>
    <footer>
      This is the file itself. ⌘S saves; the app reloads from it afterwards.
      Editing it in Obsidian at the same time is fine — whoever saves second is told.
    </footer>
  {:else}
    <p class="loading">Reading the file…</p>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(20,20,30,.28); z-index: 50; }
  :global(:root[data-theme="dark"]) .scrim { background: rgba(0,0,0,.55); }
  .sheet {
    position: fixed; z-index: 51; inset: 24px; margin: auto;
    width: min(860px, calc(100vw - 32px)); max-height: calc(100vh - 48px);
    display: flex; flex-direction: column;
    background: var(--card); color: var(--text);
    border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
           padding: 12px 14px; border-bottom: 1px solid var(--hair); }
  .who { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .p { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 11.5px; color: var(--text3); }
  .acts { display: flex; gap: 8px; flex: none; }
  button { font: inherit; font-size: 13px; color: #fff; background: var(--accent);
           border: 0; border-radius: 7px; padding: 6px 14px; cursor: pointer; }
  button.ghost { background: none; color: var(--text2); }
  button:disabled { opacity: .5; cursor: default; }
  .mini { font-size: 12px; background: none; color: var(--accent); padding: 2px 6px; }
  .mini.danger { color: var(--dead); }
  textarea {
    flex: 1; min-height: 240px; resize: none; border: 0; outline: none;
    padding: 14px; background: var(--main); color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; line-height: 1.65; tab-size: 4; white-space: pre;
    overflow: auto;
  }
  footer { padding: 8px 14px; border-top: 1px solid var(--hair);
           font-size: 11.5px; color: var(--text3); }
  .err { margin: 8px 14px 0; font-size: 12.5px; color: var(--dead); }
  .warn { margin: 8px 14px 0; font-size: 12.5px; color: var(--star); }
  .loading { padding: 24px 14px; color: var(--text2); font-size: 13px; }
  @media (max-width: 720px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 559px) { .sheet { inset: 8px; width: auto; } }
</style>
