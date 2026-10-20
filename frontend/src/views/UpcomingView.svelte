<script>
  import { keyed } from '../lib/keyed.js';
  import ListTitle from '../components/ListTitle.svelte';
  import FilterBar from '../components/FilterBar.svelte';
  import EventsBlock from '../components/EventsBlock.svelte';
  import TodoList from '../components/TodoList.svelte';
  import TodoItem from '../components/TodoItem.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import ProjectRow from '../components/ProjectRow.svelte';
  import { app, today } from '../lib/store.svelte.js';
  import { drag } from '../lib/dnd.svelte.js';
  import { addDays, daysBetween, parseISO, weekday, monthName, shortDate, fmtTime } from '../lib/dates.js';

  let data = $derived(app.data);
  let T = $derived(today());
  let horizon = $derived(addDays(T, 7));
  let allDays = $derived(((data && data.days) || []).filter((d) => d.date > T));
  let tags = $derived(allDays.flatMap((d) => (d.items || []).flatMap((t) => t.tags || [])));
  let days = $derived.by(() => {
    if (!app.filterTag) return allDays;
    return allDays
      .map((d) => ({ ...d, items: (d.items || []).filter((t) => (t.tags || []).includes(app.filterTag)), events: [], projects: [] }))
      .filter((d) => d.items.length);
  });
  let near = $derived(days.filter((d) => d.date <= horizon));
  let far = $derived(days.filter((d) => d.date > horizon));
  let months = $derived.by(() => {
    const out = [];
    let cur = null;
    const thisYear = parseISO(T).getFullYear();
    for (const d of far) {
      const y = parseISO(d.date).getFullYear();
      const label = monthName(d.date) + (y !== thisYear ? ` ${y}` : '');
      if (!cur || cur.label !== label) { cur = { label, days: [] }; out.push(cur); }
      cur.days.push(d);
    }
    return out;
  });
  const dayLabel = (d) => (daysBetween(T, d) === 1 ? 'Tomorrow' : weekday(d));
  let total = $derived(allDays.reduce((n, d) => n + (d.items || []).length + (d.events || []).length + (d.projects || []).length, 0));
</script>

{#if data}
  <ListTitle icon="upcoming" name="Upcoming" />
  <FilterBar {tags} />
  {#each near as d, i (d.date)}
    <!-- :first-of-type cannot say "the first day": every earlier sibling is a
         <div> too. -->
    <div class="hd day" class:first={i === 0}
         class:drop={drag.active && drag.target?.kind === 'day' && drag.target?.id === d.date}
         data-drop-day={d.date}><b>{parseISO(d.date).getDate()}</b><span>{dayLabel(d.date)}</span></div>
    <EventsBlock events={d.events} bare />
    <!-- A project scheduled for this day, listed with its pie; without it a
         day whose only content was a project was a header over nothing.
         Outside the TodoList, and with no data-todo-id, so neither the drag nor
         Select All takes it for a to-do. -->
    {#each keyed(d.projects || []) as [rowKey, pr] (rowKey)}<ProjectRow project={pr} sub hideDl={pr.deadline === d.date} />{/each}
    <!-- Its own list, so a to-do dropped among its rows lands where it was
         dropped as well as moving to that day; `when` is what makes it that
         day, for the drop and for the + button alike. -->
    <TodoList items={d.items || []} sub dlFlag hideDl context={`upcoming:${d.date}`} when={d.date} hideWhen />
  {/each}
  {#each months as m (m.label)}
    <div class="hd month">{m.label}</div>
    {#each m.days as d (d.date)}
      <div class="rows">
        {#each d.events || [] as e}
          <div class="dated">
            <span class="datepill">{shortDate(d.date, T)}</span>
            <div class="grow evrow">{#if !e.allDay}<time>{fmtTime(e.time)}</time>{/if}{e.title}</div>
          </div>
        {/each}
        {#each keyed(d.projects || []) as [rowKey, pr] (rowKey)}
          <div class="dated">
            <span class="datepill">{shortDate(d.date, T)}</span>
            <div class="grow"><ProjectRow project={pr} sub hideDl /></div>
          </div>
        {/each}
        {#each keyed(d.items || []) as [rowKey, t] (rowKey)}
          <div class="dated">
            <span class="datepill">{shortDate(d.date, T)}</span>
            <div class="grow">
              <TodoItem todo={t} sub dlFlag hideDl hideWhen />
            </div>
          </div>
        {/each}
      </div>
    {/each}
  {/each}
  {#if !total}
    <EmptyState kind="upcoming" />
  {:else if !days.length}
    <EmptyState kind="filter" />
  {/if}
{/if}

<style>
  .dated { display: flex; gap: 10px; align-items: flex-start; }
  .datepill { font-size: 11px; color: var(--text2); background: var(--pill); border-radius: 5px; padding: 0 6px; line-height: 17px; margin-top: 8px; min-width: 46px; text-align: center; flex: none; font-variant-numeric: tabular-nums; }
  .grow { flex: 1; min-width: 0; }
  .evrow { color: var(--text2); font-size: 12.5px; padding: 8px 0 6px; display: flex; gap: 7px; }
  .evrow time { color: var(--event); font-variant-numeric: tabular-nums; }
</style>
