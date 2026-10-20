<script>
  import { touchLayout } from '../lib/touch.js';
  /**
   * When popover, also used for Deadline (pop.kind === 'deadline').
   * Natural-language input → POST /api/parse-date (150 ms debounce); static options;
   * month calendar; Add Reminder row. Applies via PATCH on the to-do or project.
   */
  import { tick } from 'svelte';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';
  import * as api from '../lib/api.js';
  import { app, today, weekStartsOn, findTodo, setWhen, setDeadline, patchProject, closePopover, setWhenSelected, setDeadlineSelected } from '../lib/store.svelte.js';
  import { addDays, parseISO, toISO, weekdayShort, labelDate, nextWeekStart, monthGrid, MONTHS, DAYS, whenLabel } from '../lib/dates.js';

  let { pop } = $props();
  let mode = $derived(pop.kind === 'deadline' ? 'deadline' : 'when');
  let target = $derived(pop.target);
  let obj = $derived.by(() => {
    if (!target) return null;
    if (target.type === 'todo') return findTodo(target.id);
    if (target.type === 'project') return app.data && app.data.project && app.data.project.id === target.id ? app.data.project : null;
    return null;
  });
  let T = $derived(today());
  let query = $state('');
  // Opened from a card's own field (components/TodoCard.svelte): that field is
  // the input, so we do not draw one — we take what it types and lend it the
  // Up/Down/Enter this panel already knows how to answer.
  let external = $derived(!!pop.external);
  $effect(() => { if (external) query = pop.q || ''; });
  $effect(() => {
    if (!external) return;
    pop.onkey = onkeydown;
    return () => { if (pop.onkey === onkeydown) pop.onkey = null; };
  });
  let suggestions = $state([]);
  let sel = $state(-1); // nothing highlighted until the user types or presses ↓ (as in the mockup)
  let inputEl = $state(null);
  let showReminder = $state(false);
  let reminder = $state('09:00');
  let cal = $state({ y: 0, m: 0 });
  // The phone panel is a different panel, and everything that draws it lives
  // under the same 720px breakpoint in app.css — so ask the same question the
  // stylesheet asks, not "is this a touchscreen".
  const narrow = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 720px)').matches;
  let phone = $state(narrow());
  $effect(() => {
    const on = () => (phone = narrow());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  });
  /** Four weeks from the one today is in, and more at a tap. */
  let weeks = $state(0);
  let chosen = $state(null);     // the row being pressed, held a moment before it goes

  $effect(() => {
    const d = parseISO(T);
    cal = { y: d.getFullYear(), m: d.getMonth() };
    if (obj && obj.reminder) reminder = obj.reminder;
  });
  // Not under a thumb: focusing the field raises the keyboard over the calendar,
  // which is what was being reached for. It is still there to tap.
  $effect(() => { if (inputEl && !touchLayout() && !external) tick().then(() => inputEl.focus()); });

  // parse-date suggestions
  $effect(() => {
    const q = query.trim();
    if (!q) { suggestions = []; sel = -1; return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.parseDate(q);
        if (query.trim() === q) { suggestions = Array.isArray(r) ? r : []; sel = 0; }
      } catch {
        suggestions = [];
      }
    }, 150);
    return () => clearTimeout(t);
  });

  const rt = (d) => `${weekdayShort(d)} ${parseISO(d).getDate()}`;
  let statics = $derived.by(() => {
    const tm = addDays(T, 1);
    const nw = nextWeekStart(T, weekStartsOn());
    if (mode === 'deadline') {
      return [
        { label: 'Today', right: weekdayShort(T), icon: 'flag', color: 'var(--dead)', fields: { deadline: T } },
        { label: 'Tomorrow', right: rt(tm), icon: 'cal', color: 'var(--upc)', fields: { deadline: tm } },
        { label: 'Next week', right: rt(nw), icon: 'cal', color: 'var(--upc)', fields: { deadline: nw } },
        ...(obj && obj.deadline ? [{ label: 'Remove Deadline', icon: 'x', muted: true, fields: { deadline: null } }] : [])
      ];
    }
    return [
      { label: 'Today', right: weekdayShort(T), icon: 'sunS', color: 'var(--star)', fields: { when: T, evening: false, someday: false } },
      { label: 'This Evening', right: '', icon: 'moon', color: 'var(--moon)', fields: { when: T, evening: true, someday: false } },
      // Under a thumb the calendar is right there and a tap on a day is as quick
      // as a tap on a row, so these two are left out of the phone's panel.
      ...(phone ? [] : [
        { label: 'Tomorrow', right: rt(tm), icon: 'cal', color: 'var(--upc)', fields: { when: tm, evening: false, someday: false } },
        { label: 'Next week', right: rt(nw), icon: 'cal', color: 'var(--upc)', fields: { when: nw, evening: false, someday: false } }
      ]),
      { label: 'Someday', right: '', icon: 'zz', color: 'var(--some)', fields: { when: null, evening: false, someday: true } },
      ...(obj && (obj.when || obj.someday) ? [{ label: 'Clear', right: 'Anytime', icon: 'x', muted: true, fields: { when: null, evening: false, someday: false } }] : [])
    ];
  });
  let options = $derived.by(() => {
    if (!query.trim()) return statics;
    return suggestions
      .map((s) => {
        let icon = 'cal', color = 'var(--upc)';
        if (mode === 'deadline') { icon = 'flag'; color = 'var(--dead)'; }
        else if (s.someday) { icon = 'zz'; color = 'var(--some)'; }
        else if (s.evening) { icon = 'moon'; color = 'var(--moon)'; }
        else if (s.when === T) { icon = 'sunS'; color = 'var(--star)'; }
        const fields = mode === 'deadline'
          ? { deadline: s.when || null }
          : { when: s.when ?? null, evening: !!s.evening, someday: !!s.someday, ...(s.reminder ? { reminder: s.reminder } : {}) };
        const right = s.hint || (s.when ? labelDate(s.when) + (s.reminder ? ` · ${s.reminder}` : '') : '');
        const label = s.label || (s.someday ? 'Someday' : s.when ? whenLabel(s.when, T) : 'Anytime');
        return { label, right, icon, color, fields };
      })
      .filter((o) => mode !== 'deadline' || o.fields.deadline);
  });

  /** Four weeks from the start of the week today is in, and four more each time
   *  the chevron is tapped: a phone wants the next few weeks, not a month it has
   *  to page back and forth through. */
  let rolling = $derived.by(() => {
    const start = weekStartsOn();
    const d = parseISO(T);
    const back = (d.getDay() - start + 7) % 7;
    const from = addDays(T, -back + weeks * 28);
    return Array.from({ length: 28 }, (_, i) => {
      const iso = addDays(from, i);
      const day = parseISO(iso);
      return { iso, n: day.getDate(), first: day.getDate() === 1 };
    });
  });
  let rollingLabel = $derived.by(() => {
    if (!rolling.length) return '';
    const a = parseISO(rolling[0].iso), b = parseISO(rolling[27].iso);
    const one = MONTHS[a.getMonth()] + (a.getFullYear() === parseISO(T).getFullYear() ? '' : ' ' + a.getFullYear());
    return a.getMonth() === b.getMonth() ? one : `${one} – ${MONTHS[b.getMonth()]}`;
  });

  function labelFor(f) {
    if (mode === 'deadline') return f.deadline ? `Deadline ${labelDate(f.deadline)}` : 'Deadline removed';
    if (f.someday) return 'Moved to Someday';
    if (f.when === T) return f.evening ? 'Moved to This Evening' : 'Moved to Today';
    if (f.when) return `Scheduled for ${whenLabel(f.when, T)}`;
    return 'Moved to Anytime';
  }
  /** The row it was told to use is held for a moment, with a tick, and only
   *  then is the panel taken away: a tap that vanishes in the same frame leaves
   *  you unsure what you hit. */
  function choose(i, fields) {
    if (chosen !== null) return;
    if (!phone) return apply(fields);
    chosen = i;
    const pop = document.querySelector('.pop');
    setTimeout(() => {
      if (pop) pop.classList.add('closing');
      setTimeout(() => apply(fields), 100);
    }, 160);
  }

  async function apply(fields) {
    // Read everything off the popover BEFORE closing it. closePopover() unmounts
    // this component, after which `target` and `mode` (both $derived off the
    // `pop` prop) are gone and the call would silently do nothing.
    const tgt = target;
    const isDeadline = mode === 'deadline';
    const label = labelFor(fields);
    const group = tgt && tgt.type === 'todo' && app.selected.length > 1 && app.selected.includes(tgt.id);
    const n = app.selected.length;
    closePopover();
    if (!tgt) return;
    if (tgt.type === 'project') return patchProject(tgt.id, fields);
    if (isDeadline) {
      return group ? setDeadlineSelected(fields.deadline ?? null) : setDeadline(tgt.id, fields.deadline ?? null);
    }
    return group ? setWhenSelected(fields, `${n} ${label.replace(/^\w/, (c) => c.toLowerCase())}`) : setWhen(tgt.id, fields, label);
  }
  function pickDay(d) {
    const iso = typeof d === 'string' ? d : toISO(new Date(cal.y, cal.m, d));
    if (mode === 'deadline') apply({ deadline: iso });
    else apply({ when: iso, evening: false, someday: false });
  }
  function applyReminder() {
    const tgt = target;
    const o = obj;
    if (!reminder || !tgt) return;
    const f = { reminder };
    if (!o || !o.when || o.someday) { f.when = T; f.someday = false; }
    const at = reminder;
    closePopover();
    if (tgt.type === 'project') return patchProject(tgt.id, f);
    return setWhen(tgt.id, f, `Reminder at ${at}`);
  }
  function removeReminder() {
    apply({ reminder: null });
  }
  function onkeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = Math.min(options.length - 1, sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = Math.max(0, sel - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const o = options[sel];
      if (o) apply(o.fields);
    }
  }
  const moveMonth = (n) => { const d = new Date(cal.y, cal.m + n, 1); cal = { y: d.getFullYear(), m: d.getMonth() }; };
  let picked = $derived(obj ? (mode === 'deadline' ? obj.deadline : obj.when) : null);
  let wk = $derived(weekStartsOn());
  let dayHeads = $derived(Array.from({ length: 7 }, (_, i) => DAYS[(wk + i) % 7][0]));
  let grid = $derived(monthGrid(cal.y, cal.m, wk));
  const isoOf = (d) => toISO(new Date(cal.y, cal.m, d));
