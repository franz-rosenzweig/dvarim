// The sandbox server's clock for the pictures, loaded with
// `node --import /shots/clock.mjs server/src/main.js`.
//
// The docs name weekdays ("Tuesday with an event", "yesterday, Friday,
// Thursday"), so the pictures are taken as of the same weekday every time.
// DVARIM_SHOTS_CLOCK_OFFSET is how far, in milliseconds, this server's clock is
// moved from the real one; the page gets the same offset from shoot.py, so the
// two agree on today. Never load this into a server that holds real to-dos.
const offset = Number(process.env.DVARIM_SHOTS_CLOCK_OFFSET || 0);

if (offset) {
  const Real = Date;
  function ShotDate(...args) {
    if (!new.target) return new Real(Real.now() + offset).toString();
    return args.length ? new Real(...args) : new Real(Real.now() + offset);
  }
  ShotDate.prototype = Real.prototype;
  ShotDate.now = () => Real.now() + offset;
  ShotDate.parse = Real.parse;
  ShotDate.UTC = Real.UTC;
  globalThis.Date = ShotDate;
}
