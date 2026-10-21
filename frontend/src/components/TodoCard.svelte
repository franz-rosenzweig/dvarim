<script>
  /**
   * Expanded to-do editor (mockup `.card`). Title and notes autosave with a 400 ms debounce,
   * checklist edits too. Return in the title closes the editor; Esc is handled globally.
   */
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import NotesField from './NotesField.svelte';
  import { app, today, toggleComplete, patchTodo, openPopover } from '../lib/store.svelte.js';
  import { whenLabel, shortDate, relDeadline, fmtTime } from '../lib/dates.js';
  import { touchLayout } from '../lib/touch.js';

  let { todo } = $props();
  // Read once, as the card is made: newId is cleared the moment its title has
  // focus, and a class that came off again would cut the entrance short.
  const fromPlus = untrack(() => app.fromPlus && app.newId === todo.id);

  let title = $state('');
  let notes = $state('');
  let checklist = $state([]);
  let dirty = $state(false);
  let saveTimer = null;
  let titleEl = $state(null);
  let clInputs = $state([]);
  let pendingFocus = $state(-1);
  // The row a grip is holding: {i, y, pitch}. Null the rest of the time.
  let cldrag = $state(null);
  let firstIn = $state(false);

  // A detail icon does not open a panel and leave itself behind: it unrolls in
  // place into a small grey field, and the panel hangs under it with no input
  // of its own. The field is the input; what is typed reaches the panel
  // through app.popover, and the panel lends its Up/Down/Enter back.
  // Under a thumb the phone's own sheet is right, so this is desks only.
  const FIELD_W = 124;
  let field = $state(null);       // 'when' | 'tags' | 'deadline'
  let fieldEl = $state(null);
  let chipIn = $state(false);
  // The panel and the field are one thing: whatever closes the panel — Escape,
  // the scrim, choosing a date — rolls the field back up too. And when a day
  // was what closed it, the chip that takes the field's place comes in from
  // the right as it fades.
  $effect(() => {
    if (app.popover) return;
    untrack(() => {
      if (!field) return;
      const was = field;
      field = null;
      if (was === 'when') { chipIn = true; setTimeout(() => (chipIn = false), 360); }
    });
  });

  function openField(kind, btn) {
    if (touchLayout()) return openPopover(kind, target(), btn);
    const box = btn.closest('.fld').getBoundingClientRect();
    field = kind;
    // Anchored where the field will BE, not where the icon is: it grows
    // leftward from its right edge, which does not move.
    openPopover(kind, target(), null, {
      external: true,
      q: '',
      rect: { top: box.top, bottom: box.bottom, right: box.right,
              left: box.right - FIELD_W, width: FIELD_W, height: box.height },
    });
    tick().then(() => fieldEl && fieldEl.focus());
  }
  const onFieldInput = (e) => { if (app.popover) app.popover.q = e.currentTarget.value; };
  function onFieldKey(e) {
    if (e.key === 'Escape') return;          // the global guard closes the panel
    if (app.popover && app.popover.onkey) app.popover.onkey(e);
  }

  let rootEl = $state(null);
  const focusInside = () => !!(rootEl && rootEl.contains(document.activeElement) && document.activeElement !== rootEl);

  // Pull server values in whenever the to-do changes, unless we have unsaved edits or
  // the user is typing in this card (the optimistic write-back must not clobber the caret).
  $effect(() => {
    const t = todo;
    const src = { title: t.title, notes: t.notes, checklist: t.checklist };
    untrack(() => {
      if (dirty || focusInside()) return;
      // A new to-do's title really is "New To-Do"; showing it as text to be
      // typed over means the first keystroke has to delete it. The placeholder
      // says the same thing and needs no clearing — and saves nothing, because
      // an empty title patches to nothing (collectPatch).
      title = src.title === 'New To-Do' ? '' : (src.title || '');
      notes = src.notes || '';
      checklist = (src.checklist || []).map((c) => ({ text: c.text, done: !!c.done }));
    });
  });

  // New to-do: focus the title with the placeholder text selected.
  $effect(() => {
    if (app.newId === todo.id && titleEl) {
      const el = titleEl;
      app.newId = null;
      tick().then(() => el.focus());
    }
  });
  // ⇧⌘C: add or focus a checklist item.
  $effect(() => {
    if (app.focusChecklist && app.expanded === todo.id) {
      app.focusChecklist = false;
      addAtEnd();
    }
  });
  // Flush unsaved edits when the card goes away.
  $effect(() => () => flush());

  // Phone: a card that opens near the bottom of the screen is half under the
  // Move/Delete capsule. Once the row has finished growing into it (240ms,
  // components/TodoItem.svelte), bring it into view — no further than it has
  // to, so the list does not lurch. `scroll-margin` on .card says how much
  // clearance that means.
  $effect(() => {
    if (!rootEl || !touchLayout()) return;
    const el = rootEl;
    const t = setTimeout(() => {
      const sc = el.closest('.content');
      if (!sc) return;
      const box = el.getBoundingClientRect();
      const view = sc.getBoundingClientRect();
      // Taller than the screen: its top is the part worth seeing.
      el.scrollIntoView({ block: box.height > view.height - 80 ? 'start' : 'nearest', behavior: 'smooth' });
    }, 470);   // after the row has finished growing into it
    return () => clearTimeout(t);
  });

  let fading = $derived(app.completing[todo.id]);
  let done = $derived(todo.status !== 'open' || !!fading);
  let inToday = $derived(!todo.someday && !!todo.when && todo.when <= today());

  function collectPatch() {
    const patch = {};
    // Keep trailing spaces while the user is still typing; trim once the card loses focus.
    const raw = title.trim() ? title : 'New To-Do';
    const ttl = focusInside() ? raw : raw.trimEnd();
    if (ttl !== (todo.title || '')) patch.title = ttl;
    if (notes !== (todo.notes || '')) patch.notes = notes;
    const cl = checklist.filter((c) => c.text.trim() !== '' || checklist.length === 1).map((c) => ({ text: c.text, done: c.done }));
    const clean = cl.filter((c) => c.text.trim() !== '');
    const before = JSON.stringify((todo.checklist || []).map((c) => ({ text: c.text, done: !!c.done })));
    if (JSON.stringify(clean) !== before) patch.checklist = clean;
    return patch;
  }
  function schedule() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  async function save() {
    saveTimer = null;
    const patch = collectPatch();
    dirty = false;
    if (!Object.keys(patch).length) return;
    await patchTodo(todo.id, patch, { silent: true });
  }
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const patch = collectPatch();
    dirty = false;
    if (Object.keys(patch).length) patchTodo(todo.id, patch);
  }

  function autosize(node) {
    const fit = () => { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px'; };
    fit();
    node.addEventListener('input', fit);
    const ro = new ResizeObserver(fit);
    ro.observe(node);
    return { update: fit, destroy() { node.removeEventListener('input', fit); ro.disconnect(); } };
  }

  // Done, whichever key says so. Android's IMEs do not always send a keydown
  // for the action key, but they all send a beforeinput asking for a line
  // break, and a <textarea> would happily take one.
  function commit(el) {
    flush();
    app.expanded = null;
    if (el) el.blur();
  }
  function onTitleKey(e) {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      commit(e.currentTarget);
    }
  }
  function onTitleBeforeInput(e) {
    if (e.isComposing) return;
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    e.preventDefault();
    commit(e.currentTarget);
  }

  // ---- checklist
  async function focusItem(i) {
    pendingFocus = i;
    await tick();
    const el = clInputs[i];
    if (el) { el.focus(); pendingFocus = -1; }
  }
  function addItem(after = checklist.length - 1) {
    // The first row of a checklist has an entrance; the ones typed after it do
    // not, and a card reopened on an existing checklist must not flash.
    if (!checklist.length) { firstIn = true; setTimeout(() => (firstIn = false), 320); }
    checklist.splice(after + 1, 0, { text: '', done: false });
    schedule();
    focusItem(after + 1);
  }
  /** The checklist button and ⇧⌘C: a new item at the end, unless the last one
   *  is still empty — then that is the one to type in, not a second blank. */
  function addAtEnd() {
    const last = checklist.length - 1;
    if (last >= 0 && checklist[last].text.trim() === '') focusItem(last);
    else addItem(last);
  }
  function removeItem(i) {
    checklist.splice(i, 1);
    schedule();
    if (checklist.length) focusItem(Math.max(0, i - 1)); else titleEl && titleEl.focus();
  }
  function toggleItem(i) {
    checklist[i].done = !checklist[i].done;
    schedule();
  }

  // A list copied from somewhere else is a list — paste a bulleted list and
  // you get one item per line — so a paste that spans lines is split, its
  // bullets and numbers stripped, and the text that was after the caret stays
  // on the end of the last one.
  const stripBullet = (s) => s.replace(/^[\t ]*(?:[-*\u2022\u2023\u25aa\u25e6\u2043]|\d+[.)])[\t ]+/, '').trim();
  function onItemPaste(e, i) {
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    const lines = text.split(/\r\n|\r|\n/).map(stripBullet).filter((t) => t !== '');
    if (lines.length < 2) return; // one line is an ordinary paste
    e.preventDefault();
    const el = e.currentTarget;
    const head = el.value.slice(0, el.selectionStart);
    const tail = el.value.slice(el.selectionEnd);
    checklist[i].text = head + lines[0];
    const rest = lines.slice(1).map((t) => ({ text: t, done: false }));
    rest[rest.length - 1].text += tail;
    checklist.splice(i + 1, 0, ...rest);
    schedule();
    focusItem(i + rest.length);
  }

  // ---- reorder by the grip
  //
  // Only from the grip, and from the first pixel: the row is an <input>, and a
  // hold anywhere on it is Android's text-selection gesture. `touch-action:none`
  // on the grip (app.css) is what stops the list scrolling instead; the button
  // also keeps the row's own long-press drag out of it (dnd.svelte.js down()).
  function gripDown(e, i) {
    if (e.button) return;
    const row = e.currentTarget.closest('.cli');
    cldrag = { i, y: e.clientY, pitch: row.getBoundingClientRect().height || 30 };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
  }
  function gripMove(e) {
    if (!cldrag) return;
    let { i, y, pitch } = cldrag;
    // One row per crossed middle, and a loop because a coarse pointer can hand
    // us a jump of several rows in one event.
    while (Math.abs(e.clientY - y) >= pitch * 0.6) {
      const dir = e.clientY > y ? 1 : -1;
      const j = i + dir;
      if (j < 0 || j >= checklist.length) break;
      const [it] = checklist.splice(i, 1);
      checklist.splice(j, 0, it);
      i = j;
      y += dir * pitch;
    }
    if (i !== cldrag.i) cldrag = { i, y, pitch };
  }
  function gripUp() {
    if (!cldrag) return;
    cldrag = null;
    schedule();
  }
  function onItemKey(e, i) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (checklist[i].text.trim() === '') return;
      addItem(i);
    } else if (e.key === 'Backspace' && checklist[i].text === '') {
      e.preventDefault();
      removeItem(i);
    } else if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= checklist.length) return;
      const [it] = checklist.splice(i, 1);
      checklist.splice(j, 0, it);
      schedule();
      focusItem(j);
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      focusItem(i - 1);
    } else if (e.key === 'ArrowDown' && i < checklist.length - 1) {
      e.preventDefault();
      focusItem(i + 1);
    }
  }

  function whenClass() {
    if (todo.someday) return 'some';
    if (inToday) return todo.evening ? 'moon' : 'star';
    if (todo.when) return 'date';
    return 'empty';
  }
  function whenText() {
    if (todo.someday) return 'Someday';
    if (inToday) return todo.evening ? 'This Evening' : 'Today';
    if (todo.when) return whenLabel(todo.when, today());
    return 'When';
  }
  function whenIcon() {
    if (todo.someday) return 'zz';
    if (inToday) return todo.evening ? 'moon' : 'sunS';
    return 'cal';
  }
  const target = () => ({ type: 'todo', id: todo.id });
