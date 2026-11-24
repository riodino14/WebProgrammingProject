// Calendar rendering: 12 month tables (HTML <table>) placed in a CSS Grid,
// and the day-by-day "ribbon" used for each break.

import { DOW_LETTER, MONTHS, daysInMonth, isoOf, fmtDay } from './dates.js';
import { esc } from './ui.js';

/** Text used for tooltips / screen readers. */
export function describeDay(d) {
  const parts = [fmtDay(d.iso)];
  for (const h of d.holidays) parts.push(h.name);
  for (const h of d.regional) parts.push(`${h.name} (regional)`);
  if (d.custom) parts.push(`${d.custom.type === 'off' ? 'Day off' : 'Busy'}: ${d.custom.label || 'custom day'}`);
  if (!d.holidays.length && d.weekend) parts.push('Weekend');
  return parts.join(' · ');
}

export function dayClasses(d, ctx) {
  const c = ['day'];
  if (d.weekend) c.push('weekend');
  if (d.holidays.length) c.push('holiday');
  if (d.regional.length) c.push('regional');
  if (d.custom?.type === 'off' && !d.holidays.length) c.push('custom-off');
  if (d.blocked) c.push('busy');
  if (ctx.planLeave?.has(d.iso)) c.push('plan-leave');
  if (ctx.leave?.has(d.iso)) c.push('leave');
  if (ctx.sel && d.iso >= ctx.sel.start && d.iso <= ctx.sel.end) c.push('in-break');
  if (d.iso === ctx.today) c.push('today');
  else if (ctx.dimPast && d.iso < ctx.today) c.push('past');
  return c.join(' ');
}

/**
 * @param {HTMLElement} container
 * @param {object} o  {year, days, selected, planLeave:Set, today, dimPast, weekStart}
 */
export function renderYearCalendar(container, o) {
  const byIso = new Map(o.days.map((d) => [d.iso, d]));
  const ctx = {
    sel: o.selected,
    leave: new Set(o.selected?.leaveDates ?? []),
    planLeave: o.planLeave,
    today: o.today,
    dimPast: o.dimPast,
  };
  let html = '';
  for (let m = 0; m < 12; m++) {
    const first = new Date(Date.UTC(o.year, m, 1)).getUTCDay();
    const count = daysInMonth(o.year, m);
    let holidays = 0;
    let cells = '';
    let col = 0;
    let row = '<tr>';
    for (let i = 0; i < first; i++, col++) row += '<td></td>';
    for (let day = 1; day <= count; day++) {
      const d = byIso.get(isoOf(o.year, m, day));
      if (d.holidays.length) holidays++;
      const label = describeDay(d);
      row += `<td><button type="button" class="${dayClasses(d, ctx)}" data-iso="${d.iso}" title="${esc(label)}" aria-label="${esc(label)}">${day}</button></td>`;
      col++;
      if (col % 7 === 0) {
        cells += `${row}</tr>`;
        row = '<tr>';
      }
    }
    if (col % 7 !== 0) {
      while (col % 7 !== 0) {
        row += '<td></td>';
        col++;
      }
      cells += `${row}</tr>`;
    }
    const head = DOW_LETTER.map((l) => `<th scope="col">${l}</th>`).join('');
    const badge = holidays ? `<span>${holidays} holiday${holidays > 1 ? 's' : ''}</span>` : '';
    html += `<div class="month"><h4 class="month-title" id="m${m}">${MONTHS[m]}${badge}</h4><table aria-labelledby="m${m}"><thead><tr>${head}</tr></thead><tbody>${cells}</tbody></table></div>`;
  }
  container.innerHTML = html;
}

/** Day-by-day ribbon for a break, with the working day before and after shown faded. */
export function ribbonHtml(days, brk) {
  const out = [];
  for (let i = brk.s - 1; i <= brk.e + 1; i++) {
    const d = days[i];
    if (!d) continue;
    const edge = i < brk.s || i > brk.e;
    let cls = 'rd';
    if (edge) cls += ' edge';
    else if (d.holidays.length) cls += ' holiday';
    else if (d.custom?.type === 'off') cls += ' custom-off';
    else if (d.weekend) cls += ' weekend';
    else cls += ' leave';
    const dom = Number(d.iso.slice(8));
    out.push(`<span class="${cls}" title="${esc(describeDay(d))}">${DOW_LETTER[d.dow]}<small>${dom}</small></span>`);
  }
  return out.join('');
}
