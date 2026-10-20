<script>
  /**
   * Dark anchored popover (mockup `.pop`) with a scrim. Positions itself below the anchor
   * rect inside `.main`, flips above when there is no room, and is centred on phones (CSS).
   */
  import { closePopover } from '../lib/store.svelte.js';
  let { rect = null, wide = false, children, onclose = closePopover, label = 'Popover' } = $props();
  let el = $state(null);
  let style = $state('left:50%;top:120px;transform:translateX(-50%)');

  function place() {
    if (!el) return;
    const frame = el.closest('.app') || el.parentElement;
    const fr = frame.getBoundingClientRect();
    // The phone grows it out of the row it is about (see .pop in app.css). The
    // card is centred there, so where that row is has to be said relative to
    // the card's own top — and by offsetTop, because getBoundingClientRect is
    // scaled while the entrance is running.
    if (rect) el.style.setProperty('--from', `${Math.round(rect.top + rect.height / 2 - fr.top - el.offsetTop)}px`);
    const w = el.offsetWidth || 250;
    const h = el.offsetHeight || 200;
    if (!rect) {
      style = 'left:50%;top:120px;transform:translateX(-50%)';
      return;
    }
    let left = rect.left - fr.left;
    left = Math.max(8, Math.min(left, fr.width - w - 8));
    let top = rect.bottom - fr.top + 8;
    if (top + h > fr.height - 8) top = Math.max(8, rect.top - fr.top - h - 8);
    style = `left:${Math.round(left)}px;top:${Math.round(top)}px`;
  }
  $effect(() => {
    if (!el) return;
    rect; // re-place when the anchor changes
    place();
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    // A window made narrower would otherwise leave the panel hanging off it.
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  });

  function onkeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onclose();
    }
  }
</script>

<div class="scrim" onclick={onclose} onkeydown={onkeydown} role="presentation"></div>
<div class="pop" class:wide bind:this={el} {style} role="dialog" aria-label={label} onkeydown={onkeydown} tabindex="-1">
  <!-- Phone only. These are headed with the question being asked and a way
       out, because there is no Escape key and the scrim is not obviously a button. -->
  <div class="pophead"><span>{label === 'When' ? 'When?' : label}</span><button onclick={onclose}>Cancel</button></div>
  {@render children?.()}
</div>
