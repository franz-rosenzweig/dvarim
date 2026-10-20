<script>
  import Icon from './Icon.svelte';
  import { app, goBack, viewTitle, openQuickFind, stopSelecting } from '../lib/store.svelte.js';
  let title = $derived(viewTitle());
  let offline = $derived(!app.connected);
</script>

<div class="topbar">
  <button class="back" onclick={goBack} aria-label="Back to lists"><Icon name="chev" /><span class="lbl">Lists</span></button>
  <span class="wtitle" aria-live="polite"><span class="name">{title} <span class="chev" aria-hidden="true">⌃</span></span>{#if offline}<span class="off" title="Reconnecting…">·</span>{/if}</span>
  <button class="newwin" title="Open in a new window" aria-label="Open in a new window" onclick={() => window.open(location.href, '_blank', 'noopener')}><Icon name="newwin" /></button>
  <!-- Phone only: Quick Find lives here, and the phone bar needs no title —
       the list says its own name underneath, in full size. -->
  {#if app.selecting}
    <button class="done" onclick={stopSelecting}>Done</button>
  {:else}
    <button class="qfind" aria-label="Quick Find" onclick={() => openQuickFind()}><Icon name="qfind" /></button>
  {/if}
</div>

<style>
  .off { color: var(--dead); font-size: 18px; line-height: 0; margin-left: 4px; }
</style>
