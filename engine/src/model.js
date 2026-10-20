// The model of one Markdown task file (docs/FORMAT.md). Field for field the
// Python in backend/dvarim/model.py, so the two can be compared as they are.

export class ChecklistItem {
  constructor(text, done = false) {
    this.text = text;
    this.done = done;
  }
}

export class Todo {
  constructor(fields = {}) {
    this.id = fields.id ?? null;
    this.title = fields.title ?? '';
    this.status = fields.status ?? 'open';     // open | done | canceled
    this.mark = fields.mark ?? null;           // an open to-do's box when not [ ]: '/' in progress (mdformat.js)
    this.notes = fields.notes ?? '';
    this.tags = fields.tags ?? [];
    this.when = fields.when ?? null;           // ⏳ YYYY-MM-DD
    this.evening = fields.evening ?? false;    // 🌙
    this.someday = fields.someday ?? false;    // 💤
    this.reminder = fields.reminder ?? null;   // ⏰ HH:MM
    this.deadline = fields.deadline ?? null;   // 📅
    this.repeat = fields.repeat ?? null;       // 🔁
    this.created = fields.created ?? null;     // ➕
    this.completed = fields.completed ?? null; // ✅ / ❌ date
    this.checklist = fields.checklist ?? [];
    this.trashed = fields.trashed ?? null;     // 🗑️ date (Trash.md only)
    this.origin = fields.origin ?? null;       // ↩ path#heading (Trash.md only)
    // set by the parser
    this.heading = fields.heading ?? null;
    this.line = fields.line ?? 0;
  }
}

export class Heading {
  constructor(name, archived = null, line = 0) {
    this.name = name;
    this.archived = archived;                  // ✅ date
    this.line = line;
  }
}

export class Section {
  constructor(heading = null) {
    this.heading = heading;
    this.todos = [];
    this.trailing = [];                        // unrecognised top-level lines, preserved
  }
}

const LISTS = new Set(['Inbox.md', 'Standalone.md', 'Trash.md']);

export class TaskFile {
  constructor(path, frontmatter = {}) {
    this.path = path;                          // relative to the root, POSIX separators
    this.frontmatter = frontmatter;
    this.notes = '';                           // text between front matter and first heading/to-do
    this.sections = [];
    // the front matter as it was read (frontmatter.js), so what Dvarim did not
    // change is written back exactly; null for a file that had none
    this.fmRaw = null;
  }

  /** project | area | list (Inbox/Standalone/Trash) | other */
  get kind() {
    const t = this.frontmatter.type;
    if (t === 'project' || t === 'area') return t;
    const name = this.path.split('/').pop();
    if (!this.path.includes('/') && LISTS.has(name)) return 'list';
    return 'other';
  }

  get name() {
    return this.path.split('/').pop().slice(0, -3);
  }

  *allTodos() {
    for (const s of this.sections) yield* s.todos;
  }

  /** The section before any heading, created on demand. */
  lead() {
    if (this.sections.length && this.sections[0].heading === null) return this.sections[0];
    const s = new Section(null);
    this.sections.unshift(s);
    return s;
  }

  sectionFor(headingName) {
    if (headingName == null) {
      return this.sections.length && this.sections[0].heading === null ? this.sections[0] : null;
    }
    return this.sections.find((s) => s.heading && s.heading.name === headingName) || null;
  }

  /** [section, index] of the to-do, or null. */
  find(todoId) {
    for (const s of this.sections) {
      const i = s.todos.findIndex((t) => t.id === todoId);
      if (i >= 0) return [s, i];
    }
    return null;
  }
}

/** A file as plain data: what tests compare, and what the Python oracle
 *  (tools/parity/oracle.py) answers with — the two must be the same shape. */
export function fileToPlain(f) {
  const todo = (t) => ({
    id: t.id, title: t.title, status: t.status, notes: t.notes, tags: [...t.tags],
    when: t.when, evening: t.evening, someday: t.someday, reminder: t.reminder,
    deadline: t.deadline, repeat: t.repeat, created: t.created, completed: t.completed,
    checklist: t.checklist.map((c) => ({ text: c.text, done: c.done })),
    trashed: t.trashed, origin: t.origin, heading: t.heading, line: t.line,
    ...(t.mark ? { mark: t.mark } : {}),     // the Python never had one
  });
  return {
    path: f.path, kind: f.kind, frontmatter: f.frontmatter, notes: f.notes,
    sections: f.sections.map((s) => ({
      heading: s.heading ? { name: s.heading.name, archived: s.heading.archived, line: s.heading.line } : null,
      todos: s.todos.map(todo),
      trailing: [...s.trailing],
    })),
  };
}
