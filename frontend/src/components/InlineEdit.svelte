<script>
  /**
   * Click-to-edit text (project / area / heading names). Saves on blur or Return,
   * reverts on Esc. `autofocus` selects the whole text on mount (new project etc.).
   */
  import { tick } from 'svelte';
  let { value = '', onsave, class: cls = '', placeholder = 'Untitled', autofocus = false, label = 'Name' } = $props();
  let el = $state(null);
  let editing = $state(false);

  $effect(() => {
    if (autofocus && el) {
      tick().then(() => {
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      });
    }
  });
  // Keep the DOM text in sync with the prop while not editing.
  $effect(() => {
    if (el && !editing && el.textContent !== value) el.textContent = value || '';
  });

  function commit() {
    editing = false;
    const v = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (v && v !== value) onsave && onsave(v);
    else el.textContent = value || '';
  }
  function onkeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.textContent = value || ''; editing = false; el.blur(); }
  }
  function onpaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\s+/g, ' ');
    document.execCommand('insertText', false, text);
  }
</script>

<span
  class={cls}
  bind:this={el}
  contenteditable="true"
  role="textbox"
  tabindex="0"
  aria-label={label}
  spellcheck="false"
  data-placeholder={placeholder}
  onfocus={() => (editing = true)}
  onblur={commit}
  {onkeydown}
  {onpaste}
></span>

<style>
  span:empty::before { content: attr(data-placeholder); color: var(--text3); }
</style>
