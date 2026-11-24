// Holiday & Long-Weekend Planner - main client script.
// Connects the page (DOM events) with the optimizer, the server API and the drawings.

import { api } from './api.js';
import { $, $$, esc, toast, dialog, debounce, money, num, niceRound, setBusy } from './ui.js';
import { todayIso, fmtRange, fmtDay, fmtShort, diffDays, MONTHS_SHORT } from './dates.js';
import {
  buildDays, findBreaks, rankBreaks, planYear, breakFromRange, bestBreakForDay,
  holidaysPerMonth, yearSummary, fmtEfficiency,
} from './optimizer.js';
import { renderYearCalendar, ribbonHtml, describeDay } from './calendar.js';
import { drawMonthBars, drawHeatmap, drawDonut, CATEGORY_COLOURS } from './charts.js';
import { createWorldMap } from './worldmap.js';
import { computeBudget, renderBudget, loadWeather } from './planner.js';
import { buildIcs, downloadText, shareUrl, readShareParams } from './exporters.js';
import { locate, lastLocation, regionFromLanguage } from './geo.js';
import { getCustomDays, setCustomDays, getPrefs, setPrefs, getTheme, setTheme } from './storage.js';
import { COUNTRY_META, defaultWeekend, flag } from './data/countries-meta.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const TODAY = todayIso();
const THIS_YEAR = Number(TODAY.slice(0, 4));
// In the last weeks of the year the planner opens on next year (see init).
const LATE_IN_YEAR = diffDays(TODAY, `${THIS_YEAR}-12-31`) < 45;
const PAGE = 6; // breaks shown per "page"

const state = {
  countries: [],
  countryByCode: new Map(),
  country: 'KR',
  year: THIS_YEAR,
  leave: 2,
  weekendSetting: 'auto',
  holidays: [], // this year + next January
  longWeekends: [],
  days: [],
  candidates: [],
  ranked: [],
  shown: PAGE,
  selected: null,
  yearPlan: null,
  plan: null, // saved plan from the server ({id, is_owner, ...})
  expenses: [],
  location: lastLocation(),
  worldwide: [],
  loadToken: 0,
  touchedBudget: false,
};

const els = {
  country: $('#country'),
  year: $('#year'),
  leave: $('#leave'),
  weekend: $('#weekend'),
  status: $('#status'),
  sort: $('#sort'),
  includeFree: $('#includeFree'),
  onlyUpcoming: $('#onlyUpcoming'),
  breaks: $('#breaks'),
  moreBreaks: $('#moreBreaks'),
  holidayBody: $('#holidayTable tbody'),
  calendar: $('#yearCalendar'),
  heatmap: $('#heatmap'),
  heatTip: $('#heatTip'),
  monthChart: $('#monthChart'),
  showYearPlan: $('#showYearPlan'),
  planBody: $('#planBody'),
  planEmpty: $('#planEmpty'),
  budget: $('#budget'),
  currency: $('#currency'),
  display: $('#displayCurrency'),
  destination: $('#destination'),
  city: $('#city'),
  style: $('#style'),
  baseline: $('#baseline'),
  titleInput: $('#planTitleInput'),
  notes: $('#notes'),
};

const countryName = (cc) => state.countryByCode.get(cc)?.name ?? cc;
const weekendDays = () => (state.weekendSetting === 'auto' ? defaultWeekend(state.country) : state.weekendSetting.split(',').map(Number));
const fromIso = () => (els.onlyUpcoming.checked && state.year <= THIS_YEAR ? TODAY : null);

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Loading data
// ---------------------------------------------------------------------------
async function loadYear() {
  const token = ++state.loadToken; // ignore answers from older requests
  const cc = state.country;
  const year = state.year;
  setStatus(`Loading public holidays for ${countryName(cc)} ${year}…`);
  try {
    const [cur, next, lw] = await Promise.all([
      api.holidays(year, cc),
      api.holidays(year + 1, cc).catch(() => ({ holidays: [] })),
      api.longWeekends(year, cc).catch(() => ({ longWeekends: [] })),
    ]);
    if (token !== state.loadToken) return;
    // Early January of next year (for Christmas-New Year breaks). Next year's list can also hold a
    // day in late December of this year, e.g. New Year's Day observed on Dec 31: mark it as such.
    const known = new Set(cur.holidays.map((h) => `${h.date}|${h.name}`));
    const spill = next.holidays
      .filter((h) => h.date < `${year + 1}-01-15` && !known.has(`${h.date}|${h.name}`))
      .map((h) => (h.date < `${year + 1}-01-01` ? { ...h, observedFor: year + 1 } : h));
    state.holidays = [...cur.holidays, ...spill];
    state.longWeekends = lw.longWeekends;
    // same count as the holiday table and the hero (nationwide holidays dated in this year)
    const n = state.holidays.filter((h) => h.global && h.date.startsWith(String(year))).length;
    setStatus(`${n} public holidays loaded for ${countryName(cc)} ${year} (source: ${cur.source}).`);
  } catch (err) {
    if (token !== state.loadToken) return;
    state.holidays = [];
    state.longWeekends = [];
    setStatus(`Could not load holidays: ${err.message}`, true);
  }
  state.yearPlan = null;
  $('#yearPlanResult').innerHTML = '';
  els.showYearPlan.checked = false;
  recompute();
}

