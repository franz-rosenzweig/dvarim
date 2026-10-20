// The three ways an operation refuses, as the Python's are: something named
// is not there (NotFound → 404), it would collide with something that is
// (Conflict → 409), or what was asked is not a thing that can be done
// (Invalid → 400; the Python's ValueError).
export class NotFound extends Error {}
export class Conflict extends Error {}
export class Invalid extends Error {}

// Not a refusal but a crash, as it is in the Python: a file the store counts
// on is not in its index — Inbox.md given a project's front matter and then
// trashed, say. Python's self.files[path] raises KeyError there, a 500; this
// is that KeyError, raised at the same moment (before any id is handed out).
export class Missing extends Error {
  constructor(path) { super(`'${path}'`); this.name = 'KeyError'; }
}
