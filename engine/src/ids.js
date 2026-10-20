import { sha1 } from './sha1.js';

// Ids, in the server's own alphabet and shape (backend/dvarim/ids.py): eight of
// 0-9a-z, a project's starting with "p" and an area's with "a". Chosen without
// the modulo bias of `byte % 36`: bytes from 252 up are thrown back.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(prefix = '', length = 8) {
  let id = prefix;
  while (id.length < length) {
    const bytes = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= 252) continue;
      id += ALPHABET[b % 36];
      if (id.length >= length) break;
    }
  }
  return id;
}

/** The id a line typed without one is given (store.py, line_id): made from the
 *  line itself — its temporary id, which is its file, heading, title and place
 *  among its twins — so every copy of Dvarim that meets the line names it the
 *  same, and a line typed in Obsidian on one device is not a to-do per device
 *  once the sync brings their files together. On a clash, the next candidate,
 *  the same next candidate everywhere. */
export function lineId(tmp, taken) {
  for (let n = 0; ; n++) {
    const hex = sha1(`${tmp}|${n}`);
    let cand = '';
    for (let i = 0; i < 8; i++) cand += ALPHABET[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 36];
    if (!taken.has(cand)) return cand;
  }
}

/** An id made from `seed` alone, with `prefix` ("p" for a project, "a" for an
 *  area): the same everywhere, as lineId's are, and not one of `taken`. For
 *  the copy of something whose id another file already holds (Store._repairIds). */
export function derivedId(seed, taken, prefix = '') {
  for (let n = 0; ; n++) {
    const cand = prefix + lineId(`${seed}|${n}`, { has: () => false }).slice(prefix.length);
    if (!taken.has(cand)) return cand;
  }
}
