// The notes editor's commands, run against a bare EditorState: what ⌘B does to
// a selection, what Return does in a list, and which address a link goes to.
// The rendering is checked in a real browser by tools/e2e_notes.py; these pin
// down the text each command leaves behind. They need the CodeMirror packages,
// so `npm install` first (the build needs them anyway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { markdown, toggleWrap, continueMarkup, linkAt } from '../src/lib/notes-editor.js';

/** Just enough of an EditorView for a command: a state, and dispatch. */
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
const sel = (v) => [v.state.selection.main.from, v.state.selection.main.to];

test('⌘B wraps the selection and keeps it selected', () => {
  const v = fakeView('call Dana today', 5, 9);
  toggleWrap('**')(v);
  assert.equal(text(v), 'call **Dana** today');
  assert.deepEqual(sel(v), [7, 11]);
});

test('⌘B again unwraps it, whether or not the stars were selected too', () => {
  const inside = fakeView('call **Dana** today', 7, 11);
  toggleWrap('**')(inside);
  assert.equal(text(inside), 'call Dana today');
  const withStars = fakeView('call **Dana** today', 5, 13);
  toggleWrap('**')(withStars);
  assert.equal(text(withStars), 'call Dana today');
});

test('with nothing selected, the marks go either side of the caret', () => {
  const v = fakeView('a  b', 2);
  toggleWrap('==')(v);
  assert.equal(text(v), 'a ==== b');
  assert.deepEqual(sel(v), [4, 4]);
});

test('Return in a bullet list makes the next bullet', () => {
  const v = fakeView('- milk', 6);
  assert.equal(continueMarkup(v), true);
  assert.equal(text(v), '- milk\n- ');
});

test('Return in a numbered list counts on', () => {
  const v = fakeView('9. nine', 7);
  continueMarkup(v);
  assert.equal(text(v), '9. nine\n10. ');
});

test('Return in a task list makes an open box, even after a ticked one', () => {
  const v = fakeView('- [x] done', 10);
  continueMarkup(v);
  assert.equal(text(v), '- [x] done\n- [ ] ');
});

test('Return on an empty item ends the list', () => {
  const v = fakeView('- milk\n- ', 9);
  continueMarkup(v);
  assert.equal(text(v), '- milk\n');
});

test('Return keeps a quote going', () => {
  const v = fakeView('> quoted', 8);
  continueMarkup(v);
  assert.equal(text(v), '> quoted\n> ');
});

test('outside a list, Return is left to the plain newline', () => {
  const v = fakeView('just text', 9);
  assert.equal(continueMarkup(v), false);
  assert.equal(text(v), 'just text');
});

test('a link goes to its address, a bare one to itself', () => {
  const s = EditorState.create({ doc: 'see [the brief](https://example.com/b) or www.example.org', extensions: [markdown] });
  assert.equal(linkAt(s, 6), 'https://example.com/b');
  assert.equal(linkAt(s, s.doc.length - 3), 'https://www.example.org');
  assert.equal(linkAt(s, 1), null);
});

test('a javascript: link goes nowhere', () => {
  const s = EditorState.create({ doc: '[x](javascript:alert(1))', extensions: [markdown] });
  assert.equal(linkAt(s, 1), null);
});
