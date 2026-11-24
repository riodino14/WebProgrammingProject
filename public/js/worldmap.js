// World holiday map drawn on a canvas.
// Land shapes: Natural Earth 110m (TopoJSON from the world-atlas package, served through our server).
// Dots: every Nager.Date country, coloured by whether it has a public holiday today / this week.

import { api } from './api.js';
import { cssVar, esc } from './ui.js';
import { fmtDay } from './dates.js';

const LAT_TOP = 84;
const LAT_BOTTOM = -58;

/** Decode TopoJSON arcs (quantized + delta encoded) into [lng, lat] point lists. */
function decodeTopo(topo) {
  const [kx, ky] = topo.transform.scale;
  const [dx, dy] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([a, b]) => {
      x += a;
      y += b;
      return [x * kx + dx, y * ky + dy];
    });
  });
  const ring = (indexes) => {
    const pts = [];
    for (const i of indexes) {
      const arc = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
      pts.push(...(pts.length ? arc.slice(1) : arc));
    }
    return pts;
  };
  const polygons = [];
  for (const g of Object.values(topo.objects)[0].geometries) {
    if (g.type === 'Polygon') polygons.push(g.arcs.map(ring));
    else if (g.type === 'MultiPolygon') for (const p of g.arcs) polygons.push(p.map(ring));
  }
  return polygons;
}

/**
 * Shapes that cross the date line (east Russia, Fiji) jump from +180 to -180 longitude.
 * Drawn as is, that jump is a line across the whole map that flips the fill into stripes.
 * So each ring is "unwrapped" (longitudes kept continuous) and a ring that ends up past
 * the edge is drawn a second time shifted by 360 degrees, on the other side of the map.
 * Antarctica (all below the map) is left out.
 */
function landRings(polygons) {
  const rings = [];
  for (const poly of polygons) {
    for (const pts of poly) {
      if (pts.every(([, lat]) => lat < LAT_BOTTOM)) continue;
      let shift = 0;
      let prev = pts[0][0];
      const out = pts.map(([lng, lat]) => {
        if (lng - prev > 180) shift -= 360;
        else if (prev - lng > 180) shift += 360;
        prev = lng;
        return [lng + shift, lat];
      });
      rings.push(out);
      const lngs = out.map((p) => p[0]);
      if (Math.max(...lngs) > 180) rings.push(out.map(([lng, lat]) => [lng - 360, lat]));
      if (Math.min(...lngs) < -180) rings.push(out.map(([lng, lat]) => [lng + 360, lat]));
    }
  }
  return rings;
}

export function createWorldMap(canvas, tip, { onPick }) {
  let polygons = null;
  let state = { countries: [], byCountry: new Map(), selected: null, user: null, today: '' };
  let points = [];
  let hover = null;

  const project = (lng, lat, w, h) => [((lng + 180) / 360) * w, ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * h];

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = Math.round(w * 0.46);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ocean + graticule
    ctx.fillStyle = cssVar('--map-sea');
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = cssVar('--border');
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let lng = -150; lng <= 150; lng += 30) {
      const [x] = project(lng, 0, w, h);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let lat = -30; lat <= 60; lat += 30) {
      const [, y] = project(0, lat, w, h);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // land
    if (polygons) {
      ctx.fillStyle = cssVar('--map-land');
      ctx.beginPath();
      for (const ringPts of polygons) {
        ringPts.forEach(([lng, lat], i) => {
          const [x, y] = project(lng, lat, w, h);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.strokeStyle = cssVar('--map-edge'); // country borders
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // country dots: quiet ones first, holidays on top
    const colours = { today: cssVar('--orange'), week: cssVar('--teal-bright'), none: cssVar('--map-dot') };
    const ring = cssVar('--map-sea');
    const order = { none: 0, week: 1, today: 2 };
    points = state.countries
      .map((c) => {
        const hols = state.byCountry.get(c.code) ?? [];
        const status = hols.some((x) => x.date === state.today) ? 'today' : hols.length ? 'week' : 'none';
        const [x, y] = project(c.lng, c.lat, w, h);
        return { c, hols, status, x, y, r: status === 'today' ? 6 : status === 'week' ? 4.5 : 2.2 };
      })
      .sort((a, b) => order[a.status] - order[b.status]);
    for (const p of points) {
      ctx.globalAlpha = p.status === 'none' ? 0.7 : 1;
      ctx.fillStyle = colours[p.status];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (p.status !== 'none') { // a thin ring lifts holiday dots off the land
        ctx.strokeStyle = ring;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (p.status === 'today') {
        ctx.strokeStyle = colours.today;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (p.c.code === state.selected || p === hover) {
        ctx.strokeStyle = cssVar('--text');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // the visitor's own position
    if (state.user) {
      const [x, y] = project(state.user.lng, state.user.lat, w, h);
      ctx.fillStyle = cssVar('--purple'); // matches the "You" legend dot
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function pointAt(evt) {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    let best = null;
    let bestD = 14 * 14;
    for (const p of points) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      const bonus = p.status === 'none' ? 30 : 0; // prefer holiday dots when they are close together
      if (d + bonus < bestD) {
        bestD = d + bonus;
        best = p;
      }
    }
    return { p: best, mx, my };
  }

  canvas.addEventListener('mousemove', (evt) => {
    const { p, mx, my } = pointAt(evt);
    if (p !== hover) {
      hover = p;
      draw();
    }
    if (!p) {
      tip.hidden = true;
      canvas.style.cursor = 'crosshair';
      return;
    }
    canvas.style.cursor = 'pointer';
    const list = p.hols.length
      ? p.hols.map((h) => `${esc(fmtDay(h.date))}: ${esc(h.name)}`).join('<br>')
      : 'No public holiday in the next 7 days';
    tip.innerHTML = `<b>${esc(p.c.name)}</b><br>${list}`;
    tip.hidden = false;
    const left = Math.min(mx + 14, canvas.clientWidth - tip.offsetWidth - 4);
    tip.style.left = `${canvas.offsetLeft + Math.max(0, left)}px`;
    tip.style.top = `${canvas.offsetTop + my + 14}px`;
  });
  canvas.addEventListener('mouseleave', () => {
    tip.hidden = true;
    hover = null;
    draw();
  });
  canvas.addEventListener('click', (evt) => {
    const { p } = pointAt(evt);
    if (p) onPick(p.c.code);
  });
  new ResizeObserver(() => draw()).observe(canvas.parentElement);

  api
    .worldLand()
    .then((topo) => {
      polygons = landRings(decodeTopo(topo));
      draw();
    })
    .catch(() => {
      /* the dots still work without land shapes */
    });

  return {
    update(next) {
      state = { ...state, ...next };
      draw();
    },
    redraw: draw,
  };
}
