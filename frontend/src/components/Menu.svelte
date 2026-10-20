<script>
  /** Generic ••• menu and confirm dialog in the dark popover style. items: [{label, icon?, action?, danger?, on?, sep?}] */
  import { tick } from 'svelte';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';
  import { closePopover } from '../lib/store.svelte.js';
  let { pop } = $props();
  let items = $derived((pop.items || []).filter(Boolean));
  let sel = $state(-1);
  let el = $state(null);

  $effect(() => { if (el) tick().then(() => el.focus()); });

  function run(it) {
    closePopover();
    if (it.action) it.action();
  }
  function step(dir) {
    const idx = items.map((it, i) => (it.sep ? -1 : i)).filter((i) => i >= 0);
    if (!idx.length) return;
    const k = idx.indexOf(sel);
    const next = k < 0 ? (dir > 0 ? idx[0] : idx[idx.length - 1]) : idx[Math.max(0, Math.min(idx.length - 1, k + dir))];
    sel = next;
  }
  function onkeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (sel >= 0) run(items[sel]); }
  }
</script>

<Popover rect={pop.rect} label={pop.title || 'Menu'}>
  <div class="menu" bind:this={el} tabindex="-1" role="menu" {onkeydown}>
    {#if pop.title}<div class="ttl">{pop.title}</div>{/if}
    {#each items as it, i}
      {#if it.sep}
        <div class="sep"></div>
      {:else}
        <button class="opt" class:on={sel === i} class:danger={it.danger} role="menuitem" onclick={() => run(it)} onmouseenter={() => (sel = i)}>
          {#if it.icon}<span class="ic"><Icon name={it.icon} /></span>{/if}
          <span class="lbl">{it.label}</span>
          {#if it.on}<span class="r"><Icon name="check" /></span>{/if}
        </button>
      {/if}
    {/each}
  </div>
</Popover>

<style>
  .menu:focus { outline: none; }
</style>
