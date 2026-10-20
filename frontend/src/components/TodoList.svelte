<script>
  import { keyed } from '../lib/keyed.js';
  /** A `.rows` block: collapsed rows, with the expanded one swapped for its card.
   *
   *  A list that can be dropped into says what it is, because several on one
   *  screen share a `context` — every day in Upcoming, and Today's day, its
   *  grouped sections and This Evening. `when` is the day it shows and `evening`
   *  whether it is This Evening, so that something dropped here can be made to
   *  belong here (lib/plusbutton.svelte.js, lib/dnd.svelte.js). And it is there
   *  even when it is empty, or nothing could ever be dropped into an empty
   *  heading, an empty day or an empty Inbox. `todayHeading` is which of
   *  Today's own headings the list is ('' the run above them), so a to-do
   *  dropped here is filed under it as well. */
  import TodoItem from './TodoItem.svelte';
  let { items = [], sub = false, dlFlag = false, hideDl = false, hideWhen = false, showStar = false, trash = false, style = '', context = '', when = '', evening = null, todayHeading = null } = $props();
</script>

{#if items.length || context}
  <div class="rows" style={items.length ? style : ''} role="listbox" aria-label="To-dos" data-drop-context={context}
       data-list-when={when || undefined} data-list-evening={evening === null ? undefined : String(evening)}
       data-list-today-heading={todayHeading === null ? undefined : todayHeading}>
    {#each keyed(items) as [rowKey, t] (rowKey)}
      <TodoItem todo={t} {sub} {dlFlag} {hideDl} {hideWhen} {showStar} {trash} />
    {/each}
  </div>
{/if}
