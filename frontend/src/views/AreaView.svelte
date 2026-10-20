<script>
  import { keyed } from '../lib/keyed.js';
  import Icon from '../components/Icon.svelte';
  import InlineEdit from '../components/InlineEdit.svelte';
  import ProjectRow from '../components/ProjectRow.svelte';
  import TodoList from '../components/TodoList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { app, patchArea, deleteArea, createProject, createTodo, openMenu, openPopover, confirm, openSource } from '../lib/store.svelte.js';

  const wantTitleFocus = app.editTitle;
  app.editTitle = false;

  let data = $derived(app.data);
  let a = $derived(data && data.area);
  let projects = $derived(((a && a.projects) || []).filter((p) => !p.status || p.status === 'open'));
  let items = $derived((data && data.items) || []);

  function menu(e) {
    const el = e.currentTarget;
    openMenu(el, [
      ...(a && a.obsidian ? [{ label: 'Open in Obsidian', icon: 'obsidian',
        action: () => window.open(a.obsidian, '_self') }, { sep: true }] : []),
      { label: 'Edit the note itself', icon: 'notes',
        action: () => openSource(a.file) },
      { label: 'New Project', icon: 'proj', action: () => createProject({ areaId: a.id }) },
      { label: 'New To-Do', icon: 'plus', action: () => createTodo({ areaId: a.id }) },
      { label: 'Tags…', icon: 'tagic', action: () => openPopover('tags', { type: 'area', id: a.id }, el) },
      { sep: true },
      { label: 'Delete Area', icon: 'trash', danger: true, action: () => confirm(el, 'Delete this area? Its projects and to-dos are kept.', [
        { label: 'Delete Area', icon: 'trash', danger: true, action: () => deleteArea(a.id) },
        { label: 'Cancel' }
      ]) }
    ], a.name);
  }
</script>

{#if a}
  <h1 class="t">
    <span class="ic"><Icon name="area" /></span>
    <InlineEdit class="name" value={a.name} onsave={(v) => patchArea(a.id, { name: v })} autofocus={wantTitleFocus} label="Area name" placeholder="New Area" />
    <button class="more" onclick={menu} aria-label="Area actions" aria-haspopup="menu">•••</button>
  </h1>
  {#if projects.length}
    <div class="rows" style="margin-top:10px">
      {#each keyed(projects) as [rowKey, p] (rowKey)}<ProjectRow project={p} />{/each}
    </div>
  {/if}
  <TodoList {items} showStar context={`area:${a.id}`} style={projects.length ? 'margin-top:10px' : 'margin-top:12px'} />
  {#if !projects.length && !items.length}<EmptyState kind="area" />{/if}
{:else if !app.online}
  <EmptyState kind="area" />    <!-- nothing kept for it: see ProjectView -->
{/if}
