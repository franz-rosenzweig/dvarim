<script>
  /** Building a repeat rule, in plain words.
   *
   *  The sentence this assembles is sent to the server for validation and a
   *  preview of the next few dates. The rule engine already exists and is
   *  tested; a second implementation in JavaScript would only drift from it.
   */
  import { tick } from 'svelte';
  import Popover from './Popover.svelte';
  import * as api from '../lib/api.js';
  import { app, findTodo, patchTodo, patchProject, closePopover, today, weekStartsOn } from '../lib/store.svelte.js';
  import { shortDate, parseISO, toISO } from '../lib/dates.js';

  let { pop } = $props();
  let target = $derived(pop.target);
  let obj = $derived.by(() => {
    if (!target) return null;
    if (target.type === 'todo') return findTodo(target.id);
    return app.data?.project?.id === target.id ? app.data.project : null;
  });

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  const NTH = [['1', 'first'], ['2', 'second'], ['3', 'third'], ['4', 'fourth'], ['last', 'last']];

  let mode = $state('schedule');      // 'schedule' | 'done'
  let n = $state(1);
  let unit = $state('week');          // day | week | month | year
  let weekdays = $state([]);          // for weekly
  let monthlyKind = $state('day');    // 'day' = the 15th, 'nth' = the 2nd Tuesday
  let monthDay = $state(1);
  let nth = $state('1');
  let nthDay = $state('Monday');
  let yearMonth = $state(1);
  let yearDay = $state(1);
  let ends = $state('never');         // never | on | after
  let endsOn = $state('');
  let endsAfter = $state(10);
  let preview = $state(null);
  let error = $state(null);
  let ready = $state(false);

  // Start from whatever the to-do already says, so opening this on a repeating
  // item shows its actual rule rather than a blank default.
  $effect(() => {
    if (ready || !obj) return;
    ready = true;
    const anchor = obj.when || obj.deadline || today();
    const d = new Date(anchor + 'T00:00:00');
    monthDay = d.getDate();
    yearMonth = d.getMonth() + 1;
    yearDay = d.getDate();
    nthDay = DAYS[(d.getDay() + 6) % 7];
    weekdays = [DAYS[(d.getDay() + 6) % 7]];
    // An end date on the start date would end it before it began ("That never
    // happens"), so "Ends on" offers a year from now to change.
    const yearOn = parseISO(anchor);
    yearOn.setFullYear(yearOn.getFullYear() + 1);
    endsOn = toISO(yearOn);
    if (obj.repeat) load(obj.repeat);
  });

  function load(text) {
    const s = text.trim().toLowerCase();
    mode = s.endsWith('when done') ? 'done' : 'schedule';
    const m = s.match(/^every (?:(\d+)\s+)?(day|week|month|year)s?/);
    if (m) { n = m[1] ? +m[1] : 1; unit = m[2]; }
    else if (/^every weekday/.test(s)) { unit = 'week'; n = 1; weekdays = DAYS.slice(0, 5); }
    const on = s.match(/ on (.+?)(?: when done| until | for \d+ times|$)/);
    if (on) {
      const part = on[1];
      if (unit === 'week') {
        const picked = DAYS.filter((d) => part.includes(d.toLowerCase()));
        if (picked.length) weekdays = picked;
      } else if (unit === 'month') {
        const nthM = part.match(/the (first|second|third|fourth|last|\d)(?:st|nd|rd|th)? ([a-z]+)/);
        const dayM = part.match(/the (\d{1,2})(?:st|nd|rd|th)?/);
        if (nthM) {
          monthlyKind = 'nth';
          nth = { first: '1', second: '2', third: '3', fourth: '4', last: 'last' }[nthM[1]] || nthM[1];
          const day = DAYS.find((d) => d.toLowerCase().startsWith(nthM[2].slice(0, 3)));
          if (day) nthDay = day;
        } else if (part.includes('last')) { monthlyKind = 'day'; monthDay = -1; }
        else if (dayM) { monthlyKind = 'day'; monthDay = +dayM[1]; }
      } else if (unit === 'year') {
        const ym = part.match(/([a-z]+)\s+(\d{1,2})/);
        if (ym) {
          const idx = MONTHS.findIndex((x) => x.toLowerCase().startsWith(ym[1].slice(0, 3)));
          if (idx >= 0) { yearMonth = idx + 1; yearDay = +ym[2]; }
        }
      }
    }
    const until = s.match(/until (\d{4}-\d{2}-\d{2})/);
    const times = s.match(/for (\d+) times?/);
    if (until) { ends = 'on'; endsOn = until[1]; }
    else if (times) { ends = 'after'; endsAfter = +times[1]; }
    else ends = 'never';
  }

  /** The sentence the server parses. */
  let rule = $derived.by(() => {
    let s = `every ${n > 1 ? n + ' ' : ''}${unit}${n > 1 ? 's' : ''}`;
    if (unit === 'week' && weekdays.length) {
      const ordered = DAYS.filter((d) => weekdays.includes(d));
      s += ' on ' + ordered.join(', ');
    } else if (unit === 'month') {
      if (monthlyKind === 'nth') s += ` on the ${nth === 'last' ? 'last' : nth + suffix(+nth)} ${nthDay}`;
      else s += monthDay === -1 ? ' on the last' : ` on the ${monthDay}${suffix(monthDay)}`;
    } else if (unit === 'year') {
      s += ` on ${MONTHS[yearMonth - 1]} ${yearDay}${suffix(yearDay)}`;
    }
    if (mode === 'done') s += ' when done';
    if (ends === 'on' && endsOn) s += ` until ${endsOn}`;
    else if (ends === 'after') s += ` for ${endsAfter} times`;
    return s;
  });

  function suffix(x) {
    if (x >= 11 && x <= 13) return 'th';
    return { 1: 'st', 2: 'nd', 3: 'rd' }[x % 10] || 'th';
  }

  // ask the server what this rule actually means
  let lastAsked = null;
  $effect(() => {
    const r = rule;
    if (r === lastAsked) return;
    lastAsked = r;
    const anchor = obj?.when || obj?.deadline || today();
    api.parseRepeat(r, anchor)
      .then((res) => { preview = res; error = res.ok ? null : res.error; })
      .catch((e) => { error = e.message; preview = null; });
  });

  function toggleDay(d) {
    weekdays = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d];
  }

  // The week as the person's own week runs: Sunday first unless they said Monday.
  let week = $derived(weekStartsOn() === 1 ? DAYS : [DAYS[6], ...DAYS.slice(0, 6)]);

  // Monthly reads "on the [15th] [day]" or "on the [2nd] [Tuesday]": one menu
  // for which one, one for of what. Underneath it is still a date (monthDay)
  // or an nth weekday (nth, nthDay).
  let ord = $derived(monthlyKind === 'day' ? (monthDay === -1 ? 'last' : String(monthDay)) : nth);
  let ofWhat = $derived(monthlyKind === 'day' ? 'day' : nthDay);
  let ords = $derived(monthlyKind === 'day'
    ? [...Array.from({ length: 31 }, (_, i) => [String(i + 1), `${i + 1}${suffix(i + 1)}`]), ['last', 'last']]
    : NTH.map(([v]) => [v, v === 'last' ? 'last' : `${v}${suffix(+v)}`]));
  function setOrd(v) {
    if (monthlyKind === 'day') monthDay = v === 'last' ? -1 : +v;
    else nth = v;
  }
  function setOfWhat(v) {
    if (v === 'day') {
      if (monthlyKind === 'nth') monthDay = nth === 'last' ? -1 : +nth;
      monthlyKind = 'day';
      return;
    }
    // The 15th becomes the third Tuesday: the week of the month it fell in.
    if (monthlyKind === 'day') nth = monthDay === -1 || monthDay > 28 ? 'last' : String(Math.min(4, Math.ceil(monthDay / 7)));
    monthlyKind = 'nth';
    nthDay = v;
  }

  // Return in a field does what the button says, as in any Mac dialog.
  function onkeydown(e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !error) {
      e.preventDefault();
      apply();
    }
  }

  async function apply() {
    const tgt = target;
    const text = rule;
    closePopover();
    if (!tgt) return;
    if (tgt.type === 'project') return patchProject(tgt.id, { repeat: text });
    return patchTodo(tgt.id, { repeat: text });
  }
  async function stop() {
    const tgt = target;
    closePopover();
    if (!tgt) return;
    if (tgt.type === 'project') return patchProject(tgt.id, { repeat: null });
    return patchTodo(tgt.id, { repeat: null });
  }
