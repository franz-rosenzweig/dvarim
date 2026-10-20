<script>
  import { reportPageError } from './lib/report.js';
  import { onMount } from 'svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Topbar from './components/Topbar.svelte';
  import Offline from './components/Offline.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import SelectBar from './components/SelectBar.svelte';
  import InboxSheet from './components/InboxSheet.svelte';
  import CardBar from './components/CardBar.svelte';
  import Toast from './components/Toast.svelte';
  import QuickFind from './components/QuickFind.svelte';
  import Settings from './components/Settings.svelte';
  import Login from './components/Login.svelte';
  import Join from './components/Join.svelte';
  import DragLayer from './components/DragLayer.svelte';
  import SourceEditor from './components/SourceEditor.svelte';
  import ShareSheet from './components/ShareSheet.svelte';
  import WhenPopover from './components/WhenPopover.svelte';
  import RepeatEditor from './components/RepeatEditor.svelte';
  import MovePopover from './components/MovePopover.svelte';
  import TagPicker from './components/TagPicker.svelte';
  import Menu from './components/Menu.svelte';
  import InboxView from './views/InboxView.svelte';
  import TodayView from './views/TodayView.svelte';
  import UpcomingView from './views/UpcomingView.svelte';
  import AnytimeView from './views/AnytimeView.svelte';
  import SomedayView from './views/SomedayView.svelte';
  import LogbookView from './views/LogbookView.svelte';
  import TrashView from './views/TrashView.svelte';
  import ProjectView from './views/ProjectView.svelte';
  import AreaView from './views/AreaView.svelte';
  import Icon from './components/Icon.svelte';
  import { matchKey, isEditing } from './lib/keys.js';
  import { drawerDrag } from './lib/drawer.svelte.js';
  import { plusButton, plus } from './lib/plusbutton.svelte.js';
  import { pullFind } from './lib/pullfind.svelte.js';
  import { keepAboveKeyboard } from './lib/keyboard.js';
  import { installBackStack, sync as syncBackStack } from './lib/backstack.svelte.js';
  import { slimSwipe } from './lib/slim.svelte.js';
  import { touchLayout } from './lib/touch.js';
  import {
    app, init, goList, createTodo, createProject, createHeading, createTodayHeading, toggleComplete, cancelTodo, deleteTodo,
    duplicateTodo, convertTodo, moveToToday, moveToEvening, moveToAnytime, moveToSomeday, reorderSelected,
    openPopover, openQuickFind, currentTodoId, findTodo, undo, openSettings, completeSelected, cancelSelected, duplicateSelected, setWhenSelected, selectAllVisible, clearSelection, stopSelecting, today, selectRange, selectOnly, deleteSelected, logNow, toggleSlim } from './lib/store.svelte.js';

  // An invitation link, /join/<code>, opens the join form before anything
  // else, signed in or not (components/Join.svelte, docs/PEOPLE.md).
  const joinCode = typeof location === 'undefined' ? null
    : ((/^\/join\/([A-Za-z0-9_-]{8,64})\/?$/u.exec(location.pathname) || [])[1] || null);
  let joining = $state(!!joinCode);

  const LIST_VIEWS = { inbox: InboxView, today: TodayView, upcoming: UpcomingView, anytime: AnytimeView, someday: SomedayView, logbook: LogbookView, trash: TrashView };
  let View = $derived(app.view.kind === 'project' ? ProjectView : app.view.kind === 'area' ? AreaView : LIST_VIEWS[app.view.id] || TodayView);
  let viewKey = $derived(`${app.view.kind}:${app.view.id}`);

  onMount(() => {
    const stop = init();
    installBackStack();
    return stop;
  });
  // History follows the app on a phone, so that Back closes what is open and
  // then brings out the drawer: see lib/backstack.svelte.js. Reading these is
  // what subscribes the effect to them.
  $effect(() => {
    void [app.root, app.settingsOpen, app.source, app.popover, app.quickFind, app.selecting, app.expanded, app.inboxSheet];
    syncBackStack();
  });

  const GO = { 'go.inbox': 'inbox', 'go.today': 'today', 'go.upcoming': 'upcoming', 'go.anytime': 'anytime', 'go.someday': 'someday', 'go.logbook': 'logbook' };

  function anchorFor(id) {
    return document.querySelector(`.content [data-todo-id="${id}"] .when, .content [data-todo-id="${id}"] .whenic`)
      || document.querySelector(`.content [data-todo-id="${id}"]`);
  }
  /** Arrows move the anchor. With Shift they extend the selection instead, the
   *  way a file list does. */
  function moveSelection(dir, extend = false) {
    const els = Array.from(document.querySelectorAll('.content [data-todo-id]'));
    if (!els.length) return;
    const ids = els.map((el) => el.dataset.todoId);
    let i = ids.indexOf(app.selection);
    if (i < 0) i = dir > 0 ? -1 : ids.length;
    const j = Math.max(0, Math.min(ids.length - 1, i + dir));
    if (extend) selectRange(ids[j]);
    else selectOnly(ids[j]);
    if (app.expanded && app.expanded !== ids[j]) app.expanded = null;
    els[j].scrollIntoView({ block: 'nearest' });
  }
  function blurActive() {
    const el = document.activeElement;
    if (el && el !== document.body) el.blur();
  }

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    const action = matchKey(e);
    const editing = isEditing(document.activeElement);
    const mod = e.metaKey || e.ctrlKey;

    // Modal sheets handle their own keys, Escape included. Without this an
    // app shortcut pressed over Settings acted on the list behind it.
    if (app.settingsOpen || app.source) return;

    // Overlays own the keyboard while open; only a stray Escape is handled here.
    if (app.quickFind || app.popover) {
      if (action === 'escape') { app.popover = null; app.quickFind = null; }
      return;
    }
    if (action === 'escape') {
      e.preventDefault();
      if (app.root) app.root = false;          // the drawer is over everything
      else if (app.selecting) stopSelecting();
      else if (app.expanded) { app.expanded = null; blurActive(); }
      else if (editing) blurActive();
      // a group collapses to the anchor first, so Esc is not an accidental
      // "lose everything I just picked"
      else if (app.selected.length > 1) selectOnly(app.selection);
      else if (app.selection) clearSelection();
      return;
    }

    const id = currentTodoId();
    const many = () => app.selected.length > 1;
    const t = id ? findTodo(id) : null;
    const inProject = app.view.kind === 'project';

    // Modifier shortcuts work everywhere, including inside the editor.
    if (action in GO) { e.preventDefault(); goList(GO[action]); return; }
    switch (action) {
      case 'todo.new': e.preventDefault(); createTodo(); return;
      case 'project.new': e.preventDefault(); createProject(); return;
      case 'heading.new':
        e.preventDefault();
        if (inProject) createHeading(app.view.id);
        else if (app.view.kind === 'list' && app.view.id === 'today') createTodayHeading();
        return;
      case 'settings.open': e.preventDefault(); openSettings(); return;
      case 'find': e.preventDefault(); openQuickFind(); return;
      case 'sidebar.toggle': e.preventDefault(); toggleSlim(); return;
      case 'undo': if (!editing) { e.preventDefault(); undo(); } return;
      case 'todo.complete': if (t) { e.preventDefault(); many() ? completeSelected() : toggleComplete(id); } return;
      case 'todo.cancel': if (t) { e.preventDefault(); many() ? cancelSelected() : cancelTodo(id); } return;
      case 'todo.when':
        e.preventDefault();
        if (t) openPopover('when', { type: 'todo', id }, anchorFor(id));
        else if (inProject) openPopover('when', { type: 'project', id: app.view.id }, document.querySelector('h1.t .more'));
        return;
      case 'todo.deadline':
        e.preventDefault();
        if (t) openPopover('deadline', { type: 'todo', id }, anchorFor(id));
        else if (inProject) openPopover('deadline', { type: 'project', id: app.view.id }, document.querySelector('h1.t .more'));
        return;
      case 'todo.move':
        e.preventDefault();
        if (t) openPopover('move', { type: 'todo', id }, anchorFor(id));
        else if (inProject) openPopover('move', { type: 'project', id: app.view.id }, document.querySelector('h1.t .more'));
        return;
      case 'todo.tags':
        e.preventDefault();
        if (t) openPopover('tags', { type: 'todo', id }, anchorFor(id));
        else if (inProject) openPopover('tags', { type: 'project', id: app.view.id }, document.querySelector('h1.t .more'));
        return;
      case 'todo.today': if (t) { e.preventDefault(); many() ? setWhenSelected({ when: today(), evening: false, someday: false }, `${app.selected.length} moved to Today`) : moveToToday(id); } return;
      case 'todo.evening': if (t) { e.preventDefault(); many() ? setWhenSelected({ when: today(), evening: true, someday: false }, `${app.selected.length} moved to This Evening`) : moveToEvening(id); } return;
      case 'todo.anytime': if (t) { e.preventDefault(); many() ? setWhenSelected({ when: null, evening: false, someday: false }, `${app.selected.length} moved to Anytime`) : moveToAnytime(id); } return;
      case 'todo.someday': if (t) { e.preventDefault(); many() ? setWhenSelected({ when: null, evening: false, someday: true }, `${app.selected.length} moved to Someday`) : moveToSomeday(id); } return;
      case 'todo.checklist': if (t) { e.preventDefault(); app.expanded = id; app.selection = id; app.focusChecklist = true; } return;
      case 'todo.convert': if (t) { e.preventDefault(); convertTodo(id); } return;
      case 'log.now': e.preventDefault(); logNow(); return;
      case 'todo.repeat':
        e.preventDefault();
        if (t) openPopover('repeat', { type: 'todo', id }, anchorFor(id));
        else if (inProject) openPopover('repeat', { type: 'project', id: app.view.id }, document.querySelector('h1.t .more'));
        return;
      case 'todo.duplicate': if (t) { e.preventDefault(); many() ? duplicateSelected() : duplicateTodo(id); } return;
      case 'todo.moveUp': if (!editing && app.selection) { e.preventDefault(); reorderSelected(-1); } return;
      case 'todo.moveDown': if (!editing && app.selection) { e.preventDefault(); reorderSelected(1); } return;
    }
    // ⌘A selects everything on screen; Esc and the arrows collapse back to one
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyA' && !editing) {
      e.preventDefault();
      selectAllVisible();
      return;
    }
    if (editing) return;

    // Plain keys: only when nothing is focused.
    switch (action) {
      case 'todo.open':
      case 'todo.expand':
        if (app.selection) { e.preventDefault(); app.expanded = app.selection; }
        return;
      case 'sel.up': e.preventDefault(); moveSelection(-1, e.shiftKey); return;
      case 'sel.down': e.preventDefault(); moveSelection(1, e.shiftKey); return;
      case 'todo.trash': if (app.selection) { e.preventDefault(); app.selected.length > 1 ? deleteSelected() : deleteTodo(app.selection); } return;
    }
    // Just start typing: any printable character opens Quick Find pre-filled.
    if (!action && !mod && !e.altKey && e.key && e.key.length === 1 && /\S/.test(e.key)) {
      e.preventDefault();
      openQuickFind(e.key);
    }
  }

  /** The navigation drawer, on a phone. Off every other size. */
  function showNav(open) { app.root = open; }

  // Phone: once the list's own big title has gone up under the bar, the bar
  // takes over saying where you are (see .main.scrolled in app.css).
  let scrolled = $state(false);
  function onContentScroll(e) { scrolled = e.currentTarget.scrollTop > 52; }
  $effect(() => { void viewKey; scrolled = false; });

  // Phone: a card that closes leaves nothing behind. The row stays highlighted
  // for a fifth of a second and is then let go; a row left selected for the
  // rest of the session is a Mac idea, where the selection is what the
  // keyboard acts on.
  let wasOpen = null;
  $effect(() => {
    const now = app.expanded;
    const before = wasOpen;
    wasOpen = now;
    if (before && !now && touchLayout() && !app.selecting) {
      setTimeout(() => { if (!app.expanded && !app.selecting) clearSelection(); }, 220);
    }
  });

  // Phone: a tap anywhere outside an open to-do closes it — and
  // "outside" includes the margins and the bar, which are not inside the list,
  // so the list's own handler never heard about them.
  function onMainClick(e) {
    if (!app.expanded || !touchLayout()) return;
    // The same click that opened a to-do bubbles up here, so ignore anything
    // that meant something to what it landed on.
    if (e.target.closest('.card, .cardbar, .pop, .qf, .inboxsheet, [data-todo-id], button, a, input, textarea, [contenteditable]')) return;
    app.expanded = null;
  }

  function onContentClick(e) {
    // Clicking empty space collapses the editor and clears the selection.
    if (e.target.closest('[data-todo-id], button, a, input, textarea, [contenteditable], .hd, h1')) return;
    if (app.expanded) app.expanded = null;
    else app.selection = null;
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if joining}
  <Join code={joinCode} ondone={() => (joining = false)} />
{:else if app.authChecked && !app.authed}
  <Login />
{:else if app.shared}
  <ShareSheet shared={app.shared} />
{:else}
<div class="app" class:root={app.root} class:selecting={app.selecting} class:plusing={plus.active || plus.dropping} class:slim={app.slim} class:editing={!!app.expanded} use:slimSwipe>
  <!-- Phone only, and both invisible: a strip down the left edge that slides the
       navigation in — where the system lends the edge back, see
       android/shell/src/java/.../EdgeGestures.java — and the scrim over the page
       that puts it away. See lib/drawer.svelte.js. -->
  <div class="edge" use:drawerDrag={{ opening: true, eager: true, set: showNav, flick: () => history.back() }} aria-hidden="true"></div>
  <svelte:boundary onerror={(e) => reportPageError(e, 'the sidebar')}>
    <Sidebar />
    {#snippet failed(error, reset)}
      <nav class="sidebar broke" role="alert">
        <p>Dvarim couldn't show its lists.</p>
        <p class="why">{error && error.message ? error.message : String(error)}</p>
        <button onclick={reset}>Try again</button>
      </nav>
    {/snippet}
  </svelte:boundary>
  <div class="navscrim" use:drawerDrag={{ opening: false, eager: true, set: showNav }}
       onclick={() => showNav(false)} aria-hidden="true"></div>
  <section class="main" class:scrolled onclick={onMainClick} role="presentation">
    <Topbar />
    <Offline />
    <!-- Pulling the list down from its top opens Quick Find. See
         lib/pullfind.svelte.js. -->
    <span class="pullmark" aria-hidden="true"><Icon name="search" /></span>
    <div class="content" id="content" use:pullFind use:keepAboveKeyboard onclick={onContentClick} onscroll={onContentScroll} role="presentation">
      <div class="col">
        {#key viewKey}
          <!-- One list that cannot be drawn must not take the app with it: the
               rest stays, and this says what went wrong (lib/report.js). -->
          <svelte:boundary onerror={(e) => reportPageError(e, 'this list')}>
            <View />
            {#snippet failed(error, reset)}
              <div class="broke" role="alert">
                <p>Dvarim couldn't show this list.</p>
                <p class="why">{error && error.message ? error.message : String(error)}</p>
                <button onclick={reset}>Try again</button>
              </div>
            {/snippet}
          </svelte:boundary>
        {/key}
      </div>
    </div>
    <Toolbar />
    {#if app.selecting}<SelectBar />{/if}
    <!-- Phone: while a to-do is open, the plus gives way to what you can do with
         that to-do. -->
    {#if app.expanded && !app.selecting}<CardBar id={app.expanded} />{/if}
    <!-- The + button. On a phone the toolbar gives way to this: a thumb
         reaches a corner far more easily than a row of small targets, and the
         other three actions live on the to-do's own card anyway. -->
    <button class="fab" aria-label="New To-Do" use:plusButton onclick={() => createTodo()}><Icon name="plus" /></button>
    {#if plus.dropping}
      <div class="plusghost dropping" style="left:{plus.x}px;top:{plus.y}px"><Icon name="plus" /></div>
    {/if}
    {#if plus.active}
      <!-- The button, lifted. Its corner becomes the way to put it back, and
           the Inbox comes up opposite. See lib/plusbutton.svelte.js. -->
      <div class="plustarget inbox" class:on={plus.over === 'inbox'}><span class="lbl">Add to<br />Inbox</span><Icon name="tray" /></div>
      <div class="plustarget cancel" class:on={plus.over === 'cancel'}><Icon name="x" /></div>
      <div class="plusghost" class:snapped={plus.over === 'inbox' || plus.over === 'cancel'}
           style="left:{plus.x}px;top:{plus.y}px"><Icon name="plus" /></div>
    {/if}
    {#if app.inboxSheet}<InboxSheet onclose={() => (app.inboxSheet = false)} />{/if}
  </section>

  {#if app.settingsOpen}<Settings />{/if}
  {#if app.source}<SourceEditor path={app.source} />{/if}

  {#if app.quickFind}
    <QuickFind />
  {/if}
  {#if app.popover}
    {#if app.popover.kind === 'when' || app.popover.kind === 'deadline'}
      <WhenPopover pop={app.popover} />
    {:else if app.popover.kind === 'repeat'}
      <RepeatEditor pop={app.popover} />
    {:else if app.popover.kind === 'move'}
      <MovePopover pop={app.popover} />
    {:else if app.popover.kind === 'tags'}
      <TagPicker pop={app.popover} />
    {:else}
      <Menu pop={app.popover} />
    {/if}
  {/if}
  <Toast />
  <DragLayer />
</div>
{/if}
