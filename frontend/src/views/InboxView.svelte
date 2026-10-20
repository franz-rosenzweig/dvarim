<script>
  import ListTitle from '../components/ListTitle.svelte';
  import TodoList from '../components/TodoList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { app } from '../lib/store.svelte.js';
  let data = $derived(app.data);
  let items = $derived((data && data.items) || []);
</script>

{#if data}
  <ListTitle icon="inbox" name="Inbox" />
  <TodoList {items} style="margin-top:12px" context="inbox" />
  {#if !items.length}<EmptyState kind="inbox" />{/if}
{/if}
