// Break optimizer - the "Suggest the best leave days" logic (Level 4).
//
// 1. buildDays()   turns holidays, weekends and the user's custom days into one array of days.
// 2. findBreaks()  lists every possible break: a run of days that starts and ends right next to
//                  a normal working day, and needs at most `maxLeave` leave days.
// 3. rankBreaks()  sorts the breaks (best value or longest) and keeps the ones that do not overlap.
// 4. planYear()    spreads a whole year's leave allowance over several breaks to get the most
//                  days off in total (dynamic programming, like a knapsack problem).
//
// Pure functions only (no DOM), so the same file runs in the browser and in `npm test`.

import { addDays, dayOfWeek } from './dates.js';

/**
 * @param {object} o
 * @param {number} o.year
 * @param {Array}  o.holidays    Nager.Date holidays ({date, name, global}) - may include next January
 * @param {Array}  o.customDays  [{date, type: 'off' | 'busy', label}]
 * @param {number[]} o.weekend   weekend day numbers, e.g. [0, 6] for Sun + Sat
 * @param {number} o.extendDays  extra days of next year, so Christmas-New Year breaks are found
 */
export function buildDays({ year, holidays = [], customDays = [], weekend = [0, 6], extendDays = 14 }) {
  const nationwide = new Map();
  const regional = new Map();
  for (const h of holidays) {
    const target = h.global === false ? regional : nationwide;
    if (!target.has(h.date)) target.set(h.date, []);
    target.get(h.date).push(h);
  }
  const custom = new Map(customDays.map((c) => [c.date, c]));
  const first = `${year}-01-01`;
  const nextYear = `${year + 1}-01-01`;
  const last = addDays(nextYear, extendDays - 1);
  const days = [];
  for (let iso = first, i = 0; iso <= last; iso = addDays(iso, 1), i++) {
    const dow = dayOfWeek(iso);
    const hol = nationwide.get(iso) ?? [];
    const c = custom.get(iso) ?? null;
    const isWeekend = weekend.includes(dow);
    const off = isWeekend || hol.length > 0 || c?.type === 'off';
    days.push({
      i,
      iso,
      dow,
      inYear: iso < nextYear,
      weekend: isWeekend,
      holidays: hol,
      regional: regional.get(iso) ?? [],
      custom: c,
      off, // a free day: no leave needed
      blocked: !off && c?.type === 'busy', // a day the user cannot take off (exam, deadline ...)
    });
  }
  return days;
}

const isWorkday = (d) => d && !d.off;

/** Build a break object for days[s..e]. */
export function makeBreak(days, s, e) {
  const slice = days.slice(s, e + 1);
  const leaveDates = slice.filter((d) => !d.off).map((d) => d.iso);
  const length = e - s + 1;
  const leave = leaveDates.length;
  const names = [...new Set(slice.flatMap((d) => d.holidays.map((h) => h.name)))];
  return {
    s,
    e,
    start: days[s].iso,
    end: days[e].iso,
    length,
    leave,
    leaveDates,
    holidayNames: names,
    efficiency: leave === 0 ? Infinity : length / leave,
  };
}

/** Break that covers the dates start..end (used for shared plans and manual ranges). */
export function breakFromRange(days, start, end) {
  const s = days.findIndex((d) => d.iso === start);
  const e = days.findIndex((d) => d.iso === end);
  if (s < 0 || e < 0 || e < s) return null;
  return makeBreak(days, s, e);
}

/**
 * Every break that needs 0..maxLeave leave days.
 * A break is "maximal": the day before it and the day after it are working days,
 * so it already includes all the free days that touch it.
 */
export function findBreaks(days, maxLeave, { minLength = 3, maxLength = 31, fromIso = null, includeFree = true } = {}) {
  const out = [];
  for (let s = 0; s < days.length; s++) {
    if (!days[s].inYear) break; // a break must start inside the chosen year
    if (fromIso && days[s].iso < fromIso) continue;
    if (s > 0 && !isWorkday(days[s - 1])) continue; // left edge must touch a working day
    if (days[s].blocked) continue;
    let leave = 0;
    for (let e = s; e < days.length && e - s < maxLength; e++) {
      if (days[e].blocked) break;
      if (!days[e].off) leave++;
      if (leave > maxLeave) break;
      const rightEdge = e === days.length - 1 || isWorkday(days[e + 1]);
      if (!rightEdge) continue;
      const length = e - s + 1;
      if (length < minLength || leave === length) continue; // must contain at least one free day
      if (leave === 0 && !includeFree) continue;
      out.push(makeBreak(days, s, e));
    }
  }
  return out;
}

const overlaps = (a, b) => a.s <= b.e && b.s <= a.e;

