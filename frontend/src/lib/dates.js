// Date helpers. All dates are YYYY-MM-DD strings in the server's local zone.
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function toISO(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
export function todayISO() {
  return toISO(new Date());
}
export function addDays(iso, n) {
  const x = parseISO(iso);
  x.setDate(x.getDate() + n);
  return toISO(x);
}
/** b - a in whole days */
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}
export function weekday(iso) {
  return DAYS[parseISO(iso).getDay()];
}
export function weekdayShort(iso) {
  return weekday(iso).slice(0, 3);
}
export function monthName(iso) {
  return MONTHS[parseISO(iso).getMonth()];
}
/** "24 Sep", with the year appended when it differs from today's */
export function shortDate(iso, today) {
  const x = parseISO(iso);
  let s = `${x.getDate()} ${MONTHS[x.getMonth()].slice(0, 3)}`;
  if (today && x.getFullYear() !== parseISO(today).getFullYear()) s += ` ${x.getFullYear()}`;
  return s;
}
/** "Sat 19 Sep" as used on the When popover's rows */
export function labelDate(iso) {
  const x = parseISO(iso);
  return `${DAYS[x.getDay()].slice(0, 3)} ${x.getDate()} ${MONTHS[x.getMonth()].slice(0, 3)}`;
}
/** Label for a start date: Today, Tomorrow, weekday within the week, then "24 Sep" */
export function whenLabel(iso, today) {
  const n = daysBetween(today, iso);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n < 7) return weekday(iso);
  return shortDate(iso, today);
}
/** Deadline flag text: today / yesterday / N days ago (red), tomorrow / N days left */
export function relDeadline(dl, today) {
  const n = daysBetween(today, dl);
  if (n === 0) return { text: 'today', red: true };
  if (n < 0) return { text: n === -1 ? 'yesterday' : `${-n} days ago`, red: true };
  if (n === 1) return { text: 'tomorrow', red: false };
  return { text: `${n} days left`, red: false };
}
/** Logbook group label: Today, Yesterday, weekday within the last week, else short date */
export function pastLabel(iso, today) {
  const n = daysBetween(iso, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n > 1 && n < 7) return weekday(iso);
  return shortDate(iso, today);
}
/** First day of next week, strictly after today */
export function nextWeekStart(today, weekStartsOn = 1) {
  const dow = parseISO(today).getDay();
  let n = (weekStartsOn - dow + 7) % 7;
  if (n === 0) n = 7;
  return addDays(today, n);
}
/** Cells for a month grid: leading blanks (null) then day numbers, week starting on `weekStartsOn` */
export function monthGrid(year, month, weekStartsOn = 0) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return cells;
}
/** "15:00" stays 24-hour; strips seconds if present */
export function fmtTime(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}
