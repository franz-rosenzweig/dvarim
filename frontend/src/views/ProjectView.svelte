<script>
  import { keyed } from '../lib/keyed.js';
  import { tick, untrack } from 'svelte';
  import Pie from '../components/Pie.svelte';
  import Icon from '../components/Icon.svelte';
  import NotesField from '../components/NotesField.svelte';
  import InlineEdit from '../components/InlineEdit.svelte';
  import FilterBar from '../components/FilterBar.svelte';
  import TodoList from '../components/TodoList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import {
    app, today, patchProject, completeProject, cancelProject, deleteProject, createHeading, renameHeading,
    archiveHeading, deleteHeading, createTodo, openMenu, openPopover, confirm, openSource } from '../lib/store.svelte.js';
  import { shortDate, relDeadline, whenLabel } from '../lib/dates.js';

  // Captured once per mount (App keys this view by project id).
  const wantTitleFocus = app.editTitle;
  app.editTitle = false;

  let data = $derived(app.data);
  let p = $derived(data && data.project);
  let items = $derived((data && data.items) || []);
  let open = $derived(items.filter((t) => t.status === 'open'));
  let done = $derived(items.filter((t) => t.status !== 'open'));
  let tags = $derived(open.flatMap((t) => t.tags || []));
  const vis = (list) => (app.filterTag ? list.filter((t) => (t.tags || []).includes(app.filterTag)) : list);
  let headings = $derived((p && p.headings) || []);
  let shownHeadings = $derived(headings.filter((h) => !h.archived || app.showCompleted));
  let noHeading = $derived(vis(open.filter((t) => !t.headingId)));
  let doneNoHeading = $derived(done.filter((t) => !t.headingId));
  const under = (h, list) => list.filter((t) => t.headingId === h.id);
  let T = $derived(today());
  let dl = $derived(p && p.deadline ? relDeadline(p.deadline, T) : null);

  // Clear the "focus this heading" flag once it has been rendered.
  $effect(() => {
    if (app.editHeading && headings.some((h) => h.id === app.editHeading)) {
      tick().then(() => setTimeout(() => { app.editHeading = null; }, 100));
    }
  });

  // ---- notes autosave
  let notes = $state('');
  let notesDirty = $state(false);
  let notesTimer = null;
  $effect(() => {
    const v = p ? p.notes || '' : '';
    untrack(() => { if (!notesDirty) notes = v; });
  });
  function notesInput() {
    notesDirty = true;
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotes, 400);
  }
  function saveNotes() {
    notesTimer = null;
    notesDirty = false;
    if (p && notes !== (p.notes || '')) patchProject(p.id, { notes });
  }

  // ---- menus
  const target = () => ({ type: 'project', id: p.id });
  function menu(e) {
    const el = e.currentTarget;
    openMenu(el, [
      ...(p && p.obsidian ? [{ label: 'Open in Obsidian', icon: 'obsidian',
        action: () => window.open(p.obsidian, '_self') }, { sep: true }] : []),
      { label: 'Edit the note itself', icon: 'notes',
        action: () => openSource(p.file) },
      { label: 'Complete Project', icon: 'check', action: () => completeFlow(el) },
      { label: 'Cancel Project', icon: 'x', action: () => cancelProject(p.id) },
      { sep: true },
      { label: 'When…', icon: 'cal', action: () => openPopover('when', target(), el) },
      { label: 'Deadline…', icon: 'flag', action: () => openPopover('deadline', target(), el) },
      { label: 'Tags…', icon: 'tagic', action: () => openPopover('tags', target(), el) },
      { label: 'Move to Area…', icon: 'arrow', action: () => openPopover('move', target(), el) },
      { label: 'New Heading', icon: 'heading', action: () => createHeading(p.id) },
      { sep: true },
      { label: 'Delete Project', icon: 'trash', danger: true, action: () => confirm(el, 'Delete this project and its to-dos?', [
        { label: 'Delete Project', icon: 'trash', danger: true, action: () => deleteProject(p.id) },
        { label: 'Cancel' }
      ]) }
    ], p.name);
  }
  function completeFlow(el) {
    if (open.length) {
      confirm(el, `${open.length} to-do${open.length > 1 ? 's are' : ' is'} still open`, [
        { label: 'Complete them too', icon: 'check', action: () => completeProject(p.id, true) },
        { label: 'Leave them open', action: () => completeProject(p.id, false) },
        { label: 'Cancel' }
      ]);
    } else {
      completeProject(p.id);
    }
  }
  function headingMenu(e, h) {
    const el = e.currentTarget;
    openMenu(el, [
      { label: 'New To-Do', icon: 'plus', action: () => createTodo({ projectId: p.id, headingId: h.id }) },
      { label: 'Rename', icon: 'heading', action: () => { app.editHeading = h.id; } },
      { label: h.archived ? 'Unarchive Heading' : 'Archive Heading', icon: 'someday', action: () => archiveHeading(h.id, !h.archived) },
      { sep: true },
      { label: 'Delete Heading', icon: 'trash', danger: true, action: () => confirm(el, 'Delete this heading? Its to-dos stay in the project.', [
        { label: 'Delete Heading', icon: 'trash', danger: true, action: () => deleteHeading(h.id) },
        { label: 'Cancel' }
      ]) }
    ], h.name);
  }