</script>

<Popover rect={pop.rect} label="Repeat" wide>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="rpt" {onkeydown}>
    <div class="seg" role="radiogroup" aria-label="How it repeats">
      <button role="radio" aria-checked={mode === 'schedule'} class:on={mode === 'schedule'} onclick={() => (mode = 'schedule')}>On a schedule</button>
      <button role="radio" aria-checked={mode === 'done'} class:on={mode === 'done'} onclick={() => (mode = 'done')}>After completion</button>
    </div>
    <p class="about">
      {mode === 'done'
        ? 'The next one is counted from the day you tick this one off.'
        : 'The next one comes on schedule, whether or not this one is done.'}
    </p>

    <div class="form">
      <span class="k">Every</span>
      <div class="fields">
        <input type="number" min="1" max="99" bind:value={n} aria-label="How many" />
        <select bind:value={unit} aria-label="Unit">
          <option value="day">day{n > 1 ? 's' : ''}</option>
          <option value="week">week{n > 1 ? 's' : ''}</option>
          <option value="month">month{n > 1 ? 's' : ''}</option>
          <option value="year">year{n > 1 ? 's' : ''}</option>
        </select>
      </div>

      {#if unit === 'week'}
        <span class="k">On</span>
        <div class="days">
          {#each week as d}
            <button class:on={weekdays.includes(d)} onclick={() => toggleDay(d)} aria-pressed={weekdays.includes(d)} aria-label={d} title={d}>{d.slice(0, 2)}</button>
          {/each}
        </div>
      {:else if unit === 'month'}
        <span class="k">On</span>
        <div class="fields">
          <span class="w">the</span>
          <select value={ord} onchange={(e) => setOrd(e.currentTarget.value)} aria-label="Which one">
            {#each ords as [v, label]}<option value={v}>{label}</option>{/each}
          </select>
          <select value={ofWhat} onchange={(e) => setOfWhat(e.currentTarget.value)} aria-label="Of what">
            <option value="day">day</option>
            {#each DAYS as d}<option value={d}>{d}</option>{/each}
          </select>
        </div>
      {:else if unit === 'year'}
        <span class="k">On</span>
        <div class="fields">
          <select bind:value={yearMonth} aria-label="Month">
            {#each MONTHS as m, i}<option value={i + 1}>{m}</option>{/each}
          </select>
          <select bind:value={yearDay} aria-label="Day">
            {#each Array.from({ length: 31 }, (_, i) => i + 1) as d}<option value={d}>{d}</option>{/each}
          </select>
        </div>
      {/if}

      <span class="k">Ends</span>
      <div class="fields">
        <select bind:value={ends} aria-label="When it ends">
          <option value="never">never</option>
          <option value="on">on</option>
          <option value="after">after</option>
        </select>
        {#if ends === 'on'}
          <input type="date" bind:value={endsOn} aria-label="Last date" />
        {:else if ends === 'after'}
          <input type="number" min="1" max="999" bind:value={endsAfter} aria-label="How many times" />
          <span class="w">times</span>
        {/if}
      </div>
    </div>

    <div class="next" aria-live="polite">
      {#if error}
        <span class="err">{error}</span>
      {:else if preview && preview.next.length}
        <span class="k">Next</span>
        <span>{preview.next.map((d) => shortDate(d, today())).join(' · ')}</span>
      {:else if preview}
        <span class="err">That never happens.</span>
      {:else}
        &nbsp;
      {/if}
    </div>

    <div class="acts">
      {#if obj?.repeat}
        <button class="ghost danger" onclick={stop}>Stop repeating</button>
      {/if}
      <button class="ghost cancel" onclick={closePopover}>Cancel</button>
      <button class="primary" onclick={apply} disabled={!!error}>{obj?.repeat ? 'Update' : 'Repeat'}</button>
    </div>
  </div>
</Popover>

<style>
  /* Sized to the panel (.pop.wide), never past it, and in the panel's own
     controls: no native steppers or system focus rings on the dark card. */
  .rpt { display: flex; flex-direction: column; gap: 10px; padding: 2px; font-size: 12.5px; }

  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px;
         border-radius: 7px; background: rgba(255,255,255,.07); }
  .seg button { height: 24px; border-radius: 5px; font-size: 12px; color: var(--popmuted); white-space: nowrap; }
  .seg button:hover { color: var(--poptext); }
  .seg button.on { color: var(--poptext); font-weight: 500; background: rgba(255,255,255,.16);
                   box-shadow: 0 1px 2px rgba(0,0,0,.3); }
  .about { margin: -4px 4px 0; font-size: 11px; line-height: 1.4; color: var(--popmuted); }

  .form { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center;
          column-gap: 10px; row-gap: 8px; padding: 2px 4px; }
  .k { color: var(--popmuted); }
  .fields { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .w { color: var(--popmuted); }

  input, select {
    box-sizing: border-box; height: 26px; min-width: 0; padding: 0 8px;
    font: inherit; color: var(--poptext); background-color: rgba(255,255,255,.1);
    border: 0; border-radius: 6px; outline: none;
  }
  input:hover, select:hover { background-color: rgba(255,255,255,.15); }
  input:focus-visible, select:focus-visible { box-shadow: 0 0 0 2px var(--popsel); }
  select {
    appearance: none; -webkit-appearance: none; padding-right: 22px; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M.75.75 4 4 7.25.75' fill='none' stroke='%2398989D' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center; background-size: 8px 5px;
  }
  select option { color: #000; }
  input[type="number"] { width: 42px; padding: 0 4px; text-align: center; font-variant-numeric: tabular-nums;
                         -moz-appearance: textfield; appearance: textfield; }
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="date"] { flex: 1; }

  .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
  .days button { height: 26px; border-radius: 6px; font-size: 11.5px; color: var(--poptext);
                 background: rgba(255,255,255,.1); }
  .days button:hover { background: rgba(255,255,255,.16); }
  .days button.on { color: #fff; font-weight: 600; background: var(--popsel); }
  .days button:focus-visible, .seg button:focus-visible, .acts button:focus-visible {
    outline: none; box-shadow: 0 0 0 2px var(--popsel); }
  .seg button.on:focus-visible { box-shadow: 0 0 0 2px var(--popsel); }

  .next { display: flex; gap: 10px; align-items: baseline; min-height: 16px; padding: 9px 4px 0;
          border-top: 1px solid rgba(255,255,255,.08); font-size: 11.5px; line-height: 1.4;
          color: var(--poptext); font-variant-numeric: tabular-nums; }
  .next .err { color: #FF8A8A; }

  .acts { display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
  .acts button { height: 26px; padding: 0 12px; border-radius: 6px; }
  .acts .primary { color: #fff; font-weight: 500; background: var(--popsel); }
  .acts .primary:disabled { opacity: .45; cursor: default; }
  .acts .ghost { color: var(--popmuted); }
  .acts .ghost:hover { color: var(--poptext); background: rgba(255,255,255,.08); }
  .acts .danger { margin-right: auto; padding: 0 8px; color: #FF7B7B; }
  .acts .danger:hover { color: #FF9A9A; }

  /* A phone gives the panel the screen's width and a thumb to work it with. */
  @media (max-width: 720px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 559px) {
    .rpt { gap: 12px; font-size: 15px; }
    .seg button { height: 32px; font-size: 14px; }
    .about { font-size: 13px; }
    .form { row-gap: 10px; }
    input, select { height: 36px; }
    input[type="number"] { width: 52px; }
    .days button { height: 36px; font-size: 13.5px; }
    .next { font-size: 13.5px; }
    .acts button { height: 36px; padding: 0 14px; }
    .acts .cancel { display: none; }   /* the panel's heading has Cancel there */
  }
</style>
