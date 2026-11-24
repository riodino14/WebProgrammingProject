// "Save" features: calendar export (.ics via Blob), share links (state in the URL).

import { addDays, isValidIso } from './dates.js';

const icsDate = (iso) => iso.replaceAll('-', '');
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 says lines longer than 75 bytes must be folded (continued with a space). */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = new TextEncoder().encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function allDayEvent({ uid, start, endInclusive, summary, description, categories, transparent }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;VALUE=DATE:${icsDate(start)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(endInclusive, 1))}`, // DTEND is exclusive
    `SUMMARY:${icsEscape(summary)}`,
    description ? `DESCRIPTION:${icsEscape(description)}` : null,
    categories ? `CATEGORIES:${icsEscape(categories)}` : null,
    `TRANSP:${transparent ? 'TRANSPARENT' : 'OPAQUE'}`,
    'END:VEVENT',
  ].filter(Boolean);
}

/** Build an iCalendar file with one event for the whole break and one per leave day. */
export function buildIcs({ brk, title, countryName, efficiencyText, link }) {
  const id = `${brk.start}-${brk.end}-${Math.random().toString(36).slice(2, 8)}`;
  const desc = [
    `${brk.length} days off with ${brk.leave} leave day(s) (${efficiencyText}).`,
    brk.leaveDates.length ? `Leave days to request: ${brk.leaveDates.join(', ')}` : 'No leave needed.',
    brk.holidayNames.length ? `Holidays (${countryName}): ${brk.holidayNames.join(', ')}` : '',
    link ? `Plan: ${link}` : '',
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Holiday and Long-Weekend Planner//Web Programming 2026//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...allDayEvent({ uid: `break-${id}@holiday-planner`, start: brk.start, endInclusive: brk.end, summary: title, description: desc, categories: 'HOLIDAY', transparent: false }),
    ...brk.leaveDates.flatMap((d, i) => allDayEvent({
      uid: `leave-${i}-${id}@holiday-planner`,
      start: d,
      endInclusive: d,
      summary: `Leave day · ${title}`,
      description: `Request this day off for "${title}".`,
      categories: 'LEAVE',
      transparent: true,
    })),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Let the browser download a text file that is created in JavaScript (Blob + object URL). */
export function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----- share link: everything needed to rebuild the view is kept in the query string -----
const KEYS = { country: 'c', year: 'y', leave: 'l', start: 's', end: 'e', budget: 'b', currency: 'cur', display: 'show', destination: 'dest', city: 'city', baseline: 'base', weekend: 'wk' };

export function shareUrl(state) {
  const url = new URL(location.pathname, location.origin);
  for (const [k, short] of Object.entries(KEYS)) {
    const v = state[k];
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(short, String(v));
  }
  return url.href;
}

export function readShareParams(search = location.search) {
  const p = new URLSearchParams(search);
  const out = {};
  const up = (v) => (v || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(up(p.get('c')))) out.country = up(p.get('c'));
  const y = Number(p.get('y'));
  if (Number.isInteger(y) && y >= 1975 && y <= 2075) out.year = y;
  const l = Number(p.get('l'));
  if (p.has('l') && Number.isInteger(l) && l >= 0 && l <= 15) out.leave = l;
  if (isValidIso(p.get('s')) && isValidIso(p.get('e')) && p.get('s') <= p.get('e')) {
    out.start = p.get('s');
    out.end = p.get('e');
  }
  const b = Number(p.get('b'));
  if (p.has('b') && Number.isFinite(b) && b >= 0) out.budget = b;
  for (const [k, short] of [['currency', 'cur'], ['display', 'show']]) if (/^[A-Z]{3}$/.test(up(p.get(short)))) out[k] = up(p.get(short));
  if (/^[A-Z]{2}$/.test(up(p.get('dest')))) out.destination = up(p.get('dest'));
  if (p.get('city')) out.city = p.get('city').slice(0, 80);
  const base = Number(p.get('base'));
  if (p.has('base') && Number.isFinite(base) && base > 0) out.baseline = base;
  if (p.get('wk') && /^[0-6](,[0-6])?$/.test(p.get('wk'))) out.weekend = p.get('wk');
  if (p.get('plan') && /^[A-Za-z0-9_-]{6,20}$/.test(p.get('plan'))) out.planId = p.get('plan');
  return out;
}
