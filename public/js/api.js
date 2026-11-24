// Client for our own server's REST API (fetch + JSON).
// The browser never calls the open APIs directly (except BigDataCloud for location):
// the server proxies them and keeps a cache in its database.

import { ownerToken } from './storage.js';

const memo = new Map(); // small in-memory cache for GET requests during this visit

async function request(path, { method = 'GET', body, cache = false } = {}) {
  if (cache && method === 'GET' && memo.has(path)) return memo.get(path);
  const job = (async () => {
    const res = await fetch(path, {
      method,
      headers: {
        'X-Owner-Token': ownerToken(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  })();
  if (cache) {
    memo.set(path, job);
    job.catch(() => memo.delete(path)); // do not keep failures
  }
  return job;
}

const q = (params) => new URLSearchParams(params).toString();

export const api = {
  countries: () => request('/api/countries', { cache: true }),
  holidays: (year, cc) => request(`/api/holidays/${year}/${cc}`, { cache: true }),
  longWeekends: (year, cc) => request(`/api/long-weekends/${year}/${cc}`, { cache: true }),
  worldwide: () => request('/api/worldwide', { cache: true }),
  worldLand: () => request('/api/world-land', { cache: true }),
  currencies: () => request('/api/currencies', { cache: true }),
  fx: (from, to) => request(`/api/fx?${q({ from, to })}`, { cache: true }),
  priceLevel: (cc) => request(`/api/price-level/${cc}`, { cache: true }),
  geocode: (name, country) => request(`/api/geocode?${q({ name, country: country || '' })}`, { cache: true }),
  weather: (p) => request(`/api/weather?${q(p)}`, { cache: true }),
  stats: () => request('/api/stats'),
  plans: {
    list: () => request('/api/plans'),
    get: (id) => request(`/api/plans/${encodeURIComponent(id)}`),
    create: (plan) => request('/api/plans', { method: 'POST', body: plan }),
    update: (id, plan) => request(`/api/plans/${encodeURIComponent(id)}`, { method: 'PUT', body: plan }),
    remove: (id) => request(`/api/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  expenses: {
    add: (planId, e) => request(`/api/plans/${encodeURIComponent(planId)}/expenses`, { method: 'POST', body: e }),
    remove: (planId, id) => request(`/api/plans/${encodeURIComponent(planId)}/expenses/${id}`, { method: 'DELETE' }),
  },
};
