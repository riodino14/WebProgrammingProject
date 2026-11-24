// Trip planning: trip budget (Frankfurter), budget check (World Bank price level)
// and trip weather (Open-Meteo). Data comes from our server's API.

import { api } from './api.js';
import { esc, money, num } from './ui.js';
import { fmtDay } from './dates.js';

/**
 * Budget check rule:
 *   price level  = PPP conversion factor / market exchange rate (World Bank)
 *   needed/day   = baseline cost in the US (USD) x price level of the destination
 *   ratio        = your budget per day in USD / needed per day
 */
export function budgetStatus(ratio) {
  if (ratio >= 1.3) return { key: 'comfortable', label: 'Comfortable', text: 'You have room to spare.' };
  if (ratio >= 1.0) return { key: 'enough', label: 'Enough', text: 'Your budget covers a typical day.' };
  if (ratio >= 0.75) return { key: 'tight', label: 'Tight', text: 'Possible, but plan carefully.' };
  return { key: 'low', label: 'Not enough', text: 'Consider a higher budget, a cheaper style or a shorter trip.' };
}

export async function computeBudget({ budget, currency, display, destination, baseline, days, countryName }) {
  const total = budget * days;
  const [toDisplay, toUsd, level] = await Promise.all([
    api.fx(currency, display),
    api.fx(currency, 'USD'),
    api.priceLevel(destination).catch(() => null),
  ]);
  const budgetUsd = budget * toUsd.rate;
  const priceLevel = level?.level ?? 1;
  const needUsd = baseline * priceLevel;
  const ratio = needUsd > 0 ? budgetUsd / needUsd : 0;
  return {
    total,
    totalDisplay: total * toDisplay.rate,
    perDayDisplay: budget * toDisplay.rate,
    rate: toDisplay,
    budgetUsd,
    needUsd,
    needCur: needUsd / toUsd.rate,
    needDisplay: needUsd / toUsd.rate * toDisplay.rate,
    priceLevel,
    levelInfo: level,
    ratio,
    status: budgetStatus(ratio),
    countryName,
    currency,
    display,
    budget,
    days,
    baseline,
  };
}

