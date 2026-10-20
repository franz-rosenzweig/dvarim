// Keeping what is being typed into above the keyboard.
//
// A card near the bottom of a list is exactly where the keyboard lands, and the
// page has no say in when that happens: the keyboard arrives some time after
// the field takes focus, so scrolling at focus time measures a window that is
// still full height and moves by the wrong amount — or by nothing at all.
//
// visualViewport says when it has actually arrived, and how much room is left.
// So wait for that, then put the field in the room that remains. With
// interactive-widget=resizes-content (index.html) the layout shrinks too, which
// is what lets the list scroll far enough to do it.
const MARGIN = 12;

/** What the keyboard comes up for. */
const typable = (el) => !!el && el.matches('input, textarea, [contenteditable]');

/** @param {HTMLElement} node  the pane whose scrolling we own */
export function keepAboveKeyboard(node) {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return { destroy() {} };
  let timer = null;
  /** The window's height with nothing being typed into: no keyboard. */
  let rest = window.innerHeight;

  /**
   * Say whether the keyboard is taking room, and mark the app while it is:
   * things that live at the bottom of the screen have to get out of its way,
   * and CSS cannot ask. Returns the same answer for the caller below.
   *
   * Two ways to tell, because each misses a case the other catches.
   *
   * The keyboard shortens the visual viewport, so it ends up shorter than the
   * layout one. By its height, that is — not by where its bottom sits: once the
   * keyboard is up the browser pans the visual viewport down to keep the caret
   * in view, and measuring height + offsetTop read a 15 px pan as the keyboard
   * having gone, so the Move/Delete capsule came back and sat on it, on about
   * half of all openings. At the zoom it is at, too, or a pinch reads as a
   * keyboard.
   *
   * But the Android shell shortens the window itself for the keyboard
   * (ImeInsets.java), so the layout viewport shrinks with it and all that is
   * left of the difference is the navigation bar the keyboard overlaps — 14 px
   * with gesture navigation, and nothing on a phone that has none. So also: the
   * window is much shorter than it was when nothing was being typed into. 120 px
   * is more than any browser chrome that comes and goes, and less than any
   * keyboard.
   */
  function mark() {
    const typing = typable(document.activeElement);
    if (!typing) rest = window.innerHeight;
    const up = vv.height * vv.scale < window.innerHeight - 1 || (typing && window.innerHeight < rest - 120);
    const el = node.closest('.app') || document.querySelector('.app');
    if (el) el.classList.toggle('kb', up);
    return up;
  }

  function settle() {
    // Only while the keyboard is actually taking room. These events fire as it
    // leaves as well, and a scroll started then is still running when the next
    // gesture begins — which the browser reads as "the list is moving", takes
    // the touch, and the pull or the swipe that followed did nothing.
    if (!mark()) return;
    const room = vv.height + vv.offsetTop;
    const el = document.activeElement;
    if (!el || !node.contains(el) || !typable(el)) return;
    const over = el.getBoundingClientRect().bottom + MARGIN - room;
    if (over > 0) node.scrollBy({ top: over, behavior: 'smooth' });
  }

  // Both, because the keyboard animates: resize says how tall the window is now,
  // and the last one wins.
  function later() {
    // The mark is what the capsule watches, so it goes at once; the scroll can
    // wait for the keyboard to stop moving.
    mark();
    clearTimeout(timer);
    timer = setTimeout(settle, 60);
  }

  vv.addEventListener('resize', later);
  vv.addEventListener('scroll', later);
  document.addEventListener('focusin', later);
  return {
    destroy() {
      const el = node.closest('.app') || document.querySelector('.app');
      if (el) el.classList.remove('kb');
      clearTimeout(timer);
      vv.removeEventListener('resize', later);
      vv.removeEventListener('scroll', later);
      document.removeEventListener('focusin', later);
    }
  };
}
