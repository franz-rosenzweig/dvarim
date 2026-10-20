<script>
  import { keyed } from '../lib/keyed.js';
  import ListTitle from '../components/ListTitle.svelte';
  import TodoList from '../components/TodoList.svelte';
  import ProjectRow from '../components/ProjectRow.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { app } from '../lib/store.svelte.js';
  let data = $derived(app.data);
  let items = $derived((data && data.items) || []);
  let projects = $derived((data && data.projects) || []);
</script>

{#if data}
  <ListTitle icon="someday" name="Someday" />
  <TodoList {items} sub style="margin-top:12px" context="someday" />
  {#if projects.length}
    <div class="hd grp" style="margin-top:26px">Projects</div>
    <div class="rows">
      {#each keyed(projects) as [rowKey, p] (rowKey)}<ProjectRow project={p} sub />{/each}
    </div>
  {/if}
  {#if !items.length && !projects.length}<EmptyState kind="someday" />{/if}
{/if}
