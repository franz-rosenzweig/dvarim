<script>
  /** Markdown notes, styled as they are typed (lib/notes-editor.js).
   *
   *  The editor is its own chunk, so the first card to open may get here before
   *  it has: until then the text is shown as it is, and if the chunk cannot be
   *  had at all — offline, before the app was ever cached with it — the field
   *  is the plain textarea it used to be, so notes can always be written. */
  import { onMount } from 'svelte';
  import { openExternal } from '../lib/shell.js';

  let { value = '', onchange, onfocus, onblur, placeholder = 'Notes', label = 'Notes', class: cls = '' } = $props();

  let host = $state(null);
  let editor = null;
  let ready = $state(false);
  let failed = $state(false);

  // On a touchscreen there is no ⌘B: while the notes are being written, a bar
  // of the formats sits on top of the keyboard.
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let focused = $state(false);
  let lift = $state(0);                       // how far the keyboard covers the window's bottom
  const FORMATS = [
    { name: 'bold', label: 'Bold', text: 'B', cls: 'b' },
    { name: 'italic', label: 'Italic', text: 'I', cls: 'i' },
    { name: 'highlight', label: 'Highlight', text: 'H', cls: 'hl' },
    { name: 'strike', label: 'Strikethrough', text: 'S', cls: 's' },
    { name: 'heading2', label: 'Heading', text: '#', cls: 'h' },
    { name: 'bullets', label: 'Bulleted list', text: '•', cls: 'l' },
    { name: 'numbers', label: 'Numbered list', text: '1.', cls: 'l' },
    { name: 'tasks', label: 'Checklist in the notes', text: '☐', cls: 'l' },
    { name: 'quote', label: 'Quote', text: '❝', cls: 'l' },
    { name: 'code', label: 'Code', text: '</>', cls: 'c' },
    { name: 'link', label: 'Link', text: '🔗', cls: 'l' },
  ];
  // the bar takes the capsule's place while it shows (.app.fmt in app.css)
  $effect(() => {
    const on = touch && focused && ready;
    const app = document.querySelector('.app');
    if (app) app.classList.toggle('fmt', on);
    return () => { if (on && app) app.classList.remove('fmt'); };
  });
  $effect(() => {
    if (!touch || !focused || !window.visualViewport) return undefined;
    const vv = window.visualViewport;
    const place = () => { lift = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)); };
    place();
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => { vv.removeEventListener('resize', place); vv.removeEventListener('scroll', place); };
  });

  onMount(() => {
    let gone = false;
    import('../lib/notes-editor.js')
      .then((m) => {
        if (gone || !host) return;
        editor = m.createNotesEditor(host, {
          doc: value, placeholder, label,
          onChange: (v) => onchange && onchange(v),
          onFocus: () => { focused = true; if (onfocus) onfocus(); },
          onBlur: () => { focused = false; if (onblur) onblur(); },
          openLink: openExternal,
        });
        ready = true;
      })
      .catch(() => { if (!gone) failed = true; });
    return () => { gone = true; if (editor) editor.destroy(); editor = null; };
  });

  // The card pulls the server's copy in whenever it is not being typed in;
  // hand that on, and never while the caret is here.
  $effect(() => {
    const v = value;
    if (ready && editor && !editor.hasFocus()) editor.setDoc(v);
  });

  function autosize(node) {
    const fit = () => { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px'; };
    fit();
    node.addEventListener('input', fit);
    return { update: fit, destroy: () => node.removeEventListener('input', fit) };
  }
</script>

{#if failed}
  <textarea class={cls} rows="1" {placeholder} aria-label={label} value={value} use:autosize={value}
            oninput={(e) => onchange && onchange(e.currentTarget.value)}
            onfocus={() => onfocus && onfocus()} onblur={() => onblur && onblur()}></textarea>
{:else}
  <div class="notesfield {cls}" class:ready bind:this={host}>
    {#if !ready}<div class="nf-wait" class:empty={!value}>{value || placeholder}</div>{/if}
  </div>
  {#if touch && focused && ready}
    <!-- a tap here must not take the caret out of the notes -->
    <div class="fmtbar" role="toolbar" aria-label="Format" style="bottom:{lift}px"
         onpointerdown={(e) => e.preventDefault()} onmousedown={(e) => e.preventDefault()}>
      {#each FORMATS as f}
        <button type="button" class={f.cls} aria-label={f.label} title={f.label} data-format={f.name}
                onclick={() => editor && editor.format(f.name)}>{f.text}</button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .fmtbar {
    position: fixed; left: 0; right: 0; z-index: 60;
    display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none;
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px));
    background: var(--main); border-top: 1px solid var(--hair);
    box-shadow: 0 -2px 8px rgba(0, 0, 0, .06);
  }
  .fmtbar::-webkit-scrollbar { display: none; }
  .fmtbar button {
    flex: 0 0 auto; min-width: 40px; height: 36px; padding: 0 8px;
    font: inherit; font-size: 16px; color: var(--text); background: none;
    border: 0; border-radius: 8px; cursor: pointer;
  }
  .fmtbar button:active { background: var(--hover); }
  .fmtbar .b { font-weight: 700; }
  .fmtbar .i { font-style: italic; font-family: Georgia, serif; }
  .fmtbar .hl { align-self: center; height: 26px; min-width: 30px; margin: 0 5px; background: rgba(255, 214, 10, .5); border-radius: 5px; }
  .fmtbar .s { text-decoration: line-through; }
  .fmtbar .c { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
</style>
