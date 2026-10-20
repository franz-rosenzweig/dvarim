// One to-do per project in Today, as The Organised Writer keeps it: Today is
// each project's next step, and a project with two or three there is spilling
// its list into the day. The exception is a catch-all of errands, which that
// book calls "Agenda & Admin": any project whose name has "agenda" or "admin"
// in it may put as many in Today as it likes.

const CATCHALL = /\b(agenda|admin)\b/iu;

/** The projects with more than one open to-do among `items` (Today's list),
 *  as [{id, name, count}], in the order they first appear. */
export function crowdedProjects(items) {
  const seen = new Map();
  for (const t of items || []) {
    if (!t.projectId || (t.status && t.status !== 'open')) continue;
    if (CATCHALL.test(t.projectName || '')) continue;
    const e = seen.get(t.projectId) || { id: t.projectId, name: t.projectName || 'A project', count: 0 };
    e.count += 1;
    seen.set(t.projectId, e);
  }
  return [...seen.values()].filter((e) => e.count > 1);
}
