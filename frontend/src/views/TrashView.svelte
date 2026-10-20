<script>
  import { keyed } from '../lib/keyed.js';
  import ListTitle from '../components/ListTitle.svelte';
  import TodoList from '../components/TodoList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Pie from '../components/Pie.svelte';
  import { app, emptyTrash, confirm, restoreProject } from '../lib/store.svelte.js';
  let data = $derived(app.data);
  let items = $derived((data && data.items) || []);
  let projects = $derived((data && data.projects) || []);
  function askEmpty(e) {
    confirm(e.currentTarget, 'Permanently delete everything in the Trash?', [
      { label: 'Empty Trash', icon: 'trash', danger: true, action: emptyTrash },
      { label: 'Cancel' }
    ]);
  }
</script>

{#if data}
  <ListTitle icon="trash" name="Trash" />
  {#if projects.length}
    <div class="hd grp" style="margin-top:14px">Projects</div>
    <div class="rows">
      {#each keyed(projects) as [rowKey, p] (rowKey)}
        <div class="row prow" data-project-id={p.id}>
          <span class="pieic"><Pie progress={p.progress} color="var(--text2)" /></span>
          <div class="body"><div class="title"><span class="txt">{p.name}</span></div>{#if p.areaName}<div class="sub">{p.areaName}</div>{/if}</div>
          <button class="restore" onclick={() => restoreProject(p.id)} title="Put this project back where it came from">Restore</button>
        </div>
      {/each}
    </div>
  {/if}
  <TodoList {items} sub trash style="margin-top:12px" context="trash" />
  {#if items.length || projects.length}
    <button class="showdone" onclick={askEmpty}>Empty Trash</button>
  {:else}
    <EmptyState kind="trash" />
  {/if}
{/if}

<style>
  .prow { align-items: center; }
  .restore {
    margin-left: auto;
    font: inherit;
    font-size: 12.5px;
    color: var(--accent);
    background: none;
    border: 0;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity .12s;
  }
  .prow:hover .restore, .restore:focus-visible { opacity: 1; }
  @media (hover: none) { .restore { opacity: 1; } }
</style>
