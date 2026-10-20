<script>
  import { fmtTime } from '../lib/dates.js';
  /** Calendar events for one day, as in the Today / Upcoming mockup.
   *  `bare` drops the grey card: it is a Today device, and Upcoming shows
   *  its events as plain lines under the day's rule. */
  let { events = [], bare = false } = $props();
</script>

{#if events && events.length}
  <div class="events" class:bare>
    {#each events as e}
      {#if e.allDay}
        <div class="ev allday" class:b={e.calendar !== 'hebcal'} style={e.color ? `--event2:${e.color};--event:${e.color}` : ''}>{e.title}</div>
      {:else}
        <div class="ev"><time style={e.color ? `color:${e.color}` : ''}>{fmtTime(e.time)}</time>{e.title}</div>
      {/if}
    {/each}
  </div>
{/if}
