// The line formats and the rest of the Markdown commands in notes
// (formats in src/lib/notes-editor.js: shortcuts, and the phone's format bar),
// and a title's inline Markdown as a row shows it (src/lib/inline-md.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { markdown, formats } from '../src/lib/notes-editor.js';
import { inlineMarkdown } from '../src/lib/inline-md.js';

function fakeView(doc, anchor, head = anchor) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [markdown] }),
    dispatch(...specs) {
      const tr = specs[0] instanceof Transaction ? specs[0] : view.state.update(...specs);
      view.state = tr.state;
    },
  };
  return view;
}
const text = (v) => v.state.doc.toString();
const run = (name, doc, a, b) => { const v = fakeView(doc, a, b); formats[name](v); return v; };

test('a heading, on and off, and one level for another', () => {
  assert.equal(text(run('heading2', 'Plan', 2)), '## Plan');
  assert.equal(text(run('heading2', '## Plan', 4)), 'Plan');
  assert.equal(text(run('heading1', '### Plan', 5)), '# Plan');
});

test('lists over every line the selection touches; again takes them off', () => {
  const doc = 'milk\neggs\nbread';
  assert.equal(text(run('bullets', doc, 0, doc.length)), '- milk\n- eggs\n- bread');
  assert.equal(text(run('numbers', doc, 0, doc.length)), '1. milk\n2. eggs\n3. bread');
  assert.equal(text(run('tasks', doc, 0, doc.length)), '- [ ] milk\n- [ ] eggs\n- [ ] bread');
  assert.equal(text(run('bullets', '- milk\n- eggs', 0, 13)), 'milk\neggs');
  // one kind of list becomes another, rather than one inside the other
  assert.equal(text(run('numbers', '- milk\n- [ ] eggs', 0, 17)), '1. milk\n2. eggs');
  assert.equal(text(run('tasks', '  - milk', 4)), '  - [ ] milk', 'indentation kept');
});

test('quote, code block and link', () => {
  assert.equal(text(run('quote', 'said so', 0)), '> said so');
  assert.equal(text(run('quote', '> said so', 3)), 'said so');
  assert.equal(text(run('codeBlock', 'npm ci', 0, 6)), '```\nnpm ci\n```');
  const l = run('link', 'see the docs here', 8, 12);
  assert.equal(text(l), 'see the [docs]() here');
  assert.equal(l.state.selection.main.head, 15, 'the caret where the address goes');
  assert.equal(text(run('link', 'https://x.org', 0, 13)), '[](https://x.org)');
});

test('a title\'s Markdown, as a row shows it', () => {
  assert.equal(inlineMarkdown('Order **supplies** for *the* office'), 'Order <strong>supplies</strong> for <em>the</em> office');
  assert.equal(inlineMarkdown('==now== and ~~later~~ and `a*b*c`'), '<mark>now</mark> and <s>later</s> and <code>a*b*c</code>');
  assert.equal(inlineMarkdown('see [the brief](https://x.org/a?b=1&c=2)'), 'see <a href="https://x.org/a?b=1&amp;c=2" class="tlink">the brief</a>');
  assert.equal(inlineMarkdown('read https://x.org/page.'), 'read <a href="https://x.org/page" class="tlink">https://x.org/page</a>.');
  assert.equal(inlineMarkdown('2*3*4 and snake_case_name'), '2*3*4 and snake_case_name', 'no emphasis inside words');
});

test('a title can put no markup of its own into the page', () => {
  assert.equal(inlineMarkdown('<img src=x onerror=alert(1)> **b**'), '&lt;img src=x onerror=alert(1)&gt; <strong>b</strong>');
  assert.equal(inlineMarkdown('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inlineMarkdown('`<b>`'), '<code>&lt;b&gt;</code>');
  assert.ok(!inlineMarkdown('[a"b](https://x.org/"onmouseover="x)').includes('" onmouseover'));
});
