<script>
  import { touchLayout } from '../lib/touch.js';
  /** Move a to-do (Inbox, No List, areas, projects, headings) or a project (areas). POST /api/todos/{id}/move */
  import { tick } from 'svelte';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';
  import Pie from './Pie.svelte';
  import { app, findTodo, moveTodo, patchProject, closePopover, moveSelected } from '../lib/store.svelte.js';

  let { pop } = $props();
  let target = $derived(pop.target);
  let obj = $derived.by(() => {
    if (!target) return null;
    if (target.type === 'todo') return findTodo(target.id);
    if (target.type === 'project') return app.data && app.data.project && app.data.project.id === target.id ? app.data.project : null;
    return null;
  });
  let query = $state('');
  let sel = $state(0);
  let inputEl = $state(null);
  // Not under a thumb: focusing the field raises the keyboard over the list of places,
  // which is what was being reached for. It is still there to tap.
  $effect(() => { if (inputEl && !touchLayout()) tick().then(() => inputEl.focus()); });

  let areas = $derived((app.state && app.state.areas) || []);
  let loose = $derived(((app.state && app.state.looseProjects) || []).filter((p) => !p.status || p.status === 'open'));
  const openProjects = (a) => (a.projects || []).filter((p) => !p.status || p.status === 'open');

  let options = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    const o = obj;
    if (target && target.type === 'project') {
      out.push({ label: 'No Area', icon: 'heading', body: { areaId: null }, on: o && !o.areaId });
      for (const a of areas) out.push({ label: a.name, icon: 'area', body: { areaId: a.id }, on: o && o.areaId === a.id });
    } else {
      out.push({ label: 'Inbox', icon: 'inboxS', body: { inbox: true }, on: o && o.inbox });
      out.push({ label: 'No List', right: 'Anytime', icon: 'heading', body: { standalone: true }, on: o && !o.inbox && !o.projectId && !o.areaId });
      const pushProject = (p, ind) => {
        out.push({ label: p.name, pie: p.progress, body: { projectId: p.id }, ind, on: o && o.projectId === p.id && !o.headingId });
        const showHeadings = q || (o && o.projectId === p.id);
        if (showHeadings) {
          for (const h of (p.headings || []).filter((h) => !h.archived)) {
            out.push({ label: h.name, parent: p.name, icon: 'heading', body: { projectId: p.id, headingId: h.id }, ind: ind + 1, on: o && o.headingId === h.id });
          }
        }
      };
      for (const a of areas) {
        out.push({ label: a.name, icon: 'area', body: { areaId: a.id }, on: o && o.areaId === a.id && !o.projectId, area: true });
        for (const p of openProjects(a)) pushProject(p, 1);
      }
      for (const p of loose) pushProject(p, 0);
    }
    if (!q) return out;
    return out.filter((x) => x.label.toLowerCase().includes(q) || (x.parent && x.parent.toLowerCase().includes(q)));
  });

  async function pick(x) {
    // Capture before closing: closePopover() unmounts this component and
    // `target` is $derived off the `pop` prop, so reading it after is too late.
    const tgt = target;
    const group = tgt && tgt.type === 'todo' && app.selected.length > 1 && app.selected.includes(tgt.id);
    const n = app.selected.length;
    closePopover();
    if (!tgt) return;
    if (tgt.type === 'project') return patchProject(tgt.id, x.body);
    return group
      ? moveSelected(x.body, `${n} moved to ${x.label}`)
      : moveTodo(tgt.id, x.body, `Moved to ${x.label}`);
  }
  function onkeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = Math.min(options.length - 1, sel + 1); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = Math.max(0, sel - 1); scroll(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (options[sel]) pick(options[sel]); }
  }
  let listEl = $state(null);
  function scroll() {
    tick().then(() => listEl && listEl.querySelector('.opt.on')?.scrollIntoView({ block: 'nearest' }));
  }
</script>

<Popover rect={pop.rect} label="Move to">
  <div class="in">
    <Icon name="arrow" />
    <input bind:this={inputEl} bind:value={query} oninput={() => (sel = 0)} placeholder="Move to…" autocomplete="off" spellcheck="false" {onkeydown} aria-label="Move to" />
  </div>
  <div class="list" bind:this={listEl} role="listbox">
    {#each options as x, i}
      <button class="opt" class:on={i === sel} class:area={x.area} style:padding-left={x.ind ? `${8 + x.ind * 18}px` : null} onclick={() => pick(x)} onmouseenter={() => (sel = i)} role="option" aria-selected={i === sel}>
        <span class="ic">{#if x.pie !== undefined}<Pie progress={x.pie} size={14} />{:else}<Icon name={x.icon} />{/if}</span>
        <span class="lbl">{x.label}</span>
        {#if x.on}<span class="r"><Icon name="check" /></span>{:else if x.right}<span class="r">{x.right}</span>{/if}
      </button>
    {/each}
    {#if !options.length}<div class="hint">No list matches</div>{/if}
  </div>
</Popover>

<style>
  .list { max-height: 320px; overflow: auto; }
  .area { font-weight: 600; }
</style>
