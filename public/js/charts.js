// Canvas drawings: holidays-per-month bar chart, year heatmap and expense doughnut.
// All of them are drawn with the plain Canvas 2D API (no chart library) and read their
// colours from CSS variables, so they follow light / dark mode.

import { MONTHS_SHORT, DOW_LETTER } from './dates.js';
import { cssVar } from './ui.js';

/** Size the canvas for the screen's pixel ratio so lines stay sharp. */
export function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(240, canvas.clientWidth || canvas.parentElement.clientWidth);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, w: width, h: height };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2)); // arcTo throws on a negative radius
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = (size, weight = 500) => `${weight} ${size}px Poppins, system-ui, sans-serif`;

// ---------------------------------------------------------------------------
// Bar chart: public holidays per month
// ---------------------------------------------------------------------------
export function drawMonthBars(canvas, counts, { animate = true } = {}) {
  const max = Math.max(1, ...counts);
  const top = Math.max(...counts);
  const draw = (t) => {
    const { ctx, w, h } = setupCanvas(canvas, 230);
    const pad = { l: 28, r: 8, t: 22, b: 26 };
    const cw = (w - pad.l - pad.r) / 12;
    const ch = h - pad.t - pad.b;
    const steps = Math.min(max, 5);
    ctx.font = FONT(10);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= steps; i++) {
      const v = Math.round((max / steps) * i);
      const y = pad.t + ch - (v / max) * ch;
      ctx.strokeStyle = cssVar('--border');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(y) + 0.5);
      ctx.lineTo(w - pad.r, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = cssVar('--muted');
      ctx.fillText(String(v), pad.l - 6, y);
    }
    counts.forEach((c, m) => {
      const bw = Math.min(34, cw * 0.62);
      const x = pad.l + m * cw + (cw - bw) / 2;
      const bh = (c / max) * ch * t;
      const y = pad.t + ch - bh;
      if (c > 0 && bh > 0) {
        ctx.fillStyle = c === top ? cssVar('--orange') : cssVar('--teal');
        roundRect(ctx, x, y, bw, bh, 5);
        ctx.fill();
      }
      ctx.fillStyle = cssVar('--text');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = FONT(11, 700);
      if (t === 1) ctx.fillText(String(c), x + bw / 2, y - 3);
      ctx.fillStyle = cssVar('--muted');
      ctx.textBaseline = 'top';
      ctx.font = FONT(11);
      ctx.fillText(MONTHS_SHORT[m], x + bw / 2, h - pad.b + 7);
    });
  };
  if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(1);
  const start = performance.now();
  const step = (now) => {
    // the frame timestamp can be a little earlier than `start`, so clamp to 0..1
    const p = Math.max(0, Math.min(1, (now - start) / 500));
    draw(1 - (1 - p) ** 3);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Heatmap: every day of the year in a grid of weeks (columns) x weekdays (rows)
// ---------------------------------------------------------------------------
export function drawHeatmap(canvas, o) {
  const yearDays = o.days.filter((d) => d.inYear);
  const firstDow = yearDays[0].dow;
  const weeks = Math.ceil((yearDays.length + firstDow) / 7);
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const left = 18;
  const topPad = 18;
  const gap = 2;
  const cell = Math.max(6, Math.min(22, Math.floor((width - left - 2) / weeks) - gap));
  const height = topPad + 7 * (cell + gap) + 4;
  const { ctx } = setupCanvas(canvas, height);
  const leave = new Set(o.selected?.leaveDates ?? []);
  const colours = {
    work: cssVar('--day-work'),
    weekend: cssVar('--day-weekend'),
    holiday: cssVar('--orange'),
    leave: cssVar('--teal'),
    plan: cssVar('--leave-plan-bg'),
    custom: cssVar('--purple'),
    busy: cssVar('--red'),
    border: cssVar('--border'),
    sel: cssVar('--teal-bright'),
    muted: cssVar('--muted'),
    today: cssVar('--orange'),
  };
  ctx.font = FONT(cell >= 14 ? 11 : 9); // labels grow with the cells on wide screens
  ctx.fillStyle = colours.muted;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  [1, 3, 5].forEach((r) => ctx.fillText(DOW_LETTER[r], 2, topPad + r * (cell + gap) + cell / 2));
  const cells = [];
  yearDays.forEach((d, idx) => {
    const pos = idx + firstDow;
    const col = Math.floor(pos / 7);
    const row = pos % 7;
    const x = left + col * (cell + gap);
    const y = topPad + row * (cell + gap);
    if (d.iso.endsWith('-01')) {
      // month label above the week that contains the 1st
      ctx.fillStyle = colours.muted;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(MONTHS_SHORT[Number(d.iso.slice(5, 7)) - 1], x, 11);
    }
    let fill = colours.work;
    if (d.weekend) fill = colours.weekend;
    if (d.custom?.type === 'off') fill = colours.custom;
    if (d.blocked) fill = colours.busy;
    if (o.planLeave?.has(d.iso)) fill = colours.plan;
    if (leave.has(d.iso)) fill = colours.leave;
    if (d.holidays.length) fill = colours.holiday;
    ctx.globalAlpha = o.dimPast && d.iso < o.today ? 0.4 : 1;
    ctx.fillStyle = fill;
    roundRect(ctx, x, y, cell, cell, Math.min(4, cell / 3));
    ctx.fill();
    if (fill === colours.work) {
      ctx.strokeStyle = colours.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (o.selected && d.iso >= o.selected.start && d.iso <= o.selected.end) {
      ctx.strokeStyle = colours.sel;
      ctx.lineWidth = 2;
      roundRect(ctx, x - 1, y - 1, cell + 2, cell + 2, 4);
      ctx.stroke();
    }
    if (d.iso === o.today) {
      ctx.strokeStyle = colours.today;
      ctx.lineWidth = 2;
      roundRect(ctx, x - 1.5, y - 1.5, cell + 3, cell + 3, 4);
      ctx.stroke();
    }
    cells.push({ x, y, size: cell, day: d });
  });
  // hit test used for hover tooltips and clicks
  return (px, py) => cells.find((c) => px >= c.x && px <= c.x + c.size && py >= c.y && py <= c.y + c.size)?.day ?? null;
}

// ---------------------------------------------------------------------------
// Doughnut chart: expenses by category
// ---------------------------------------------------------------------------
export const CATEGORY_COLOURS = {
  // sea and sand tones from the hero photo, far enough apart to tell the slices apart
  Lodging: '#0e7a6e',   // teal
  Food: '#e8aa68',      // sand
  Transport: '#2f7fa6', // deep water
  Activities: '#7cc9b8',// shallow water
  Shopping: '#c0654a',  // terracotta
  Other: '#8c9a9b',     // driftwood grey
};

export function drawDonut(canvas, slices, { title = '', subtitle = '' } = {}) {
  const { ctx, w, h } = setupCanvas(canvas, 230);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const legendW = w > 420 ? 150 : 0;
  const cx = (w - legendW) / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 8;
  const inner = r * 0.62;
  if (!total) {
    ctx.strokeStyle = cssVar('--border');
    ctx.lineWidth = r - inner;
    ctx.beginPath();
    ctx.arc(cx, cy, (r + inner) / 2, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    let a = -Math.PI / 2;
    for (const s of slices) {
      if (!s.value) continue;
      const da = (s.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a, a + da);
      ctx.closePath();
      ctx.fillStyle = s.colour;
      ctx.fill();
      a += da;
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = cssVar('--text');
  ctx.font = `700 ${Math.max(14, Math.min(20, r / 4.5))}px Montserrat, system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, cx, cy + 3);
  ctx.font = FONT(11);
  ctx.fillStyle = cssVar('--muted');
  ctx.textBaseline = 'top';
  ctx.fillText(subtitle, cx, cy + 8);
  if (legendW) {
    let y = cy - (slices.length * 22) / 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const s of slices) {
      ctx.fillStyle = s.colour;
      roundRect(ctx, w - legendW + 8, y + 3, 12, 12, 3);
      ctx.fill();
      ctx.fillStyle = cssVar('--text');
      ctx.font = FONT(12);
      const pct = total ? Math.round((s.value / total) * 100) : 0;
      ctx.fillText(`${s.label}  ${pct}%`, w - legendW + 28, y + 9);
      y += 22;
    }
  }
}
