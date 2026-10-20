<script>
  /**
   * The dark bar shown once you are choosing several to-dos: When, Move,
   * Delete — and Tags, which a phone would otherwise have no way to do. Each
   * opens the popover the keyboard already opens, and those apply to the whole
   * selection on their own — see WhenPopover, MovePopover and TagPicker, which
   * check app.selected before acting.
   */
  import Icon from './Icon.svelte';
  import { app, openPopover, deleteSelected, stopSelecting } from '../lib/store.svelte.js';

  let n = $derived(app.selected.length);
  /** The popovers anchor to something; the bar itself will do. */
  const anchor = () => document.querySelector('.selbar');
  const target = () => ({ type: 'todo', id: app.selection });

  async function remove() {
    await deleteSelected();
    stopSelecting();
  }
</script>

<div class="selbar" role="toolbar" aria-label="Selected to-dos">
  <button disabled={!n} onclick={() => openPopover('when', target(), anchor())}>
    <Icon name="cal" /> When
  </button>
  <button disabled={!n} onclick={() => openPopover('move', target(), anchor())}>
    <Icon name="arrow" /> Move
  </button>
  <button disabled={!n} onclick={() => openPopover('tags', target(), anchor())}>
    <Icon name="tagic" /> Tags
  </button>
  <button disabled={!n} onclick={remove}>
    <Icon name="trash" /> Delete
  </button>
</div>

<style>
  button:disabled { opacity: .4; }
</style>
