// Reminders at a to-do's ⏰ on its When day (backend/dvarim/notify.py, ported).
//
// Ticked by the watcher every few seconds. Delivery over Signal, through
// signal-cli-rest-api (DVARIM_SIGNAL_URL) or the host's signal-cli
// (DVARIM_SIGNAL_CLI), both with DVARIM_SIGNAL_FROM / DVARIM_SIGNAL_TO; with
// neither, a reminder is only logged. What was sent is kept in state.json per
// day, so a restart never sends one twice.
import { execFile } from 'node:child_process';

/** How to send, from the environment, or null. */
export function makeSender(env = process.env) {
  const from = env.DVARIM_SIGNAL_FROM, to = env.DVARIM_SIGNAL_TO;
  const url = env.DVARIM_SIGNAL_URL, cli = env.DVARIM_SIGNAL_CLI;
  if (url && from && to) {
    return async (text) => {
      const res = await fetch(url.replace(/\/+$/u, '') + '/v2/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, number: from, recipients: [to] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Signal answered ${res.status}`);
    };
  }
  if (cli && from && to) {
    return (text) => new Promise((resolve, reject) => {
      execFile(cli, ['-a', from, 'send', '-m', text, to], { timeout: 60000 }, (err) => (err ? reject(err) : resolve()));
    });
  }
  return null;
}

export function formatReminder(todo) {
  let line = `⏰ ${todo.title}`;
  if (todo.projectName) line += ` · ${todo.projectName}`;
  if (todo.deadline) line += ` · deadline ${todo.deadline}`;
  const notes = (todo.notes || '').trim().split('\n')[0];
  // notes[:160]: code points, as Python slices
  if (notes) line += `\n${[...notes].slice(0, 160).join('')}`;
  return line;
}

const pad = (n) => String(n).padStart(2, '0');
/** Local date and HH:MM, the way Python's datetime.now() reads the clock. */
export const localParts = (d) => ({
  day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
});

export class Reminders {
  /**
   * @param {import('../../engine/src/store.js').Store} store
   * @param {((text: string) => Promise<void>|void)|null} sender
   * @param {() => Date} [nowFn]
   */
  constructor(store, sender = null, nowFn = () => new Date()) {
    this.store = store;
    this.sender = sender;
    this.nowFn = nowFn;
    this.log = [];
  }

  _sent(day) {
    const state = this.store.state;
    if (!state.remindersSent || typeof state.remindersSent !== 'object') state.remindersSent = {};
    const sent = state.remindersSent;
    for (const k of Object.keys(sent)) if (k < day) delete sent[k];     // forget older days
    if (!Array.isArray(sent[day])) sent[day] = [];
    return sent[day];
  }

  due(now = this.nowFn()) {
    const { day, hhmm } = localParts(now);
    const sent = new Set(this._sent(day));
    const out = [];
    for (const [f, t] of this.store.openTodos()) {
      if (t.reminder && t.when === day && t.reminder <= hhmm && !sent.has(t.id) && !t.id.startsWith('tmp')) {
        out.push(this.store.todoJson(t, f));
      }
    }
    return out;
  }

  async tick(now = this.nowFn()) {
    const fired = [];
    const { day } = localParts(now);
    const stamp = `${day}T${localParts(now).hhmm}`;
    for (const todo of this.due(now)) {
      const text = formatReminder(todo);
      try {
        if (this.sender) await this.sender(text);
        this.log.push(`${stamp} ${text.split('\n')[0]}`);
        this._sent(day).push(todo.id);
        fired.push(todo);
      } catch (e) {
        this.log.push(`${stamp} FAILED ${todo.title}: ${e && e.message ? e.message : e}`);   // again next tick
      }
    }
    if (fired.length) this.store.saveState();
    return fired;
  }
}
