<script>
  /**
   * One collapsed to-do row (mockup `.row`). Options mirror the mockup's row(t, opts):
   *  sub        show the project/area name under the title (mixed lists)
   *  dlFlag     right-aligned deadline flag "today"/"3 days" (Today view)
   *  hideDl     hide the deadline date pill
   *  showStar   star/moon when the to-do is in Today (project, area, anytime views)
   *  trash      row lives in Trash: offers Restore instead of flags
   */
  import Icon from './Icon.svelte';
  import { app, today, toggleComplete, restoreTodo, isSelected, selectOnly, toggleSelected, selectRange, openPopover } from '../lib/store.svelte.js';
  import { draggable, drag } from '../lib/dnd.svelte.js';
  import { rowMenu } from '../lib/rowmenu.js';
  import { swipeRow } from '../lib/swipe.svelte.js';
  import { pickDrag } from '../lib/pickdrag.svelte.js';
  import { shortDate, relDeadline } from '../lib/dates.js';
  import { inlineMarkdown } from '../lib/inline-md.js';
  import { openExternal } from '../lib/shell.js';

  let { todo, sub = false, dlFlag = false, hideDl = false, hideWhen = false, showStar = false, trash = false } = $props();

  let fading = $derived(app.completing[todo.id]);
  let done = $derived(todo.status === 'done' || fading === 'done');
  let canceled = $derived(todo.status === 'canceled' || fading === 'canceled');
  let open = $derived(!done && !canceled);
  let selected = $derived(isSelected(todo.id) || app.selection === todo.id);
  let anchor = $derived(app.selection === todo.id);
  let inToday = $derived(open && !todo.someday && !!todo.when && todo.when <= today());
  // Meant for a day still to come. Not worth saying where the list is already
  // grouped by day (Upcoming), which is what hideWhen is for.
  let later = $derived(!hideWhen && open && !todo.someday && !!todo.when && todo.when > today());
  let dl = $derived(todo.deadline && dlFlag && open ? relDeadline(todo.deadline, today()) : null);
  let subText = $derived(sub ? (todo.projectName || (!todo.projectId && !todo.inbox ? todo.areaName : '')) || '' : '');
  // Phone layout or touch: a single tap opens the to-do.
  const tapOpens = () => typeof matchMedia !== 'undefined' && (matchMedia('(max-width: 720px)').matches || matchMedia('(pointer: coarse)').matches);

  // Select on mouse-down, in one frame. That collides with "a click on
  // the row that was already selected opens it": after selecting on the way
  // down, every click would satisfy it. So the press records what the selection
  // was before it, and the click that follows reads that instead.
  let armed = null;
  function onpointerdown(e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (trash || app.selecting || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest('.cb, .restore, .whenbtn, button, a, input, textarea, [contenteditable]')) return;
    armed = { wasSelected: app.selection === todo.id && app.selected.length <= 1 };
    // A row inside a larger selection keeps it: that is what a group drag carries.
    if (!app.selected.includes(todo.id)) selectOnly(todo.id);
  }

  function onclick(e) {
    const press = armed;
    armed = null;
    // a link in the title is a link, as it is in Obsidian
    const link = e.target.closest('a.tlink');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !app.selecting) {
      e.preventDefault();
      openExternal(link.getAttribute('href'));
      return;
    }
    if (e.target.closest('.cb, .restore, .whenbtn')) return;
    if (trash) return;
    // Choosing several: a tap adds or removes.
    if (app.selecting) { toggleSelected(todo.id); return; }
    // ⌘-click adds or removes one; Shift-click takes everything in between.
    if (e.metaKey || e.ctrlKey) { app.expanded = null; toggleSelected(todo.id); return; }
    if (e.shiftKey) { app.expanded = null; selectRange(todo.id); return; }
    if (tapOpens() || (press ? press.wasSelected : app.selection === todo.id && app.selected.length <= 1)) {
      // A tap outside an open to-do only closes it; it does not open what was
      // tapped. (On a phone the dimmed rows take no taps at all — see
      // `.app.editing` in app.css — but a tablet's coarse pointer gets here.)
      if (app.expanded && app.expanded !== todo.id) { app.expanded = null; return; }
      selectOnly(todo.id);
      app.expanded = todo.id;
    } else {
      selectOnly(todo.id);
      if (app.expanded) app.expanded = null;
    }
  }
  function ondblclick(e) {
    if (e.target.closest('.cb, .whenbtn') || trash) return;
    selectOnly(todo.id);
    app.expanded = todo.id;
  }
  function onkeydown(e) {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      selectOnly(todo.id);
      app.expanded = todo.id;
    }
  }
