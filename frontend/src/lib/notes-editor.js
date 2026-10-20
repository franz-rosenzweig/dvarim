// Notes as Markdown, styled while they are typed — Obsidian's "live preview".
//
// A to-do's notes and a project's notes were a plain <textarea>: **bold** stayed
// two asterisks either side of a word. Obsidian renders its notes live, and
// Obsidian is where these files are also read. So this is CodeMirror 6 — the
// editor Obsidian itself is built on, on the desktop and on Android — with the
// syntax hidden wherever the caret is not, and shown again the moment it is,
// so what you are editing is always the real text.
//
// What is recognised is the common core of Markdown notes: headings, **bold**,
// *italic*, ==highlight==, ~~strike~~, `code`, fenced code, > quotes, bullet
// and numbered lists, - [ ] task lists with a box that ticks, [links](…) and
// bare links, and --- rules. A task list in notes is text in the notes, not the
// to-do's checklist; the file keeps the two apart (FORMAT.md, "Markdown in
// notes").
//
// It is its own chunk: nothing in a list needs it, so it loads when the first
// card opens (and is fetched ahead of time when the app goes idle), and a card
// that opens before it arrives shows the text as it is until it does.
//
// No @codemirror/lang-markdown: it pulls in the HTML, CSS and JavaScript
// languages for embedded code, three times the size of all of this. The Lezer
// Markdown parser is enough, wrapped in a Language the same way that package
// does it.
import { Annotation, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as placeholderExt,
} from '@codemirror/view';
import {
  history, historyKeymap, standardKeymap, indentMore, indentLess, insertNewline,
} from '@codemirror/commands';
import {
  HighlightStyle, Language, LanguageSupport, defineLanguageFacet, syntaxHighlighting, syntaxTree,
} from '@codemirror/language';
import { parser as commonmark, Autolink, Strikethrough, TaskList } from '@lezer/markdown';
import { Tag, tags as t } from '@lezer/highlight';

// ---- ==highlight== ---------------------------------------------------------
// Obsidian's syntax: these files are Obsidian's, so it is ==. Modelled on
// Lezer's own ~~strikethrough~~.
const markTag = Tag.define();
const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
const Highlight = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': markTag } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      const pBefore = PUNCT.test(before), pAfter = PUNCT.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2,
        !sAfter && (!pAfter || sBefore || pBefore),
        !sBefore && (!pBefore || sAfter || pAfter));
    },
    after: 'Emphasis',
  }],
};

const parser = commonmark.configure([TaskList, Strikethrough, Autolink, Highlight]);
export const markdown = new LanguageSupport(new Language(defineLanguageFacet(), parser, [], 'markdown'));

const styles = HighlightStyle.define([
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: markTag, class: 'md-mark' },
  { tag: t.monospace, class: 'md-code' },
  { tag: t.link, class: 'md-link' },
  { tag: t.url, class: 'md-link' },
  { tag: t.heading1, class: 'md-h md-h1' },
  { tag: t.heading2, class: 'md-h md-h2' },
  { tag: t.heading3, class: 'md-h md-h3' },
  { tag: [t.heading4, t.heading5, t.heading6], class: 'md-h md-h4' },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], class: 'md-syntax' },
]);

// ---- live preview ----------------------------------------------------------

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'md-bullet';
    s.textContent = '•';
    return s;
  }
}

class Box extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'md-box' + (this.checked ? ' on' : '');
    s.setAttribute('role', 'checkbox');
    s.setAttribute('aria-checked', String(this.checked));
    return s;
  }
  ignoreEvent() { return false; }
}

class Rule extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'md-rule';
    return s;
  }
}

/** Does any selection touch [from, to]? Touching counts: a caret right after
 *  the closing ** is editing that bold, and should see its asterisks. */
function touches(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}
const lineTouched = (state, pos) => {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
};

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });
const rule = Decoration.replace({ widget: new Rule() });
const done = Decoration.mark({ class: 'md-done' });
const lineClass = (cls) => Decoration.line({ class: cls });
// Each line takes its direction from its own first letter, so a Hebrew line in
// an English note runs right to left and the next English one does not. (The
// perLineTextDirection facet only reads a line's direction; this sets it.)
const autoDir = Decoration.line({ attributes: { dir: 'auto' } });

