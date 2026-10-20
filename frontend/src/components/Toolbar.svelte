<script>
  import Icon from './Icon.svelte';
  import { app, createTodo, openPopover, openQuickFind, currentTodoId, clearSelection } from '../lib/store.svelte.js';
  import { keyLabel } from '../lib/keys.js';
  let id = $derived(currentTodoId());
  let isProject = $derived(app.view.kind === 'project');
  function anchor() {
    return document.querySelector(`.content [data-todo-id="${id}"] .when`) || document.querySelector(`.content [data-todo-id="${id}"]`);
  }
  function when(e) {
    if (id) openPopover('when', { type: 'todo', id }, anchor() || e.currentTarget);
    else if (isProject) openPopover('when', { type: 'project', id: app.view.id }, e.currentTarget);
  }
  function move(e) {
    if (id) openPopover('move', { type: 'todo', id }, anchor() || e.currentTarget);
    else if (isProject) openPopover('move', { type: 'project', id: app.view.id }, e.currentTarget);
  }
</script>

<div class="toolbar" role="toolbar" aria-label="Actions">
  <button aria-label="New To-Do" title="New To-Do ({keyLabel('todo.new')})" onclick={() => createTodo()}><Icon name="plus" /></button>
  <button aria-label="When" title="When… ({keyLabel('todo.when')})" onclick={when} disabled={!id && !isProject}><Icon name="cal" /></button>
  <button aria-label="Move" title="Move… ({keyLabel('todo.move')})" onclick={move} disabled={!id && !isProject}><Icon name="arrow" /></button>
  <button aria-label="Quick Find" title="Quick Find ({keyLabel('find')})" onclick={() => openQuickFind()}><Icon name="search" /></button>
  {#if app.selected.length > 1}
    <!-- says what the next action will apply to, and gets out of it -->
    <span class="count" role="status" aria-live="polite">
      {app.selected.length} selected
      <button class="x" onclick={clearSelection} aria-label="Clear the selection" title="Esc">✕</button>
    </span>
  {/if}
</div>

<style>
  button:disabled { opacity: 0.35; cursor: default; }
  .count {
    position: absolute; right: 14px;
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--text2);
    background: var(--pill); border-radius: 11px; padding: 2px 6px 2px 10px;
  }
  .count .x { font-size: 11px; color: var(--text2); padding: 0 2px; width: auto; height: auto; }
  .count .x:hover { color: var(--text); background: none; }
  button:disabled:hover { background: none; color: var(--text2); }
</style>
