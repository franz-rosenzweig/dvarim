<script>
  /** Progress pie, identical geometry to the mockup's pie(). */
  let { progress = 0, size = 16, color = 'currentColor', class: cls = '' } = $props();
  const C = 2 * Math.PI * 3.1;
  let v = $derived(Math.min(1, Math.max(0, Number(progress) || 0)));
</script>

<svg class="pie {cls}" width={size} height={size} viewBox="0 0 16 16" style:color={color} aria-hidden="true">
  <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
  <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="6.2"
    stroke-dasharray={C.toFixed(2)} stroke-dashoffset={(C * (1 - v)).toFixed(2)} transform="rotate(-90 8 8)" />
</svg>
