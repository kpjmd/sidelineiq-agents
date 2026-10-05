/**
 * Calendar-date arithmetic for the ledger. Every date the resolution rules
 * compare is a `YYYY-MM-DD` string on the NFL's local calendar
 * (America/New_York) — never a UTC instant. The one place an instant matters is
 * a freeze point (spec "Freeze point per field"), and the only freeze point that
 * is a clock time rather than a date is F2's kickoff; `etToUtcIso` builds it.
 *
 * Pure. No imports.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function assertIsoDate(value: string, what: string): void {
  if (!isIsoDate(value)) throw new Error(`${what} is not a YYYY-MM-DD date: ${JSON.stringify(value)}`);
}

/** Days from the Unix epoch, for order and difference. */
function epochDays(date: IsoDate): number {
  const m = ISO_DATE_RE.exec(date)!;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  assertIsoDate(date, 'date');
  if (!Number.isInteger(days)) throw new Error(`days must be an integer: ${days}`);
  return new Date((epochDays(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** b − a in whole days. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  assertIsoDate(a, 'a');
  assertIsoDate(b, 'b');
  return epochDays(b) - epochDays(a);
}

export function compareDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  assertIsoDate(a, 'a');
  assertIsoDate(b, 'b');
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The America/New_York calendar date of an instant. `en-CA` formats as
 * YYYY-MM-DD. Same trick as `localCalendarDate` in season-calendar.ts; copied
 * rather than imported so this module stays dependency-free.
 */
export function etCalendarDate(instant: Date): IsoDate {
  return instant.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The UTC instant of a wall-clock time in America/New_York, as an ISO string.
 * `time` is `HH:MM` (24h). Needed for F2's freeze point: `games.csv` gives
 * `gameday` + `gametime` in Eastern time.
 *
 * Method: guess the instant as if the wall time were UTC, read back what that
 * instant is in New York, and shift by the difference. One correction is exact
 * except across a DST transition hour, where a second pass settles it.
 */
export function etToUtcIso(date: IsoDate, time: string): string {
  assertIsoDate(date, 'date');
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!tm) throw new Error(`time is not HH:MM: ${JSON.stringify(time)}`);
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = [Number(tm[1]), Number(tm[2])];
  const wall = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const seen = wallClockMsInNewYork(new Date(guess));
    guess += wall - seen;
  }
  return new Date(guess).toISOString();
}

function wallClockMsInNewYork(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/**
 * The instant at which a calendar day ENDS on the New York calendar: the first
 * moment of the next day, as UTC. Used for "day 7" and "day 28" freeze points,
 * which the spec states as days, so the field is still forecastable until that
 * day has fully passed.
 */
export function endOfEtDayIso(date: IsoDate): string {
  return etToUtcIso(addDays(date, 1), '00:00');
}

/** Lexicographic compare of two ISO instants is chronological when both are UTC `Z` strings. */
export function compareInstants(a: string, b: string): -1 | 0 | 1 {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error(`not an instant: ${JSON.stringify([a, b])}`);
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}
