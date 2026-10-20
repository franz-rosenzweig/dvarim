<script>
  import ListTitle from '../components/ListTitle.svelte';
  import FilterBar from '../components/FilterBar.svelte';
  import TodoList from '../components/TodoList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Pie from '../components/Pie.svelte';
  import Icon from '../components/Icon.svelte';
  import { app, goProject, goArea } from '../lib/store.svelte.js';

  let data = $derived(app.data);
  let loose = $derived((data && data.items) || []);
  let groups = $derived((data && data.groups) || []);
  let tags = $derived([...loose, ...groups.flatMap((g) => g.items || [])].flatMap((t) => t.tags || []));
  const vis = (list) => (app.filterTag ? list.filter((t) => (t.tags || []).includes(app.filterTag)) : list);
  let looseVis = $derived(vis(loose));
  let groupsVis = $derived(groups.map((g) => ({ ...g, items: vis(g.items || []) })).filter((g) => g.items.length));
  let total = $derived(loose.length + groups.reduce((n, g) => n + (g.items || []).length, 0));
  const ctx = (g) => (g.project ? `project:${g.project.id}` : g.area ? `area:${g.area.id}` : 'anytime');
</script>

{#if data}
  <ListTitle icon="anytime" name="Anytime" />
  <FilterBar {tags} />
  <TodoList items={looseVis} showStar context="anytime" />
  {#each groupsVis as g (g.project ? 'p:' + g.project.id : g.area ? 'a:' + g.area.id : 'loose')}
    {#if g.project}
      <button class="hd grp link" onclick={() => goProject(g.project.id)}>
        <Pie progress={g.project.progress} size={14} color="var(--text2)" />
        {g.project.name}
        {#if g.project.areaName}<span class="sub">· {g.project.areaName}</span>{/if}
      </button>
    {:else if g.area}
      <button class="hd grp link" onclick={() => goArea(g.area.id)}><Icon name="area" />{g.area.name}</button>
    {/if}
    <TodoList items={g.items} showStar context={ctx(g)} />
  {/each}
  {#if !total}
    <EmptyState kind="anytime" />
  {:else if !looseVis.length && !groupsVis.length}
    <EmptyState kind="filter" />
  {/if}
{/if}

<style>
  .link { width: 100%; text-align: left; cursor: pointer; }
  .link:hover { color: var(--text); }
</style>