/** Rebuild days and breaks from the current inputs and redraw everything. */
function recompute({ keepSelection = true } = {}) {
  state.days = buildDays({ year: state.year, holidays: state.holidays, customDays: getCustomDays(), weekend: weekendDays() });
  state.candidates = findBreaks(state.days, state.leave, { fromIso: fromIso(), includeFree: els.includeFree.checked });
  state.ranked = rankBreaks(state.candidates, { sort: els.sort.value, limit: 60 });
  // the days may have changed (custom days, weekend, filters): an existing year plan is redone on them
  if (state.yearPlan) runYearPlan({ redraw: false });
  if (keepSelection && state.selected) {
    state.selected = breakFromRange(state.days, state.selected.start, state.selected.end);
  } else if (!keepSelection) state.selected = null;
  renderHero();
  renderBreaks();
  renderHolidayTable();
  renderCalendarAndCharts();
  renderSelected();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderHero() {
  const s = yearSummary(state.days);
  $('#heroFlag').textContent = flag(state.country);
  $('#heroTitle').textContent = `Best breaks in ${countryName(state.country)}, ${state.year}`;
  $('#heroSub').textContent = `${s.holidays} public holidays, ${s.holidaysOnWorkdays} on working days · ${s.freeDays} free days in total · up to ${state.leave} leave day${state.leave === 1 ? '' : 's'} per break`;
  renderHeroPicks();
  // Late in the year we show next year: say so, and offer the rest of this year.
  const yearNote = $('#yearNote');
  yearNote.hidden = !(LATE_IN_YEAR && state.year === THIS_YEAR + 1);
  if (!yearNote.hidden) {
    yearNote.innerHTML = `${THIS_YEAR} is almost over, so you are seeing ${state.year}. <button type="button" class="link-btn" id="restOfYear">See the rest of ${THIS_YEAR}</button>`;
  }
  const next = state.days.find((d) => d.iso >= TODAY && d.holidays.length);
  $('#nextHoliday').innerHTML = next
    ? `Next holiday: <b>${esc(next.holidays[0].name)}</b> · ${esc(fmtDay(next.iso))}${next.iso.slice(0, 4) !== String(state.year) ? `, ${next.iso.slice(0, 4)}` : ''} (${diffDays(TODAY, next.iso) === 0 ? 'today' : `in ${diffDays(TODAY, next.iso)} days`})`
    : '';
}

// Photo for a break: the season it falls in, flipped for the southern hemisphere.
// Countries near the equator have no real seasons, so they always get the beach.
const SEASON_PHOTOS = ['winter', 'spring', 'summer', 'autumn'];
function seasonPhoto(iso, cc = state.country) {
  const lat = COUNTRY_META[cc]?.[2] ?? 45;
  if (Math.abs(lat) < 23.5) return 'summer';
  let month = Number(iso.slice(5, 7)) - 1; // 0 = January
  if (lat < 0) month = (month + 6) % 12;
  return SEASON_PHOTOS[Math.floor(((month + 1) % 12) / 3)];
}
// There are 3 photos per season. `variant` (1-3) defaults to one picked from the date,
// so the same break always gets the same photo.
function photoUrl(iso, cc = state.country, variant = (Number(iso.slice(8, 10)) % 3) + 1) {
  return `img/season-${seasonPhoto(iso, cc)}-${variant}.jpg`;
}
// Each photo also has a 1600px "-hd" version, used for the printed / PDF trip sheet.
const hdPhoto = (url) => url.replace(/\.jpg$/, '-hd.jpg');

// Spread key for the hero picks: the season, or the quarter of the year near the equator
// (where every break gets the beach photo, so the season says nothing).
function spreadKey(iso) {
  const lat = COUNTRY_META[state.country]?.[2] ?? 45;
  return Math.abs(lat) < 23.5 ? `q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3)}` : seasonPhoto(iso);
}

const byValue = (a, b) => b.efficiency - a.efficiency || b.length - a.length;

// The three breaks with the most days off per leave day, shown as photo cards in the hero.
// A strictly better break always wins. Among equally good breaks, prefer one from a season
// that is not shown yet, so the cards spread over the year instead of three January breaks.
function pickHeroBreaks(list, n = 3) {
  const pool = [...list].sort((a, b) => byValue(a, b) || a.s - b.s);
  const picks = [];
  const usedKeys = new Set();
  while (picks.length < n && pool.length) {
    const tied = pool.filter((b) => byValue(b, pool[0]) === 0);
    const b = tied.find((x) => !usedKeys.has(spreadKey(x.start))) ?? pool[0];
    picks.push(b);
    usedKeys.add(spreadKey(b.start));
    pool.splice(pool.indexOf(b), 1);
  }
  return picks.sort((a, b) => byValue(a, b) || a.s - b.s);
}

function renderHeroPicks() {
  const picks = pickHeroBreaks(state.ranked);
  const used = {}; // three winter breaks get three different winter photos
  $('#heroPicks').innerHTML = picks.length
    ? picks.map((b) => {
      const season = seasonPhoto(b.start);
      used[season] = (used[season] || 0) + 1;
      const name = b.holidayNames.length ? b.holidayNames[0] : 'Long weekend';
      const extra = b.holidayNames.length > 1 ? ` +${b.holidayNames.length - 1}` : '';
      const leaveText = b.leave ? `${b.leave} leave day${b.leave > 1 ? 's' : ''}` : 'no leave';
      return `<li><button class="pick" type="button" data-start="${b.start}" data-end="${b.end}">
        <img src="${photoUrl(b.start, state.country, used[season])}" alt="" loading="lazy" width="500" height="332">
        <span class="pick-body">
          <span class="pick-title">${esc(name)}${esc(extra)}</span>
          <span class="pick-date">${esc(fmtRange(b.start, b.end))}</span>
          <span class="pick-meta"><b>${b.length} days off</b> · ${leaveText}</span>
        </span>
      </button></li>`;
    }).join('')
    : `<li class="pick-empty">No break found with up to ${state.leave} leave days. Try more leave days or another year.</li>`;
}

function breakItem(b) {
  const sel = state.selected && state.selected.start === b.start && state.selected.end === b.end;
  const names = b.holidayNames.length ? b.holidayNames.join(', ') : 'Weekend';
  const leaveText = b.leave ? `${b.leave} leave day${b.leave > 1 ? 's' : ''}` : 'no leave needed';
  return `<li><div class="break${sel ? ' selected' : ''}" role="button" tabindex="0" data-start="${b.start}" data-end="${b.end}" aria-pressed="${sel}">
    <div class="break-info">
      <p class="break-title">${esc(fmtRange(b.start, b.end))}</p>
      <p class="break-sub">${b.length} days off, ${leaveText} · ${esc(names)}</p>
    </div>
    <div class="break-score"><b>${esc(fmtEfficiency(b))}</b><span>days off per leave day</span></div>
    <div class="ribbon">${ribbonHtml(state.days, b)}</div>
  </div></li>`;
}

function renderBreaks() {
  const list = state.ranked.slice(0, state.shown);
  els.breaks.innerHTML = list.length
    ? list.map(breakItem).join('')
    : `<li class="break-empty">No break found with up to ${state.leave} leave days${fromIso() ? ' in the rest of this year' : ''}. Try more leave days, another year, or turn on “Free long weekends”.</li>`;
  els.moreBreaks.hidden = state.ranked.length <= state.shown;
  renderHeroPicks(); // the filters (upcoming / free weekends) change the candidates too
}

function renderHolidayTable() {
  const rows = state.holidays.filter((h) => h.date.startsWith(String(state.year)));
  $('#holCount').textContent = rows.filter((h) => h.global).length;
  els.holidayBody.innerHTML = rows.length
    ? rows.map((h) => {
      const dow = new Date(`${h.date}T00:00:00Z`).getUTCDay();
      const onWeekend = weekendDays().includes(dow);
      const tags = `${h.observedFor ? `<span class="tag">observed for ${h.observedFor}</span>` : ''}${onWeekend ? '<span class="tag tag-weekend">weekend</span>' : ''}${h.global ? '' : '<span class="tag tag-regional">regional</span>'}`;
      return `<tr class="${h.date < TODAY ? 'past' : ''}">
        <td>${esc(fmtShort(h.date))}</td><td>${esc(fmtDay(h.date).slice(0, 3))}</td>
        <td>${esc(h.name)}${tags}</td><td>${esc(h.localName ?? '')}</td></tr>`;
    }).join('')
    : '<tr><td colspan="4" class="muted">No holidays found.</td></tr>';
  const lw = state.longWeekends;
  $('#longWeekendNote').textContent = lw.length
    ? `Nager.Date also lists ${lw.length} long weekends in ${state.year}; ${lw.filter((x) => x.needBridgeDay).length} of them need a bridge day.`
    : '';
}

let heatHit = () => null;
function renderCalendarAndCharts() {
  const planLeave = els.showYearPlan.checked && state.yearPlan ? new Set(state.yearPlan.breaks.flatMap((b) => b.leaveDates)) : null;
  const opts = { year: state.year, days: state.days, selected: state.selected, planLeave, today: TODAY, dimPast: state.year === THIS_YEAR };
  renderYearCalendar(els.calendar, opts);
  heatHit = drawHeatmap(els.heatmap, opts);
  const ys = yearSummary(state.days);
  $('#heatNote').textContent = `${ys.totalDays} days: ${ys.workdays} working days, ${ys.freeDays} free days (weekends + holidays). ${ys.holidaysOnWeekend} holiday${ys.holidaysOnWeekend === 1 ? ' falls' : 's fall'} on a weekend.`;
  const counts = holidaysPerMonth(state.days);
  drawMonthBars(els.monthChart, counts);
  const max = Math.max(...counts);
  const empty = counts.filter((c) => c === 0).length;
  $('#monthChartNote').textContent = max
    ? `${counts.map((c, i) => (c === max ? MONTHS_SHORT[i] : null)).filter(Boolean).join(', ')} ha${counts.filter((c) => c === max).length > 1 ? 've' : 's'} the most holidays (${max}). ${empty} month${empty === 1 ? ' has' : 's have'} none: that is where leave days matter most.`
    : '';
}

function renderSelected() {
  const b = state.selected;
  els.planBody.hidden = !b;
  els.planEmpty.hidden = !!b;
  $$('.break', els.breaks).forEach((n) => {
    const on = b && n.dataset.start === b.start && n.dataset.end === b.end;
    n.classList.toggle('selected', !!on);
    n.setAttribute('aria-pressed', String(!!on));
  });
  if (!b) return;
  $('#selectedSummary').innerHTML = `<div class="sel-head">
      <div>
        <p class="kicker">${esc(flag(state.country))} ${esc(countryName(state.country))} · selected break</p>
        <h3>${esc(fmtRange(b.start, b.end))}</h3>
        <p>${b.length} days off${b.leave ? `, take ${b.leave} leave day${b.leave > 1 ? 's' : ''}: ${b.leaveDates.map((d) => esc(fmtDay(d))).join(', ')}` : ', no leave needed'}</p>
        ${b.holidayNames.length ? `<p>Holidays: ${esc(b.holidayNames.join(', '))}</p>` : ''}
      </div>
      <div class="sel-score">
        <div><b>${b.length}</b><span>days off</span></div>
        <div><b>${b.leave}</b><span>leave days</span></div>
        <div class="accent"><b>${esc(fmtEfficiency(b))}</b><span>per leave day</span></div>
      </div>
    </div>`;
  // wide banner: the HD photo (also what the PDF uses, so Ctrl+P finds it in the cache)
  const photo = hdPhoto(photoUrl(b.start, els.destination.value || state.country));
  if ($('#selectedPhoto').getAttribute('src') !== photo) $('#selectedPhoto').src = photo;
  $('#selectedRibbon').innerHTML = ribbonHtml(state.days, b);
  if (!els.titleInput.value || els.titleInput.dataset.auto === '1') {
    els.titleInput.value = `${countryName(els.destination.value || state.country)} trip · ${fmtRange(b.start, b.end)}`;
    els.titleInput.dataset.auto = '1';
  }
  refreshPlan();
}

// ---------------------------------------------------------------------------
// Selecting breaks
// ---------------------------------------------------------------------------
function selectBreak(b, { scroll = false } = {}) {
  if (!b) return;
  const changed = !state.selected || state.selected.start !== b.start || state.selected.end !== b.end;
  state.selected = b;
  if (changed && state.plan && (state.plan.start_date !== b.start || state.plan.end_date !== b.end)) {
    detachPlan(); // a different break is a new plan
  }
  if (changed) $('#expDate').value = ''; // a date from the previous break would be outside this one
  renderCalendarAndCharts();
  renderSelected();
  updateUrl();
  if (scroll) goToPlan(scroll);
}

// Jump to the plan and remember where the visitor came from, so
// "Back to ..." returns them to the same spot in the list.
function goToPlan(from) {
  const back = $('#backLink');
  back.dataset.y = String(window.scrollY);
  back.textContent = `← ${typeof from === 'string' ? from : 'Back'}`;
  back.hidden = false;
  $('#plan').scrollIntoView({ behavior: 'smooth' });
}

// "Plan my whole year": spread the annual leave over the best breaks (see planYear).
// Also called from recompute(), so the plan follows new custom days, weekends and filters.
function runYearPlan({ redraw = true } = {}) {
  const budget = Math.max(1, Math.min(40, Math.round(Number($('#annualLeave').value) || 15)));
  const maxPer = Math.max(1, Math.min(15, Math.round(Number($('#maxPerBreak').value) || 5)));
  const t0 = performance.now();
  state.yearPlan = planYear(state.days, budget, { maxLeavePerBreak: maxPer, fromIso: fromIso() });
  const ms = Math.max(1, Math.round(performance.now() - t0));
  const p = state.yearPlan;
  $('#yearPlanResult').innerHTML = p.breaks.length
    ? `<div class="yp-stats">
        <div class="yp-stat"><b>${p.totalLeave}<small>/${budget}</small></b><span>leave days used</span></div>
        <div class="yp-stat"><b>${p.totalOff}</b><span>days off in total</span></div>
        <div class="yp-stat"><b>${num(p.efficiency, 1)}x</b><span>days off per leave day</span></div>
      </div>
      <ol class="yp-list">${p.breaks.map((b) => `<li><button type="button" data-start="${b.start}" data-end="${b.end}">
        <b>${esc(fmtRange(b.start, b.end))}</b><span>${b.length} days · ${b.leave} leave · ${esc(fmtEfficiency(b))}</span></button></li>`).join('')}</ol>
      <p class="muted small">Checked ${num(findBreaks(state.days, Math.min(budget, maxPer), { fromIso: fromIso(), includeFree: false, minLength: 4 }).length)} possible breaks in ${ms} ms.${p.unused ? ` ${p.unused} leave day${p.unused > 1 ? 's are' : ' is'} left over because no break gains from ${p.unused > 1 ? 'them' : 'it'}.` : ''}</p>`
    : '<p class="muted">No breaks found for this budget.</p>';
  if (redraw) renderCalendarAndCharts();
}

function selectDay(iso) {
  const pool = findBreaks(state.days, Math.max(state.leave, 1), { includeFree: true });
  const b = bestBreakForDay(pool, iso);
  if (b) selectBreak(b, { scroll: 'Back to calendar' });
  else {
    const d = state.days.find((x) => x.iso === iso);
    toast(`No break with up to ${Math.max(state.leave, 1)} leave days includes ${fmtDay(iso)}${d?.blocked ? ' (it is a busy day)' : ''}.`);
  }
}

// ---------------------------------------------------------------------------
// Plan: budget, weather
// ---------------------------------------------------------------------------
let budgetRequest = 0; // only the newest budget check may write its answer
const refreshPlan = debounce(async () => {
  const b = state.selected;
  if (!b) return;
  const req = ++budgetRequest;
  $('#expCurrency').textContent = els.currency.value;
  const budget = Number(els.budget.value);
  const el = $('#budgetResult');
  if (!(budget > 0)) {
    el.innerHTML = '<p class="muted">Enter a budget per day to see the result.</p>';
  } else {
    el.innerHTML = '<p class="muted"><span class="spinner"></span>Converting with live exchange rates…</p>';
    try {
      const r = await computeBudget({
        budget,
        currency: els.currency.value,
        display: els.display.value,
        destination: els.destination.value,
        baseline: Number(els.baseline.value) || 120,
        days: b.length,
        countryName: countryName(els.destination.value),
      });
      if (req === budgetRequest) renderBudget(el, r);
    } catch (err) {
      if (req === budgetRequest) el.innerHTML = `<p class="muted">Budget check is not available: ${esc(err.message)}</p>`;
    }
  }
  refreshWeather();
  renderExpenses();
}, 300);

let lastWeatherKey = '';
async function refreshWeather(force = false) {
  const b = state.selected;
  const key = `${els.city.value}|${els.destination.value}|${b.start}|${b.end}`;
  if (!force && key === lastWeatherKey) return;
  lastWeatherKey = key;
  await loadWeather($('#weather'), { city: els.city.value.trim(), country: els.destination.value, start: b.start, end: b.end });
}

async function defaultBudgetFor(currency) {
  if (state.touchedBudget) return;
  let value = 100;
  try {
    const { rate } = await api.fx('USD', currency);
    value = niceRound(100 * rate);
  } catch {
    /* keep 100 */
  }
  // The answer arrives later: ignore it if a plan, a share link or the user set the budget meanwhile.
  if (state.touchedBudget || els.currency.value !== currency) return;
  els.budget.value = value;
  if (state.selected) refreshPlan();
}

function planPayload() {
  const b = state.selected;
  return {
    title: els.titleInput.value.trim() || `Break ${b.start}`,
    country: state.country,
    year: state.year,
    start_date: b.start,
    end_date: b.end,
    leave_dates: b.leaveDates,
    budget_per_day: Number(els.budget.value) || null,
    currency: els.currency.value,
    display_currency: els.display.value,
    destination: els.destination.value,
    city: els.city.value.trim(),
    baseline_usd: Number(els.baseline.value) || null,
    notes: els.notes.value.trim(),
  };
}

function currentShareState() {
  const b = state.selected;
  return {
    country: state.country,
    year: state.year,
    leave: state.leave,
    weekend: state.weekendSetting === 'auto' ? '' : state.weekendSetting,
    start: b?.start,
    end: b?.end,
    budget: els.budget.value,
    currency: els.currency.value,
    display: els.display.value,
    destination: els.destination.value,
    city: els.city.value.trim(),
    baseline: els.baseline.value,
  };
}

function updateUrl() {
  const url = state.plan ? `${location.pathname}?plan=${encodeURIComponent(state.plan.id)}` : shareUrl(currentShareState());
  history.replaceState(null, '', url);
}

// ---------------------------------------------------------------------------
// Saved plans (server + database)
// ---------------------------------------------------------------------------
function setPlanMode() {
  const p = state.plan;
  const readOnly = p && !p.is_owner;
  const note = $('#readOnlyNote');
  note.hidden = !readOnly;
  note.innerHTML = readOnly ? 'You are viewing a plan someone shared with you. <b>Save plan</b> keeps your own copy.' : '';
  $('#saveState').textContent = p
    ? `${p.is_owner ? 'Saved' : 'Shared plan'} · last update ${new Date(p.updated_at).toLocaleString()} · id ${p.id}`
    : 'Not saved yet. Saving stores the plan in the server database so you can add expenses and share it.';
  $('#saveBtn').lastChild.textContent = p?.is_owner ? ' Update plan' : ' Save plan';
  $$('#expenseForm input, #expenseForm select, #expenseForm button').forEach((n) => (n.disabled = !!readOnly));
  $('#expenseHint').textContent = readOnly ? 'Read only: this plan belongs to someone else.' : 'Expenses are saved with the plan on the server.';
}

function detachPlan() {
  // the old title belonged to the saved plan: let the new break get its own
  if (state.plan) els.titleInput.dataset.auto = '1';
  state.plan = null;
  state.expenses = [];
  lockCurrency();
  setPlanMode();
}

// Expenses are stored as plain amounts in the plan's currency, so the currency
// cannot change while the plan has expenses (they would silently change value).
function lockCurrency() {
  const lock = state.expenses.length > 0;
  els.currency.disabled = lock;
  els.currency.title = lock ? 'The expenses are in this currency. Delete them to change it.' : '';
}

async function savePlan({ quiet = false } = {}) {
  if (!state.selected) return null;
  const btn = $('#saveBtn');
  setBusy(btn, true, 'Saving…');
  const sel = state.selected;
  try {
    const payload = planPayload();
    const res = state.plan?.is_owner ? await api.plans.update(state.plan.id, payload) : await api.plans.create(payload);
    // Another break was picked while saving: that is a new plan now, so do not attach the saved one to it.
    if (state.selected?.start !== sel.start || state.selected?.end !== sel.end) {
      loadPlans();
      loadStats();
      if (!quiet) toast('Plan saved to the server.');
      return null;
    }
    const copied = state.plan && !state.plan.is_owner;
    state.plan = res.plan;
    if (copied) {
      state.expenses = []; // expenses are not copied with a shared plan
      renderExpenses();
    }
    setPlanMode();
    updateUrl();
    loadPlans();
    loadStats();
    if (!quiet) toast(copied ? 'Saved your own copy of this plan.' : 'Plan saved to the server.');
    return state.plan;
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'error');
    return null;
  } finally {
    setBusy(btn, false); // puts the old label back ...
    setPlanMode(); // ... so set "Save plan" / "Update plan" again after it
  }
}