// Layout: the verdict first, then one row per currency, then where the numbers come from.
export function renderBudget(el, r) {
  const m = (v, cur) => esc(money(v, cur, { whole: true }));
  const pctOfNeed = Math.round(r.ratio * 100);
  const share = r.ratio < 1 ? `covers about ${pctOfNeed}% of` : `is about ${num(r.ratio, 1)}x`;
  const meter = Math.min(100, (r.ratio / 2) * 100);
  const rows = [
    ['Your budget', `${m(r.budget, r.currency)} / day`, `${m(r.total, r.currency)} for ${r.days} day${r.days === 1 ? '' : 's'}`],
    ...(r.display !== r.currency ? [[`In ${esc(r.display)}`, `${m(r.perDayDisplay, r.display)} / day`, m(r.totalDisplay, r.display)]] : []),
    ['A typical day', `about ${m(r.needUsd, 'USD')}`, r.currency !== 'USD' ? `≈ ${m(r.needCur, r.currency)}` : ''],
  ];
  const rate = r.currency === r.display
    ? ''
    : `1 ${esc(r.currency)} = ${num(r.rate.rate, r.rate.rate < 1 ? 4 : 2)} ${esc(r.display)} (${esc(r.rate.source)}${r.rate.date ? `, ${esc(r.rate.date)}` : ''}). `;
  const level = r.levelInfo
    ? `Prices in ${esc(r.countryName)} are about ${num(r.priceLevel, 2)}x US prices (World Bank ${esc(r.levelInfo.year)}).`
    : `No price data for ${esc(r.countryName)}, so US prices are used.`;
  el.innerHTML = `
    <p class="bc-verdict"><span class="badge badge-${r.status.key}">${esc(r.status.label)}</span>
      Your budget (about ${m(r.budgetUsd, 'USD')} a day) ${share} a typical ${esc(styleName(r.baseline))} day in ${esc(r.countryName)}. ${esc(r.status.text)}</p>
    <div class="meter" aria-hidden="true"><i style="width:${meter}%"></i><span class="need" style="left:50%"></span></div>
    <div class="meter-labels" aria-hidden="true"><span>0</span><span>needed</span><span>2x needed</span></div>
    <table class="bc-table"><tbody>${rows.map(([k, a, b]) => `<tr><th scope="row">${k}</th><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table>
    <p class="bc-note">${rate}${level} Rough estimate, not financial advice.</p>`;
}

function styleName(baseline) {
  if (baseline <= 60) return 'budget';
  if (baseline <= 120) return 'mid-range';
  if (baseline <= 220) return 'comfort';
  return 'custom';
}

// ----- weather -----
// Weather icons: small line drawings (24x24) that follow the theme colours.
// Cloud outline, sun, and what falls from the cloud are separate pieces.
const CLOUD = 'M7 17h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-1.1A4.1 4.1 0 0 0 7 17Z';
const CLOUD_UP = 'M7 14h10a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-10-1.1A4.1 4.1 0 0 0 7 14Z';
const SUN = '<g class="wx-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g>';
const SMALL_SUN = '<g class="wx-sun"><circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.4M1.8 8h1.4M3.6 3.6l1 1M12.4 3.6l-1 1"/></g>';
const ICONS = {
  clear: SUN,
  partly: `${SMALL_SUN}<path class="wx-cloud" d="M9 19h8.5a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-1A3.7 3.7 0 0 0 9 19Z"/>`,
  cloud: `<path class="wx-cloud" d="${CLOUD}"/>`,
  fog: `<path class="wx-cloud" d="${CLOUD_UP}"/><path class="wx-cloud" d="M5 17.5h14M7 20.5h10"/>`,
  drizzle: `<path class="wx-cloud" d="${CLOUD_UP}"/><path class="wx-drop" d="M9 17.5v1.5M15 17.5v1.5M12 19.5V21"/>`,
  rain: `<path class="wx-cloud" d="${CLOUD_UP}"/><path class="wx-drop" d="M9 17l-1 4M13 17l-1 4M17 17l-1 4"/>`,
  snow: `<path class="wx-cloud" d="${CLOUD_UP}"/><g class="wx-snow"><circle cx="8.5" cy="18.5" r=".9"/><circle cx="12" cy="20.5" r=".9"/><circle cx="15.5" cy="18.5" r=".9"/></g>`,
  storm: `<path class="wx-cloud" d="${CLOUD_UP}"/><path class="wx-bolt" d="M12.5 14.5 10 18.5h3l-1.5 3.5"/>`,
};

// WMO weather codes (Open-Meteo): icon and words
const WMO = [
  [[0], 'clear', 'Clear'],
  [[1], 'partly', 'Mostly clear'],
  [[2], 'partly', 'Partly cloudy'],
  [[3], 'cloud', 'Cloudy'],
  [[45, 48], 'fog', 'Fog'],
  [[51, 53, 55, 56, 57], 'drizzle', 'Drizzle'],
  [[61, 63, 65, 66, 67], 'rain', 'Rain'],
  [[71, 73, 75, 77], 'snow', 'Snow'],
  [[80, 81, 82], 'rain', 'Showers'],
  [[85, 86], 'snow', 'Snow showers'],
  [[95, 96, 99], 'storm', 'Thunderstorm'],
];
export function weatherInfo(code) {
  const row = WMO.find(([codes]) => codes.includes(code));
  return row ? { icon: row[1], text: row[2] } : { icon: 'cloud', text: 'Unknown' };
}
export const wxIcon = (key) => `<svg class="wx-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;

const MODE_TEXT = {
  forecast: 'Forecast (Open-Meteo).',
  history: 'Recorded weather for these dates (Open-Meteo archive).',
  'last-year': 'Same dates last year, as a guide: the trip is more than 16 days away (Open-Meteo archive).',
};

function rainText(d) {
  // the column is named "Rain chance" (forecast) or "Rain" (measured), so the cells stay short
  if (d.precipProb != null) return `${d.precipProb}%`;
  if (d.precip == null) return '';
  return d.precip < 0.5 ? 'dry' : `${num(d.precip)} mm`;
}

let weatherRequest = 0; // only the newest request may write its answer

export async function loadWeather(el, { city, country, start, end }) {
  const req = ++weatherRequest;
  if (!city) {
    el.innerHTML = '<p class="muted">Enter a city to see the weather.</p>';
    return null;
  }
  el.innerHTML = '<p class="muted"><span class="spinner"></span>Loading weather…</p>';
  try {
    const { results } = await api.geocode(city, country);
    const place = results[0] ?? (await api.geocode(city, '')).results[0];
    if (req !== weatherRequest) return null; // a newer city or break was asked for meanwhile
    if (!place) {
      el.innerHTML = `<p class="muted">No place called “${esc(city)}” was found.</p>`;
      return null;
    }
    const wx = await api.weather({ lat: place.lat, lon: place.lng, start, end });
    if (req !== weatherRequest) return null;
    const temps = wx.days.flatMap((d) => [d.tmax, d.tmin]).filter((t) => t != null);
    const rainy = wx.days.filter((d) => (d.precip ?? 0) >= 1).length;
    const summary = temps.length
      ? `${num(Math.min(...temps))}–${num(Math.max(...temps))} °C · ${rainy} rainy day${rainy === 1 ? '' : 's'}`
      : '';
    const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(', '); // skip empty parts
    el.innerHTML = `
      <p class="wx-note"><b>${esc(placeName)}</b>${summary ? ` · ${summary}` : ''}<br>${esc(MODE_TEXT[wx.mode])}</p>
      <table class="wx-table">
        <thead><tr><th scope="col">Day</th><th scope="col">Weather</th><th scope="col">High / Low</th><th scope="col">${wx.mode === 'forecast' ? 'Rain chance' : 'Rain'}</th></tr></thead>
        <tbody>${wx.days.map((d) => `<tr${d.sourceDate !== d.date ? ` title="measured ${esc(d.sourceDate)}"` : ''}>
          <th scope="row">${esc(fmtDay(d.date))}</th>
          <td class="wx-cond">${wxIcon(weatherInfo(d.code).icon)}${esc(weatherInfo(d.code).text)}</td>
          <td class="num">${d.tmax != null ? num(d.tmax) : '–'}° / ${d.tmin != null ? num(d.tmin) : '–'}°</td>
          <td class="num muted">${esc(rainText(d))}</td>
        </tr>`).join('')}</tbody></table>`;
    return { place, wx };
  } catch (err) {
    if (req !== weatherRequest) return null;
    el.innerHTML = `<p class="muted">Weather is not available right now (${esc(err.message)}).</p>`;
    return null;
  }
}