</script>

{#if p}
  <h1 class="t">
    <span class="ic"><Pie progress={p.progress} size={24} color="var(--accent)" /></span>
    <InlineEdit class="name" value={p.name} onsave={(v) => patchProject(p.id, { name: v })} autofocus={wantTitleFocus} label="Project name" placeholder="New Project" />
    <button class="more" onclick={menu} aria-label="Project actions" aria-haspopup="menu">•••</button>
  </h1>
  {#if p.when || p.someday || p.deadline || (p.tags && p.tags.length)}
    <div class="pmeta">
      {#if p.someday}
        <button class="mi some" onclick={(e) => openPopover('when', target(), e.currentTarget)}><Icon name="zz" /> Someday</button>
      {:else if p.when && p.when <= T}
        <button class="mi {p.evening ? 'moon' : 'star'}" onclick={(e) => openPopover('when', target(), e.currentTarget)}><Icon name={p.evening ? 'moon' : 'sunS'} /> {p.evening ? 'This Evening' : 'Today'}</button>
      {:else if p.when}
        <button class="mi date" onclick={(e) => openPopover('when', target(), e.currentTarget)}><Icon name="cal" /> {whenLabel(p.when, T)}</button>
      {/if}
      {#if p.deadline}
        <button class="mi" class:red={dl && dl.red} onclick={(e) => openPopover('deadline', target(), e.currentTarget)}><Icon name="flag" /> Deadline {shortDate(p.deadline, T)} · {dl.text}</button>
      {/if}
      {#if p.tags && p.tags.length}
        <button class="mi tags" onclick={(e) => openPopover('tags', target(), e.currentTarget)} aria-label="Project tags">{#each p.tags as t}<span class="tag">{t}</span>{/each}</button>
      {/if}
    </div>
  {/if}
  <NotesField class="pnotes" value={notes} onchange={(v) => { notes = v; notesInput(); }}
              onblur={() => { if (notesTimer) { clearTimeout(notesTimer); saveNotes(); } }}
              placeholder="Notes" label="Project notes" />
  <FilterBar {tags} />

  <TodoList items={noHeading} showStar context={`project:${p.id}`} />
  {#if app.showCompleted}<TodoList items={doneNoHeading} />{/if}

  {#each keyed(shownHeadings) as [rowKey, h] (rowKey)}
    <div class="hd" class:archived={h.archived}>
      <InlineEdit class="hname" value={h.name} onsave={(v) => renameHeading(h.id, v)} autofocus={app.editHeading === h.id} label="Heading name" placeholder="New Heading" />
      <button class="more" onclick={(e) => headingMenu(e, h)} aria-label="Heading actions" aria-haspopup="menu">•••</button>
    </div>
    <TodoList items={vis(under(h, open))} showStar context={`heading:${h.id}`} />
    {#if app.showCompleted}<TodoList items={under(h, done)} />{/if}
  {/each}

  {#if done.length}
    <button class="showdone" onclick={() => (app.showCompleted = !app.showCompleted)}>
      {app.showCompleted ? 'Hide' : 'Show'} {done.length} completed item{done.length > 1 ? 's' : ''}
    </button>
  {/if}
  {#if !items.length}<EmptyState kind="project" />{/if}
  {#if p.someday && !p.when}
    <div class="dlrow somenote"><Icon name="zz" /> This project is in Someday</div>
  {/if}
{:else if !app.online}
  <!-- Never opened on this device while there was a server, so nothing is kept
       to show: say that, where a page with no project would be blank. -->
  <EmptyState kind="project" />
{/if}

<style>
  .pmeta { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 8px; font-size: 12.5px; color: var(--text2); align-items: center; }
  .mi { display: inline-flex; gap: 5px; align-items: center; color: var(--text2); }
  .mi:hover { color: var(--text); }
  .mi.star :global(svg) { color: var(--star); }
  .mi.moon :global(svg) { color: var(--moon); }
  .mi.date :global(svg) { color: var(--upc); }
  .mi.some :global(svg) { color: var(--some); }
  .mi.red { color: var(--dead); }
  .mi.tags { gap: 5px; }
  .tag { font-size: 11px; color: var(--text2); border: 1px solid var(--hair); border-radius: 9px; padding: 0 7px; line-height: 16px; }
  .somenote { margin: 14px 0 0; color: var(--text3); font-size: 12.5px; display: flex; gap: 5px; align-items: center; }
</style>