async function loadPlans() {
  const box = $('#plansList');
  try {
    const { plans } = await api.plans.list();
    box.innerHTML = plans.length
      ? plans.map((p) => {
        const total = (p.budget_per_day ?? 0) * (diffDays(p.start_date, p.end_date) + 1);
        return `<article class="card plan-card" data-expenses="${Number(p.expense_count) || 0}">
          <img class="plan-photo" src="${photoUrl(p.start_date, p.destination || p.country)}" alt="" loading="lazy" width="500" height="332">
          <p class="kicker">${esc(flag(p.country))} ${esc(countryName(p.country))}${p.destination && p.destination !== p.country ? ` → ${esc(flag(p.destination))} ${esc(countryName(p.destination))}` : ''}</p>
          <h3>${esc(p.title)}</h3>
          <p>${esc(fmtRange(p.start_date, p.end_date))} · ${diffDays(p.start_date, p.end_date) + 1} days · ${p.leave_days} leave</p>
          <p>Budget ${esc(money(total, p.currency || 'USD', { whole: true }))} · spent ${esc(money(p.spent, p.currency || 'USD', { whole: true }))} (${p.expense_count} item${p.expense_count === 1 ? '' : 's'})</p>
          <div class="row">
            <button class="btn btn-sm btn-primary" data-open="${esc(p.id)}" type="button">Open</button>
            <button class="btn btn-sm btn-danger" data-delete="${esc(p.id)}" type="button">Delete</button>
          </div>
        </article>`;
      }).join('')
      : '<div class="card empty"><p>No saved plans yet. Pick a break and press <b>Save plan</b>.</p></div>';
  } catch (err) {
    box.innerHTML = `<div class="card empty"><p>Could not load saved plans: ${esc(err.message)}</p></div>`;
  }
}