function decorate(view) {
  const { state } = view;
  // Out of focus, everything is rendered; in focus, what the caret is in is not.
  const live = view.hasFocus;
  const active = (from, to) => live && touches(state, from, to);
  const onLine = (pos) => live && lineTouched(state, pos);
  const out = [];
  const lines = (from, to, cls) => {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      out.push(lineClass(cls).range(line.from));
      pos = line.to + 1;
    }
  };

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      out.push(autoDir.range(line.from));
      pos = line.to + 1;
    }
    syntaxTree(state).iterate({
      from, to,
      enter(ref) {
        const node = ref.node;
        switch (ref.name) {
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'HighlightMark': {
            const el = node.parent;
            if (el && !active(el.from, el.to)) out.push(hide.range(ref.from, ref.to));
            return;
          }
          case 'CodeMark': {
            const el = node.parent;
            if (el && el.name === 'InlineCode' && !active(el.from, el.to)) out.push(hide.range(ref.from, ref.to));
            return;
          }
          case 'Link': {
            if (active(ref.from, ref.to)) return;
            const marks = node.getChildren('LinkMark');
            if (marks.length >= 2 && node.getChild('URL')) {
              out.push(hide.range(marks[0].from, marks[0].to));     // [
              out.push(hide.range(marks[1].from, ref.to));          // ](url)
            }
            return;
          }
          case 'HeaderMark': {
            if (onLine(ref.from)) return;
            const line = state.doc.lineAt(ref.from);
            const heading = node.parent;
            // A setext underline is a line of its own; hiding it would leave a blank one.
            if (!heading || heading.name.startsWith('SetextHeading')) return;
            // The opening #s start the heading node; any others close it. (Testing
            // for "start of line" instead gets "> ## x" wrong and overlaps the > .)
            if (ref.from === heading.from) {
              let end = ref.to;
              while (end < line.to && state.sliceDoc(end, end + 1) === ' ') end++;
              out.push(hide.range(ref.from, end));
            } else {
              let start = ref.from;
              while (start > line.from && state.sliceDoc(start - 1, start) === ' ') start--;
              out.push(hide.range(start, ref.to));
            }
            return;
          }
          case 'Blockquote':
            lines(ref.from, ref.to, 'md-quote');
            return;
          case 'QuoteMark': {
            if (onLine(ref.from)) return;
            const end = state.sliceDoc(ref.to, ref.to + 1) === ' ' ? ref.to + 1 : ref.to;
            out.push(hide.range(ref.from, end));
            return;
          }
          case 'ListMark': {
            if (onLine(ref.from)) return;
            const item = node.parent;
            if (item && item.getChild('Task')) {
              // a task item shows only its box, as Obsidian does
              const end = state.sliceDoc(ref.to, ref.to + 1) === ' ' ? ref.to + 1 : ref.to;
              out.push(hide.range(ref.from, end));
            } else if (/^[-*+]$/.test(state.sliceDoc(ref.from, ref.to))) {
              out.push(bullet.range(ref.from, ref.to));
            }
            return;
          }
          case 'Task': {
            const marker = node.getChild('TaskMarker');
            if (!marker) return;
            const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
            if (checked && marker.to < ref.to) out.push(done.range(marker.to, ref.to));
            if (!onLine(ref.from)) {
              out.push(Decoration.replace({ widget: new Box(checked) }).range(marker.from, marker.to));
            }
            return;
          }
          case 'FencedCode':
            lines(ref.from, ref.to, 'md-block');
            return;
          case 'HorizontalRule':
            if (!onLine(ref.from)) out.push(rule.range(ref.from, ref.to));
            return;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = decorate(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged
        || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = decorate(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

// ---- links and boxes -------------------------------------------------------

/** The address a link at `pos` goes to, or null. */
export function linkAt(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'URL' || n.name === 'Autolink') return href(state.sliceDoc(n.from, n.to));
    if (n.name === 'Link') {
      const url = n.getChild('URL');
      return url ? href(state.sliceDoc(url.from, url.to)) : null;
    }
  }
  return null;
}

function href(raw) {
  const s = raw.replace(/^<|>$/g, '').trim();
  if (/^(javascript|data|vbscript):/i.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^www\./i.test(s)) return 'https://' + s;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
  return null;
}

function toggleBox(view, pos) {
  const ch = view.state.sliceDoc(pos + 1, pos + 2);
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: /x/i.test(ch) ? ' ' : 'x' },
    userEvent: 'input',
  });
}

// ---- commands ----------------------------------------------------------------

/** ⌘B and friends: wrap the selection in `mark`, or unwrap it if it already is. */
export function toggleWrap(mark) {
  return (view) => {
    const { state } = view;
    const n = mark.length;
    const spec = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (state.sliceDoc(range.from - n, range.from) === mark && state.sliceDoc(range.to, range.to + n) === mark) {
        return {
          changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: [{ from: range.from, to: range.from + n }, { from: range.to - n, to: range.to }],
          range: EditorSelection.range(range.from, range.to - 2 * n),
        };
      }
      return {
        changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    });
    view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

const LIST = /^(\s*)(?:([-*+•])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s*>\s?)/;

/** Return in a list makes the next item; Return on an empty item ends the list,
 *  which is how Obsidian does it. Same for a quote. */
export function continueMarkup(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const m = LIST.exec(line.text) || QUOTE.exec(line.text);
  if (!m || sel.head < line.from + m[0].length) return false;
  const rest = line.text.slice(m[0].length);
  if (!rest.trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' },
                    selection: { anchor: line.from }, userEvent: 'input' });
    return true;
  }
  let next;
  if (m.length === 2) next = m[1];                                            // quote
  else next = m[1] + (m[2] || `${Number(m[3]) + 1}${m[4]}`) + m[5] + (m[6] ? '[ ] ' : '');
  view.dispatch(state.replaceSelection('\n' + next), { scrollIntoView: true, userEvent: 'input' });
  return true;
}