</script>

<div class="card" class:fromplus={fromPlus} data-todo-id={todo.id} data-card role="group" aria-label="Edit to-do" bind:this={rootEl}>
  <div class="head">
    <button class="cb" class:done aria-label={done ? 'Reopen' : 'Complete'} onclick={() => toggleComplete(todo.id)}>
      <Icon name={todo.status === 'canceled' ? 'x' : 'check'} />
    </button>
    <textarea
      class="ttl"
      rows="1"
      bind:this={titleEl}
      bind:value={title}
      use:autosize={title}
      oninput={schedule}
      onblur={() => { if (saveTimer) { clearTimeout(saveTimer); save(); } }}
      onkeydown={onTitleKey}
      onbeforeinput={onTitleBeforeInput}
      enterkeyhint="done"
      placeholder="New To-Do"
      aria-label="Title"
      spellcheck="false"
    ></textarea>
  </div>
  <NotesField
    class="note"
    value={notes}
    onchange={(v) => { notes = v; schedule(); }}
    onblur={() => { if (saveTimer) { clearTimeout(saveTimer); save(); } }}
    placeholder="Notes"
    label="Notes"
  />

  {#if checklist.length}
    <div class="cl" role="list" aria-label="Checklist">
      {#each checklist as item, i (i)}
        <div class="cli" class:done={item.done} class:lifted={cldrag && cldrag.i === i}
             class:clin={firstIn && i === 0} role="listitem">
          <button class="dot" aria-label={item.done ? 'Uncheck' : 'Check'} onclick={() => toggleItem(i)}></button>
          <input
            bind:this={clInputs[i]}
            bind:value={item.text}
            oninput={schedule}
            onkeydown={(e) => onItemKey(e, i)}
            onpaste={(e) => onItemPaste(e, i)}
            onblur={() => { if (saveTimer) { clearTimeout(saveTimer); save(); } }}
            placeholder="Checklist item"
            aria-label="Checklist item"
            enterkeyhint="next"
          />
          <!-- There is no X on the row and no standing "add" row: Return makes
               the next item, an emptied row goes when it is saved, and this
               takes hold of the one you want somewhere else. -->
          <button class="grip" aria-label="Reorder item" title="Drag to reorder"
                  onpointerdown={(e) => gripDown(e, i)}
                  onpointermove={gripMove}
                  onpointerup={gripUp}
                  onpointercancel={gripUp}><Icon name="grip" /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if todo.tags && todo.tags.length}
    <div class="tags">
      {#each todo.tags as tag}
        <button onclick={(e) => openPopover('tags', target(), e.currentTarget)} aria-label={`Tag ${tag}: edit tags`}>{tag}</button>
      {/each}
    </div>
  {/if}
  {#if todo.repeat || todo.reminder}
    <div class="dlrow muted">
      {#if todo.repeat}
        <!-- the rule is the control: click it to change it, as the date is -->
        <button class="rulebtn" onclick={(e) => openPopover('repeat', target(), e.currentTarget)}
                title="Change how this repeats"><Icon name="repeat" /> Repeats {todo.repeat}</button>
      {/if}
      {#if todo.repeat && todo.reminder} · {/if}
      {#if todo.reminder}<Icon name="bell" /> {todo.repeat ? fmtTime(todo.reminder) : `Reminder at ${fmtTime(todo.reminder)}`}{/if}
    </div>
  {/if}
  {#if todo.deadline}
    <button class="dlrow" onclick={(e) => openPopover('deadline', target(), e.currentTarget)} aria-label="Change deadline">
      <Icon name="flag" /> Deadline {shortDate(todo.deadline, today())} · {relDeadline(todo.deadline, today()).text}
    </button>
  {/if}

  <div class="foot">
    <!-- With no day set there is nothing to say, so nothing is said: the
         calendar joins the other icons on the right, and a chip appears here
         only once there is a day to name. -->
    {#if whenClass() !== 'empty'}
      <button class="when {whenClass()}" class:chipin={chipIn} onclick={(e) => openPopover('when', target(), e.currentTarget)} aria-label="When">
        <Icon name={whenIcon()} /> {whenText()}
      </button>
    {/if}
    <div class="icons">
      {#if whenClass() === 'empty'}
        <span class="fld" class:open={field === 'when'}>
          <button class="whenic" title="When (⌘S)" aria-label="When" onclick={(e) => openField('when', e.currentTarget)}><Icon name="cal" /></button>
          {#if field === 'when'}
            <input bind:this={fieldEl} oninput={onFieldInput} onkeydown={onFieldKey}
                   placeholder="When" autocomplete="off" spellcheck="false" aria-label="When" />
          {/if}
        </span>
      {/if}
      <span class="fld" class:open={field === 'tags'}>
        <button title="Tags (⇧⌘T)" aria-label="Tags" onclick={(e) => openField('tags', e.currentTarget)}><Icon name="tagic" /></button>
        {#if field === 'tags'}
          <input bind:this={fieldEl} oninput={onFieldInput} onkeydown={onFieldKey}
                 placeholder="Tags" autocomplete="off" spellcheck="false" aria-label="Tags" />
        {/if}
      </span>
      <!-- Always here. It used to go once the first item existed, leaving
           Return inside an item as the only way to add another — which nothing
           on screen said, and which a phone keyboard barely offers. -->
      <button title={checklist.length ? 'Add checklist item (⇧⌘C)' : 'Checklist (⇧⌘C)'}
              aria-label={checklist.length ? 'Add checklist item' : 'Add checklist'}
              onclick={addAtEnd}><Icon name="clist" /></button>
      <span class="fld" class:open={field === 'deadline'}>
        <button title="Deadline (⇧⌘D)" aria-label="Deadline" onclick={(e) => openField('deadline', e.currentTarget)}><Icon name="flag" /></button>
        {#if field === 'deadline'}
          <input bind:this={fieldEl} oninput={onFieldInput} onkeydown={onFieldKey}
                 placeholder="Deadline" autocomplete="off" spellcheck="false" aria-label="Deadline" />
        {/if}
      </span>
      <button title="Repeat (⇧⌘R)" aria-label="Repeat" class:on={!!todo.repeat} onclick={(e) => openPopover('repeat', target(), e.currentTarget)}><Icon name="repeat" /></button>
      {#if todo.obsidian}
        <!-- lands on this to-do's line in the real note, via the Advanced URI plugin -->
        <a class="obs" href={todo.obsidian} title="Open this line in Obsidian" aria-label="Open in Obsidian"><Icon name="obsidian" /></a>
      {/if}
    </div>
  </div>
</div>
<style>
  .icons .obs { color: var(--text3); display: grid; place-items: center; text-decoration: none; }
  .icons .obs:hover { color: var(--text); }
</style>
