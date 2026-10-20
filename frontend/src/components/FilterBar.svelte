<script>
  import { app } from '../lib/store.svelte.js';
  /** Tag filter pills. `tags` is the set of tags present in the list. */
  let { tags = [] } = $props();
  let list = $derived(Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b)));
  // When the active tag no longer occurs in the list (last item completed), fall back to All.
  $effect(() => {
    if (app.filterTag && !list.includes(app.filterTag)) app.filterTag = null;
  });
</script>

{#if list.length}
  <div class="filters" role="group" aria-label="Filter by tag">
    <button class:on={!app.filterTag} onclick={() => (app.filterTag = null)} aria-pressed={!app.filterTag}>All</button>
    {#each list as t (t)}
      <button class:on={app.filterTag === t} onclick={() => (app.filterTag = app.filterTag === t ? null : t)} aria-pressed={app.filterTag === t}>{t}</button>
    {/each}
  </div>
{/if}
