<script>
  import { keyed } from '../lib/keyed.js';
  /** What you see while dragging, on both: the row itself lifted as a card,
   *  the place it left closed up, and the list parted where it would land
   *  (lib/gap.js). No insertion line — the room IS the line, and it shows how
   *  much room. Rendered once, at the top of the app. */
  import { drag, restingRows } from '../lib/dnd.svelte.js';
  import { partAt, closeGap } from '../lib/gap.js';
  import { touchLayout } from '../lib/touch.js';

  // The row itself, lifted, on both. What reads as lifted is the shadow and the
  // grey gap showing behind it — no scale and no tilt at a desk. A finger gets
  // a little scale, because a finger is covering the thing it moved.
  let card = $derived(drag.active && !!drag.rect);
  let touch = $derived(touchLayout());

  // The first room opens at once and full size, in the place the row has just
  // left: the row goes to nothing in the same frame, so the list does not move.
  // After that the room travels, closing behind and opening ahead.
  let opened = false;
  $effect(() => {
    if (!card) { opened = false; return; }
    // While the card is settling into the room, the room is exactly where it
    // was: neither re-opened somewhere else nor closed under the card. The
    // write lands first, then dnd's up() takes both away in one frame.
    if (drag.settling) return;
    const list = !drag.target && drag.index >= 0 ? drag.list : null;
    if (!list) return void closeGap();
    partAt(list, restingRows(list)[drag.index] || null, drag.span, !opened);
    opened = true;
  });
  // Dropped or abandoned: what the room was for has arrived, or never will.
  $effect(() => { if (!drag.active) closeGap(true); });
</script>

{#if drag.active && drag.todo}
  {#if card}
    <div class="drag-card" class:touch class:settling={drag.settling} aria-hidden="true"
         style="left:{touch ? drag.rect.left : drag.x - drag.grab.dx}px;width:{drag.rect.width}px;top:{drag.y - drag.grab.dy}px;min-height:{drag.rect.height}px">
      <!-- the row as it looked, which is the point of lifting it. However many
           travel, there is one card and it says nothing about how many: the
           room it left open is what says that. -->
      <div class="row">{@html drag.html}</div>
    </div>
    <!-- …and the rest of the selection arriving in it. -->
    {#each keyed(drag.gather) as [rowKey, g] (rowKey)}
      <div class="drag-card gathering" aria-hidden="true"
           style="left:{g.left}px;top:{g.top}px;width:{g.width}px;min-height:{g.height}px;--gx:{g.dx}px;--gy:{g.dy}px">
        <div class="row">{@html g.html}</div>
      </div>
    {/each}
  {/if}
  <div class="sr" role="status" aria-live="polite">
    {drag.target ? `Drop on ${drag.target.label}` : 'Dragging ' + (drag.todo.title || '')}
  </div>
{/if}

<style>
  .sr { position: fixed; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
