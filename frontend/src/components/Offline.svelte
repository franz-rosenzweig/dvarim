<script>
  /** The strip that says the lists on screen are a kept copy, and how old,
   *  and how many edits are waiting to be sent. With a mirror (lib/backend.js)
   *  nothing is a kept copy: everything works, and it says only that the
   *  server will hear of it later.
   *
   *  It sits under the title bar for as long as the server cannot be reached,
   *  which is the one thing a toast could not do: on a plane the whole flight
   *  is offline, and "Cannot reach the server" for four seconds followed by an
   *  empty day reads as "nothing to do". Nothing on it is a control — there is
   *  nothing to press; it goes away by itself the moment the server answers,
   *  and the edits go with it (lib/outbox.js). */
  import { app } from '../lib/store.svelte.js';

  let show = $derived(!app.online && !!app.data);

  /** "09:12" today, "yesterday 21:40", "Mon 08:05" — enough to know whether to trust it. */
  function since(at) {
    if (!at) return '';
    const d = new Date(at);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    if (day(d) === day(now)) return time;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (day(d) === day(y)) return `yesterday ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
</script>

{#if show}
  <div class="offline" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span>
      {#if app.mirror}
        Offline. Everything works on this device, and your changes go to the server when it's back{app.staleAt ? ` (last synced ${since(app.staleAt)})` : ''}.
      {:else}
        Offline — your lists as of {since(app.staleAt)}.
        {#if app.pending}
          {app.pending} {app.pending === 1 ? 'change' : 'changes'} kept on this device, to be saved when the server is back.
        {:else}
          Changes are kept on this device until it's back.
        {/if}
      {/if}
    </span>
  </div>
{/if}

<style>
  .offline {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 6px 16px; font-size: 12.5px; line-height: 1.35;
    color: var(--text2); background: var(--hover); border-bottom: 1px solid var(--hair);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dead); flex: none; }
</style>
