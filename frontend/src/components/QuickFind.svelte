<script>
  import { plainTitle } from '../lib/inline-md.js';
  /** Quick Find: lists, projects, areas, tags and to-dos via GET /api/search. */
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Pie from './Pie.svelte';
  import * as api from '../lib/api.js';
  import { LIST_ICONS } from '../lib/icons.js';
  import { app, allProjects, goList, goProject, goArea, revealTodo, closeQuickFind, openSettings } from '../lib/store.svelte.js';

  let q = $state(app.quickFind ? app.quickFind.query || '' : '');
  let results = $state(null);
  let sel = $state(0);
  let inputEl = $state(null);
  let listEl = $state(null);

  $effect(() => {
    if (inputEl) tick().then(() => { inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); });
  });
  $effect(() => {
    const text = q.trim();
    if (!text) { results = null; return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.search(text);
        if (q.trim() === text) { results = r; sel = 0; }
      } catch (e) {
        results = { error: e.message };
      }
    }, 120);
    return () => clearTimeout(t);
  });

  const LISTS = [['inbox', 'Inbox'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['anytime', 'Anytime'], ['someday', 'Someday'], ['logbook', 'Logbook']];
  let rows = $derived.by(() => {
    const out = [];
    const text = q.trim().toLowerCase();
    const areas = (app.state && app.state.areas) || [];
    if (!text) {
      for (const [id, name] of LISTS) out.push({ group: 'Lists', kind: 'list', id, name, icon: LIST_ICONS[id] });
      for (const p of allProjects().filter((p) => !p.status || p.status === 'open')) out.push({ group: 'Projects', kind: 'project', id: p.id, name: p.name, pie: p.progress, meta: p.areaName || '' });
      for (const a of areas) out.push({ group: 'Areas', kind: 'area', id: a.id, name: a.name, icon: 'area' });
      return out;
    }
    if (!results || results.error) return out;
    for (const l of results.lists || []) out.push({ group: 'Lists', kind: 'list', id: l.id, name: l.name, icon: LIST_ICONS[l.id] || 'heading' });
    // Settings can be reached by typing its name here.
    if ('settings'.startsWith(text) || 'preferences'.startsWith(text)) {
      out.push({ group: 'Lists', kind: 'settings', id: 'settings', name: 'Settings', icon: 'sliders' });
    }
    for (const p of results.projects || []) out.push({ group: 'Projects', kind: 'project', id: p.id, name: p.name, pie: p.progress, meta: p.areaName || '' });
    for (const a of results.areas || []) out.push({ group: 'Areas', kind: 'area', id: a.id, name: a.name, icon: 'area' });
    for (const t of results.tags || []) out.push({ group: 'Tags', kind: 'tag', id: t.name, name: `#${t.name}`, icon: 'tagic', meta: `${t.count} to-do${t.count === 1 ? '' : 's'}` });
    for (const t of results.todos || []) out.push({ group: 'To-Dos', kind: 'todo', id: t.id, name: t.title, todo: t, meta: t.projectName || (t.inbox ? 'Inbox' : t.areaName || '') });
    return out;
  });

  function pick(r) {
    closeQuickFind();
    if (r.kind === 'settings') openSettings();
    else if (r.kind === 'list') goList(r.id);
    else if (r.kind === 'project') goProject(r.id);
    else if (r.kind === 'area') goArea(r.id);
    else if (r.kind === 'tag') goList('anytime', { filterTag: r.id });
    else if (r.kind === 'todo') revealTodo(r.todo);
  }
  function onkeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = Math.min(rows.length - 1, sel + 1); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = Math.max(0, sel - 1); scroll(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (rows[sel]) pick(rows[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuickFind(); }
  }
  function scroll() {
    tick().then(() => listEl && listEl.querySelector('.r.on')?.scrollIntoView({ block: 'nearest' }));
  }
</script>

<div class="scrim" onclick={closeQuickFind} role="presentation"></div>
<div class="qf" role="dialog" aria-label="Quick Find" tabindex="-1" {onkeydown}>
  <div class="in">
    <Icon name="search" />
    <input bind:this={inputEl} bind:value={q} placeholder="Quick Find" autocomplete="off" spellcheck="false" aria-label="Quick Find" />
  </div>
  <div class="res" bind:this={listEl} role="listbox">
    {#each rows as r, i (r.kind + ':' + r.id)}
      {#if i === 0 || rows[i - 1].group !== r.group}<div class="grp">{r.group}</div>{/if}
      <button class="r" class:on={i === sel} onclick={() => pick(r)} onmouseenter={() => (sel = i)} role="option" aria-selected={i === sel}>
        <span class="ic">
          {#if r.pie !== undefined}<Pie progress={r.pie} color="var(--text2)" />
          {:else if r.kind === 'todo'}<span class="cbx"></span>
          {:else}<Icon name={r.icon} />{/if}
        </span>
        <span class="n">{r.kind === 'todo' ? plainTitle(r.name) : r.name}</span>
        {#if r.meta}<span class="m">{r.meta}</span>{/if}
      </button>
    {/each}
    {#if q.trim() && results && !results.error && !rows.length}
      <div class="none">Nothing matches “{q.trim()}”</div>
    {:else if results && results.error}
      <div class="none">{results.error}</div>
    {/if}
  </div>
</div>
