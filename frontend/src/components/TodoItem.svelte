<script>
  /**
   * One line of a list: the to-do's row, or its card when it is open.
   *
   * The swap is what this is for. One is not replaced with the other in a
   * single frame — the card grows out of the row and pushes what is below it
   * down, and folds back into the row on the way out. So this wrapper measures
   * itself either side of the swap and animates its own height across, which is
   * the only thing the rows below need in order to travel with it.
   *
   * Height, not a transform, because everything under it must actually move;
   * and on the wrapper rather than the card, so the card can keep its own
   * entrance (a to-do made with the + button grows out of it).
   */
  import TodoRow from './TodoRow.svelte';
  import TodoCard from './TodoCard.svelte';
  import { app } from '../lib/store.svelte.js';
  import { touchLayout } from '../lib/touch.js';

  let { todo, ...rest } = $props();
  let open = $derived(app.expanded === todo.id);

  let el = $state(null);
  let was = 0;              // the height before the swap
  let last = null;          // what `open` was when we measured
  let landed = $state(false);   // just shrunk back: still a card for a moment

  // Before the DOM changes, take the height it is changing from.
  $effect.pre(() => {
    void open;
    if (el) was = el.offsetHeight;
  });

  $effect(() => {
    const now = open;
    if (!el || last === null) { last = now; return; }
    if (last === now) return;
    last = now;
    // The card is not swapped for a row in one frame: it shrinks to one row
    // with its shadow still on, and the shadow goes a moment later. The height
    // is animated below; this is the paper it lands as.
    if (!now && touchLayout()) {
      landed = true;
      setTimeout(() => (landed = false), 520);
    }
    const to = el.offsetHeight;
    if (!was || was === to || typeof el.animate !== 'function') return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.style.overflow = 'hidden';
    const a = el.animate(
      [{ height: `${was}px` }, { height: `${to}px` }],
      { duration: now ? 430 : 420, easing: now ? 'cubic-bezier(.2,.8,.2,1)' : 'ease-in-out' }
    );
    a.finished.catch(() => {}).finally(() => { if (el) el.style.overflow = ''; });
  });
</script>

<div class="titem" class:landed bind:this={el}>
  {#if open}
    <TodoCard {todo} />
  {:else}
    <TodoRow {todo} {...rest} />
  {/if}
</div>
