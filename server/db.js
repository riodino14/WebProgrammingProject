// Database layer: SQLite through Node's built-in `node:sqlite` module.
// No npm packages are needed. The database file is created on first start.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('\n[db] This app needs Node.js 22.13 or newer (built-in node:sqlite).');
  console.error(`[db] You are running Node ${process.version}. Please update Node.js.\n`);
  process.exit(1);
}

export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- Generic cache for open API responses (currency, weather, World Bank ...)
    CREATE TABLE IF NOT EXISTS api_cache (
      key        TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- Public holidays from Nager.Date, stored row by row
    CREATE TABLE IF NOT EXISTS holidays (
      country    TEXT NOT NULL,
      year       INTEGER NOT NULL,
      date       TEXT NOT NULL,
      local_name TEXT,
      name       TEXT NOT NULL,
      is_global  INTEGER NOT NULL DEFAULT 1,
      counties   TEXT,
      types      TEXT,
      PRIMARY KEY (country, year, date, name)
    );
    CREATE TABLE IF NOT EXISTS holiday_fetch (
      country    TEXT NOT NULL,
      year       INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (country, year)
    );

    -- Saved trip plans. owner_hash is a SHA-256 of the browser's anonymous token.
    CREATE TABLE IF NOT EXISTS plans (
      id               TEXT PRIMARY KEY,
      owner_hash       TEXT NOT NULL,
      title            TEXT NOT NULL,
      country          TEXT NOT NULL,
      year             INTEGER NOT NULL,
      start_date       TEXT NOT NULL,
      end_date         TEXT NOT NULL,
      leave_days       INTEGER NOT NULL DEFAULT 0,
      leave_dates      TEXT NOT NULL DEFAULT '[]',
      budget_per_day   REAL,
      currency         TEXT,
      display_currency TEXT,
      destination      TEXT,
      city             TEXT,
      baseline_usd     REAL,
      notes            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plans_owner ON plans(owner_hash, updated_at DESC);

    -- Expenses that belong to a saved plan
    CREATE TABLE IF NOT EXISTS expenses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      category   TEXT NOT NULL,
      amount     REAL NOT NULL,
      note       TEXT,
      spent_on   TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_plan ON expenses(plan_id);
  `);

  const q = {
    getCache: db.prepare('SELECT body, fetched_at FROM api_cache WHERE key = ?'),
    setCache: db.prepare(`INSERT INTO api_cache (key, body, fetched_at) VALUES (?, ?, ?)
                          ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`),
    getHolidayFetch: db.prepare('SELECT fetched_at FROM holiday_fetch WHERE country = ? AND year = ?'),
    setHolidayFetch: db.prepare(`INSERT INTO holiday_fetch (country, year, fetched_at) VALUES (?, ?, ?)
                                 ON CONFLICT(country, year) DO UPDATE SET fetched_at = excluded.fetched_at`),
    deleteHolidays: db.prepare('DELETE FROM holidays WHERE country = ? AND year = ?'),
    insertHoliday: db.prepare(`INSERT OR REPLACE INTO holidays
      (country, year, date, local_name, name, is_global, counties, types) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    listHolidays: db.prepare('SELECT * FROM holidays WHERE country = ? AND year = ? ORDER BY date, name'),

    insertPlan: db.prepare(`INSERT INTO plans (id, owner_hash, title, country, year, start_date, end_date, leave_days,
      leave_dates, budget_per_day, currency, display_currency, destination, city, baseline_usd, notes, created_at, updated_at)
      VALUES (:id, :owner_hash, :title, :country, :year, :start_date, :end_date, :leave_days, :leave_dates,
      :budget_per_day, :currency, :display_currency, :destination, :city, :baseline_usd, :notes, :created_at, :updated_at)`),
    updatePlan: db.prepare(`UPDATE plans SET title = :title, country = :country, year = :year, start_date = :start_date,
      end_date = :end_date, leave_days = :leave_days, leave_dates = :leave_dates, budget_per_day = :budget_per_day,
      currency = :currency, display_currency = :display_currency, destination = :destination, city = :city,
      baseline_usd = :baseline_usd, notes = :notes, updated_at = :updated_at WHERE id = :id`),
    getPlan: db.prepare('SELECT * FROM plans WHERE id = ?'),
    listPlans: db.prepare(`SELECT p.*, (SELECT COALESCE(SUM(amount), 0) FROM expenses e WHERE e.plan_id = p.id) AS spent,
      (SELECT COUNT(*) FROM expenses e WHERE e.plan_id = p.id) AS expense_count
      FROM plans p WHERE owner_hash = ? ORDER BY updated_at DESC LIMIT 100`),
    deletePlan: db.prepare('DELETE FROM plans WHERE id = ?'),

    listExpenses: db.prepare('SELECT * FROM expenses WHERE plan_id = ? ORDER BY spent_on, id'),
    insertExpense: db.prepare(`INSERT INTO expenses (plan_id, category, amount, note, spent_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    getExpense: db.prepare('SELECT * FROM expenses WHERE id = ? AND plan_id = ?'),
    deleteExpense: db.prepare('DELETE FROM expenses WHERE id = ? AND plan_id = ?'),
    touchPlan: db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?'),

    stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM holidays) AS holidays,
      (SELECT COUNT(*) FROM holiday_fetch) AS holiday_sets,
      (SELECT COUNT(*) FROM api_cache) AS cache_entries,
      (SELECT COUNT(*) FROM plans) AS plans,
      (SELECT COUNT(*) FROM expenses) AS expenses`),
  };

  /** Run fn inside a transaction (all-or-nothing). */
  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    raw: db,
    getCache(key) {
      return q.getCache.get(key) ?? null;
    },
    setCache(key, value) {
      q.setCache.run(key, JSON.stringify(value), Date.now());
    },
    holidayFetchedAt(country, year) {
      return q.getHolidayFetch.get(country, year)?.fetched_at ?? null;
    },
    saveHolidays(country, year, list) {
      tx(() => {
        q.deleteHolidays.run(country, year);
        for (const h of list) {
          q.insertHoliday.run(country, year, h.date, h.localName ?? null, h.name, h.global === false ? 0 : 1,
            h.counties ? JSON.stringify(h.counties) : null, JSON.stringify(h.types ?? []));
        }
        q.setHolidayFetch.run(country, year, Date.now());
      });
    },
    listHolidays(country, year) {
      return q.listHolidays.all(country, year).map((r) => ({
        date: r.date,
        localName: r.local_name,
        name: r.name,
        global: r.is_global === 1,
        counties: r.counties ? JSON.parse(r.counties) : null,
        types: r.types ? JSON.parse(r.types) : [],
      }));
    },
    insertPlan(row) {
      q.insertPlan.run(row);
    },
    updatePlan(row) {
      q.updatePlan.run(row);
    },
    getPlan(id) {
      return q.getPlan.get(id) ?? null;
    },
    listPlans(ownerHash) {
      return q.listPlans.all(ownerHash);
    },
    deletePlan(id) {
      return q.deletePlan.run(id).changes;
    },
    listExpenses(planId) {
      return q.listExpenses.all(planId);
    },
    addExpense(planId, e) {
      return tx(() => {
        const info = q.insertExpense.run(planId, e.category, e.amount, e.note, e.spent_on, Date.now());
        q.touchPlan.run(Date.now(), planId);
        return q.getExpense.get(Number(info.lastInsertRowid), planId);
      });
    },
    deleteExpense(planId, id) {
      return q.deleteExpense.run(id, planId).changes;
    },
    stats() {
      return q.stats.get();
    },
    close() {
      db.close();
    },
  };
}
