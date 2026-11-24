// Unit tests for the break optimizer. Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDays, findBreaks, rankBreaks, planYear, breakFromRange, holidaysPerMonth, fmtEfficiency } from '../public/js/optimizer.js';
import { addDays, dayOfWeek, fmtRange, isValidIso } from '../public/js/dates.js';

// A small set of South Korea 2026 holidays (same shape as Nager.Date returns).
const KR_2026 = [
  { date: '2026-01-01', name: "New Year's Day", global: true },
  { date: '2026-03-01', name: 'Independence Movement Day', global: true },
  { date: '2026-05-05', name: "Children's Day", global: true },
  { date: '2026-06-06', name: 'Memorial Day', global: true },
  { date: '2026-08-15', name: 'Liberation Day', global: true },
  { date: '2026-10-03', name: 'National Foundation Day', global: true },
  { date: '2026-10-09', name: 'Hangul Day', global: true },
  { date: '2026-12-25', name: 'Christmas Day', global: true },
  { date: '2027-01-01', name: "New Year's Day", global: true },
];

test('date helpers work in UTC', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // leap year
  assert.equal(dayOfWeek('2026-05-01'), 5); // Friday
  assert.equal(fmtRange('2026-12-24', '2027-01-03'), 'Dec 24, 2026 to Jan 3, 2027');
  assert.ok(isValidIso('2026-02-28'));
  assert.ok(!isValidIso('2026-02-30'));
});

test('buildDays marks weekends, holidays and custom days', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026, customDays: [{ date: '2026-07-01', type: 'off' }, { date: '2026-07-02', type: 'busy' }] });
  const get = (iso) => days.find((d) => d.iso === iso);
  assert.equal(days.filter((d) => d.inYear).length, 365);
  assert.ok(get('2026-05-02').weekend && get('2026-05-02').off);
  assert.ok(get('2026-05-05').off && get('2026-05-05').holidays.length === 1);
  assert.ok(!get('2026-05-04').off);
  assert.ok(get('2026-07-01').off);
  assert.ok(get('2026-07-02').blocked);
});

test('regional holidays are shown but do not count as a day off', () => {
  const days = buildDays({ year: 2026, holidays: [{ date: '2026-03-10', name: 'Local day', global: false }] });
  const d = days.find((x) => x.iso === '2026-03-10');
  assert.equal(d.off, false);
  assert.equal(d.regional.length, 1);
});

test('proposal example: May 1 to May 5 needs 2 leave days (2.5x)', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026 });
  const all = findBreaks(days, 2);
  const may = all.find((b) => b.start === '2026-05-01' && b.end === '2026-05-05');
  assert.ok(may, 'May 1-5 break should be found');
  assert.equal(may.length, 5);
  assert.equal(may.leave, 2);
  assert.deepEqual(may.leaveDates, ['2026-05-01', '2026-05-04']);
  assert.equal(fmtEfficiency(may), '2.5x');
});

test('every break touches a working day on both sides and respects the limit', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026 });
  const all = findBreaks(days, 3);
  assert.ok(all.length > 50);
  for (const b of all) {
    assert.ok(b.leave <= 3);
    assert.ok(b.length >= 3);
    if (b.s > 0) assert.equal(days[b.s - 1].off, false);
    if (b.e < days.length - 1) assert.equal(days[b.e + 1].off, false);
  }
});

test('busy days are never used as leave', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026, customDays: [{ date: '2026-05-04', type: 'busy' }] });
  const all = findBreaks(days, 3);
  assert.ok(all.every((b) => !b.leaveDates.includes('2026-05-04')));
});

test('Christmas break can continue into next January', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026 });
  const all = findBreaks(days, 4);
  assert.ok(all.some((b) => b.start <= '2026-12-25' && b.end >= '2027-01-01'));
});

test('rankBreaks returns non-overlapping breaks sorted by value', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026 });
  const top = rankBreaks(findBreaks(days, 2, { includeFree: false }), { sort: 'value', limit: 8 });
  assert.ok(top.length > 3);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].efficiency >= top[i].efficiency);
  for (const a of top) for (const b of top) if (a !== b) assert.ok(a.e < b.s || b.e < a.s);
});

test('planYear stays within budget and beats a simple greedy choice', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026 });
  for (const budget of [1, 3, 5, 10, 15]) {
    const plan = planYear(days, budget);
    assert.ok(plan.totalLeave <= budget, `budget ${budget}`);
    for (let i = 1; i < plan.breaks.length; i++) assert.ok(plan.breaks[i - 1].e < plan.breaks[i].s);
    // greedy: take best-value breaks while budget lasts
    let left = budget;
    let greedyOff = 0;
    for (const b of rankBreaks(findBreaks(days, Math.min(budget, 9), { includeFree: false, minLength: 4 }), { limit: 99 })) {
      if (b.leave <= left) {
        left -= b.leave;
        greedyOff += b.length;
      }
    }
    assert.ok(plan.totalOff >= greedyOff, `DP ${plan.totalOff} should be >= greedy ${greedyOff}`);
  }
});

test('breakFromRange and holidaysPerMonth', () => {
  const days = buildDays({ year: 2026, holidays: KR_2026 });
  const b = breakFromRange(days, '2026-10-03', '2026-10-11');
  assert.equal(b.length, 9);
  assert.equal(b.leave, 4); // Oct 5-8
  const counts = holidaysPerMonth(days);
  assert.equal(counts.length, 12);
  assert.equal(counts[9], 2); // October
  assert.equal(counts.reduce((a, c) => a + c, 0), 8); // Jan 2027 is not counted
});

test('Friday-Saturday weekend', () => {
  const days = buildDays({ year: 2026, holidays: [], weekend: [5, 6] });
  const fri = days.find((d) => d.iso === '2026-05-01');
  const sun = days.find((d) => d.iso === '2026-05-03');
  assert.ok(fri.off);
  assert.ok(!sun.off);
});
