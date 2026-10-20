<script>
  import { I } from '../lib/icons.js';
  /** @type {{ name: string, class?: string, color?: string, title?: string }} */
  let { name, class: cls = '', color, title } = $props();
</script>

<span class="icon {cls}" style:color={color} {title} aria-hidden={title ? undefined : 'true'}>{@html I[name] || ''}</span>

<style>
  .icon { display: inline-flex; align-items: center; justify-content: center; flex: none; line-height: 0; }
</style>
