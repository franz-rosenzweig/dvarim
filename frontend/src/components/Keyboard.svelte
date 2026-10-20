<script>
  /** Settings → Keyboard. Every action, what it answers to, and a way to change
   *  it. Recording captures the next combo you press; Clear leaves an action
   *  with no key; Default puts back what it shipped with. */
  import {
    KEYMAP, comboFromEvent, comboLabel, actionUsing, groupOf,
  } from '../lib/keys.js';
  import { app, saveSettings, toast } from '../lib/store.svelte.js';

  let recording = $state(null);        // the action id currently listening
  let clash = $state(null);            // {combo, taken} while recording

  // Read the overrides from the settings object, not from the keymap module's
  // global. The global is what the matcher uses, but Svelte cannot see it
  // change, so a rebind would save correctly and never redraw the row.
  let overrides = $derived(app.settings?.keymap || {});
  const overridden = (id) => Object.prototype.hasOwnProperty.call(overrides, id);
  function bindingsFor(id) {
    if (overridden(id)) {
      const v = overrides[id];
      return v == null || v === '' ? [] : [].concat(v);
    }
    const b = KEYMAP.find((x) => x.id === id);
    return b ? [].concat(b.keys) : [];
  }

  const ORDER = ['Go to', 'Create', 'Selected to-do', 'Scheduling', 'Selection', 'App'];
  let groups = $derived.by(() => {
    const by = new Map();
    for (const b of KEYMAP) {
      const g = groupOf(b.id);
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(b);
    }
    return ORDER.filter((g) => by.has(g)).map((g) => ({ name: g, items: by.get(g) }));
  });

  function labelFor(id) {
    const combos = bindingsFor(id);
    return combos.length ? combos.map(comboLabel).join('  or  ') : 'None';
  }

  async function set(id, value) {
    const next = { ...(app.settings?.keymap || {}) };
    if (value === undefined) delete next[id];     // back to the built-in
    else next[id] = value;                        // a combo, or null for none
    await saveSettings({ keymap: next });
  }

  function startRecording(id) {
    recording = id;
    clash = null;
  }

  /** Recording listens in the capture phase, on purpose. A bubbling listener
   *  runs after the app's own window handler and after the sheet's Escape, so
   *  pressing ⌘2 to rebind it navigated to Today instead, and Escape shut the
   *  whole Settings window rather than stopping the recording. */
  $effect(() => {
    if (!recording) return;
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  });

  function onKeydown(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { recording = null; clash = null; return; }
    const combo = comboFromEvent(e);
    if (!combo) return;                           // a modifier on its own
    const taken = actionUsing(combo, recording);
    if (taken) {
      clash = { combo, taken };
      return;
    }
    const id = recording;
    recording = null;
    clash = null;
    set(id, combo);
  }

  async function takeItAnyway() {
    const { combo, taken } = clash;
    const id = recording;
    recording = null;
    clash = null;
    const next = { ...(app.settings?.keymap || {}), [taken]: null, [id]: combo };
    await saveSettings({ keymap: next });
    toast(`${comboLabel(combo)} moved from ${KEYMAP.find((b) => b.id === taken)?.label || taken}`);
  }

  const anyOverrides = $derived(Object.keys(app.settings?.keymap || {}).length > 0);
</script>

<p class="note">
  Click a shortcut to record a new one. Esc stops recording without changing anything.
  These are stored on the server, so a change here reaches your other devices.
</p>

{#each groups as g}
  <h3>{g.name}</h3>
  <div class="rows">
    {#each g.items as b}
      <div class="row" class:rec={recording === b.id}>
        <span class="lbl">{b.label}</span>
        <span class="acts">
          {#if bindingsFor(b.id).length}
            <button class="mini" onclick={() => set(b.id, null)} title="No shortcut">Clear</button>
          {/if}
          {#if overridden(b.id)}
            <button class="mini" onclick={() => set(b.id, undefined)} title="Back to the original">Default</button>
          {/if}
        </span>
        <button class="combo" class:none={!bindingsFor(b.id).length}
                onclick={() => startRecording(b.id)}
                aria-label={`Change the shortcut for ${b.label}`}>
          {recording === b.id ? 'Press a key…' : labelFor(b.id)}
        </button>
      </div>
      {#if recording === b.id && clash}
        <p class="clash">
          {comboLabel(clash.combo)} already does
          <strong>{KEYMAP.find((x) => x.id === clash.taken)?.label || clash.taken}</strong>.
          <button class="mini" onclick={takeItAnyway}>Use it here instead</button>
          <button class="mini" onclick={() => { recording = null; clash = null; }}>Cancel</button>
        </p>
      {/if}
    {/each}
  </div>
{/each}

{#if anyOverrides}
  <div class="resetall">
    <button class="mini" onclick={() => saveSettings({ keymap: {} })}>Reset every shortcut</button>
  </div>
{/if}

<style>
  h3 { margin: 18px 0 6px; font-size: 12px; font-weight: 600; color: var(--text2);
       text-transform: uppercase; letter-spacing: .04em; }
  h3:first-of-type { margin-top: 6px; }
  .rows { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 7px; }
  .row:hover { background: var(--hover); }
  .row.rec { background: var(--sel); }
  .lbl { flex: 1; font-size: 13.5px; min-width: 0; }
  .combo {
    flex: none; font: inherit; font-size: 12.5px; text-align: center;
    color: var(--text); background: var(--main);
    border: 1px solid var(--hair); border-bottom-width: 2px; border-radius: 5px;
    padding: 2px 8px; min-width: 88px; cursor: pointer;
  }
  .combo.none { color: var(--text3); font-style: italic; }
  .combo:hover { border-color: var(--accent); }
  .row.rec .combo { border-color: var(--accent); color: var(--accent); }
  /* Space kept for Clear/Default whether or not they are showing, so nothing
     shifts sideways when the pointer crosses a row. */
  .acts { flex: none; display: flex; gap: 4px; width: 92px; justify-content: flex-end; }
  .mini { font: inherit; font-size: 11.5px; color: var(--accent);
          background: none; border: 0; padding: 2px 4px; cursor: pointer; }
  .row:not(:hover) .mini { opacity: 0; }
  .row:hover .mini, .row.rec .mini { opacity: 1; }
  .clash { margin: 2px 6px 8px; font-size: 12px; color: var(--dead); }
  .clash .mini { color: var(--accent); }
  .resetall { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--hair); }
  .note { color: var(--text2); font-size: 12.5px; line-height: 1.5; margin: 0 0 10px; max-width: 60ch; }
  @media (hover: none) { .row .mini { opacity: 1; } }
</style>