async function openPlan(id, { scroll = true } = {}) {
  try {
    const { plan, expenses } = await api.plans.get(id);
    state.plan = plan;
    state.expenses = expenses;
    state.country = plan.country;
    state.year = plan.year;
    state.leave = Math.max(plan.leave_days, 0);
    els.country.value = plan.country;
    ensureYearOption(plan.year);
    els.year.value = String(plan.year);
    els.leave.value = String(state.leave);
    els.onlyUpcoming.checked = false;
    els.titleInput.value = plan.title;
    els.titleInput.dataset.auto = '0';
    if (plan.currency) els.currency.value = plan.currency;
    if (plan.display_currency) els.display.value = plan.display_currency;
    if (plan.destination) els.destination.value = plan.destination;
    els.city.value = plan.city ?? '';
    if (plan.budget_per_day != null) {
      els.budget.value = plan.budget_per_day;
      state.touchedBudget = true;
    }
    setBaseline(plan.baseline_usd ?? 120);
    els.notes.value = plan.notes ?? '';
    state.selected = { start: plan.start_date, end: plan.end_date };
    await loadYear();
    state.selected = breakFromRange(state.days, plan.start_date, plan.end_date);
    renderCalendarAndCharts();
    renderSelected();
    setPlanMode();
    updateUrl();
    if (scroll) goToPlan('Back to my plans');
  } catch (err) {
    toast(`Could not open the plan: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
function renderExpenses() {
  lockCurrency();
  const cur = state.plan?.currency || els.currency.value;
  const list = $('#expenseList');
  list.innerHTML = state.expenses.length
    ? state.expenses.map((e) => `<li>
        <span class="cat-dot" style="background:${CATEGORY_COLOURS[e.category] || CATEGORY_COLOURS.Other}"></span>
        <span>${esc(e.category)}${e.note ? ` · ${esc(e.note)}` : ''}<small>${e.spent_on ? esc(fmtDay(e.spent_on)) : 'no date'}</small></span>
        <span class="amt">${esc(money(e.amount, cur))}</span>
        <button class="icon-x no-print" type="button" data-expense="${e.id}" aria-label="Delete expense" ${state.plan?.is_owner ? '' : 'disabled'}>×</button>
      </li>`).join('')
    : '<li class="muted">No expenses yet.</li>';
  const totals = Object.keys(CATEGORY_COLOURS).map((label) => ({
    label,
    colour: CATEGORY_COLOURS[label],
    value: state.expenses.filter((e) => e.category === label).reduce((s, e) => s + e.amount, 0),
  }));
  const spent = totals.reduce((s, t) => s + t.value, 0);
  const budget = (Number(els.budget.value) || 0) * (state.selected?.length ?? 0);
  const left = budget - spent;
  drawDonut($('#expenseChart'), totals.filter((t) => t.value > 0).length ? totals.filter((t) => t.value > 0) : totals, {
    title: money(spent, cur, { compact: true }),
    subtitle: 'spent',
  });
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  $('#expenseSummary').innerHTML = `
    <div class="remaining${left < 0 ? ' over' : ''}" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <p class="small"><b>${esc(money(spent, cur))}</b> spent of ${esc(money(budget, cur))} ·
      ${left >= 0 ? `<b>${esc(money(left, cur))}</b> left` : `<b style="color:var(--red)">${esc(money(-left, cur))}</b> over budget`}</p>`;
}

// ---------------------------------------------------------------------------
// Print sheet ("Save as PDF"): a one-page trip summary instead of the on-screen form
// ---------------------------------------------------------------------------
const LOGO_SVG = $('.brand-logo').outerHTML; // the same pin logo as the header

function renderPrintSheet() {
  const b = state.selected;
  const created = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const head = `<header class="ps-head">${LOGO_SVG}
      <div class="ps-brand"><b>Holiday &amp; Long-Weekend Planner</b><span>Trip plan</span></div>
      <p class="ps-date">Created ${esc(created)}</p></header>`;
  if (!b) {
    $('#printSheet').innerHTML = `${head}<p>Pick a break in the planner first, then print to get a trip plan.</p>`;
    return;
  }
  const dest = els.destination.value || state.country;
  const title = els.titleInput.value.trim() || `${countryName(dest)} trip · ${fmtRange(b.start, b.end)}`;
  const crossesYear = b.start.slice(0, 4) !== b.end.slice(0, 4);
  const dates = crossesYear ? fmtRange(b.start, b.end) : `${fmtRange(b.start, b.end)}, ${b.start.slice(0, 4)}`;
  const cur = state.plan?.currency || els.currency.value;
  const style = els.style.value === 'custom'
    ? `Custom (${els.baseline.value} USD/day in the US)`
    : els.style.selectedOptions[0]?.textContent ?? '';
  const notes = els.notes.value.trim();

  const details = [
    ['Dates', dates],
    ['Leave to take', b.leave ? b.leaveDates.map((d) => fmtDay(d)).join(', ') : 'None'],
    ['Holiday calendar', countryName(state.country)],
    ['Destination', countryName(dest)],
    ['City', els.city.value.trim() || '–'],
    ['Budget per day', money(Number(els.budget.value) || 0, cur)],
    ['Travel style', style],
    ...(notes ? [['Notes', notes]] : []),
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  // budget and weather are already rendered on the page: reuse that markup (empty states are skipped)
  const budgetHtml = $('#budgetResult .bc-table') ? $('#budgetResult').innerHTML : '<p class="muted">Enter a budget to see the check.</p>';
  const weatherHtml = $('#weather .wx-table') ? $('#weather').innerHTML : '';

  let expensesHtml = '';
  if (state.expenses.length) {
    const spent = state.expenses.reduce((s, e) => s + e.amount, 0);
    const budget = (Number(els.budget.value) || 0) * b.length;
    const left = budget - spent;
    expensesHtml = `<section class="ps-box"><h2>Expenses</h2>
      <table class="ps-table"><thead><tr><th>Category</th><th>Note</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>
      ${state.expenses.map((e) => `<tr><td>${esc(e.category)}</td><td>${esc(e.note ?? '')}</td><td>${e.spent_on ? esc(fmtDay(e.spent_on)) : '–'}</td><td class="num">${esc(money(e.amount, cur))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="3">Total spent <span class="ps-sub">(budget ${esc(money(budget, cur))} · ${left >= 0 ? `${esc(money(left, cur))} left` : `${esc(money(-left, cur))} over budget`})</span></td><td class="num">${esc(money(spent, cur))}</td></tr></tfoot></table></section>`;
  }

  const link = state.plan ? `${location.origin}/?plan=${state.plan.id}` : shareUrl(currentShareState());
  // a long break has a long weather table: leave the photo out so the sheet stays one A4 page
  $('#printSheet').classList.toggle('ps-long', b.length > 7);
  $('#printSheet').innerHTML = `${head}
    <img class="ps-photo" src="${hdPhoto(photoUrl(b.start, dest))}" alt="">
    <section class="ps-hero">
      <div>
        <p class="ps-kicker">Selected break</p>
        <h1>${esc(title)}</h1>
        ${b.holidayNames.length ? `<p>Holidays: ${esc(b.holidayNames.join(', '))}</p>` : ''}
      </div>
      <div class="ps-stats">
        <div><b>${b.length}</b><span>days off</span></div>
        <div><b>${b.leave}</b><span>leave day${b.leave === 1 ? '' : 's'}</span></div>
        <div class="accent"><b>${esc(fmtEfficiency(b))}</b><span>per leave day</span></div>
      </div>
    </section>
    <div class="ribbon ribbon-lg">${ribbonHtml(state.days, b)}</div>
    <div class="ps-cols">
      <section class="ps-box"><h2>Trip details</h2><dl class="ps-dl">${details}</dl></section>
      <section class="ps-box"><h2>Budget check</h2><div class="budget-result">${budgetHtml}</div></section>
    </div>
    ${weatherHtml ? `<section class="ps-box"><h2>Weather</h2><div class="weather">${weatherHtml}</div></section>` : ''}
    ${expensesHtml}
    <footer class="ps-foot">
      <p><b>Open this plan:</b> ${esc(link)}</p>
      <p>Holidays: Nager.Date · exchange rates: Frankfurter / World Bank · weather: Open-Meteo. The budget check is a rough estimate, not financial advice; check official holiday lists before booking.</p>
    </footer>`;
}

// ---------------------------------------------------------------------------
// Custom days (Web Storage)
// ---------------------------------------------------------------------------
function renderCustomDays() {
  const list = getCustomDays();
  $('#customList').innerHTML = list.length
    ? list.map((d, i) => `<li class="${d.type}">${esc(fmtShort(d.date, true))} · ${esc(d.label || (d.type === 'off' ? 'Day off' : 'Busy day'))}
        <button class="icon-x" type="button" data-custom="${i}" aria-label="Remove ${esc(d.date)}">×</button></li>`).join('')
    : '<li class="muted" style="border:0">No custom days yet.</li>';
}

// ---------------------------------------------------------------------------
// World map
// ---------------------------------------------------------------------------
let worldMap;
async function loadWorld() {
  try {
    const { holidays } = await api.worldwide();
    state.worldwide = holidays;
    const by = new Map();
    for (const h of holidays) {
      if (!by.has(h.countryCode)) by.set(h.countryCode, []);
      by.get(h.countryCode).push(h);
    }
    worldMap.update({ byCountry: by, today: TODAY });
    const chips = [...by.entries()].sort((a, b) => a[1][0].date.localeCompare(b[1][0].date));
    $('#worldList').innerHTML = chips.map(([cc, hs]) => `<button class="world-chip${hs.some((h) => h.date === TODAY) ? ' is-today' : ''}" type="button" data-cc="${esc(cc)}" title="${esc(hs.map((h) => `${fmtDay(h.date)}: ${h.name}`).join('\n'))}">
        ${esc(flag(cc))} ${esc(countryName(cc))} <small>${esc(fmtShort(hs[0].date))}</small></button>`).join('');
  } catch (err) {
    $('#worldList').innerHTML = `<p class="muted">World holidays are not available: ${esc(err.message)}</p>`;
  }
}

function pickCountry(cc, { scroll = true } = {}) {
  if (!state.countryByCode.has(cc)) return;
  state.country = cc;
  els.country.value = cc;
  state.selected = null;
  detachPlan();
  setPrefs({ country: cc });
  syncPlanDefaults();
  worldMap.update({ selected: cc });
  loadYear();
  updateUrl();
  if (scroll) $('#find').scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Form setup
// ---------------------------------------------------------------------------
function ensureYearOption(y) {
  if (![...els.year.options].some((o) => Number(o.value) === y)) {
    els.year.add(new Option(String(y), String(y)));
    [...els.year.options].sort((a, b) => a.value - b.value).forEach((o) => els.year.add(o));
  }
}

function setBaseline(v) {
  els.baseline.value = v;
  const preset = [...els.style.options].find((o) => Number(o.value) === Number(v));
  els.style.value = preset ? preset.value : 'custom';
  $('#baselineField').hidden = els.style.value !== 'custom';
}

/** Destination, currencies and city follow the chosen country unless the user changed them. */
function syncPlanDefaults({ force = false } = {}) {
  const meta = COUNTRY_META[state.country];
  if (!meta) return;
  if (force || els.destination.dataset.touched !== '1') els.destination.value = state.country;
  const destMeta = COUNTRY_META[els.destination.value] ?? meta;
  if (force || els.display.dataset.touched !== '1') els.display.value = destMeta[0];
  if (force || els.city.dataset.touched !== '1') els.city.value = destMeta[1];
  if (els.currency.dataset.touched !== '1' && !els.currency.disabled) {
    const home = state.location?.countryCode && COUNTRY_META[state.location.countryCode] ? state.location.countryCode : state.country;
    const prev = els.currency.value;
    els.currency.value = COUNTRY_META[home][0];
    // a budget the user typed keeps its value: convert the amount into the new currency
    if (state.touchedBudget && prev && prev !== els.currency.value) convertBudget(prev, els.currency.value);
    else defaultBudgetFor(els.currency.value);
  }
}

async function convertBudget(from, to) {
  const amount = Number(els.budget.value);
  if (!(amount > 0)) return;
  try {
    const { rate } = await api.fx(from, to);
    // the currency or the amount changed meanwhile (typed, opened plan, share link): keep that
    if (els.currency.value !== to || Number(els.budget.value) !== amount) return;
    els.budget.value = niceRound(amount * rate);
  } catch {
    toast(`The budget is still ${amount} but the currency is now ${to}. Please check it.`, 'error');
  }
  if (state.selected) refreshPlan();
}

async function fillCurrencies() {
  let names = {};
  let all = [...new Set(Object.values(COUNTRY_META).map((m) => m[0]))].sort();
  try {
    const res = await api.currencies();
    names = res.frankfurter;
    all = res.all;
  } catch {
    /* offline: codes only */
  }
  const html = all.map((c) => `<option value="${esc(c)}">${esc(c)}${names[c] ? ` · ${esc(names[c])}` : ''}</option>`).join('');
  els.currency.innerHTML = html;
  els.display.innerHTML = html;
  els.currency.value = 'USD';
  els.display.value = 'USD';
}

function wireEvents() {
  $('#controls').addEventListener('submit', (e) => {
    e.preventDefault();
    const leave = Math.max(0, Math.min(15, Math.round(Number(els.leave.value) || 0)));
    els.leave.value = leave;
    const changedYear = Number(els.year.value) !== state.year;
    const changedCountry = els.country.value !== state.country;
    state.leave = leave;
    state.weekendSetting = els.weekend.value;
    setPrefs({ leave, weekend: state.weekendSetting, year: Number(els.year.value) });
    if (changedCountry) return pickCountry(els.country.value, { scroll: false });
    if (changedYear) {
      state.year = Number(els.year.value);
      state.selected = null;
      detachPlan();
      loadYear();
    } else recompute();
    updateUrl();
  });
  // live updates for the simple inputs
  els.country.addEventListener('change', () => pickCountry(els.country.value, { scroll: false }));
  els.year.addEventListener('change', () => $('#controls').requestSubmit());
  els.weekend.addEventListener('change', () => $('#controls').requestSubmit());
  els.leave.addEventListener('change', () => $('#controls').requestSubmit());

  for (const el of [els.sort, els.includeFree, els.onlyUpcoming]) {
    el.addEventListener('change', () => {
      state.shown = PAGE;
      recompute();
    });
  }
  els.moreBreaks.addEventListener('click', () => {
    state.shown += PAGE;
    renderBreaks();
  });

  const pickFromList = (e) => {
    const card = e.target.closest('.break');
    if (!card) return;
    const b = breakFromRange(state.days, card.dataset.start, card.dataset.end);
    selectBreak(b, { scroll: 'Back to breaks' });
  };
  $('#backLink').addEventListener('click', (e) => {
    e.preventDefault();
    const y = Number(e.currentTarget.dataset.y);
    window.scrollTo({ top: Number.isFinite(y) ? y : 0, behavior: 'smooth' });
  });
  els.breaks.addEventListener('click', pickFromList);
  $('#yearNote').addEventListener('click', (e) => {
    if (!e.target.closest('#restOfYear')) return;
    els.onlyUpcoming.checked = true;
    els.year.value = String(THIS_YEAR);
    $('#controls').requestSubmit();
  });
  $('#heroPicks').addEventListener('click', (e) => {
    const card = e.target.closest('.pick');
    if (card) selectBreak(breakFromRange(state.days, card.dataset.start, card.dataset.end), { scroll: 'Back to top' });
  });

  // The top bar sits on the hero photo until the photo scrolls away.
  const topbar = $('.topbar');
  new IntersectionObserver(([entry]) => topbar.classList.toggle('on-photo', entry.isIntersecting), {
    rootMargin: '-60px 0px 0px 0px',
  }).observe($('.hero-copy'));
  els.breaks.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickFromList(e);
    }
  });

  els.calendar.addEventListener('click', (e) => {
    const btn = e.target.closest('.day');
    if (btn) selectDay(btn.dataset.iso);
  });
  els.showYearPlan.addEventListener('change', renderCalendarAndCharts);

  // heatmap hover + click
  const heatPos = (e) => {
    const r = els.heatmap.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  els.heatmap.addEventListener('mousemove', (e) => {
    const [x, y] = heatPos(e);
    const d = heatHit(x, y);
    const tip = els.heatTip;
    if (!d) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = esc(describeDay(d)).replaceAll(' · ', '<br>');
    tip.hidden = false;
    tip.style.left = `${els.heatmap.offsetLeft + Math.min(x + 12, els.heatmap.clientWidth - tip.offsetWidth)}px`;
    tip.style.top = `${els.heatmap.offsetTop + y + 14}px`;
  });
  els.heatmap.addEventListener('mouseleave', () => (els.heatTip.hidden = true));
  els.heatmap.addEventListener('click', (e) => {
    const d = heatHit(...heatPos(e));
    if (d) selectDay(d.iso);
  });

  // year optimizer
  $('#yearPlanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runYearPlan({ redraw: false });
    els.showYearPlan.checked = true;
    renderCalendarAndCharts();
  });
  $('#yearPlanResult').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-start]');
    if (btn) selectBreak(breakFromRange(state.days, btn.dataset.start, btn.dataset.end), { scroll: 'Back to year plan' });
  });

  // plan form
  const onPlanInput = (e) => {
    if (e.target === els.budget) state.touchedBudget = true;
    if (e.target === els.titleInput) els.titleInput.dataset.auto = '0';
    if ([els.destination, els.display, els.city, els.currency].includes(e.target)) e.target.dataset.touched = '1';
    if (e.target === els.style) {
      $('#baselineField').hidden = els.style.value !== 'custom';
      if (els.style.value !== 'custom') els.baseline.value = els.style.value;
    }
    if (e.target === els.destination) {
      const m = COUNTRY_META[els.destination.value];
      if (m && els.display.dataset.touched !== '1') els.display.value = m[0];
      if (m && els.city.dataset.touched !== '1') els.city.value = m[1];
      if (els.titleInput.dataset.auto === '1' && state.selected) els.titleInput.value = `${countryName(els.destination.value)} trip · ${fmtRange(state.selected.start, state.selected.end)}`;
    }
    if (e.target === els.currency && !state.touchedBudget) defaultBudgetFor(els.currency.value).then(refreshPlan);
    refreshPlan();
    updateUrl();
  };
  $('#planForm').addEventListener('input', onPlanInput);
  $('#planForm').addEventListener('change', onPlanInput);
  $('#planForm').addEventListener('submit', (e) => e.preventDefault());

  // export & share
  $('#icsBtn').addEventListener('click', () => {
    const b = state.selected;
    if (!b) return;
    const title = els.titleInput.value.trim() || `Break ${fmtRange(b.start, b.end)}`;
    const link = state.plan ? `${location.origin}/?plan=${state.plan.id}` : shareUrl(currentShareState());
    const ics = buildIcs({ brk: b, title, countryName: countryName(state.country), efficiencyText: fmtEfficiency(b), link });
    downloadText(`break-${b.start}.ics`, ics, 'text/calendar;charset=utf-8');
    toast('Calendar file downloaded. Open it to add the break and leave days.');
  });
  let sheetReady = false;
  $('#pdfBtn').addEventListener('click', async () => {
    const old = document.title;
    document.title = (els.titleInput.value.trim() || 'Holiday plan').replace(/[\\/:*?"<>|]/g, '');
    renderPrintSheet();
    // wait for the HD photo (otherwise the PDF can come out with an empty photo strip),
    // but never longer than 3 s, so a slow or failed image cannot block printing
    const photo = $('#printSheet .ps-photo');
    if (photo) await Promise.race([photo.decode().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    sheetReady = true;
    window.print();
    document.title = old;
  });
  // Ctrl+P prints the same sheet (the HD photo was preloaded when the break was selected)
  addEventListener('beforeprint', () => { if (!sheetReady) renderPrintSheet(); });
  addEventListener('afterprint', () => { sheetReady = false; });
  $('#shareBtn').addEventListener('click', async () => {
    const link = state.plan ? `${location.origin}/?plan=${state.plan.id}` : shareUrl(currentShareState());
    try {
      await navigator.clipboard.writeText(link);
      toast(state.plan ? 'Link to the saved plan copied.' : 'Share link copied. It keeps the country, year, break and budget.');
    } catch {
      // clipboard blocked: show the link selected, ready for Ctrl+C
      dialog({ title: 'Copy this link', text: 'Press Ctrl+C (or ⌘+C) to copy it.', field: link, ok: 'Done', cancel: '' });
    }
  });
  $('#saveBtn').addEventListener('click', () => savePlan());

  // expenses
  $('#expDate').addEventListener('focus', () => {
    if (!$('#expDate').value && state.selected) $('#expDate').value = state.selected.start;
  });
  $('#expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number($('#expAmount').value);
    if (!(amount > 0)) return toast('Enter an amount above zero.', 'error');
    if (!state.plan?.is_owner) {
      const saved = await savePlan({ quiet: true });
      if (!saved) return;
      toast('Plan saved so the expense can be stored.');
    }
    try {
      const { expense } = await api.expenses.add(state.plan.id, {
        category: $('#expCategory').value,
        amount,
        note: $('#expNote').value.trim(),
        spent_on: $('#expDate').value || null,
      });
      state.expenses.push(expense);
      $('#expAmount').value = '';
      $('#expNote').value = '';
      renderExpenses();
      loadPlans();
      loadStats();
    } catch (err) {
      toast(`Could not add the expense: ${err.message}`, 'error');
    }
  });
  $('#expenseList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-expense]');
    if (!btn || !state.plan) return;
    try {
      await api.expenses.remove(state.plan.id, btn.dataset.expense);
      state.expenses = state.expenses.filter((x) => String(x.id) !== btn.dataset.expense);
      renderExpenses();
      loadPlans();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // saved plans
  $('#plansList').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    const del = e.target.closest('[data-delete]');
    if (open) openPlan(open.dataset.open);
    if (!del) return;
    const card = del.closest('.plan-card');
    const name = card?.querySelector('h3')?.textContent ?? 'this plan';
    const items = Number(card?.dataset.expenses) || 0;
    const sure = await dialog({
      title: `Delete “${name}”?`,
      text: `The plan${items ? ` and its ${items} expense${items === 1 ? '' : 's'}` : ''} will be removed from the server. This cannot be undone.`,
      ok: 'Delete plan',
      danger: true,
    });
    if (sure) {
      try {
        await api.plans.remove(del.dataset.delete);
        if (state.plan?.id === del.dataset.delete) {
          detachPlan();
          updateUrl();
        }
        toast('Plan deleted.');
        loadPlans();
        loadStats();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  // custom days
  $('#customForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const date = $('#customDate').value;
    if (!date) return;
    const list = getCustomDays().filter((d) => d.date !== date);
    list.push({ date, type: $('#customType').value, label: $('#customLabel').value.trim().slice(0, 40) });
    setCustomDays(list);
    $('#customLabel').value = '';
    renderCustomDays();
    if (Number(date.slice(0, 4)) !== state.year) toast(`Saved. It will be used when you plan ${date.slice(0, 4)}.`);
    recompute();
  });
  $('#customList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-custom]');
    if (!btn) return;
    const list = getCustomDays();
    list.splice(Number(btn.dataset.custom), 1);
    setCustomDays(list);
    renderCustomDays();
    recompute();
  });

  // world list chips
  $('#worldList').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cc]');
    if (chip) pickCountry(chip.dataset.cc);
  });

  // location
  $('#locateBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, 'Finding you…');
    try {
      const loc = await locate();
      state.location = loc;
      worldMap.update({ user: loc });
      const place = [loc.city, loc.countryName].filter(Boolean).join(', ');
      if (loc.countryCode && state.countryByCode.has(loc.countryCode)) {
        els.currency.dataset.touched = '0';
        state.touchedBudget = false;
        pickCountry(loc.countryCode, { scroll: false });
        toast(`You are in ${place || loc.countryCode}. Showing its holidays.`);
      } else {
        toast(place ? `You are in ${place}, which Nager.Date does not cover yet.` : 'Location found, but the country is unknown.');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  });

  // theme
  $('#themeToggle').addEventListener('click', () => {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
    renderCalendarAndCharts();
    renderExpenses();
    worldMap.redraw();
  });

  // redraw canvases when the layout width changes
  let lastW = innerWidth;
  addEventListener('resize', debounce(() => {
    if (innerWidth === lastW) return;
    lastW = innerWidth;
    renderCalendarAndCharts();
    if (state.selected) renderExpenses();
  }, 200));

  // highlight the nav link of the section on screen
  const links = $$('.nav a');
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${en.target.id}`));
    }
  }, { rootMargin: '-40% 0px -55% 0px' });
  ['find', 'calendar', 'plan', 'explore', 'plans'].forEach((id) => io.observe($(`#${id}`)));

  // menu button (small screens): open / close the section links
  const nav = $('#siteNav');
  const menuBtn = $('#menuToggle');
  const setMenu = (open) => {
    nav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('click', (e) => {
    if (nav.classList.contains('open') && !e.target.closest('#siteNav, #menuToggle')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('open')) {
      setMenu(false);
      menuBtn.focus();
    }
  });
}

async function loadStats() {
  try {
    const s = await api.stats();
    $('#serverStats').innerHTML = `<span class="live"></span>Server online · SQLite: ${num(s.holidays)} holidays in ${s.holiday_sets} country-years, ${num(s.cache_entries)} cached API answers, ${s.plans} plans, ${s.expenses} expenses`;
  } catch {
    $('#serverStats').textContent = 'Server is not reachable.';
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function init() {
  const share = readShareParams();
  const prefs = getPrefs();
  if (share.planId || share.budget != null) state.touchedBudget = true;
  wireEvents();
  renderCustomDays();
  worldMap = createWorldMap($('#worldMap'), $('#mapTip'), { onPick: (cc) => pickCountry(cc) });
  if (state.location) worldMap.update({ user: state.location });

  // years: last year ... 3 years ahead. Late in the year, start with next year.
  const defaultYear = LATE_IN_YEAR ? THIS_YEAR + 1 : THIS_YEAR;
  for (let y = THIS_YEAR - 1; y <= THIS_YEAR + 3; y++) els.year.add(new Option(String(y), String(y)));

  try {
    const { countries } = await api.countries();
    state.countries = countries;
    state.countryByCode = new Map(countries.map((c) => [c.code, c]));
    const opts = countries.map((c) => `<option value="${esc(c.code)}">${esc(flag(c.code))}  ${esc(c.name)}</option>`).join('');
    els.country.innerHTML = opts;
    els.destination.innerHTML = opts;
    worldMap.update({ countries });
  } catch (err) {
    setStatus(`Could not reach the server: ${err.message}. Start it with "npm start".`, true);
    return;
  }
  await fillCurrencies();

  const pick = (...ccs) => ccs.find((c) => c && state.countryByCode.has(c));
  state.country = pick(share.country, prefs.country, state.location?.countryCode, regionFromLanguage(), 'KR');
  state.year = share.year ?? (prefs.year && prefs.year >= THIS_YEAR ? prefs.year : defaultYear);
  state.leave = share.leave ?? prefs.leave ?? 2;
  state.weekendSetting = share.weekend ?? prefs.weekend ?? 'auto';
  ensureYearOption(state.year);
  els.country.value = state.country;
  els.year.value = String(state.year);
  els.leave.value = String(state.leave);
  els.weekend.value = [...els.weekend.options].some((o) => o.value === state.weekendSetting) ? state.weekendSetting : 'auto';
  worldMap.update({ selected: state.country });
  syncPlanDefaults({ force: true });
  setBaseline(120);
  setPlanMode();

  // values from a share link
  if (share.destination && state.countryByCode.has(share.destination)) {
    els.destination.value = share.destination;
    els.destination.dataset.touched = '1';
  }
  if (share.currency) {
    els.currency.value = share.currency;
    els.currency.dataset.touched = '1';
  }
  if (share.display) {
    els.display.value = share.display;
    els.display.dataset.touched = '1';
  }
  if (share.city) {
    els.city.value = share.city;
    els.city.dataset.touched = '1';
  }
  if (share.budget != null) {
    els.budget.value = share.budget;
    state.touchedBudget = true;
  }
  if (share.baseline) setBaseline(share.baseline);
  if (share.start && state.year > THIS_YEAR - 1) els.onlyUpcoming.checked = share.start >= TODAY;

  loadPlans();
  loadStats();
  loadWorld();

  if (share.planId) {
    await openPlan(share.planId, { scroll: true });
    return;
  }
  await loadYear();
  if (share.start) {
    const b = breakFromRange(state.days, share.start, share.end);
    if (b) {
      selectBreak(b);
      setTimeout(() => $('#plan').scrollIntoView({ behavior: 'smooth' }), 300);
    }
  }
}

init();

