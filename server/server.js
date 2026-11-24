// Holiday & Long-Weekend Planner - server
// ------------------------------------------------------------
// A small Node.js web server with no npm dependencies.
//  * serves the client (public/ folder)
//  * exposes a REST API (/api/...)
//  * calls the open APIs (Nager.Date, Frankfurter, World Bank, Open-Meteo)
//    and caches their answers in SQLite, so repeat requests are fast and
//    the app keeps working when an upstream API is slow or down
//  * stores saved trip plans and their expenses in SQLite
//
// Run:  node server/server.js   (then open http://localhost:3000)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { COUNTRY_META, defaultWeekend, currencyToCountry } from '../public/js/data/countries-meta.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const db = openDatabase(process.env.DB_FILE || join(ROOT, 'data', 'planner.db'));

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const UA = 'HolidayPlanner/1.0 (Web Programming student project)';

// ---------- helpers ----------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(8).toString('base64url');

function ownerHash(req) {
  const token = req.headers['x-owner-token'];
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(token)) return null;
  return sha256(token);
}

const isCountry = (cc) => typeof cc === 'string' && /^[A-Z]{2}$/.test(cc);
const isCurrency = (c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c);
const isIsoDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const toYear = (y) => {
  const n = Number(y);
  if (!Number.isInteger(n) || n < 1975 || n > 2075) throw new HttpError(400, 'Year must be between 1975 and 2075');
  return n;
};
const cleanText = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const toNumber = (v, { min = 0, max = 1e12 } = {}) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid number: ${v}`);
  return n;
};

// ---------- open API access with SQLite cache --------------------------------

const inFlight = new Map(); // de-duplicates identical concurrent upstream calls

async function fetchUpstream(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Upstream ${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/**
 * Fetch JSON from an open API, using the api_cache table.
 * Fresh cache -> returned directly. Stale cache -> refreshed; if the refresh fails the stale copy is used.
 */
async function cachedJson(key, url, ttl) {
  const row = db.getCache(key);
  if (row && Date.now() - row.fetched_at < ttl) return { data: JSON.parse(row.body), cached: true, fetchedAt: row.fetched_at };
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const data = await fetchUpstream(url);
      db.setCache(key, data);
      return { data, cached: false, fetchedAt: Date.now() };
    } catch (err) {
      if (row) return { data: JSON.parse(row.body), cached: true, stale: true, fetchedAt: row.fetched_at };
      throw err.status ? err : new HttpError(502, `Could not reach ${new URL(url).host}: ${err.message}`);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

async function getCountries() {
  const { data } = await cachedJson('nager:countries', 'https://date.nager.at/api/v3/AvailableCountries', 7 * DAY);
  return (data ?? [])
    .map(({ countryCode: code, name }) => {
      const [currency, city, lat, lng] = COUNTRY_META[code] ?? ['USD', '', 0, 0];
      return { code, name, currency, city, lat, lng, weekend: defaultWeekend(code) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Holidays are stored row by row in the `holidays` table (refreshed every 3 days). */
async function getHolidays(cc, year) {
  const fetchedAt = db.holidayFetchedAt(cc, year);
  if (fetchedAt && Date.now() - fetchedAt < 3 * DAY) return { holidays: db.listHolidays(cc, year), source: 'database' };
  try {
    const data = await fetchUpstream(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`);
    db.saveHolidays(cc, year, data ?? []);
    return { holidays: db.listHolidays(cc, year), source: 'nager.date' };
  } catch (err) {
    if (fetchedAt) return { holidays: db.listHolidays(cc, year), source: 'database (stale)' };
    throw err;
  }
}

async function getFrankfurterCurrencies() {
  const { data } = await cachedJson('fx:currencies', 'https://api.frankfurter.dev/v1/currencies', 7 * DAY);
  return data ?? {};
}

/** Local currency units per 1 USD from the World Bank (official exchange rate, latest year). */
async function worldBankIndicator(cc, indicator) {
  const url = `https://api.worldbank.org/v2/country/${cc}/indicator/${indicator}?format=json&mrnev=1`;
  const { data } = await cachedJson(`wb:${cc}:${indicator}`, url, 30 * DAY);
  const row = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : null;
  if (!row || row.value == null) return null;
  return { value: row.value, year: row.date };
}

const CURRENCY_COUNTRY = currencyToCountry();

async function perUsd(currency) {
  if (currency === 'USD') return { value: 1, year: null };
  const cc = CURRENCY_COUNTRY[currency];
  if (!cc) return null;
  return worldBankIndicator(cc, 'PA.NUS.FCRF');
}

