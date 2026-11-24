// Date helpers. All dates are handled as ISO strings ("2026-05-01") and computed in UTC,
// so the results never shift because of the visitor's time zone or daylight saving time.

export const DAY_MS = 86_400_000;
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const pad = (n) => String(n).padStart(2, '0');

export function isoToUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export const utcToIso = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => utcToIso(isoToUTC(iso) + n * DAY_MS);
export const dayOfWeek = (iso) => new Date(isoToUTC(iso)).getUTCDay();
export const diffDays = (a, b) => Math.round((isoToUTC(b) - isoToUTC(a)) / DAY_MS);
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
export const isoOf = (year, month, day) => `${year}-${pad(month + 1)}-${pad(day)}`;

/** Today's date in the visitor's own time zone. */
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidIso(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return utcToIso(isoToUTC(iso)) === iso;
}

/** "May 1" (or "May 1, 2027" when withYear is true). */
export function fmtShort(iso, withYear = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** "Fri, May 1" */
export const fmtDay = (iso) => `${DOW_SHORT[dayOfWeek(iso)]}, ${fmtShort(iso)}`;

/** "May 1 to May 5", adding the year when the range crosses into another year. */
export function fmtRange(a, b) {
  const crosses = a.slice(0, 4) !== b.slice(0, 4);
  return `${fmtShort(a, crosses)} to ${fmtShort(b, crosses)}`;
}

/** Inclusive list of ISO dates from a to b. */
export function rangeIso(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}
