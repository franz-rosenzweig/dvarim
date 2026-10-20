<script>
  import { touchLayout } from '../lib/touch.js';
  /** Tag picker: existing tags with counts (GET /api/tags), toggle on/off, create by typing.
   *  Opened on a to-do that is one of several selected, it tags them all: a tag
   *  every one of them has is ticked, one only some have shows a dash, and
   *  choosing either puts it on all of them — or, when all had it, takes it off. */
  import { tick } from 'svelte';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';
  import * as api from '../lib/api.js';
  import { app, findTodo, setTags, setTagSelected, patchProject, patchArea, toastError } from '../lib/store.svelte.js';

  let { pop } = $props();
  let target = $derived(pop.target);
  let obj = $derived.by(() => {
    if (!target) return null;
    if (target.type === 'todo') return findTodo(target.id);
    if (target.type === 'project') return app.data && app.data.project && app.data.project.id === target.id ? app.data.project : null;
    if (target.type === 'area') return app.data && app.data.area && app.data.area.id === target.id ? app.data.area : null;
    return null;
  });
  let all = $state([]);
  let query = $state('');
  // Opened from a card's own field (components/TodoCard.svelte): that field is
  // the input, so we do not draw one — we take what it types and lend it the
  // Up/Down/Enter this panel already knows how to answer.
  let external = $derived(!!pop.external);
  $effect(() => { if (external) query = pop.q || ''; });
  $effect(() => {
    if (!external) return;
    pop.onkey = onkeydown;
    return () => { if (pop.onkey === onkeydown) pop.onkey = null; };
  });
  let sel = $state(0);
  let inputEl = $state(null);
  // Not under a thumb: focusing the field raises the keyboard over the tags,
  // which is what was being reached for. It is still there to tap.
  $effect(() => { if (inputEl && !touchLayout() && !external) tick().then(() => inputEl.focus()); });
  $effect(() => {
    api.getTags().then((r) => { all = Array.isArray(r) ? r : []; }).catch(() => { all = (app.state && app.state.tags) || []; });
  });

  let current = $derived((obj && obj.tags) || []);
  /** The selected to-dos, when this was opened on one of several. */
  let group = $derived(target && target.type === 'todo' && app.selected.length > 1 && app.selected.includes(target.id)
    ? app.selected.map(findTodo).filter(Boolean) : null);
  const onAll = (n) => (group ? group.every((t) => (t.tags || []).includes(n)) : current.includes(n));
  const onSome = (n) => !!group && !onAll(n) && group.some((t) => (t.tags || []).includes(n));
  let options = $derived.by(() => {
    const q = query.trim();
    const ql = q.toLowerCase();
    const names = new Set(all.map((t) => t.name));
    for (const t of group ? group.flatMap((x) => x.tags || []) : current) names.add(t);
    let list = [...names].sort((a, b) => a.localeCompare(b));
    if (ql) list = list.filter((n) => n.toLowerCase().includes(ql));
    const opts = list.map((n) => ({ name: n, count: (all.find((t) => t.name === n) || {}).count, on: onAll(n), some: onSome(n) }));
    if (q && !names.has(q)) opts.unshift({ name: q, create: true });
    return opts;
  });

  async function toggle(o) {
    if (!target) return;
    const next = o.on ? current.filter((t) => t !== o.name) : [...current, o.name];
    if (o.create) query = '';
    try {
      if (group) await setTagSelected(o.name, !o.on);
      else if (target.type === 'project') await patchProject(target.id, { tags: next });
      else if (target.type === 'area') await patchArea(target.id, { tags: next });
      else await setTags(target.id, next);
    } catch (e) {
      toastError(e);
    }
  }
  function onkeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = Math.min(options.length - 1, sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = Math.max(0, sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (options[sel]) toggle(options[sel]); }
  }
  const split = (n) => { const i = n.lastIndexOf('/'); return i < 0 ? ['', n] : [n.slice(0, i + 1), n.slice(i + 1)]; };
</script>

<Popover rect={pop.rect} label={group ? `Tags for ${group.length} to-dos` : 'Tags'}>
  {#if !external}
  <div class="in">
    <Icon name="tagic" />
    <input bind:this={inputEl} bind:value={query} oninput={() => (sel = 0)} placeholder="Tag…" autocomplete="off" spellcheck="false" {onkeydown} aria-label="Tag name" />
  </div>
  {/if}
  <div class="list" role="listbox" aria-multiselectable="true">
    {#each options as o, i (o.name + (o.create ? '+' : ''))}
      <button class="opt" class:on={i === sel} onclick={() => toggle(o)} onmouseenter={() => (sel = i)} role="option" aria-selected={o.on} aria-checked={o.some ? 'mixed' : o.on}>
        <span class="ic" class:chk={o.on || o.some}>{#if o.on}<Icon name="check" />{:else if o.some}<span class="some"></span>{:else if o.create}<Icon name="plus" />{/if}</span>
        <span class="lbl">
          {#if o.create}Create “{o.name}”{:else}{#if split(o.name)[0]}<span class="parent">{split(o.name)[0]}</span>{/if}{split(o.name)[1]}{/if}
        </span>
        {#if o.count !== undefined && !o.create}<span class="r">{o.count}</span>{/if}
      </button>
    {/each}
    {#if !options.length}<div class="hint">No tags yet. Type to create one.</div>{/if}
  </div>
</Popover>

<style>
  .list { max-height: 300px; overflow: auto; }
  .ic { width: 14px; }
  .chk { color: #8FB4FF; }
  /* on some of the selection, not all */
  .some { display: inline-block; width: 9px; height: 2px; border-radius: 1px; background: currentColor; vertical-align: middle; }
  .parent { color: var(--popmuted); }
</style>
