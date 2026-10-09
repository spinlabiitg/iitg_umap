// Printable poster (light, dark or cartoon): the campus drawn as one SVG in millimetres (so it prints at true size), with numbered places,
// an index by category, north arrow and scale bar. Export as PNG (fonts embedded) or print to a vector PDF.
import { CATEGORIES, BASE, catColor, tierOf, labelOf, replacedKeys } from './config.js';

const FRESH = { cache: 'no-cache' };
const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };   // landscape width, height in mm
const NS = 'http://www.w3.org/2000/svg';
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const r2 = v => Math.round(v * 100) / 100;

const state = { paper: 'A3', orient: 'landscape', theme: 'light' };
try { Object.assign(state, JSON.parse(localStorage.getItem('iitg-poster') || '{}')); } catch { /* defaults */ }
const urlTheme = new URLSearchParams(location.search).get('theme');
if (['light', 'dark', 'cartoon'].includes(urlTheme)) state.theme = urlTheme;
const save = () => { try { localStorage.setItem('iitg-poster', JSON.stringify(state)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- data
const layers = ['boundary', 'buildings', 'buildings_ml', 'roads', 'paths', 'water', 'green', 'sports'];
const D = Object.fromEntries(await Promise.all(layers.map(async n => [n, await fetch(`data/osm/${n}.geojson`, FRESH).then(r => r.json())])));
const places = (await fetch('data/places.json', FRESH).then(r => r.json())).places.filter(p => p.lnglat && !p.deleted);
const custom = await fetch('data/custom_buildings.json', FRESH).then(r => r.ok ? r.json() : null).catch(() => null)
  || { added: { features: [] }, hidden: [], paths: { features: [] } };
const [contours, peaks] = await Promise.all(['contours', 'peaks'].map(n => fetch(`data/terrain/${n}.geojson`, FRESH).then(r => r.json())));
const ring = D.boundary.features[0].geometry.coordinates[0];
const replaced = new Set(replacedKeys(D.buildings_ml));
const hidden = new Set(custom.hidden || []);
for (const f of D.buildings.features) f.properties.fid = f.properties.key = f.properties.osm_id;

// Numbering follows a route from the Main Gate that visits every place once, always stepping to a close neighbour,
// so consecutive numbers are next to each other on the map. The index lists places by category, in number order.
const CAT_ORDER = Object.keys(CATEGORIES);
const indexName = p => p.name.replace(/^Department of /, '') + (p.short ? ` (${p.short})` : '');
const numbered = routeFrom(places, 'main-gate');
numbered.forEach((p, i) => { p.n = i + 1; });

// Open-path travelling-salesman heuristic: nearest-neighbour tour from the start, then 2-opt until no reversal of a
// stretch of the route makes it shorter. The start stays fixed; distances are straight-line metres.
function routeFrom(ps, startId) {
  const lat0 = ps[0].lnglat[1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const xy = ps.map(p => [p.lnglat[0] * kx, p.lnglat[1] * ky]);
  const d = (i, j) => Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
  const start = Math.max(0, ps.findIndex(p => p.id === startId));
  const left = new Set(ps.keys()), tour = [start];
  left.delete(start);
  while (left.size) {
    const last = tour[tour.length - 1];
    let best = -1, bd = Infinity;
    for (const j of left) if (d(last, j) < bd) { bd = d(last, j); best = j; }
    tour.push(best); left.delete(best);
  }
  for (let improved = true, pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 1; i < tour.length - 1; i++) for (let k = i + 1; k < tour.length; k++) {
      const a = tour[i - 1], b = tour[i], c = tour[k], e = tour[k + 1];
      const before = d(a, b) + (e === undefined ? 0 : d(c, e)), after = d(a, c) + (e === undefined ? 0 : d(b, e));
      if (after < before - 1e-6) { tour.splice(i, k - i + 1, ...tour.slice(i, k + 1).reverse()); improved = true; }
    }
  }
  return tour.map(i => ps[i]);
}
const placeByFeature = new Map();
for (const p of places) if (p.feature && !placeByFeature.has(p.feature)) placeByFeature.set(p.feature, p);

// ---------------------------------------------------------------- geometry helpers
// Local equirectangular projection in true metres: WGS-84 metres per degree of longitude and latitude at the campus
// latitude, so one poster millimetre is the same ground distance in every direction and the scale bar is exact.
function projector(frame) {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const lat0 = (Math.min(...ys) + Math.max(...ys)) / 2, phi = lat0 * Math.PI / 180;
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const pad = 0.05, w = (Math.max(...xs) - Math.min(...xs)) * mLon, h = (Math.max(...ys) - Math.min(...ys)) * mLat;
  const s = Math.min(frame.w / (w * (1 + 2 * pad)), frame.h / (h * (1 + 2 * pad)));   // poster mm per ground metre
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = lat0;
  const P = ([lon, lat]) => [r2(frame.x + frame.w / 2 + (lon - cx) * mLon * s), r2(frame.y + frame.h / 2 - (lat - cy) * mLat * s)];
  const metresPerMm = 1 / s;
  return { P, metresPerMm };
}
const ringPath = (P, rg) => 'M' + rg.map(c => P(c).join(' ')).join('L') + 'Z';
function geomPath(P, g) {
  if (!g) return '';
  if (g.type === 'Polygon') return g.coordinates.map(rg => ringPath(P, rg)).join('');
  if (g.type === 'MultiPolygon') return g.coordinates.flatMap(poly => poly.map(rg => ringPath(P, rg))).join('');
  if (g.type === 'LineString') return 'M' + g.coordinates.map(c => P(c).join(' ')).join('L');
  return '';
}
const centroid = rg => { const pts = rg.slice(0, -1); return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]; };

// Spread markers that would overlap: repeatedly push overlapping pairs apart, with a weak pull back to their true
// spot so each stays as close as possible. Returns the new centres (same order as `pts`).
function spreadMarkers(pts, r, f) {
  const minD = 2 * r + .3 * f, cur = pts.map(p => [...p]);
  for (let it = 0; it < 300; it++) {
    let moved = false;
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      let dx = cur[j][0] - cur[i][0], dy = cur[j][1] - cur[i][1], d = Math.hypot(dx, dy);
      if (d >= minD) continue;
      if (d < 1e-6) { const a = (i * 2.399963) % (2 * Math.PI); dx = Math.cos(a); dy = Math.sin(a); d = 1; }   // same spot: golden-angle split
      const push = (minD - d) / 2 + 1e-3, ux = dx / d, uy = dy / d;
      cur[i][0] -= ux * push; cur[i][1] -= uy * push; cur[j][0] += ux * push; cur[j][1] += uy * push;
      moved = true;
    }
    if (!moved && it > 5) break;
    const pull = it < 240 ? .04 : 0;                // pull back towards the true position; the last rounds only separate
    for (let i = 0; i < cur.length; i++) {
      cur[i][0] += (pts[i][0] - cur[i][0]) * pull; cur[i][1] += (pts[i][1] - cur[i][1]) * pull;
    }
  }
  return cur.map(([x, y]) => [r2(x), r2(y)]);
}

// ---------------------------------------------------------------- drawing
// Cartoon skin: bright flat colours, thin colour-matched outlines, a hand-drawn wobble, doodled trees, waves, a boat and clouds.
const CARTOON = {
  paper: '#fff3d1', outside: '#d9efb0', campus: '#a8dd7c', green: '#7fcb5c', sports: '#d4f08a',
  water: '#5cc6f0', waterLine: '#1f6fa8', road: '#fffaf0', roadCase: '#3b2414', path: '#8a6a45',
  building: '#ffe1b0', label: '#3b2414', labelSoft: '#7a5636', halo: '#fffaf0', edge: '#ff5a36', ink: '#3b2414',
  soft: 'rgba(110, 80, 50, .45)', roadEdge: '#d6bf96', shadow: 'rgba(110, 80, 50, .22)', pitchEdge: '#8cc95a',
  contour: '#a07a4a', contourText: '#7a5636',
};
const CARTOON_CATS = { academic: '#ff8a5c', hostel: '#3fc7ad', food: '#ffb627', facility: '#ffd93d', sports: '#7ed957',
  services: '#b28dff', admin: '#5b8def', gate: '#9aa5b1', residential: '#e9b384', nature: '#4fc3f7', landmark: '#ff6fb5' };
const EMOJI_CAT = { academic: '🎓', hostel: '🏠', food: '🍔', facility: '⭐', sports: '⚽', services: '🛒', admin: '🏛️',
  gate: '🚪', residential: '🏡', nature: '🌳', landmark: '📍' };
// A darker shade of a colour, for outlines that match their fill instead of a uniform dark ink.
function shade(hex, k = .72) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => Math.round(v * k).toString(16).padStart(2, '0');
  return '#' + ch(n >> 16) + ch(n >> 8 & 255) + ch(n & 255);
}
// A lighter tint of a colour (mixed towards white), for cartoon marker fills that carry grey numbers.
function tint(hex, k = .6) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0');
  return '#' + ch(n >> 16) + ch(n >> 8 & 255) + ch(n & 255);
}
// Mix towards a background colour instead (dark poster: deep tints that sit quietly on the dark map).
function mix(hex, bg, k) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(bg.slice(1), 16);
  const ch = s => Math.round((a >> s & 255) + ((b >> s & 255) - (a >> s & 255)) * k).toString(16).padStart(2, '0');
  return '#' + ch(16) + ch(8) + ch(0);
}
const NUM_GREY = '#5a5a5a', NUM_GREY_DARK = '#c9cfcc';

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function inRing([x, y], rg) {
  let hit = false;
  for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) {
    const [xi, yi] = rg[i], [xj, yj] = rg[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const polyRings = g => g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];

function draw() {
  const [lw, lh] = PAPERS[state.paper];
  const [W, H] = state.orient === 'landscape' ? [lw, lh] : [lh, lw];
  const f = Math.min(W, H) / 297;                       // type and line scale relative to A3
  const toon = state.theme === 'cartoon', dark = state.theme === 'dark';
  const c = toon ? CARTOON : BASE[state.theme];
  const color = cat => toon ? (CARTOON_CATS[cat] || CARTOON_CATS.residential) : catColor(cat, state.theme);
  const ink = toon ? CARTOON.ink : null;
  const font = toon ? 'Fredoka, Inter, sans-serif' : 'Inter, sans-serif';
  const display = toon ? 'Fredoka, Georgia, sans-serif' : 'Fraunces, Georgia, serif';
  const m = 12 * f;
  const landscape = state.orient === 'landscape';
  const panelW = landscape ? W * 0.29 : W - 2 * m;
  const frame = landscape ? { x: m, y: m, w: W - panelW - 3 * m, h: H - 2 * m }
    : { x: m, y: m + 30 * f, w: W - 2 * m, h: H * 0.6 };
  const panel = landscape ? { x: frame.x + frame.w + m, y: m, w: panelW, h: H - 2 * m }
    : { x: m, y: frame.y + frame.h + 8 * f, w: W - 2 * m, h: H - frame.y - frame.h - 8 * f - m };
  const { P, metresPerMm } = projector(frame);

  const out = [];
  const add = s => out.push(s);
  const paper = toon ? CARTOON.paper : dark ? '#0f1a1f' : '#f6f1e6';
  add(`<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="${font}">`);
  add(`<defs><clipPath id="mapclip"><rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="${4 * f}"/></clipPath>
    <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${0.9 / f}" numOctaves="2" seed="4"/>
      <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${dark ? .05 : .06} 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <filter id="wobble" x="-2%" y="-2%" width="104%" height="104%"><feTurbulence type="fractalNoise" baseFrequency="${0.11 / f}" numOctaves="2" seed="7"/>
      <feDisplacementMap in="SourceGraphic" scale="${0.9 * f}" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`);
  add(`<rect width="${W}" height="${H}" fill="${paper}"/>`);

  // ---- map shapes (wobbled in the cartoon skin)
  add(`<g clip-path="url(#mapclip)">`);
  add(`<g${toon ? ' filter="url(#wobble)"' : ''}>`);
  add(`<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" fill="${c.outside}"/>`);
  add(`<path d="${ringPath(P, ring)}" fill="${c.campus}"/>`);
  for (const ft of D.green.features) add(`<path d="${geomPath(P, ft.geometry)}" fill="${c.green}" opacity=".9"/>`);
  for (const ft of D.sports.features) if (ft.geometry.type !== 'Point')
    add(`<path d="${geomPath(P, ft.geometry)}" fill="${c.sports}"${toon ? ` stroke="${c.pitchEdge}" stroke-width="${.15 * f}"` : ''}/>`);
  for (const ft of D.water.features) {
    const g = ft.geometry;
    if (g.type === 'LineString') add(`<path d="${geomPath(P, g)}" fill="none" stroke="${c.water}" stroke-width="${1.2 * f}" stroke-linecap="round"/>`);
    else if (g.type !== 'Point') add(`<path d="${geomPath(P, g)}" fill="${c.water}" stroke="${c.waterLine}" stroke-width="${(toon ? .18 : .2) * f}" stroke-opacity="${toon ? .6 : 1}" fill-rule="evenodd"/>`);
  }
  // contour lines (5 m; every 25 m slightly stronger), under roads and buildings
  for (const ft of contours.features) {
    const idx = ft.properties.idx;
    add(`<path d="${geomPath(P, ft.geometry)}" fill="none" stroke="${c.contour}" stroke-width="${r2((idx ? .22 : .12) * f)}" stroke-opacity="${idx ? .6 : .38}" stroke-linejoin="round"/>`);
  }
  // roads: casing then fill, widths by class
  const roadW = hw => ({ trunk: 1.7, trunk_link: 1.4, primary: 1.7, secondary: 1.5, tertiary: 1.2, unclassified: 1.1, service: .6, road: 1, footway: .35 }[hw] ?? .85) * f * (toon ? 1.15 : 1);
  const roads = [...D.roads.features.filter(r => r.geometry.type === 'LineString'),
    ...(custom.paths?.features || []).filter(r => ['road', 'service'].includes(r.properties.highway))];
  for (const pass of ['case', 'fill']) for (const r of roads) {
    const w = roadW(r.properties.highway) + (pass === 'case' ? (toon ? .3 : .35) * f : 0);
    add(`<path d="${geomPath(P, r.geometry)}" fill="none" stroke="${pass === 'case' ? (toon ? c.roadEdge : c.roadCase) : c.road}" stroke-width="${r2(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  const paths = [...D.paths.features, ...(custom.paths?.features || []).filter(r => !['road', 'service'].includes(r.properties.highway))];
  for (const p of paths) if (p.geometry.type === 'LineString')
    add(`<path d="${geomPath(P, p.geometry)}" fill="none" stroke="${c.path}" stroke-width="${.3 * f}" stroke-dasharray="${.6 * f} ${.7 * f}" stroke-linecap="round"/>`);

  // buildings: a base offset by height (a soft shadow in the cartoon), then the roof coloured by its place
  const blds = [
    ...D.buildings.features.filter(b => !replaced.has(b.properties.key) && !hidden.has(b.properties.fid)),
    ...D.buildings_ml.features.filter(b => !hidden.has(b.properties.fid)),
    ...(custom.added?.features || []),
  ].filter(b => b.geometry.type === 'Polygon' || b.geometry.type === 'MultiPolygon');
  const lift = b => Math.min(b.properties.height || (b.properties['building:levels'] ? +b.properties['building:levels'] * 3.5 : 9), 30) / metresPerMm * 0.55;
  const shadow = toon ? c.shadow : dark ? 'rgba(0,0,0,.55)' : 'rgba(60,50,30,.28)';
  for (const b of blds) { const d = geomPath(P, b.geometry), l = toon ? Math.max(lift(b), .5 * f) : lift(b); add(`<path d="${d}" transform="translate(${r2(l * .45)} ${r2(l * .6)})" fill="${shadow}"/>`); }
  for (const b of blds) {
    const p = placeByFeature.get(b.properties.fid) || placeByFeature.get(b.properties.key);
    const fill = p ? color(p.category) : c.building;
    const stroke = toon ? `stroke="${shade(fill)}" stroke-width="${.14 * f}" stroke-linejoin="round"` : `stroke="${dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.12)'}" stroke-width="${.08 * f}"`;
    add(`<path d="${geomPath(P, b.geometry)}" fill="${fill}" ${stroke}/>`);
  }
  const rM = 1.45 * f, fsN = 1.55 * f, fsL = 2.55 * f;
  const pos = spreadMarkers(numbered.map(p => P(p.lnglat)), rM, f);
  const at = new Map(numbered.map((p, i) => [p, pos[i]]));
  if (toon) doodles(add, { P, f, frame, blds, roads, roadW, ink, c, keepClear: [...pos, ...numbered.map(p => P(p.lnglat))], rM });

  // fade everything outside the campus area; no outline (the shape is OpenStreetMap's, approximate, not an official boundary)
  add(`<path d="M${frame.x} ${frame.y}h${frame.w}v${frame.h}h${-frame.w}Z${ringPath(P, ring)}" fill="${c.outside}" fill-opacity="${toon ? .45 : .62}" fill-rule="evenodd"/>`);
  add(`</g>`);   // end of wobbled shapes

  // river name (and, in the cartoon, a boat and a couple of clouds)
  drawTerrainLabels(add, { P, f, frame, c, toon, paper, keepClear: [...pos, ...numbered.map(p => P(p.lnglat))] });
  const riverPt = [r2(frame.x + frame.w * 0.62), r2(frame.y + frame.h - 3.2 * f)];
  add(`<text x="${riverPt[0]}" y="${riverPt[1]}" text-anchor="middle" font-family="${display}" font-style="${toon ? 'normal' : 'italic'}" font-weight="${toon ? 600 : 400}" font-size="${5 * f}" fill="${c.waterLine}" letter-spacing="${1.4 * f}" opacity=".9">Brahmaputra</text>`);
  if (toon) {
    add(`<text x="${r2(frame.x + frame.w * 0.36)}" y="${r2(frame.y + frame.h - 2.4 * f)}" font-size="${6 * f}">⛵</text>`);
    const cloud = (x, y, s) => `<g transform="translate(${r2(x)} ${r2(y)}) scale(${r2(s)})" fill="#fffdf6" stroke="${c.soft}" stroke-width="${.2 / s * f}">
      <path d="M-6 2a3 3 0 0 1 1-5.8a4 4 0 0 1 7.4-1.6a3.4 3.4 0 0 1 5.6 2.6a2.6 2.6 0 0 1-.4 4.8Z"/></g>`;
    add(cloud(frame.x + 16 * f, frame.y + 13 * f, 1.3 * f));
    add(cloud(frame.x + frame.w - 40 * f, frame.y + frame.h * 0.42, 1 * f));
  }

  // markers (all places) and name labels for the major ones, with simple collision avoidance
  const boxes = pos.map(([x, y]) => ({ x: x - rM, y: y - rM, w: 2 * rM, h: 2 * rM }));
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inFrame = a => a.x > frame.x + 2 && a.y > frame.y + 2 && a.x + a.w < frame.x + frame.w - 2 && a.y + a.h < frame.y + frame.h - 2;
  const labels = [];
  for (const p of numbered.filter(p => !toon && tierOf(p) === 0)) {
    const text = labelOf(p);
    const [x, y] = at.get(p), pad = 0;
    const tw = text.length * fsL * .56, th = fsL * 1.15;
    // right, left, above, below the marker, first close by and then further out in crowded spots
    const options = [1, 2.4, 4].flatMap(k => { const g = rM + .8 * f * k + (k - 1) * rM; return [
      { x: x + g, y: y - th / 2, anchor: 'start', d: k }, { x: x - g - tw, y: y - th / 2, anchor: 'end', d: k },
      { x: x - tw / 2, y: y - g - th, anchor: 'middle', d: k }, { x: x - tw / 2, y: y + g, anchor: 'middle', d: k }]; });
    let best = null, bestCost = Infinity;
    for (const o of options) {
      const box = { x: o.x, y: o.y, w: tw, h: th };
      if (!inFrame(box)) continue;
      const cost = labels.filter(l => hit(l.box, box)).length * 20 + boxes.filter(b => hit(b, box)).length * 3 + (o.d - 1) * 2;
      if (cost < bestCost) { bestCost = cost; best = { ...o, box }; }
    }
    if (best) labels.push({ p, text, pad, ...best });
  }
  const halo = toon ? CARTOON.halo : dark ? '#0f1a1f' : '#fffaf0';
  const ring2 = toon ? '#ffffff' : halo;
  const numGrey = dark ? NUM_GREY_DARK : NUM_GREY;
  // markers pushed away from their true spot keep a thin leader line to a dot at the real location
  for (const p of numbered) {
    const [x0, y0] = P(p.lnglat), [x, y] = at.get(p);
    if (Math.hypot(x - x0, y - y0) > rM * 0.7)
      add(`<line x1="${x0}" y1="${y0}" x2="${x}" y2="${y}" stroke="${c.label}" stroke-width="${.18 * f}" opacity=".55"/>
        <circle cx="${x0}" cy="${y0}" r="${r2(.45 * f)}" fill="${color(p.category)}" stroke="${ring2}" stroke-width="${.15 * f}"/>`);
  }
  for (const p of numbered) {
    const [x, y] = at.get(p);
    if (toon) add(`<circle cx="${r2(x + .15 * f)}" cy="${r2(y + .25 * f)}" r="${r2(rM + .2 * f)}" fill="${c.shadow}"/>`);
    // every skin: a tinted fill with a ring in the full category colour, and a regular-weight grey number
    const fillM = dark ? mix(color(p.category), '#0f1a1f', .62) : tint(color(p.category));
    add(`<circle cx="${x}" cy="${y}" r="${r2(rM)}" fill="${fillM}" stroke="${color(p.category)}" stroke-width="${.35 * f}"/>`);
    add(`<text x="${x}" y="${r2(y + fsN * 0.36)}" text-anchor="middle" font-size="${r2(fsN)}" font-weight="400" fill="${numGrey}">${p.n}</text>`);
  }
  for (const l of labels) {
    const tx = l.anchor === 'start' ? l.box.x : l.anchor === 'end' ? l.box.x + l.box.w : l.box.x + l.box.w / 2;
    const ty = l.box.y + l.box.h * 0.8;
    add(`<text x="${r2(tx)}" y="${r2(ty)}" text-anchor="${l.anchor}" font-size="${r2(fsL)}" font-weight="700" fill="${c.label}"
      stroke="${halo}" stroke-width="${.7 * f}" stroke-linejoin="round" paint-order="stroke">${esc(l.text)}</text>`);
  }
  add(`</g>`);
  add(`<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="${4 * f}" fill="none" stroke="${toon ? c.soft : dark ? 'rgba(255,255,255,.18)' : 'rgba(35,48,43,.25)'}" stroke-width="${(toon ? .7 : .3) * f}"/>`);
  add(`<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="${4 * f}" fill="#000" filter="url(#grain)" pointer-events="none"/>`);

  // north arrow and scale bar
  const na = { x: frame.x + frame.w - 14 * f, y: frame.y + 16 * f };
  add(`<g transform="translate(${na.x} ${na.y})"><circle r="${7 * f}" fill="${halo}" opacity="${toon ? 1 : .85}"${toon ? ` stroke="${c.soft}" stroke-width="${.2 * f}"` : ''}/>
    <path d="M0 ${-5.5 * f}L${2.4 * f} ${3 * f}L0 ${1.6 * f}L${-2.4 * f} ${3 * f}Z" fill="${c.edge}"/>
    <text y="${-7.8 * f}" text-anchor="middle" font-size="${2.6 * f}" font-weight="700" fill="${c.label}">N</text></g>`);
  // scale bar: two divisions (0, half, full), labelled, with the walking time at 4.8 km/h (80 m per minute)
  const nice = [50, 100, 200, 250, 500, 1000].find(v => v / metresPerMm > 18 * f) || 1000;
  const sb = { x: frame.x + 8 * f, y: frame.y + frame.h - 9 * f, w: r2(nice / metresPerMm) };
  const mins = Math.round(nice / 80 * 2) / 2, minsTxt = `≈ ${Math.floor(mins) || ''}${mins % 1 ? '½' : ''} min walk`;
  const fs = 2.2 * f, walkW = minsTxt.length * fs * .52, boxW = 3 * f + sb.w + 3 * f + walkW + 3 * f;
  const tick = x => `<line x1="${r2(x)}" y1="${r2(sb.y - .5 * f)}" x2="${r2(x)}" y2="${r2(sb.y + 1.5 * f)}" stroke="${c.label}" stroke-width="${.2 * f}"/>`;
  add(`<g font-size="${fs}" fill="${c.label}"><rect x="${sb.x - 3 * f}" y="${sb.y - 5.5 * f}" width="${r2(boxW)}" height="${9 * f}" rx="${1.5 * f}" fill="${halo}" opacity="${toon ? 1 : .85}"${toon ? ` stroke="${c.soft}" stroke-width="${.2 * f}"` : ''}/>
    <rect x="${sb.x}" y="${sb.y}" width="${sb.w / 2}" height="${1 * f}" fill="${c.label}"/><rect x="${sb.x + sb.w / 2}" y="${sb.y}" width="${sb.w / 2}" height="${1 * f}" fill="none" stroke="${c.label}" stroke-width="${.2 * f}"/>
    ${tick(sb.x)}${tick(sb.x + sb.w / 2)}${tick(sb.x + sb.w)}
    <text x="${sb.x}" y="${sb.y - 1.4 * f}" text-anchor="middle">0</text><text x="${r2(sb.x + sb.w / 2)}" y="${sb.y - 1.4 * f}" text-anchor="middle">${nice / 2}</text>
    <text x="${r2(sb.x + sb.w)}" y="${sb.y - 1.4 * f}" text-anchor="middle">${nice} m</text>
    <text x="${r2(sb.x + sb.w + 3 * f)}" y="${r2(sb.y + 1.1 * f)}" fill="${c.labelSoft}">${minsTxt}</text></g>`);

  // ---- title and index
  const T = { x: landscape ? panel.x : m, y: landscape ? panel.y : m };
  const titleStyle = toon ? 'font-weight="700"' : 'font-weight="800"';
  const TITLE_DX = 21.5; // portrait: "Campus uMap" follows "IITG" on the same line
  if (toon) for (const [txt, dy, dx] of [['IITG', 9, 0], ['Campus uMap', landscape ? 20 : 9, landscape ? 0 : TITLE_DX]])
    add(`<text x="${r2(T.x + dx * f + .5 * f)}" y="${r2(T.y + dy * f + .6 * f)}" font-family="${display}" font-weight="700" font-size="${10 * f}" fill="${c.shadow}">${txt}</text>`);
  add(`<text x="${T.x}" y="${T.y + 9 * f}" font-family="${display}" ${titleStyle} font-size="${10 * f}" fill="${toon ? '#3fc7ad' : c.label}">IITG</text>`);
  add(`<text x="${T.x + (landscape ? 0 : TITLE_DX * f)}" y="${T.y + (landscape ? 20 : 9) * f}" font-family="${display}" ${titleStyle} font-size="${10 * f}" fill="${toon ? '#ffb627' : c.edge}">Campus <tspan font-style="italic" font-weight="600">u</tspan>Map</text>`);
  const subY = T.y + (landscape ? 27.5 : 16.5) * f;
  add(`<text x="${T.x}" y="${subY}" font-size="${2.8 * f}" fill="${c.labelSoft}">${toon ? 'Hills, lakes &amp; the Brahmaputra · a doodled map · u for unofficial' : 'Hills, lakes &amp; the Brahmaputra · u for unofficial'} · ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</text>`);

  add(`<text x="${T.x}" y="${r2(subY + 4.4 * f)}" font-size="${2.6 * f}" font-weight="600" fill="${c.label}">Designed by SPIN Lab, Mehta Family School of DSAI, IIT Guwahati</text>`);
  const idx = landscape ? { x: panel.x, y: subY + 12 * f, w: panel.w, h: panel.y + panel.h - subY - 12 * f - 12 * f }
    : { x: panel.x, y: panel.y, w: panel.w, h: panel.h - 12 * f };
  const groups = CAT_ORDER.map(k => [k, numbered.filter(p => p.category === k)]).filter(([, ps]) => ps.length);
  const fsI = 2.05 * f, lineH = fsI * 1.38, headH = fsI * 2.1;
  // Dry run of the column flow (headings never end a column), so the columns are sized to the number really used.
  let cols = 1;
  { let yy = 0; const fit = h => { if (yy + h > idx.h) { cols++; yy = 0; } };
    for (const [, ps] of groups) { fit(headH + lineH); yy += headH; for (const _ of ps) { fit(lineH); yy += lineH; } yy += lineH * 0.4; } }
  const colW = idx.w / cols, maxChars = Math.floor((colW - 7 * f) / (fsI * 0.52));
  let col = 0, y = idx.y;
  const nextLine = h => { if (y + h > idx.y + idx.h) { col++; y = idx.y; } };
  for (const [k, ps] of groups) {
    nextLine(headH + lineH);
    const x = idx.x + col * colW;
    add(toon
      ? `<text x="${x}" y="${y + headH * 0.74}" font-size="${2.5 * f}">${EMOJI_CAT[k]}</text>
         <text x="${x + 3.8 * f}" y="${y + headH * 0.72}" font-size="${2.5 * f}" font-weight="700" fill="${ink}">${esc(CATEGORIES[k].label)}</text>`
      : `<circle cx="${x + 1.2 * f}" cy="${y + headH * 0.55}" r="${1.2 * f}" fill="${color(k)}"/>
         <text x="${x + 3.4 * f}" y="${y + headH * 0.72}" font-size="${2.4 * f}" font-weight="700" fill="${c.label}" letter-spacing="${.15 * f}">${esc(CATEGORIES[k].label.toUpperCase())}</text>`);
    y += headH;
    for (const p of ps) {
      nextLine(lineH);
      const xx = idx.x + col * colW;
      let name = indexName(p);
      if (name.length > maxChars) name = name.slice(0, maxChars - 1).trimEnd() + '…';
      add(`<text x="${xx + 4.4 * f}" y="${y + lineH * 0.75}" font-size="${fsI}" fill="${dark ? NUM_GREY_DARK : NUM_GREY}" text-anchor="end" font-weight="400">${p.n}</text>
        <text x="${xx + 5.6 * f}" y="${y + lineH * 0.75}" font-size="${fsI}" fill="${c.label}">${esc(name)}</text>`);
      y += lineH;
    }
    y += lineH * 0.4;
  }

  // ---- credits
  const credY = H - m + 2 * f;
  add(`<text x="${landscape ? panel.x : m}" y="${credY - 12 * f}" font-size="${1.7 * f}" fill="${c.labelSoft}">Use with care: paths come from open data and may be incomplete or closed. Use your own judgement.</text>`);
  add(`<text x="${landscape ? panel.x : m}" y="${credY - 8 * f}" font-size="${1.7 * f}" fill="${c.labelSoft}">Not an official IIT Guwahati map. Numbers follow a route from the Main Gate (1), so nearby places have nearby numbers.</text>`);
  add(`<text x="${landscape ? panel.x : m}" y="${credY - 4 * f}" font-size="${1.7 * f}" fill="${c.labelSoft}">Data © OpenStreetMap contributors (ODbL) · buildings © Google Open Buildings (CC BY 4.0), Microsoft (ODbL).</text>`);
  add(`<text x="${landscape ? panel.x : m}" y="${credY}" font-size="${1.7 * f}" fill="${c.labelSoft}">Elevation © Copernicus DEM GLO-30 (© DLR e.V., © Airbus Defence and Space; provided under COPERNICUS by the EU and ESA).</text>`);
  add(`</svg>`);
  return { svg: out.join('\n'), W, H };
}

// Height labels set along index contour lines (upright, a few per line, clear of place markers) and summit markers.
function drawTerrainLabels(add, { P, f, frame, c, toon, paper, keepClear }) {
  const inFrame = ([x, y], m) => x > frame.x + m && x < frame.x + frame.w - m && y > frame.y + m && y < frame.y + frame.h - m;
  const near = ([x, y], r) => keepClear.some(([a, b]) => Math.hypot(a - x, b - y) < r);
  const lakes = D.water.features.flatMap(ft => polyRings(ft.geometry)).map(rg => rg[0].map(P));
  const onWater = pt => lakes.some(rg => inRing(pt, rg));          // elevation over water is noise: no labels there
  const placed = [];
  const fs = 1.6 * f;
  for (const ft of contours.features) {
    if (!ft.properties.idx) continue;
    const pts = ft.geometry.coordinates.map(P);
    let run = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (run < 45 * f) continue;                                   // one label every ~45 mm of line
      const [x, y] = pts[i];
      if (!inFrame(pts[i], 6 * f) || near(pts[i], 4 * f) || onWater(pts[i]) || placed.some(([a, b]) => Math.hypot(a - x, b - y) < 25 * f)) continue;
      let ang = Math.atan2(pts[i + 1][1] - pts[i - 1][1], pts[i + 1][0] - pts[i - 1][0]) * 180 / Math.PI;
      if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;     // keep text upright
      add(`<text transform="translate(${r2(x)} ${r2(y)}) rotate(${r2(ang)})" y="${r2(fs * .35)}" text-anchor="middle" font-size="${r2(fs)}"
        fill="${c.contourText}" stroke="${paper}" stroke-width="${r2(.5 * f)}" paint-order="stroke">${ft.properties.elev} m</text>`);
      placed.push([x, y]);
      run = 0;
    }
  }
  for (const pk of peaks.features) {
    const [x, y] = P(pk.geometry.coordinates);
    if (!inFrame([x, y], 5 * f)) continue;
    const s = 1.3 * f;
    add(toon
      ? `<path d="M${r2(x - 2.4 * s)} ${r2(y + .8 * s)}q${r2(1.2 * s)} ${r2(-2.6 * s)} ${r2(2.4 * s)} ${r2(-2.6 * s)}t${r2(2.4 * s)} ${r2(2.6 * s)}Z" fill="#c9a46a" stroke="${c.soft}" stroke-width="${r2(.15 * f)}"/>`
      : `<path d="M${r2(x)} ${r2(y - s)}L${r2(x + .9 * s)} ${r2(y + .6 * s)}H${r2(x - .9 * s)}Z" fill="${c.contourText}"/>`);
    add(`<text x="${r2(x)}" y="${r2(y - (toon ? 2.4 : 1.6) * s)}" text-anchor="middle" font-size="${r2(1.8 * f)}" font-weight="600"
      fill="${c.contourText}" stroke="${paper}" stroke-width="${r2(.5 * f)}" paint-order="stroke">${pk.properties.elev} m</text>`);
  }
}

// Cartoon doodles: trees scattered over open ground (away from buildings, roads, water and pitches) and wave squiggles
// on the water. Works on a coarse occupancy grid in poster millimetres; seeded, so the poster is the same every time.
function doodles(add, { P, f, frame, blds, roads, roadW, ink, c, keepClear, rM }) {
  const cell = 1.2 * f, gw = Math.ceil(frame.w / cell), gh = Math.ceil(frame.h / cell);
  const busy = new Uint8Array(gw * gh);
  const mark = (x, y, r) => {
    const i0 = Math.max(0, Math.floor((x - r - frame.x) / cell)), i1 = Math.min(gw - 1, Math.floor((x + r - frame.x) / cell));
    const j0 = Math.max(0, Math.floor((y - r - frame.y) / cell)), j1 = Math.min(gh - 1, Math.floor((y + r - frame.y) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) busy[j * gw + i] = 1;
  };
  for (const r of roads) {
    const pts = r.geometry.coordinates.map(P), rad = roadW(r.properties.highway) / 2 + 1.1 * f;
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k], n = Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * .7)) || 1;
      for (let s = 0; s <= n; s++) mark(ax + (bx - ax) * s / n, ay + (by - ay) * s / n, rad);
    }
  }
  for (const b of blds) for (const rg of polyRings(b.geometry)) {
    const pts = rg[0].map(P), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    mark((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2 + .9 * f);
  }
  for (const [x, y] of keepClear) mark(x, y, rM * 2.3);   // no trees on or right around a place marker
  const visible = rg => rg.some(([x, y]) => x > frame.x && x < frame.x + frame.w && y > frame.y && y < frame.y + frame.h);
  const waters = D.water.features.flatMap(ft => polyRings(ft.geometry)).map(rg => rg[0].map(P)).filter(visible);
  const pitches = D.sports.features.flatMap(ft => polyRings(ft.geometry)).map(rg => rg[0].map(P));
  const campus = ring.map(P);
  const free = (x, y) => {
    const i = Math.floor((x - frame.x) / cell), j = Math.floor((y - frame.y) / cell);
    return i >= 0 && j >= 0 && i < gw && j < gh && !busy[j * gw + i];
  };

  // trees: dense on campus, sparse outside, never on water or pitches
  const r = rng(42), step = 5.6 * f, trees = [];
  for (let y = frame.y + step / 2; y < frame.y + frame.h; y += step) for (let x = frame.x + step / 2; x < frame.x + frame.w; x += step) {
    const px = x + (r() - .5) * step * .8, py = y + (r() - .5) * step * .8;
    const onCampus = inRing([px, py], campus);
    if (!onCampus ? r() > .3 : r() > .8) continue;
    if (!free(px, py) || waters.some(w => inRing([px, py], w)) || pitches.some(w => inRing([px, py], w))) continue;
    trees.push([px, py, .6 + r() * .3, r() < .5]);
  }
  trees.sort((a, b) => a[1] - b[1]);   // draw back to front
  const greens = ['#6cc35c', '#7fcf68', '#5db55a'];
  for (const [x, y, s, round] of trees) {
    const k = s * f, g = greens[Math.floor((x * 7 + y * 3) % 3 + 3) % 3];
    add(`<g transform="translate(${r2(x)} ${r2(y)})" stroke="#3f8a3c" stroke-width="${r2(.1 * f)}" stroke-opacity=".5" stroke-linejoin="round" opacity=".85">
      <rect x="${r2(-.25 * k)}" y="${r2(-.2 * k)}" width="${r2(.5 * k)}" height="${r2(1.1 * k)}" fill="#8a5a33"/>
      ${round ? `<circle cy="${r2(-1.1 * k)}" r="${r2(1.15 * k)}" fill="${g}"/>`
        : `<path d="M0 ${r2(-2.6 * k)}L${r2(1.2 * k)} ${r2(-.1 * k)}H${r2(-1.2 * k)}Z" fill="${g}"/>`}</g>`);
  }

  // waves on the water
  const ws = 5.5 * f;
  for (let y = frame.y + ws / 2; y < frame.y + frame.h; y += ws) for (let x = frame.x + ws / 2; x < frame.x + frame.w; x += ws) {
    const px = x + (r() - .5) * ws * .7, py = y + (r() - .5) * ws * .5;
    if (!waters.some(w => inRing([px, py], w)) || !waters.some(w => inRing([px + 2 * f, py], w))) continue;
    add(`<path d="M${r2(px)} ${r2(py)}q${r2(.5 * f)} ${r2(-.55 * f)} ${r2(1 * f)} 0t${r2(1 * f)} 0" fill="none" stroke="#fffdf6" stroke-width="${r2(.25 * f)}" stroke-linecap="round" opacity=".9"/>`);
  }
}

// ---------------------------------------------------------------- page
const stage = document.getElementById('stage');
let current;
function render() {
  current = draw();
  stage.innerHTML = current.svg;
  document.documentElement.dataset.theme = state.theme;
  document.getElementById('page-size').textContent = `@page { size: ${state.paper} ${state.orient}; margin: 0; }
    @media print { #stage svg { width: ${current.W}mm; height: ${current.H}mm; } }`;
  for (const [attr, key] of [['data-paper', 'paper'], ['data-orient', 'orient'], ['data-theme-btn', 'theme']])
    document.querySelectorAll(`[${attr}]`).forEach(b => b.setAttribute('aria-pressed', b.getAttribute(attr) === state[key]));
  save();
}
for (const [attr, key] of [['data-paper', 'paper'], ['data-orient', 'orient'], ['data-theme-btn', 'theme']])
  document.querySelectorAll(`[${attr}]`).forEach(b => b.onclick = () => { state[key] = b.getAttribute(attr); render(); });
document.getElementById('print').onclick = () => window.print();

// PNG: an <img> cannot load web fonts, so the poster's fonts are embedded into the SVG as data URLs first.
let fontCSS = null;
async function embeddedFonts() {
  if (fontCSS !== null) return fontCSS;
  try {
    const href = document.querySelector('link[href*="fonts.googleapis.com/css2"]').href;
    const css = await fetch(href).then(r => r.text());
    const faces = [...css.matchAll(/\/\*\s*latin\s*\*\/\s*(@font-face\s*{[^}]+})/g)].map(m => m[1]);
    const inlined = await Promise.all(faces.map(async face => {
      const url = face.match(/url\(([^)]+)\)/)[1];
      const buf = await fetch(url).then(r => r.arrayBuffer());
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return face.replace(url, `data:font/woff2;base64,${btoa(bin)}`);
    }));
    fontCSS = inlined.join('\n');
  } catch { fontCSS = ''; }   // fall back to system fonts
  return fontCSS;
}

document.getElementById('png').onclick = async e => {
  const btn = e.currentTarget, dpi = +document.getElementById('dpi').value;
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const fonts = await embeddedFonts();
    const svg = current.svg.replace('<defs>', `<defs><style>${fonts}</style>`);
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    const px = mm => Math.round(mm / 25.4 * dpi);
    const canvas = Object.assign(document.createElement('canvas'), { width: px(current.W), height: px(current.H) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: `iitg-campus-map-${state.paper}-${state.orient}-${state.theme}-${dpi}dpi.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } finally {
    btn.disabled = false; btn.textContent = '⬇ Download PNG';
  }
};

render();
