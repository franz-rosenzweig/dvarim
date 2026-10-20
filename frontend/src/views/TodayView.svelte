<script>
  import { keyed } from '../lib/keyed.js';
  import ListTitle from '../components/ListTitle.svelte';
  import FilterBar from '../components/FilterBar.svelte';
  import EventsBlock from '../components/EventsBlock.svelte';
  import TodoList from '../components/TodoList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import ProjectRow from '../components/ProjectRow.svelte';
  import Icon from '../components/Icon.svelte';
  import InlineEdit from '../components/InlineEdit.svelte';
  import { tick } from 'svelte';
  import { app, goProject, openMenu, createTodo, createTodayHeading, renameTodayHeading, deleteTodayHeading,
    moveTodayHeading, fileInToday } from '../lib/store.svelte.js';
  import { crowdedProjects } from '../lib/today.js';

  let data = $derived(app.data);
  let items = $derived((data && data.items) || []);
  let tags = $derived(items.flatMap((t) => t.tags || []));
  let filtered = $derived(app.filterTag ? items.filter((t) => (t.tags || []).includes(app.filterTag)) : items);
  let day = $derived(filtered.filter((t) => !t.evening));
  let evening = $derived(filtered.filter((t) => t.evening));

  // Headings of your own (Settings has nothing to do with them): kept in
  // state.json, each with the to-dos under it. Those under none come first,
  // grouped by list if that is set, and the headings follow, as in a project.
  let headings = $derived((data && data.headings) || []);
  let filed = $derived(new Set(headings.flatMap((h) => h.todos)));
  let unfiled = $derived(day.filter((t) => !filed.has(t.id)));
  const under = (h) => day.filter((t) => h.todos.includes(t.id));

  // Clear the "focus this heading" flag once it has been rendered.
  $effect(() => {
    if (app.editTodayHeading && headings.some((h) => h.id === app.editTodayHeading)) {
      tick().then(() => setTimeout(() => { app.editTodayHeading = null; }, 100));
    }
  });

  function menu(e) {
    openMenu(e.currentTarget, [{ label: 'New Heading', icon: 'heading', action: () => createTodayHeading() }], 'Today');
  }
  function headingMenu(e, h, i) {
    openMenu(e.currentTarget, [
      { label: 'New To-Do', icon: 'plus', action: () => createTodo({}, { place: (t) => fileInToday([t.id], h.id) }) },
      { label: 'Rename', icon: 'heading', action: () => { app.editTodayHeading = h.id; } },
      ...(i > 0 ? [{ label: 'Move Up', icon: 'arrow', action: () => moveTodayHeading(h.id, -1) }] : []),
      ...(i < headings.length - 1 ? [{ label: 'Move Down', icon: 'arrow', action: () => moveTodayHeading(h.id, 1) }] : []),
      { sep: true },
      { label: 'Delete Heading', icon: 'trash', danger: true, action: () => deleteTodayHeading(h.id) },
    ], h.name);
  }

  // Settings -> Group to-dos in the Today list by project or area. Off, Today is
  // one flat list in your own order. On, it reads like the sidebar: loose items
  // first, then a heading per list, in the order the sidebar shows them.
  let grouped = $derived(!!app.settings?.groupTodayByList);

  function groupsOf(list) {
    if (!grouped) return null;
    const order = [];
    for (const a of app.state?.areas || []) {
      order.push('area:' + a.id);
      for (const p of a.projects) order.push('project:' + p.id);
    }
    for (const p of app.state?.looseProjects || []) order.push('project:' + p.id);

    const key = (t) => (t.projectId ? 'project:' + t.projectId : t.areaId ? 'area:' + t.areaId : null);
    const loose = list.filter((t) => !key(t));
    const bucket = new Map();
    for (const t of list) {
      const k = key(t);
      if (!k) continue;
      if (!bucket.has(k)) bucket.set(k, []);
      bucket.get(k).push(t);
    }
    const named = [...bucket.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    });
    return {
      loose,
      sections: named.map((k) => ({
        key: k,
        name: bucket.get(k)[0].projectName || bucket.get(k)[0].areaName || 'Elsewhere',
        items: bucket.get(k),
      })),
    };
  }

  let dayGroups = $derived(groupsOf(unfiled));
  // more than one to-do from the same project (lib/today.js)
  let crowded = $derived(crowdedProjects(items));
</script>

{#if data}
  <ListTitle icon="star" name="Today" onmenu={menu} />
  <FilterBar {tags} />
  <EventsBlock events={data.events} />
  <!-- Projects due or scheduled today: their pie, and no data-todo-id, so
       nothing takes them for a to-do. -->
  {#each keyed(data.projects || []) as [rowKey, pr] (rowKey)}<ProjectRow project={pr} sub />{/each}
  {#if dayGroups}
    <TodoList items={dayGroups.loose} dlFlag hideDl context="today" evening={false} todayHeading="" />
    {#each dayGroups.sections as g (g.key)}
      <div class="hd grp">{g.name}</div>
      <TodoList items={g.items} dlFlag hideDl context="today" evening={false} todayHeading="" />
    {/each}
  {:else}
    <TodoList items={unfiled} sub dlFlag hideDl context="today" evening={false} todayHeading="" />
  {/if}
  {#each keyed(headings) as [rowKey, h], i (rowKey)}
    <div class="hd own">
      <InlineEdit class="hname" value={h.name} onsave={(v) => renameTodayHeading(h.id, v)} autofocus={app.editTodayHeading === h.id} label="Heading name" placeholder="New Heading" />
      <button class="more" onclick={(e) => headingMenu(e, h, i)} aria-label="Heading actions" aria-haspopup="menu">•••</button>
    </div>
    <TodoList items={under(h)} sub dlFlag hideDl context="today" evening={false} todayHeading={h.id} />
  {/each}
  {#if evening.length}
    <div class="hd evening"><Icon name="moon" /> This Evening</div>
    <TodoList items={evening} sub dlFlag hideDl context="today" evening={true} />
  {/if}
  {#if crowded.length}
    <p class="onehint">
      More than one to-do from
      {#each crowded as c, i (c.id)}{i ? (i === crowded.length - 1 ? ' and ' : ', ') : ' '}<button class="linkish" onclick={() => goProject(c.id)}>{c.name}</button>&nbsp;({c.count}){/each}.
      One next step from each project keeps Today a list of what to do next.
    </p>
  {/if}
  {#if !items.length && !(data.projects || []).length}
    <EmptyState kind="today" />
  {:else if !filtered.length}
    <EmptyState kind="filter" />
  {/if}
{/if}

<style>
  /* a quiet word at the end of the day's list, not a warning */
  .onehint { margin: 20px 0 8px; padding: 0 12px; font-size: 13px; line-height: 1.5; color: var(--text2); }
  .onehint .linkish { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer;
    text-decoration: underline; text-decoration-color: var(--hair); text-underline-offset: 2px; }
  .onehint .linkish:hover { color: var(--text); }
</style>
