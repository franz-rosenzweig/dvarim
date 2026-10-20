// What this browser last saw, so the app has something to show when it cannot
// reach the server.
//
// Dvarim is a window on a server: every list comes down the wire each time, and
// the service worker deliberately never caches /api, because SSE and JSON have
// to be live. That is right when there is a network and useless when there is
// not — the app opened on a plane to an empty day and a four-second error, with
// no way to tell "nothing to do" from "nothing to reach".
//
// So each read that a list is built from is kept here as it arrives, under its
// own API path, and handed back when the server cannot be reached. It is a copy
// of the last good answer and nothing cleverer: no merging, no expiry. What the
// page does with it — saying how old it is, refusing to pretend it is live — is
// the page's business.
//
// IndexedDB rather than localStorage: this is a whole vault's worth of JSON, it
// must not block the main thread, and localStorage would be full within a few
// lists. Every call degrades to "no copy" rather than throwing, because a
// private window, blocked site data or a browser mid-upgrade can all refuse to
// open a database, and none of those is a reason for the app to stop working.
const DB_NAME = 'dvarim';
const DB_VERSION = 2;
const READS = 'reads';
/** Operations waiting for the server; see lib/outbox.js. Keyed by an
 *  ascending number, which is the order they were made in and the order they
 *  must be sent in. */
const OUTBOX = 'outbox';

let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);                  // no IndexedDB at all
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(READS)) db.createObjectStore(READS);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

/** One transaction, resolving with the request's result, or null for any
 *  trouble at all. Callers treat null as "this browser keeps no copies". */
function run(mode, fn, store = READS) {
  return open().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let t;
      try {
        t = db.transaction(store, mode);
      } catch {
        resolve(null);
        return;
      }
      let request = null;
      try {
        request = fn(t.objectStore(store));
      } catch (e) {
        // The transaction still has to finish, and the caller reads null as
        // "nothing kept" — but say so: a DataCloneError swallowed here looks
        // from the outside exactly like a browser with no database at all.
        console.warn('Dvarim: could not reach the offline store', e);
      }
      t.oncomplete = () => resolve(request ? request.result : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    });
  });
}

/** Keep the answer to `key` (an API path), with the moment it was true. */
export function remember(key, data) {
  return run('readwrite', (s) => s.put({ at: Date.now(), data }, key));
}

/** `{ at, data }` as last seen, or null. */
export function recall(key) {
  return run('readonly', (s) => s.get(key));
}

/**
 * Throw all of it away.
 *
 * Signing out has to reach this: these are the person's to-dos, sitting in a
 * database the next person to open the browser could read. Clearing the cookie
 * without clearing this would leave the list on screen after "Sign out".
 */
export function forget() {
  return Promise.all([run('readwrite', (s) => s.clear()), run('readwrite', (s) => s.clear(), OUTBOX)]);
}

// ---- the outbox. The shape of what goes in is lib/outbox.js's business;
// this only keeps it, in order, with the key the store gave it.

/** Everything waiting, oldest first, each as `{ key, ...op }`. */
export async function outboxAll() {
  const [keys, values] = await Promise.all([
    run('readonly', (s) => s.getAllKeys(), OUTBOX),
    run('readonly', (s) => s.getAll(), OUTBOX)
  ]);
  if (!keys || !values) return [];
  return values.map((op, i) => ({ key: keys[i], ...op }));
}

/** Resolves with the new key, or null if nothing could be kept — in which
 *  case the caller has no business pretending the edit is safe. */
export function outboxAdd(op) {
  return run('readwrite', (s) => s.add(op), OUTBOX);
}

export function outboxRemove(key) {
  return run('readwrite', (s) => s.delete(key), OUTBOX);
}