</script>

<Popover rect={pop.rect} label={mode === 'deadline' ? 'Deadline' : 'When'}>
  {#if !phone && !external}
  <div class="in">
    <Icon name="search" />
    <input bind:this={inputEl} bind:value={query} placeholder={mode === 'deadline' ? 'Deadline' : 'When'} autocomplete="off" spellcheck="false" {onkeydown} aria-label={mode === 'deadline' ? 'Deadline' : 'When'} />
    {#if query}<button class="clr" aria-label="Clear" onclick={() => { query = ''; inputEl.focus(); }}><Icon name="x" /></button>{/if}
  </div>
  {/if}
  {#each options as o, i}
    <button class="opt" class:on={i === sel} class:muted={o.muted} class:pressed={chosen === i}
            onclick={() => choose(i, o.fields)} onmouseenter={() => (sel = i)} onmouseleave={() => { if (!query.trim()) sel = -1; }}>
      <span class="ic" style:color={o.color}><Icon name={o.icon} /></span>
      <span class="lbl">{o.label}</span>
      {#if chosen === i}<span class="tick"><Icon name="check" /></span>{:else if o.right}<span class="r">{o.right}</span>{/if}
    </button>
  {/each}
  {#if query.trim() && !options.length}
    <div class="hint">{suggestions.length ? 'No date in that' : 'Keep typing…'}</div>
  {/if}
  {#if !query.trim()}
    <div class="sep"></div>
    {#if phone}
      <!-- The weeks ahead, rolling from this one, with more at a tap: a phone
           wants the next few weeks rather than a month to page through. -->
      <div class="calhead">
        <button onclick={() => (weeks = Math.max(0, weeks - 1))} disabled={weeks === 0} aria-label="Earlier weeks"><Icon name="chev" /></button>
        <span>{rollingLabel}</span>
        <button onclick={() => (weeks += 1)} aria-label="Later weeks"><Icon name="chevR" /></button>
      </div>
      <div class="cal roll" role="grid" aria-label="Calendar">
        {#each dayHeads as h}<b aria-hidden="true">{h}</b>{/each}
        {#each rolling as c (c.iso)}
          <button class="d" class:today={c.iso === T} class:dim={c.iso < T} class:pick={picked === c.iso}
                  onclick={() => pickDay(c.iso)} aria-label={labelDate(c.iso)}>
            {#if c.iso === T}<span class="star"><Icon name="sunS" /></span>{/if}{c.n}
          </button>
        {/each}
      </div>
    {:else}
      <div class="calhead">
        <button onclick={() => moveMonth(-1)} aria-label="Previous month"><Icon name="chev" /></button>
        <span>{MONTHS[cal.m]} {cal.y}</span>
        <button onclick={() => moveMonth(1)} aria-label="Next month"><Icon name="chevR" /></button>
      </div>
      <div class="cal" role="grid" aria-label="Calendar">
        {#each dayHeads as h, i}<b aria-hidden="true">{h}</b>{/each}
        {#each grid as d, i (i)}
          {#if d === null}
            <span></span>
          {:else}
            <button class="d" class:today={isoOf(d) === T} class:dim={isoOf(d) < T} class:pick={picked === isoOf(d)} onclick={() => pickDay(d)} aria-label={labelDate(isoOf(d))}>{d}</button>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
  {#if mode === 'when' && target && target.type === 'todo' && !query.trim()}
    <div class="sep"></div>
    {#if showReminder}
      <div class="opt rem">
        <span class="ic" style="color:var(--popmuted)"><Icon name="bell" /></span>
        <input type="time" bind:value={reminder} aria-label="Reminder time" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyReminder(); } }} />
        <button class="r set" onclick={applyReminder}>Set</button>
      </div>
      {#if obj && obj.reminder}<button class="opt muted" onclick={removeReminder}><span class="ic"><Icon name="x" /></span><span class="lbl">Remove Reminder</span></button>{/if}
    {:else}
      <button class="opt muted" onclick={() => (showReminder = true)}>
        <span class="ic"><Icon name="bell" /></span>
        <span class="lbl">{obj && obj.reminder ? `Reminder at ${obj.reminder}` : 'Add Reminder'}</span>
      </button>
    {/if}
    {#if !phone}<div class="hint">Type "tom", "sat", "in 3 days", "oct 2", "wed 8pm", "someday"</div>{/if}
  {/if}
</Popover>

<style>
  .rem { gap: 8px; }
  .rem:hover { background: none; }
  .set { color: var(--popaccent) !important; font-weight: 600; }
</style>
