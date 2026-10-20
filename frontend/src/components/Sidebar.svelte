<script>
  import { keyed } from '../lib/keyed.js';
  import Icon from './Icon.svelte';
  import Pie from './Pie.svelte';
  import { app, goList, goProject, goArea, openMenu, createProject, createArea, openSettings } from '../lib/store.svelte.js';
  import { drag } from '../lib/dnd.svelte.js';
  import { drawerDrag } from '../lib/drawer.svelte.js';

  const TOP = [
    ['inbox', 'Inbox', 'inbox'],
    ['today', 'Today', 'sun'],
    ['upcoming', 'Upcoming', 'upcoming'],
    ['anytime', 'Anytime', 'anytime'],
    ['someday', 'Someday', 'someday']
  ];
  const BOTTOM = [
    ['logbook', 'Logbook', 'logbook'],
    ['trash', 'Trash', 'trash']
  ];
  let counts = $derived((app.state && app.state.counts) || {});
  let areas = $derived((app.state && app.state.areas) || []);
  let loose = $derived(((app.state && app.state.looseProjects) || []).filter((p) => !p.status || p.status === 'open'));
  const isList = (id) => app.view.kind === 'list' && app.view.id === id;
  const openProjects = (a) => (a.projects || []).filter((p) => !p.status || p.status === 'open');

  function newList(e) {
    openMenu(e.currentTarget, [
      { label: 'New Project', icon: 'proj', action: () => createProject() },
      { label: 'New Area', icon: 'area', action: () => createArea() }
    ], 'New List');
  }
</script>

<aside class="sidebar" use:drawerDrag={{ opening: false, set: (open) => (app.root = open) }}>
  <nav class="nav" aria-label="Lists">
    {#each TOP as [id, name, icon]}
      <button class="item" class:on={isList(id)} class:drop={drag.active && drag.target?.kind === 'list' && drag.target?.id === id} onclick={() => goList(id)} data-drop-list={id} aria-current={isList(id) ? 'page' : undefined}>
        <span class="ic"><Icon name={icon} /></span>
        <span class="lbl">{name}</span>
        {#if id === 'inbox' && counts.inbox}<span class="cnt">{counts.inbox}</span>{/if}
        {#if id === 'today'}
          {#if counts.todayDeadlines}<span class="badge" title="Deadlines today">{counts.todayDeadlines}</span>{/if}
          {#if counts.today}<span class="cnt">{counts.today}</span>{/if}
        {/if}
      </button>
    {/each}
    <div class="gap"></div>
    {#each BOTTOM as [id, name, icon]}
      <button class="item" class:on={isList(id)} class:drop={drag.active && drag.target?.kind === 'list' && drag.target?.id === id} onclick={() => goList(id)} data-drop-list={id} aria-current={isList(id) ? 'page' : undefined}>
        <span class="ic"><Icon name={icon} /></span>
        <span class="lbl">{name}</span>
      </button>
    {/each}
    {#each keyed(areas) as [rowKey, a] (rowKey)}
      <div class="gap"></div>
      <button class="item area" class:on={app.view.kind === 'area' && app.view.id === a.id} class:drop={drag.active && drag.target?.kind === 'area' && drag.target?.id === a.id} onclick={() => goArea(a.id)} data-drop-area={a.id}>
        <span class="ic"><Icon name="area" /></span>
        <span class="lbl">{a.name}</span>
      </button>
      {#each keyed(openProjects(a)) as [rowKey, p] (rowKey)}
        <button class="item proj" class:on={app.view.kind === 'project' && app.view.id === p.id} class:drop={drag.active && drag.target?.kind === 'project' && drag.target?.id === p.id} onclick={() => goProject(p.id)} data-drop-project={p.id}>
          <span class="ic"><Pie progress={p.progress} color="var(--text2)" /></span>
          <span class="lbl">{p.name}</span>
        </button>
      {/each}
    {/each}
    {#if loose.length}
      <div class="gap"></div>
      {#each keyed(loose) as [rowKey, p] (rowKey)}
        <button class="item proj" class:on={app.view.kind === 'project' && app.view.id === p.id} class:drop={drag.active && drag.target?.kind === 'project' && drag.target?.id === p.id} onclick={() => goProject(p.id)} data-drop-project={p.id}>
          <span class="ic"><Pie progress={p.progress} color="var(--text2)" /></span>
          <span class="lbl">{p.name}</span>
        </button>
      {/each}
    {/if}
  </nav>
  <div class="sidefoot">
    <button onclick={newList} aria-haspopup="menu"><Icon name="plus" /> New List</button>
    <button onclick={openSettings} aria-label="Settings" title="Settings (⌘,)"><Icon name="sliders" /></button>
  </div>
</aside>