// ---- line formats: headings, quotes, lists --------------------------------------

// what a line may begin with, taken off before another is put on
const LEAD = /^(\s*)(#{1,6}\s+|>\s?|(?:[-*+•]|\d+[.)])\s+(?:\[[ xX~]\]\s+)?)?/;

/** Give every line the selection touches the prefix `make(i)` (i: its place,
 *  for a numbered list), or take it off if all of them have it already. */
export function toggleLines(test, make) {
  return (view) => {
    const { state } = view;
    const lines = [];
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to;) {
        const line = state.doc.lineAt(pos);
        if (!lines.some((l) => l.number === line.number)) lines.push(line);
        pos = line.to + 1;
      }
    }
    const all = lines.every((l) => test(l.text.replace(/^\s*/u, '')));
    const changes = lines.map((l, i) => {
      const m = LEAD.exec(l.text);
      const from = l.from + m[1].length, to = from + (m[2] || '').length;
      return { from, to, insert: all ? '' : make(i) };
    });
    view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

const heading = (n) => toggleLines((t) => new RegExp(`^#{${n}}\\s`, 'u').test(t), () => '#'.repeat(n) + ' ');
export const formats = {
  bold: toggleWrap('**'),
  italic: toggleWrap('*'),
  highlight: toggleWrap('=='),
  strike: toggleWrap('~~'),
  code: toggleWrap('`'),
  heading1: heading(1), heading2: heading(2), heading3: heading(3),
  heading4: heading(4), heading5: heading(5), heading6: heading(6),
  quote: toggleLines((t) => /^>/u.test(t), () => '> '),
  bullets: toggleLines((t) => /^[-*+•]\s(?!\[[ xX~]\])/u.test(t), () => '- '),
  numbers: toggleLines((t) => /^\d+[.)]\s/u.test(t), (i) => `${i + 1}. `),
  tasks: toggleLines((t) => /^[-*+]\s\[[ xX~]\]\s/u.test(t), () => '- [ ] '),
  codeBlock(view) {
    const { state } = view;
    const r = state.selection.main;
    const first = state.doc.lineAt(r.from), last = state.doc.lineAt(r.to);
    const body = state.sliceDoc(first.from, last.to);
    view.dispatch(state.update({
      changes: { from: first.from, to: last.to, insert: '```\n' + body + '\n```' },
      selection: { anchor: first.from + 4 + (body ? body.length : 0) },
      scrollIntoView: true, userEvent: 'input',
    }));
    return true;
  },
  /** [the selection](…), the caret where the address goes. */
  link(view) {
    const { state } = view;
    const r = state.selection.main;
    const text = state.sliceDoc(r.from, r.to);
    const url = /^(https?:\/\/|mailto:)\S+$/u.test(text);
    const insert = url ? `[](${text})` : `[${text}]()`;
    const caret = url ? r.from + 1 : r.from + text.length + 3;
    view.dispatch(state.update({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: caret },
      scrollIntoView: true, userEvent: 'input' }));
    return true;
  },
};

// Markdown shortcuts. Where a Mac holds Control and Command together,
// elsewhere it is Control and Alt, as Mod is already Control there.
const markdownKeys = [
  { key: 'Enter', run: (v) => continueMarkup(v) || insertNewline(v) },
  { key: 'Shift-Enter', run: insertNewline },
  { key: 'Mod-b', run: formats.bold },
  { key: 'Mod-i', run: formats.italic },
  { key: 'Mod-Shift-u', run: formats.highlight },
  { key: 'Mod-Alt-u', run: formats.strike },
  { key: 'Mod-Shift-j', run: formats.code },
  { key: 'Mod-Alt-Shift-j', run: formats.codeBlock },
  { key: "Mod-'", run: formats.quote },
  { key: 'Mod-Shift-l', run: formats.bullets },
  { key: 'Mod-Alt-l', run: formats.numbers },
  { mac: 'Ctrl-Cmd-l', key: 'Ctrl-Alt-Shift-l', run: formats.tasks },
  { key: 'Mod-Shift-k', run: formats.link },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ mac: `Ctrl-Cmd-${n}`, key: `Ctrl-Alt-${n}`, run: formats[`heading${n}`] })),
  { key: 'Mod-]', run: indentMore },
  { key: 'Mod-[', run: indentLess },
];