const COMPARE = {
  value: (a, b) => b.efficiency - a.efficiency || b.length - a.length || a.s - b.s,
  longest: (a, b) => b.length - a.length || b.efficiency - a.efficiency || a.s - b.s,
  soonest: (a, b) => a.s - b.s || b.efficiency - a.efficiency,
};

/** Sort breaks and greedily keep the best ones that do not overlap each other. */
export function rankBreaks(breaks, { sort = 'value', limit = 12 } = {}) {
  // "soonest" still picks the best-value breaks first, then shows them in date order.
  const ranked = [...breaks].sort(sort === 'longest' ? COMPARE.longest : COMPARE.value);
  const chosen = [];
  for (const b of ranked) {
    if (chosen.length >= limit) break;
    if (!chosen.some((c) => overlaps(c, b))) chosen.push(b);
  }
  if (sort === 'soonest') chosen.sort(COMPARE.soonest);
  return chosen;
}

/** The best break that contains a given day (used when the user clicks the calendar). */
export function bestBreakForDay(breaks, iso) {
  return breaks.filter((b) => b.start <= iso && iso <= b.end).sort(COMPARE.value)[0] ?? null;
}

/**
 * Spend an annual leave allowance on several non-overlapping breaks so that the total
 * number of days off is as large as possible.
 *
 * Weighted interval scheduling with a budget (dynamic programming):
 *   best[j][b] = most days off using only the first j breaks (sorted by end) and b leave days
 *   best[j][b] = max( best[j-1][b],                                 // skip break j
 *                     best[p(j)][b - leave_j] + length_j )          // take break j
 * where p(j) is the number of breaks that end before break j starts.
 * Ties are broken in favour of using fewer leave days.
 */
export function planYear(days, budget, { maxLeavePerBreak = 9, fromIso = null, minLength = 4 } = {}) {
  budget = Math.max(0, Math.min(60, Math.floor(budget)));
  const cands = findBreaks(days, Math.min(budget, maxLeavePerBreak), { fromIso, minLength, includeFree: false })
    .filter((b) => b.leave >= 1)
    .sort((a, b) => a.e - b.e || a.s - b.s);
  const n = cands.length;
  const ends = cands.map((c) => c.e);
  // p[j]: how many breaks end strictly before cands[j] starts (binary search on sorted ends)
  const p = cands.map((c) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] < c.s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  });
  // score = daysOff * 1000 - leaveUsed  (more days off first, then less leave)
  const W = budget + 1;
  const best = new Float64Array((n + 1) * W);
  const take = new Uint8Array((n + 1) * W);
  for (let j = 1; j <= n; j++) {
    const c = cands[j - 1];
    for (let b = 0; b <= budget; b++) {
      let v = best[(j - 1) * W + b];
      if (c.leave <= b) {
        const withIt = best[p[j - 1] * W + b - c.leave] + c.length * 1000 - c.leave;
        if (withIt > v) {
          v = withIt;
          take[j * W + b] = 1;
        }
      }
      best[j * W + b] = v;
    }
  }
  const breaks = [];
  for (let j = n, b = budget; j > 0;) {
    if (take[j * W + b]) {
      const c = cands[j - 1];
      breaks.push(c);
      b -= c.leave;
      j = p[j - 1];
    } else j--;
  }
  breaks.reverse();
  const totalLeave = breaks.reduce((s, b) => s + b.leave, 0);
  const totalOff = breaks.reduce((s, b) => s + b.length, 0);
  return { breaks, totalLeave, totalOff, unused: budget - totalLeave, efficiency: totalLeave ? totalOff / totalLeave : 0 };
}

/** Holidays per month (nationwide only, inside the year). */
export function holidaysPerMonth(days) {
  const counts = new Array(12).fill(0);
  for (const d of days) if (d.inYear && d.holidays.length) counts[Number(d.iso.slice(5, 7)) - 1]++;
  return counts;
}

/** Summary numbers for the year. */
export function yearSummary(days) {
  const y = days.filter((d) => d.inYear);
  const holidaysOnWorkdays = y.filter((d) => d.holidays.length && !d.weekend).length;
  return {
    totalDays: y.length,
    freeDays: y.filter((d) => d.off).length,
    holidays: y.filter((d) => d.holidays.length).length,
    holidaysOnWeekend: y.filter((d) => d.holidays.length && d.weekend).length,
    holidaysOnWorkdays,
    workdays: y.filter((d) => !d.off).length,
  };
}

/** Format efficiency like the proposal: "2.5x" (or "Free"). */
export function fmtEfficiency(b) {
  if (b.leave === 0) return 'Free';
  const v = Math.round(b.efficiency * 10) / 10;
  return `${v}x`;
}
