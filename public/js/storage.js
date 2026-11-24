// Web Storage (localStorage) helpers. Every access is wrapped in try/catch because storage
// can be blocked (private mode, strict privacy settings) - the app must still work then.

const PREFIX = 'hp.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function randomToken() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Anonymous id for this browser. The server stores only a hash of it and uses it to know
 * which saved plans belong to this visitor (no login needed).
 */
export function ownerToken() {
  let t = load('owner', null);
  if (typeof t !== 'string' || t.length < 16) {
    t = randomToken();
    save('owner', t);
  }
  return t;
}

// ----- custom days: [{date, type: 'off' | 'busy', label}] -----
export function getCustomDays() {
  const list = load('customDays', []);
  return Array.isArray(list) ? list.filter((d) => d && typeof d.date === 'string') : [];
}

export function setCustomDays(list) {
  save('customDays', [...list].sort((a, b) => a.date.localeCompare(b.date)));
}

// ----- preferences -----
export const getPrefs = () => load('prefs', {});
export const setPrefs = (p) => save('prefs', { ...getPrefs(), ...p });

export const getTheme = () => document.documentElement.getAttribute('data-theme') || 'light';
export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(PREFIX + 'theme', theme);
  } catch {
    /* ignore */
  }
}