async function getRate(from, to) {
  if (from === to) return { from, to, rate: 1, date: null, source: 'same currency' };
  const supported = await getFrankfurterCurrencies();
  if (supported[from] && supported[to]) {
    const { data, fetchedAt, stale } = await cachedJson(`fx:${from}:${to}`,
      `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, 6 * HOUR);
    const rate = data?.rates?.[to];
    if (rate) return { from, to, rate, date: data.date, source: 'Frankfurter (ECB reference rate)', fetchedAt, stale: !!stale };
  }
  // Fallback for currencies the ECB does not publish: cross rate through USD using World Bank data.
  const [a, b] = await Promise.all([perUsd(from), perUsd(to)]);
  if (!a || !b) throw new HttpError(404, `No exchange rate available for ${from} -> ${to}`);
  return { from, to, rate: b.value / a.value, date: b.year || a.year, source: 'World Bank official rate (annual average)' };
}

/** Price level = PPP conversion factor / market exchange rate (1.0 = like the US). */
async function getPriceLevel(cc) {
  const [ppp, fx] = await Promise.all([worldBankIndicator(cc, 'PA.NUS.PPP'), worldBankIndicator(cc, 'PA.NUS.FCRF')]);
  if (!ppp || !fx) throw new HttpError(404, `World Bank has no price level data for ${cc}`);
  return { country: cc, ppp: ppp.value, exchangeRate: fx.value, level: ppp.value / fx.value, year: ppp.year };
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Weather for a trip. Open-Meteo forecasts only 16 days ahead, so:
 *  - trip inside the forecast window -> forecast
 *  - trip in the past                -> recorded weather (archive)
 *  - trip further in the future      -> weather on the same dates last year
 */
async function getWeather(lat, lon, start, end) {
  const daily = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max';
  const today = new Date().toISOString().slice(0, 10);
  const forecastEnd = addDaysIso(today, 15);
  let mode;
  let url;
  let shift = 0;
  if (start >= today && end <= forecastEnd) {
    mode = 'forecast';
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${daily}&timezone=auto&start_date=${start}&end_date=${end}`;
  } else {
    const archiveLimit = addDaysIso(today, -6);
    mode = end <= archiveLimit ? 'history' : 'last-year';
    let s = start;
    let e = end;
    while (e > archiveLimit) {
      s = addDaysIso(s, -364); // 52 weeks keeps the same weekday
      e = addDaysIso(e, -364);
      shift += 364;
    }
    const d = daily.replace(',precipitation_probability_max', '');
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&daily=${d}&timezone=auto&start_date=${s}&end_date=${e}`;
  }
  const ttl = mode === 'forecast' ? 3 * HOUR : 30 * DAY;
  const { data } = await cachedJson(`wx:${lat}:${lon}:${start}:${end}:${mode}`, url, ttl);
  if (!data?.daily?.time) throw new HttpError(502, 'Open-Meteo returned no data');
  const dd = data.daily;
  return {
    mode,
    timezone: data.timezone,
    days: dd.time.map((t, i) => ({
      date: addDaysIso(t, shift),
      sourceDate: t,
      code: dd.weather_code?.[i] ?? null,
      tmax: dd.temperature_2m_max?.[i] ?? null,
      tmin: dd.temperature_2m_min?.[i] ?? null,
      precip: dd.precipitation_sum?.[i] ?? null,
      precipProb: dd.precipitation_probability_max?.[i] ?? null,
    })),
  };
}

// ---------- plans -------------------------------------------------------------

function planFromBody(body) {
  if (!isCountry(body.country)) throw new HttpError(400, 'country must be a 2-letter code');
  if (!isIsoDate(body.start_date) || !isIsoDate(body.end_date)) throw new HttpError(400, 'start_date and end_date must be YYYY-MM-DD');
  if (body.end_date < body.start_date) throw new HttpError(400, 'end_date is before start_date');
  if ((Date.parse(body.end_date) - Date.parse(body.start_date)) / DAY > 60) throw new HttpError(400, 'A break can be at most 60 days');
  const leaveDates = Array.isArray(body.leave_dates) ? body.leave_dates.filter(isIsoDate).slice(0, 60) : [];
  for (const c of ['currency', 'display_currency']) {
    if (body[c] && !isCurrency(body[c])) throw new HttpError(400, `${c} must be a 3-letter code`);
  }
  if (body.destination && !isCountry(body.destination)) throw new HttpError(400, 'destination must be a 2-letter code');
  return {
    title: cleanText(body.title, 80) || `Break ${body.start_date}`,
    country: body.country,
    year: toYear(body.year ?? body.start_date.slice(0, 4)),
    start_date: body.start_date,
    end_date: body.end_date,
    leave_days: leaveDates.length,
    leave_dates: JSON.stringify(leaveDates),
    budget_per_day: toNumber(body.budget_per_day, { max: 1e10 }),
    currency: body.currency || null,
    display_currency: body.display_currency || null,
    destination: body.destination || null,
    city: cleanText(body.city, 80) || null,
    baseline_usd: toNumber(body.baseline_usd, { max: 1e6 }),
    notes: cleanText(body.notes, 1000) || null,
  };
}

function publicPlan(row, req) {
  if (!row) return null;
  const { owner_hash, ...rest } = row;
  return { ...rest, leave_dates: JSON.parse(rest.leave_dates || '[]'), is_owner: ownerHash(req) === owner_hash };
}

function requireOwnedPlan(req, id) {
  const owner = ownerHash(req);
  if (!owner) throw new HttpError(401, 'Missing X-Owner-Token header');
  const plan = db.getPlan(id);
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.owner_hash !== owner) throw new HttpError(403, 'Only the creator of this plan can change it');
  return plan;
}

const EXPENSE_CATEGORIES = ['Lodging', 'Food', 'Transport', 'Activities', 'Shopping', 'Other'];

// ---------- router ------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => ({ ok: true, time: new Date().toISOString(), node: process.version }));

route('GET', '/api/stats', () => ({ ...db.stats(), uptimeSeconds: Math.round(process.uptime()) }));

route('GET', '/api/countries', async () => ({ countries: await getCountries() }));

route('GET', '/api/holidays/:year/:cc', async ({ params }) => {
  const year = toYear(params.year);
  const cc = params.cc.toUpperCase();
  if (!isCountry(cc)) throw new HttpError(400, 'Invalid country code');
  return { country: cc, year, ...(await getHolidays(cc, year)) };
});

route('GET', '/api/long-weekends/:year/:cc', async ({ params }) => {
  const year = toYear(params.year);
  const cc = params.cc.toUpperCase();
  if (!isCountry(cc)) throw new HttpError(400, 'Invalid country code');
  const { data } = await cachedJson(`nager:lw:${cc}:${year}`, `https://date.nager.at/api/v3/LongWeekend/${year}/${cc}`, 3 * DAY);
  return { country: cc, year, longWeekends: data ?? [] };
});

route('GET', '/api/worldwide', async () => {
  const { data, fetchedAt } = await cachedJson('nager:worldwide', 'https://date.nager.at/api/v3/NextPublicHolidaysWorldwide', 3 * HOUR);
  return { holidays: (data ?? []).filter((h) => h.global !== false), fetchedAt };
});

route('GET', '/api/world-land', async () => {
  const { data } = await cachedJson('map:land-110m', 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json', 60 * DAY);
  return data;
});

route('GET', '/api/currencies', async () => {
  const frankfurter = await getFrankfurterCurrencies();
  const all = [...new Set([...Object.keys(frankfurter), ...Object.values(COUNTRY_META).map((m) => m[0])])].sort();
  return { frankfurter, all };
});

route('GET', '/api/fx', async ({ query }) => {
  const from = (query.get('from') || '').toUpperCase();
  const to = (query.get('to') || '').toUpperCase();
  if (!isCurrency(from) || !isCurrency(to)) throw new HttpError(400, 'from and to must be 3-letter currency codes');
  return getRate(from, to);
});

route('GET', '/api/price-level/:cc', async ({ params }) => {
  const cc = params.cc.toUpperCase();
  if (!isCountry(cc)) throw new HttpError(400, 'Invalid country code');
  return getPriceLevel(cc);
});

route('GET', '/api/geocode', async ({ query }) => {
  const name = cleanText(query.get('name'), 80);
  if (name.length < 2) throw new HttpError(400, 'name is too short');
  const cc = (query.get('country') || '').toUpperCase();
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', name);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'en');
  if (isCountry(cc)) url.searchParams.set('countryCode', cc);
  const { data } = await cachedJson(`geo:${name.toLowerCase()}:${cc}`, url.href, 30 * DAY);
  return {
    results: (data?.results ?? []).map((r) => ({
      name: r.name, admin1: r.admin1, country: r.country, countryCode: r.country_code, lat: r.latitude, lng: r.longitude,
    })),
  };
});

route('GET', '/api/weather', async ({ query }) => {
  const lat = toNumber(query.get('lat'), { min: -90, max: 90 });
  const lon = toNumber(query.get('lon'), { min: -180, max: 180 });
  const start = query.get('start');
  const end = query.get('end');
  if (lat === null || lon === null) throw new HttpError(400, 'lat and lon are required');
  if (!isIsoDate(start) || !isIsoDate(end) || end < start) throw new HttpError(400, 'start and end must be YYYY-MM-DD');
  if ((Date.parse(end) - Date.parse(start)) / DAY > 31) throw new HttpError(400, 'Weather is limited to 31 days');
  return getWeather(lat.toFixed(2), lon.toFixed(2), start, end);
});

// --- plans (database CRUD) ---
route('GET', '/api/plans', ({ req }) => {
  const owner = ownerHash(req);
  if (!owner) return { plans: [] };
  return { plans: db.listPlans(owner).map((p) => publicPlan(p, req)) };
});

route('POST', '/api/plans', async ({ req }) => {
  const owner = ownerHash(req);
  if (!owner) throw new HttpError(401, 'Missing X-Owner-Token header');
  const data = planFromBody(await readJsonBody(req));
  const now = Date.now();
  const id = newId();
  db.insertPlan({ id, owner_hash: owner, ...data, created_at: now, updated_at: now });
  return [201, { plan: publicPlan(db.getPlan(id), req) }];
});

route('GET', '/api/plans/:id', ({ req, params }) => {
  const plan = db.getPlan(params.id);
  if (!plan) throw new HttpError(404, 'Plan not found');
  return { plan: publicPlan(plan, req), expenses: db.listExpenses(plan.id) };
});

route('PUT', '/api/plans/:id', async ({ req, params }) => {
  requireOwnedPlan(req, params.id);
  const data = planFromBody(await readJsonBody(req));
  db.updatePlan({ id: params.id, ...data, updated_at: Date.now() });
  return { plan: publicPlan(db.getPlan(params.id), req) };
});

route('DELETE', '/api/plans/:id', ({ req, params }) => {
  requireOwnedPlan(req, params.id);
  db.deletePlan(params.id);
  return { deleted: true };
});

route('GET', '/api/plans/:id/expenses', ({ params }) => {
  if (!db.getPlan(params.id)) throw new HttpError(404, 'Plan not found');
  return { expenses: db.listExpenses(params.id) };
});

route('POST', '/api/plans/:id/expenses', async ({ req, params }) => {
  requireOwnedPlan(req, params.id);
  const body = await readJsonBody(req);
  const category = EXPENSE_CATEGORIES.includes(body.category) ? body.category : null;
  if (!category) throw new HttpError(400, `category must be one of ${EXPENSE_CATEGORIES.join(', ')}`);
  const amount = toNumber(body.amount, { min: 0.01, max: 1e10 });
  if (amount === null) throw new HttpError(400, 'amount is required');
  const spent_on = isIsoDate(body.spent_on) ? body.spent_on : null;
  const expense = db.addExpense(params.id, { category, amount, note: cleanText(body.note, 120) || null, spent_on });
  return [201, { expense }];
});

route('DELETE', '/api/plans/:id/expenses/:eid', ({ req, params }) => {
  requireOwnedPlan(req, params.id);
  const changes = db.deleteExpense(params.id, Number(params.eid));
  if (!changes) throw new HttpError(404, 'Expense not found');
  return { deleted: true };
});

// ---------- static files ------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://api.bigdatacloud.net",
  ].join('; '),
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(403, 'Forbidden');
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  if (!info.isFile()) throw new HttpError(404, 'Not found');
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- server ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        const anyMethod = routes.some((r) => r.re.test(url.pathname));
        throw new HttpError(anyMethod ? 405 : 404, anyMethod ? 'Method not allowed' : 'Unknown API endpoint');
      }
      const values = url.pathname.match(match.re).slice(1).map(decodeURIComponent);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, values[i]]));
      const out = await match.handler({ req, res, params, query: url.searchParams });
      const [status, data] = Array.isArray(out) ? out : [200, out];
      sendJson(res, status, data);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
    } else {
      throw new HttpError(405, 'Method not allowed');
    }
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: err.message || 'Server error' });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${status} ${err.message}`);
    }
  } finally {
    if (url.pathname.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${Date.now() - started} ms)`);
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use (maybe the planner is already running in another terminal).`);
    console.error('Stop the other server, or start this one on another port:');
    console.error('  PowerShell:  $env:PORT=3001; npm start');
    console.error('  bash/macOS:  PORT=3001 npm start\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\nHoliday & Long-Weekend Planner is running at http://localhost:${PORT}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
