<script>
  import { keyed } from '../lib/keyed.js';
  import * as api from '../lib/api.js';
  import ListTitle from '../components/ListTitle.svelte';
  import TodoList from '../components/TodoList.svelte';
  import ProjectRow from '../components/ProjectRow.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { app, today, loadMoreLogbook, logNow } from '../lib/store.svelte.js';
  import { pastLabel, shortDate } from '../lib/dates.js';
  let data = $derived(app.data);
  // How many completions are still sitting in their lists, unfiled.
  let pending = $state(0);
  $effect(() => {
    void app.data;                       // recheck whenever anything changes
    api.logbookPending().then((r) => (pending = r.pending)).catch(() => (pending = 0));
  });
  async function fileThem() {
    await logNow();
    pending = 0;
  }
  let groups = $derived(((data && data.groups) || []).filter((g) => (g.items && g.items.length) || (g.projects && g.projects.length)));
  let T = $derived(today());
</script>

{#if data}
  <ListTitle icon="logbook" name="Logbook" />
  {#if pending > 0}
    <div class="pendrow">
      <span>{pending} completed {pending === 1 ? 'item is' : 'items are'} still in {pending === 1 ? 'its' : 'their'} list.</span>
      <button onclick={fileThem}>Log Now</button>
    </div>
  {/if}
  {#each groups as g (g.date ?? 'undated')}
    <div class="hd gray">
      {#if g.date}
        <span class="lab">{pastLabel(g.date, T)}<span class="d">{shortDate(g.date, T)}</span></span>
      {:else}
        <!-- ticked by hand in Obsidian before the app ever saw them: the date is
             genuinely unknown, and inventing one would be worse than saying so -->
        <span class="lab">Completed<span class="d">date unknown</span></span>
      {/if}
    </div>
    {#if g.projects && g.projects.length}
      <div class="rows">{#each keyed(g.projects) as [rowKey, p] (rowKey)}<ProjectRow project={p} sub />{/each}</div>
    {/if}
    <TodoList items={g.items || []} sub context="logbook" />
  {/each}
  {#if !groups.length}
    <EmptyState kind="logbook" />
  {:else if !app.logbookExhausted}
    <button class="showdone" onclick={loadMoreLogbook}>Show earlier</button>
  {/if}
{/if}

<style>
  .lab { display: flex; gap: 8px; align-items: baseline; }
  .d { color: var(--text3); font-weight: 400; }
  .pendrow {
    display: flex; align-items: center; gap: 12px;
    margin: 10px 0 4px; padding: 8px 10px;
    background: var(--hover); border-radius: 8px;
    font-size: 12.5px; color: var(--text2);
  }
  .pendrow button {
    margin-left: auto; font: inherit; font-size: 12.5px; font-weight: 500;
    color: #fff; background: var(--accent); border: 0; border-radius: 6px;
    padding: 4px 12px; cursor: pointer;
  }
</style>
