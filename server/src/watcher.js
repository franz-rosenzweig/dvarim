// What Obsidian, Syncthing or anyone else changes in the folder
// (backend/dvarim/watcher.py, ported): a change to a note, debounced, and
// every few seconds anyway in case the operating system missed one, makes the
// store read the folder again (and merge, docs/SYNC.md). Once a minute, lines
// typed without an id and then left alone get one; every pass, due reminders
// are sent.
import { watch } from 'node:fs';

export class Watcher {
  /**
   * @param {import('../../engine/src/store.js').Store} store
   * @param {string} root
   * @param {{debounce?: number, fallback?: number, normalizeEvery?: number, reminders?: object, onError?: Function}} [opts]
   *   times in seconds, as the Python's
   */
  constructor(store, root, opts = {}) {
    this.store = store;
    this.root = root;
    this.debounce = (opts.debounce ?? 0.3) * 1000;
    this.fallback = (opts.fallback ?? 5.0) * 1000;
    this.normalizeEvery = (opts.normalizeEvery ?? 60.0) * 1000;
    this.reminders = opts.reminders || null;
    this.onError = opts.onError || ((e) => console.error('watcher error:', e));
    this.lastNormalize = Date.now();
    this._timer = null;
    this._running = null;
    this._again = false;
    this._fs = null;
    this._interval = null;
    this.stopped = false;
  }

  start() {
    try {
      // recursive: Linux since Node 20, macOS and Windows always
      this._fs = watch(this.root, { recursive: true }, (_type, name) => {
        if (!name || name.endsWith('.md') || !name.includes('.')) this.poke();
      });
      this._fs.on('error', (e) => this.onError(e));
    } catch (e) {
      this.onError(e);                     // the fallback pass still runs
    }
    this._interval = setInterval(() => this.pass(), this.fallback);
    return this;
  }

  /** A change was seen: a pass, shortly, once the burst is over. */
  poke() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.pass(), this.debounce);
  }

  /** One pass: read the folder, name quiet lines, send due reminders. */
  async pass() {
    if (this.stopped) return;
    if (this._running) { this._again = true; return this._running; }
    this._running = (async () => {
      try {
        await this.store.scanChanges();
        this.store.writeHeld();          // what waited for its file to go quiet (Store.quietMs)
        if (Date.now() - this.lastNormalize > this.normalizeEvery) {
          this.store.normalizeQuietFiles();
          this.lastNormalize = Date.now();
        }
        if (this.reminders) await this.reminders.tick();
        await this.store.flush();
      } catch (e) {
        this.onError(e);                   // keep watching no matter what
      }
    })();
    try {
      await this._running;
    } finally {
      this._running = null;
      if (this._again) { this._again = false; this.pass(); }
    }
  }

  close() {
    this.stopped = true;
    clearTimeout(this._timer);
    clearInterval(this._interval);
    if (this._fs) this._fs.close();
  }
}
