<script>
  import Icon from './Icon.svelte';
  /** h1 for the fixed lists: icon + name, and a ••• button where the list has
   *  something to offer (Today: a heading of its own). */
  let { icon, name, onmenu = null } = $props();
</script>

<h1 class="t"><span class="ic"><Icon name={icon} /></span><span class="name">{name}</span>{#if onmenu}<button class="more" onclick={onmenu} aria-label={`${name} actions`} aria-haspopup="menu">•••</button>{/if}</h1>
