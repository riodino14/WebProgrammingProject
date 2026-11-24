# Holiday & Long-Weekend Planner

*Find the best breaks, then plan the trip.*
Web Programming 2026 assignment. Riodino Raihan (50261893). Proposal #23.

Pick a country, a year and how many leave days you can spend. The app loads the public
holidays, finds the breaks that give the most days off per leave day, and helps you plan the
trip: budget in two currencies, a budget check, the weather, an expense tracker, calendar export,
PDF and share links.

## How to run

Requirements: **Node.js 22.13 or newer** (it uses the built-in `node:sqlite` module).
No `npm install` is needed because the project has no dependencies.

```bash
cd holiday-planner
npm start          # or: node server/server.js
# open http://localhost:3000
npm test           # 11 unit tests for the optimizer
```

The SQLite database file `data/planner.db` is created automatically on first start.
An internet connection is needed the first time a country/year is opened (open APIs). After that
the server answers from its database cache.
"Use my location" needs `http://localhost` or https, because browsers only allow geolocation
in a secure context.

## Features (proposal levels)

| Level | Feature | Where |
|---|---|---|
| 1 | Month calendar in HTML tables | `public/js/calendar.js` |
| 2 | Responsive year calendar (CSS Grid) and break ribbons, dark mode, mobile layout | `public/css/style.css` |
| 3 | Holidays fetched from Nager.Date (through our server) | `server/server.js`, `public/js/api.js` |
| 4 | Suggest the best leave days + whole-year optimizer (dynamic programming) | `public/js/optimizer.js` |
| 5 | **All 9 menu items:** trip budget, budget check, expense tracker, trip weather, .ics + PDF export, share link, year heatmap, world holiday map, custom days | see below |

Extras: location-based country detection, saved plans in a database, read-only shared plans,
Friday-Saturday weekend support, regional holidays, Christmas–New Year breaks that cross into
January, mobile menu, one-page PDF trip sheet, unit tests.

## Architecture

```
Browser (HTML + CSS + JS modules, Canvas)
   │  fetch /api/...                      └─ BigDataCloud (reverse geocoding, called directly)
   ▼
Node.js server (server/server.js, no frameworks)
   ├─ REST API + static files + security headers (CSP)
   ├─ proxy and cache for open APIs ──► Nager.Date, Frankfurter, World Bank, Open-Meteo, world-atlas
   └─ SQLite database (server/db.js)
        tables: holidays, holiday_fetch, api_cache, plans, expenses
```

### REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/countries` | Nager.Date countries + currency, main city, coordinates, weekend |
| GET | `/api/holidays/:year/:cc` | Public holidays (stored row by row in SQLite) |
| GET | `/api/long-weekends/:year/:cc` | Nager.Date long weekends |
| GET | `/api/worldwide` | Holidays worldwide in the next 7 days (map) |
| GET | `/api/world-land` | Land shapes (TopoJSON) for the map |
| GET | `/api/currencies` | Currency list |
| GET | `/api/fx?from=&to=` | Exchange rate (Frankfurter; World Bank fallback for other currencies) |
| GET | `/api/price-level/:cc` | World Bank PPP / exchange rate = price level |
| GET | `/api/geocode?name=&country=` | City search (Open-Meteo) |
| GET | `/api/weather?lat=&lon=&start=&end=` | Forecast, or last year's weather when the trip is > 16 days away |
| GET/POST | `/api/plans` | List my plans / save a plan |
| GET/PUT/DELETE | `/api/plans/:id` | Read (anyone with the link) / update / delete (owner only) |
| POST | `/api/plans/:id/expenses` | Add an expense (owner only) |
| DELETE | `/api/plans/:id/expenses/:eid` | Delete an expense (owner only) |
| GET | `/api/stats`, `/api/health` | Database statistics / health check |

Ownership: each browser creates a random token (localStorage) and sends it in the `X-Owner-Token`
header. The server stores only its SHA-256 hash. Anyone with a plan link can view it; only the
owner can change it.

## Open APIs used (all free, no API key)

- Nager.Date: public holidays, long weekends, worldwide holidays
- Frankfurter: ECB exchange rates
- World Bank: `PA.NUS.PPP` and `PA.NUS.FCRF` (price level, fallback exchange rates)
- Open-Meteo: geocoding, forecast, historical weather
- BigDataCloud: reverse geocoding for "Use my location"
- world-atlas / Natural Earth: land shapes for the canvas map

## Folder structure

```
holiday-planner/
├─ package.json
├─ server/
│  ├─ server.js        HTTP server, REST API, open-API proxy + cache
│  └─ db.js            SQLite schema and queries
├─ public/
│  ├─ index.html
│  ├─ favicon.svg      logo: a map pin with a plane over sea and sunset waves
│  ├─ css/style.css    layout, components, dark mode, responsive
│  ├─ css/print.css    "Save as PDF": one-page A4 trip sheet
│  ├─ img/             hero photo + 12 season photos (640px for cards, -hd 1600px for the PDF)
│  └─ js/
│     ├─ main.js       app controller (state, events)
│     ├─ optimizer.js  break finder + year optimizer (pure functions)
│     ├─ dates.js      UTC date helpers
│     ├─ calendar.js   month tables and ribbons
│     ├─ charts.js     canvas bar chart, heatmap, doughnut
│     ├─ worldmap.js   canvas world map (TopoJSON decoder)
│     ├─ planner.js    budget, budget check, weather (with icons)
│     ├─ exporters.js  .ics export, share links
│     ├─ geo.js        geolocation + reverse geocoding
│     ├─ api.js        client for our REST API
│     ├─ storage.js    localStorage helpers
│     ├─ ui.js         DOM helpers, money format, in-page dialog
│     ├─ theme-init.js
│     └─ data/countries-meta.js
└─ test/optimizer.test.js
```
