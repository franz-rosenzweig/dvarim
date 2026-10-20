<script>
  /**
   * The bar that floats at the bottom of a phone while a to-do is open, where
   * the blue plus was: Move, Delete, and a ••• for the rest. A card that fills
   * the screen has nowhere to put these, and a thumb should not have to reach
   * into the card for them.
   */
  import Icon from './Icon.svelte';
  import { openPopover, openMenu, deleteTodo, duplicateTodo, convertTodo, cancelTodo, findTodo, app } from '../lib/store.svelte.js';

  let { id } = $props();
  const target = () => ({ type: 'todo', id });

  function more(e) {
    const el = e.currentTarget;
    openMenu(el, [
      { label: 'Duplicate', action: () => duplicateTodo(id) },
      { label: 'Convert to Project', icon: 'proj', action: () => convertTodo(id) },
      { label: 'Repeat…', icon: 'repeat', action: () => openPopover('repeat', target(), el) },
      { label: 'Deadline…', icon: 'flag', action: () => openPopover('deadline', target(), el) },
      { label: 'Tags…', icon: 'tagic', action: () => openPopover('tags', target(), el) },
      // the one way to cancel a to-do under a thumb: a desk has ⌥⌘K and a right-click
      findTodo(id)?.status === 'open' && { label: 'Mark as Canceled', icon: 'x', action: () => cancelTodo(id) }
    ]);
  }
</script>

<div class="cardbar" role="toolbar" aria-label="This to-do">
  <button class="move" onclick={(e) => openPopover('move', target(), e.currentTarget)}>
    <Icon name="arrow" /> Move
  </button>
  <button aria-label="Delete" onclick={() => { app.expanded = null; deleteTodo(id); }}><Icon name="trash" /></button>
  <button aria-label="More" onclick={more}><Icon name="dots" /></button>
</div>