// ---- the editor ----------------------------------------------------------------

/** Marks a change that came from outside (the server's copy), so it is not
 *  reported back as an edit and does not land in undo. */
const External = Annotation.define();

const theme = EditorView.theme({
  '&': { color: 'inherit', fontSize: 'inherit', background: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--text3)' },
  '.md-h': { fontWeight: '600' },
  '.md-h1': { fontSize: '1.4em' },
  '.md-h2': { fontSize: '1.22em' },
  '.md-h3': { fontSize: '1.08em' },
  '.md-mark': { background: 'var(--mdmark)', borderRadius: '2px' },
  '.md-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.88em',
    background: 'var(--pill)', borderRadius: '3px',
  },
  '.md-link': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer' },
  '.md-syntax': { color: 'var(--text3)' },
  '.md-quote': { borderLeft: '3px solid var(--hair)', paddingLeft: '10px !important', color: 'var(--text2)' },
  '.md-block': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.88em',
    background: 'var(--hover)', padding: '0 8px !important',
  },
  '.md-bullet': { color: 'var(--text3)', display: 'inline-block', width: '.7em' },
  '.md-box': {
    display: 'inline-block', boxSizing: 'border-box', width: '.95em', height: '.95em',
    margin: '0 .15em -.12em 0', border: '1.5px solid var(--check)', borderRadius: '3px', cursor: 'pointer',
  },
  '.md-box.on': {
    background: 'var(--checkon)', borderColor: 'var(--checkon)',
    backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2 5 8.6 9.6 3.6' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
    backgroundSize: '100% 100%',
  },
  '.md-done': { color: 'var(--text3)', textDecoration: 'line-through' },
  '.md-rule': { display: 'inline-block', width: '100%', height: '1px', background: 'var(--hair)', verticalAlign: 'middle' },
});

/**
 * Put an editor in `parent`.
 *
 * @param {HTMLElement} parent
 * @param {{ doc?: string, placeholder?: string, label?: string,
 *           onChange?: (text: string) => void, onFocus?: () => void, onBlur?: () => void,
 *           openLink?: (url: string) => void }} opts
 */
export function createNotesEditor(parent, opts = {}) {
  const { onChange, onFocus, onBlur, openLink } = opts;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc || '',
      extensions: [
        markdown,
        syntaxHighlighting(styles),
        livePreview,
        history(),
        keymap.of([...markdownKeys, ...historyKeymap, ...standardKeymap]),
        EditorView.lineWrapping,
        // Hebrew and English in the same note: each line runs its own way.
        EditorView.perLineTextDirection.of(true),
        EditorView.contentAttributes.of({
          'aria-label': opts.label || 'Notes', 'aria-multiline': 'true',
          spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences',
        }),
        placeholderExt(opts.placeholder || 'Notes'),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange && !u.transactions.some((tr) => tr.annotation(External))) {
            onChange(u.state.doc.toString());
          }
          if (u.focusChanged) (u.view.hasFocus ? onFocus : onBlur)?.();
        }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            const box = e.target instanceof Element && e.target.closest('.md-box');
            if (box) {
              e.preventDefault();
              toggleBox(v, v.posAtDOM(box));
              return true;
            }
            if (!openLink) return false;
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const url = linkAt(v.state, pos);
            // A link opens when the note is being read, or with ⌘/Ctrl held while
            // it is being written — otherwise a click is where the caret goes.
            if (url && (e.metaKey || e.ctrlKey || !v.hasFocus)) {
              e.preventDefault();
              openLink(url);
              return true;
            }
            return false;
          },
        }),
      ],
    }),
  });

  return {
    view,
    hasFocus: () => view.hasFocus,
    focus: () => view.focus(),
    /** One of `formats` on the selection: the phone's format bar. */
    format(name) { if (formats[name]) { formats[name](view); view.focus(); } },
    /** Replace the text from outside, unless it is already that. */
    setDoc(text) {
      const now = view.state.doc.toString();
      if ((text || '') === now) return;
      view.dispatch({
        changes: { from: 0, to: now.length, insert: text || '' },
        annotations: [External.of(true), Transaction.addToHistory.of(false)],
      });
    },
    destroy: () => view.destroy(),
  };
}