</script>

<div
  class="row"
  class:ghosted={drag.active && drag.todo?.id === todo.id}
  class:done
  class:canceled
  class:fade={!!fading}
  class:sel={selected}
  class:anchor={anchor && app.selected.length > 1}
  class:placing={app.placing === todo.id}
  class:whenopen={app.popover?.kind === 'when' && app.popover?.swiped && app.popover?.target?.id === todo.id}
  data-todo-id={todo.id}
  use:draggable={todo}
  use:swipeRow={todo}
  data-drag-handle
  role="option"
  aria-selected={selected}
  tabindex="-1"
  {onpointerdown}
  {onclick}
  {ondblclick}
  {onkeydown}
  oncontextmenu={(e) => { if (!trash) rowMenu(e, todo); }}
>
  <!-- What a swipe uncovers: the When popover's tab on the left, the choosing
       tab on the right. Both hang off the row's ends and stay hidden until a
       finger moves. See lib/swipe.svelte.js. -->
  <span class="swipeic whentab" aria-hidden="true"><Icon name="cal" /></span>
  <span class="swipeic pickhint" aria-hidden="true"><Icon name="multi" /></span>
  <!-- At a desk there is a calendar in the gutter: hover a row and one click
       sets its day, without opening it. A thumb has the swipe instead. -->
  {#if !trash}
    <button class="whenbtn" aria-label="When…" tabindex="-1"
            onclick={(e) => { e.stopPropagation(); openPopover('when', { type: 'todo', id: todo.id }, e.currentTarget); }}>
      <Icon name="cal" />
    </button>
  {/if}
  <button class="cb" aria-label={open ? 'Complete' : 'Reopen'} onclick={() => toggleComplete(todo.id)} tabindex="-1">
    <Icon name={canceled ? 'x' : 'check'} />
  </button>
  <div class="body">
    <div class="title">
      {#if showStar && inToday}
        {#if todo.evening}<span class="moonic"><Icon name="moon" /></span>{:else}<span class="star"><Icon name="starS" /></span>{/if}
      {/if}
      {#if later}
        <!-- The day it is meant for, in front of the title, in the same grey
             pill a deadline uses. -->
        <span class="dl when">{shortDate(todo.when, today())}</span>
      {/if}
      {#if todo.deadline && !hideDl && open}
        <span class="dl">{shortDate(todo.deadline, today())}</span>
      {/if}
      <span class="txt">{#if todo.title}{@html inlineMarkdown(todo.title)}{:else}New To-Do{/if}</span>
      {#if todo.notes || (todo.checklist && todo.checklist.length) || (todo.tags && todo.tags.length)}
        <span class="inds">
          {#if todo.notes}<Icon name="notes" title="Has notes" />{/if}
          {#if todo.checklist && todo.checklist.length}<Icon name="clist" title="Has a checklist" />{/if}
          {#if todo.tags && todo.tags.length}<Icon name="tagic" class="tagic" title={todo.tags.join(', ')} />{/if}
        </span>
      {/if}
      <!-- A real divergence, not a size: at a desk a row names a tag, on a
           phone it only marks that there is one. Both are here and app.css
           picks. -->
      {#if todo.tags}
        {#each todo.tags as tag}<span class="tag">{tag}</span>{/each}
      {/if}
      {#if trash}
        <button class="restore" onclick={() => restoreTodo(todo.id)}>Restore</button>
      {:else if dl}
        <span class="flag" class:red={dl.red}><Icon name="flag" /><span class="ftxt">{dl.text}</span></span>
      {:else if todo.repeat && open}
        <span class="flag rep" title={todo.repeat}><Icon name="repeat" /></span>
      {:else if todo.reminder && open}
        <span class="flag rep" title={`Reminder ${todo.reminder}`}><Icon name="bell" /></span>
      {/if}
    </div>
    {#if subText}<div class="sub">{subText}</div>{/if}
  </div>
  {#if app.selecting && !trash}
    <button class="pick" class:on={isSelected(todo.id)} use:pickDrag={todo.id}
            aria-label={isSelected(todo.id) ? 'Deselect' : 'Select'}></button>
  {/if}
</div>
