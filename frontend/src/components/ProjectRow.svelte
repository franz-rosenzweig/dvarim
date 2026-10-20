<script>
  /** A project shown as a row (Area view, Someday, Logbook, Trash). */
  import Pie from './Pie.svelte';
  import { goProject, today } from '../lib/store.svelte.js';
  import { shortDate } from '../lib/dates.js';
  /** hideDl: the list is already grouped by that date (Upcoming), so saying
   *  it again on the row is noise. */
  let { project, sub = false, hideDl = false } = $props();
  let finished = $derived(project.status && project.status !== 'open');
</script>

<button class="row prow" class:done={finished} onclick={() => goProject(project.id)} data-project-id={project.id}>
  <span class="pieic"><Pie progress={finished ? 1 : project.progress} color="var(--text2)" /></span>
  <div class="body">
    <div class="title">
      <span class="txt">{project.name}</span>
      {#if project.deadline && !finished && !hideDl}<span class="dl">{shortDate(project.deadline, today())}</span>{/if}
    </div>
    {#if sub && project.areaName}<div class="sub">{project.areaName}</div>{/if}
  </div>
</button>
