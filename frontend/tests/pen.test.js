import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPen, resetPen, penNear, lastPointerType } from '../src/lib/pen.js';

// A clock the test moves, and a window that is only an EventTarget: what the
// page would hear is whatever reaches a listener added after installPen's.
let t = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => t }, configurable: true });

function fakeWindow() {
  const win = new EventTarget();
  installPen(win);
  const heard = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove']) {
    win.addEventListener(type, (e) => heard.push(`${type}:${e.pointerType || e.who}`));
  }
  return { win, heard };
}

function pointer(win, type, fields) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerId: 1, width: 12, height: 12, ...fields });
  win.dispatchEvent(e);
  return e;
}

function touch(win, type, touches, who = 'finger') {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { changedTouches: touches, who });
  win.dispatchEvent(e);
  return e;
}

beforeEach(() => { resetPen(); t = 1000; });

test('a finger on its own is the page\'s, and a palm-sized contact never is', () => {
  const { win, heard } = fakeWindow();
  pointer(win, 'pointerdown', { pointerType: 'touch' });
  pointer(win, 'pointerup', { pointerType: 'touch' });
  pointer(win, 'pointerdown', { pointerType: 'touch', pointerId: 2, width: 64, height: 50 });
  pointer(win, 'pointermove', { pointerType: 'touch', pointerId: 2 });
  pointer(win, 'pointerup', { pointerType: 'touch', pointerId: 2 });
  assert.deepEqual(heard, ['pointerdown:touch', 'pointerup:touch'], 'the palm, start to finish, was never heard');
});

test('while a pen is near, a finger is a resting hand; a moment after it goes, a finger again', () => {
  const { win, heard } = fakeWindow();
  pointer(win, 'pointermove', { pointerType: 'pen', pointerId: 9 });       // hovering
  assert.ok(penNear());
  t += 200;
  pointer(win, 'pointerdown', { pointerType: 'touch', pointerId: 3 });
  pointer(win, 'pointerup', { pointerType: 'touch', pointerId: 3 });
  t += 700;
  assert.ok(!penNear());
  pointer(win, 'pointerdown', { pointerType: 'touch', pointerId: 4 });
  assert.deepEqual(heard, ['pointermove:pen', 'pointerdown:touch']);
});

test('the pen itself is always heard, and says what pressed last', () => {
  const { win, heard } = fakeWindow();
  pointer(win, 'pointerdown', { pointerType: 'pen', pointerId: 5, width: 1, height: 1 });
  pointer(win, 'pointerup', { pointerType: 'pen', pointerId: 5 });
  assert.deepEqual(heard, ['pointerdown:pen', 'pointerup:pen']);
  assert.equal(lastPointerType(), 'pen');
});

test('a resting hand neither scrolls nor taps; the pen\'s own touches pass', () => {
  const { win } = fakeWindow();
  const finger = { touchType: 'direct', radiusX: 6, radiusY: 6 };
  const stylus = { touchType: 'stylus', radiusX: 0.5, radiusY: 0.5 };
  assert.equal(touch(win, 'touchstart', [finger]).defaultPrevented, false, 'no pen: a finger scrolls');
  assert.equal(touch(win, 'touchstart', [{ touchType: 'direct', radiusX: 30, radiusY: 26 }]).defaultPrevented, true, 'a palm does not');
  pointer(win, 'pointermove', { pointerType: 'pen' });
  assert.equal(touch(win, 'touchstart', [stylus], 'pen').defaultPrevented, false);
  assert.equal(touch(win, 'touchstart', [finger]).defaultPrevented, true);
  assert.equal(touch(win, 'touchmove', [finger]).defaultPrevented, true);
});
