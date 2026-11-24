// Small DOM helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text before putting it into HTML (protects against XSS from API or user data). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

let toastTimer;
export function toast(message, type = 'info') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${type === 'error' ? 'error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/**
 * A dialog in the page's own style instead of the browser's confirm()/prompt().
 * Resolves true when the main button is pressed; Esc, Cancel or a click outside resolve false.
 * `field` shows a read-only text (e.g. a link) that is selected so it can be copied.
 */
export function dialog({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, field = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.setAttribute('aria-labelledby', 'dialogTitle');
    dlg.innerHTML = `<form method="dialog">
        <h3 id="dialogTitle">${esc(title)}</h3>
        ${text ? `<p>${esc(text)}</p>` : ''}
        ${field != null ? `<input class="dialog-field" readonly value="${esc(field)}" aria-label="${esc(title)}">` : ''}
        <div class="dialog-actions">
          ${cancel ? `<button class="btn" value="cancel">${esc(cancel)}</button>` : ''}
          <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" value="ok">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    // the dialog box has no padding of its own, so a click on the dialog element itself is the backdrop
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
    dlg.showModal();
    const input = dlg.querySelector('.dialog-field');
    if (input) input.select();
    else dlg.querySelector(`button[value="${cancel ? 'cancel' : 'ok'}"]`).focus(); // the safe choice has focus
  });
}

export function debounce(fn, ms = 350) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

/** Money with the right symbol and decimals; falls back to "1,234 XCG" for rare currencies. */
export function money(amount, currency, { compact = false, whole = false } = {}) {
  if (!Number.isFinite(amount)) return '–';
  const big = whole || Math.abs(amount) >= 1000;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      // X.. currencies (XPF, XOF, XAF) get symbols few people know ("CFPF"): show the code
      currencyDisplay: currency.startsWith('X') ? 'code' : 'symbol',
      minimumFractionDigits: big ? 0 : undefined,
      maximumFractionDigits: big ? 0 : 2,
      notation: compact && Math.abs(amount) >= 1e6 ? 'compact' : 'standard',
    }).format(amount);
  } catch {
    return `${num(amount, big ? 0 : 2)} ${currency}`;
  }
}

export const num = (n, digits = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);

/** Round to two significant digits: 1328.45 -> 1300, 0.0753 -> 0.075. */
export function niceRound(n) {
  if (!Number.isFinite(n) || n <= 0) return n;
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

/** Read a CSS custom property (used by the canvas drawings so they follow the theme). */
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label || 'Working…')}`;
  } else if (button.dataset.label) {
    button.innerHTML = button.dataset.label;
    button.disabled = false;
  }
}
