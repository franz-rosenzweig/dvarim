<script>
  import { app, undo, dismissToast } from '../lib/store.svelte.js';
</script>

{#if app.toast}
  <div class="toast" class:err={app.toast.error} role="status" aria-live="polite">
    <span>{app.toast.text}</span>
    {#if app.toast.undo}
      <span aria-hidden="true">·</span>
      <button onclick={undo}>Undo</button>
    {:else if app.toast.error}
      <button onclick={dismissToast} aria-label="Dismiss">OK</button>
    {/if}
  </div>
{/if}
