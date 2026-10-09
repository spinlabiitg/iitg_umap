// Walking/cycling-time rings and the hostel league, hill-aware.
// Shortest paths run in the browser over data/network.json (built by scripts/build_network.py). Each step of the
// network has a height at both ends (graph.js, from the Copernicus terrain tiles), so a step costs different time
// uphill and downhill: going up to a hilltop takes longer than coming back down.
import { map, ui, getPlaces, getTheme, onStyle, closePopup, sheet } from './app.js';
import { G, loadGraph, snap, dijkstra, metres } from './graph.js';
import { pulseOff } from './pulse.js';
import { seasonsOff } from './seasons.js';

const SPEEDS = { walk: 80, cycle: 200 };  // metres per minute on the flat: ~4.8 km/h stroll, ~12 km/h campus cycling
let travel = 'walk', SPEED = SPEEDS.walk, hills = true;
const BANDS = [5, 10, 15, 20];  // minute thresholds for the rings
const MAX_MIN = 25;
const BAND_COLORS = {
  light: ['#2a9d8f', '#8ab17d', '#e9c46a', '#f4a261', '#e76f51'],
  dark:  ['#3cc4b3', '#a3cf8f', '#f2d27c', '#f7b47a', '#f28b70'],
};

// Destinations that matter in daily student life; weights reflect how often you go there.
const DESTS = [
  { id: 'academic-complex', label: 'Classes (Academic Complex)', short: 'Classes', w: 3 },
  { id: 'lecture-halls',    label: 'Lecture Halls',              short: 'LH',      w: 2 },
  { id: 'library',          label: 'Central Library',            short: 'Library', w: 1 },
  { id: 'food-court',       label: 'Food Court',                 short: 'Food',    w: 1 },
  { id: 'new-sac',          label: 'New SAC',                    short: 'SAC',     w: 1 },
  { id: 'hospital',         label: 'Hospital',                   short: 'Hospital', w: .5 },
  { id: 'market-complex',   label: 'Market Complex',             short: 'Market',  w: .5 },
];

let origin = null, result = null, animFrame = 0, marker = null, tab = 'league', league = [], routeTo = null;

// ---------- hills ----------
// Walking: Tobler's hiking function, 6·e^(−3.5·|s + 0.05|) km/h on grade s, scaled so flat ground stays at 4.8 km/h.
// It is fastest on a gentle downhill (about −5%) and slows on steep descents as well as climbs.
// Cycling: a simple effort model. Every 1% of climb costs 8% of speed, down to pushing the bike (a bit slower than
// walking); downhill speeds up to 1.5× the flat speed.
const TOBLER_FLAT = Math.exp(-3.5 * .05);
function speedOn(s) {
  s = Math.max(-.4, Math.min(.4, s));
  const walk = SPEEDS.walk * Math.exp(-3.5 * Math.abs(s + .05)) / TOBLER_FLAT;
  if (travel === 'walk') return walk;
  return s > 0 ? Math.max(SPEEDS.cycle * (1 - 8 * s), .9 * walk) : SPEEDS.cycle * Math.min(1.5, 1 - 4 * s);
}
const rise = (u, v) => { const dh = G.elev[v] - G.elev[u]; return dh === dh ? dh : 0; };   // NaN (no data) → flat
const stepMin = (u, v, m, withHills = hills) => m > 0 ? m / speedOn(withHills ? rise(u, v) / m : 0) : 0;

// Minutes for every adjacency slot u→v of the network (direction matters once hills count).
function buildCost(withHills) {
  const { adjStart, adjTo, adjLen } = G, w = new Float32Array(adjTo.length);
  for (let u = 0; u < G.nodes.length; u++)
    for (let k = adjStart[u]; k < adjStart[u + 1]; k++) w[k] = stepMin(u, adjTo[k], adjLen[k], withHills);
  return w;
}
let COST = null, FLAT = null;
function setCosts() {
  COST = buildCost(hills);
  FLAT = hills ? buildCost(false) : COST;
}
const slot = (u, v) => { for (let k = G.adjStart[u]; k < G.adjStart[u + 1]; k++) if (G.adjTo[k] === v) return k; return -1; };

// Shortest-time tree from a point; the walk to and from the nearest network node is counted as flat.
function treeFrom(lnglat, w = COST) {
  const s = snap(lnglat);
  return { ...dijkstra(s.node, w), offset: s.offset, origin: lnglat };
}
function minutesTo(res, lnglat) {
  const s = snap(lnglat);
  return res.dist[s.node] + (s.offset + res.offset) / SPEED;
}

function pathTo(res, lnglat) {
  const coords = [lnglat];
  for (let v = snap(lnglat).node; v !== -1; v = res.prev[v]) coords.push(G.nodes[v]);
  coords.push(res.origin);
  return coords;
}

const CLIMB_BAND = 2;   // metres
// Along the chosen route: distance, metres climbed and descended, the height profile, and the time to come back
// the same way (different from the way out on a slope).
function routeInfo(res, lnglat) {
  const ids = [];
  for (let v = snap(lnglat).node; v !== -1; v = res.prev[v]) ids.push(v);
  ids.reverse();
  const flatEnds = (snap(lnglat).offset + res.offset) / SPEED;
  let d = res.offset, up = 0, down = 0, back = flatEnds;
  const prof = [];
  const h0 = G.elev[ids[0]];
  if (h0 === h0) prof.push([0, h0], [d, h0]);
  // Climb and descent counted with a 2 m dead band (as GPS elevation gain is), so leftover wobble is not summed.
  let anchor = h0 === h0 ? h0 : null;
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1], b = ids[i], h = G.elev[b];
    d += metres(G.nodes[a], G.nodes[b]);
    if (h === h) {
      if (anchor === null) anchor = h;
      else if (h - anchor >= CLIMB_BAND) { up += h - anchor; anchor = h; }
      else if (anchor - h >= CLIMB_BAND) { down += anchor - h; anchor = h; }
    }
    const k = slot(b, a);
    back += k >= 0 ? COST[k] : 0;
    if (G.elev[b] === G.elev[b]) prof.push([d, G.elev[b]]);
  }
  d += snap(lnglat).offset;
  if (prof.length) prof.push([d, prof.at(-1)[1]]);
  return { min: minutesTo(res, lnglat), back, metres: d, up, down, prof };
}

// ---------- hostel league ----------
function computeLeague() {
  const places = getPlaces();
  const dests = DESTS.map(d => ({ ...d, place: places.find(p => p.id === d.id) })).filter(d => d.place?.lnglat);
  const W = dests.reduce((a, t) => a + t.w, 0);
  const score = times => times.reduce((a, t) => a + t.w * t.min, 0) / W;
  const hostels = places.filter(p => p.category === 'hostel' && p.lnglat);
  const flatRank = new Map();
  if (hills) {
    hostels.map(h => { const res = treeFrom(h.lnglat, FLAT); return [h.id, score(dests.map(d => ({ w: d.w, min: minutesTo(res, d.place.lnglat) })))]; })
      .sort((a, b) => a[1] - b[1]).forEach(([id, s], i) => flatRank.set(id, { s, i }));
  }
  // Each trip counted both ways: out to the destination and back to the hostel (on flat ground the two are equal).
  const backTrees = dests.map(d => treeFrom(d.place.lnglat));
  league = hostels.map(h => {
    const res = treeFrom(h.lnglat);
    const times = dests.map((d, j) => ({ ...d, min: (minutesTo(res, d.place.lnglat) + minutesTo(backTrees[j], h.lnglat)) / 2 }));
    return { hostel: h, times, score: score(times) };
  }).sort((a, b) => a.score - b.score);
  league.forEach((l, i) => { const f = flatRank.get(l.hostel.id); if (f) { l.flatRank = f.i; l.rankMove = f.i - i; } });
}

// ---------- map layers ----------
const bandExpr = theme => ['step', ['get', 't'], ...BAND_COLORS[theme].flatMap((c, i) => i < BANDS.length ? [c, BANDS[i]] : [c])];

function addLayers(theme) {
  if (!map.getSource('walk')) {
    map.addSource('walk', { type: 'geojson', data: G.edgesGeo });
    map.addSource('walk-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (map.getLayer('walk-lines')) return;
  const before = map.getLayer('bld-ml') ? 'bld-ml' : undefined;
  map.addLayer({ id: 'walk-glow', type: 'line', source: 'walk', layout: { 'line-cap': 'round' },
    paint: { 'line-color': bandExpr(theme), 'line-width': 14, 'line-blur': 10, 'line-opacity': 0 } }, before);
  map.addLayer({ id: 'walk-lines', type: 'line', source: 'walk', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': bandExpr(theme), 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 18, 8], 'line-opacity': 0 } }, before);
  map.addLayer({ id: 'walk-route', type: 'line', source: 'walk-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': theme === 'dark' ? '#ffffff' : '#23302b', 'line-width': 4, 'line-dasharray': [1, 1.6] } });
  setReveal(result ? MAX_MIN : 0);
}

function removeLayers() {
  for (const id of ['walk-route', 'walk-lines', 'walk-glow']) if (map.getLayer(id)) map.removeLayer(id);
}

function setReveal(T) {
  const vis = ['case', ['<=', ['get', 't'], T], 1, 0];
  map.setPaintProperty('walk-lines', 'line-opacity', ['*', vis, .95]);
  map.setPaintProperty('walk-glow', 'line-opacity', ['*', vis, .35]);
}

// Rings ripple outwards: reveal edges up to T minutes, T growing over ~1.5 s.
function animate() {
  cancelAnimationFrame(animFrame);
  const start = performance.now();
  const step = now => {
    const k = Math.min(1, (now - start) / 1500);
    setReveal(MAX_MIN * (1 - (1 - k) ** 3));
    if (k < 1) animFrame = requestAnimationFrame(step);
  };
  animFrame = requestAnimationFrame(step);
}

function setOrigin(lnglat, label) {
  result = { ...treeFrom(lnglat), label };
  const flatEnd = result.offset / SPEED;
  for (const f of G.edgesGeo.features) {
    const { a, b, m } = f.properties;
    f.properties.t = Math.min(result.dist[a] + stepMin(a, b, m) / 2, result.dist[b] + stepMin(b, a, m) / 2) + flatEnd;
  }
  map.getSource('walk').setData(G.edgesGeo);
  map.getSource('walk-route').setData({ type: 'FeatureCollection', features: [] });
  routeTo = null;
  if (!marker) {
    const el = Object.assign(document.createElement('div'), { className: 'walk-origin' });
    marker = new maplibregl.Marker({ element: el });
  }
  marker.setLngLat(lnglat).addTo(map);
  animate();
  tab = 'here';
  render();
}

function showRoute(p) {
  if (!result) return;
  routeTo = p;
  map.getSource('walk-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: pathTo(result, p.lnglat) } });
  const card = document.getElementById('walk-route-card');
  if (card) card.innerHTML = routeCard(p);
}

// ---------- panel ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const fmt = m => m < 1 ? '<1' : Math.round(m);
const colorFor = m => BAND_COLORS[getTheme()][BANDS.findIndex(b => m < b) === -1 ? BANDS.length : BANDS.findIndex(b => m < b)];
const dist = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

// Height profile of the route as a small filled sparkline (start on the left).
function profileSvg(prof) {
  if (prof.length < 2) return '';
  const W = 280, H = 54, pad = 4, D = prof.at(-1)[0] || 1;
  const lo = Math.min(...prof.map(q => q[1])), hi = Math.max(...prof.map(q => q[1]));
  const span = Math.max(hi - lo, 10);                       // at least 10 m tall, so flat routes look flat
  const mid = (hi + lo) / 2;
  const X = d => (pad + d / D * (W - 2 * pad)).toFixed(1);
  const Y = h => (H - pad - ((h - mid) / span + .5) * (H - 2 * pad - 10)).toFixed(1);
  const line = prof.map(([d, h], i) => `${i ? 'L' : 'M'}${X(d)} ${Y(h)}`).join('');
  return `<svg class="walk-profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="Height along the route, ${Math.round(lo)} to ${Math.round(hi)} m">
    <path d="${line}L${X(D)} ${H}L${X(0)} ${H}Z" class="area"/><path d="${line}" class="ln"/>
    <text x="${pad}" y="10">${Math.round(prof[0][1])} m</text><text x="${W - pad}" y="10" text-anchor="end">${Math.round(prof.at(-1)[1])} m</text></svg>`;
}

function routeCard(p) {
  if (!p) return `<p class="walk-note">Tap a place below to see its route and how much it climbs.</p>`;
  const r = routeInfo(result, p.lnglat);
  const climb = r.up >= 1 || r.down >= 1 ? ` · ↑${Math.round(r.up)} m ↓${Math.round(r.down)} m` : ' · flat';
  const backNote = hills && Math.abs(r.back - r.min) >= .5 ? `<small>Coming back the same way: ${fmt(r.back)} min${r.back > r.min ? ' (uphill)' : ' (downhill)'}</small>` : '';
  return `<div class="walk-route"><b>${esc(p.name)}</b>
    <span>${fmt(r.min)} min · ${dist(r.metres)}${climb}</span>${backNote}${profileSvg(r.prof)}</div>`;
}

function render() {
  const el = document.getElementById('walk-panel');
  const places = getPlaces();
  const medal = i => ['🥇', '🥈', '🥉'][i] || `${i + 1}`;
  const worst = Math.max(...league.map(l => l.score), 1);
  const missing = DESTS.filter(d => !places.find(p => p.id === d.id)?.lnglat).map(d => d.short);
  const move = l => !hills || !l.rankMove ? '' : l.rankMove > 0
    ? `<em class="move up" title="Up ${l.rankMove} compared with flat ground">▲${l.rankMove}</em>`
    : `<em class="move down" title="Down ${-l.rankMove} compared with flat ground">▼${-l.rankMove}</em>`;

  let body;
  if (tab === 'league') {
    body = `<p class="walk-note">Average ${travel === 'walk' ? 'walk' : 'ride'} from each hostel to classes, LH, food, SAC and more,
      weighted by how often you go, there and back${hills ? ', with the hills. ▲▼ show the change from flat ground' : ' on flat ground'}.</p>
      <ol class="league">${league.map((l, i) => `
        <li data-hostel="${l.hostel.id}">
          <span class="rank">${medal(i)}</span>
          <span class="who">${esc(l.hostel.name.replace(' Hostel', ''))} ${move(l)}
            <span class="bar"><i style="width:${(100 * l.score / worst).toFixed(0)}%;background:${colorFor(l.score)}"></i></span>
            <small>${l.times.map(t => `${t.short} ${fmt(t.min)}′`).join(' · ')}</small></span>
          <b>${l.score.toFixed(1)}′</b>
        </li>`).join('')}</ol>
      ${missing.length ? `<p class="walk-note">Not yet counted (needs a location): ${missing.join(', ')}.</p>` : ''}`;
  } else if (result) {
    const rows = places.filter(p => p.lnglat && p.category !== 'residential')
      .map(p => ({ p, min: minutesTo(result, p.lnglat) })).sort((a, b) => a.min - b.min).slice(0, 40)
      .map(r => ({ ...r, up: hills ? routeInfo(result, r.p.lnglat).up : 0 }));
    body = `<p class="walk-note">From <b>${esc(result.label || 'the pin')}</b>.</p>
      <div id="walk-route-card">${routeCard(routeTo)}</div>
      <ul class="here">${rows.map(r => `<li data-place="${r.p.id}">
        <i style="background:${colorFor(r.min)}"></i><span>${esc(r.p.name)}</span>${r.up >= 5 ? `<small class="climb">↑${Math.round(r.up)} m</small>` : ''}<b>${fmt(r.min)} min</b></li>`).join('')}</ul>`;
  } else {
    body = '<p class="walk-note">Click anywhere on the map to see how far you can walk from there.</p>';
  }

  const speedNote = travel === 'walk'
    ? (hills ? 'Walking at 4.8 km/h on the flat, slower uphill and on steep descents (Tobler’s hiking function)' : 'At 4.8 km/h, ignoring hills')
    : (hills ? 'Cycling at 12 km/h on the flat, slower uphill (pushing on steep bits), faster downhill' : 'At 12 km/h, ignoring hills');
  el.innerHTML = `
    <div class="walk-head">
      <h2>${travel === 'walk' ? 'Walking' : 'Cycling'} times</h2>
      <div class="walk-tabs">
        <button data-travel="walk" aria-pressed="${travel === 'walk'}">🚶 Walk</button>
        <button data-travel="cycle" aria-pressed="${travel === 'cycle'}">🚲 Cycle</button>
        <button data-hills aria-pressed="${hills}" title="Count the climbs and descents along each route">⛰ Hills</button>
      </div>
      <div class="walk-tabs">
        <button data-tab="league" aria-pressed="${tab === 'league'}">Hostel league</button>
        <button data-tab="here" aria-pressed="${tab === 'here'}">From here</button>
      </div>
      <div class="walk-legend">${BAND_COLORS[getTheme()].map((c, i) =>
        `<span><i style="background:${c}"></i>${i < BANDS.length ? `${i ? BANDS[i - 1] : 0}–${BANDS[i]}` : `${BANDS.at(-1)}+`}′</span>`).join('')}</div>
    </div>
    <div class="walk-body">${body}</div>
    <p class="walk-foot">${speedNote}, along mapped roads and paths${travel === 'walk' ? ' (no grass shortcuts)' : ', no parking time'}.
      ${hills ? 'Heights from the 30 m Copernicus DEM, good to a few metres. ' : ''}Mapped paths may be incomplete, closed or private: use your own judgement.</p>`;

  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
  el.querySelectorAll('[data-travel]').forEach(b => b.onclick = () => setTravel(b.dataset.travel));
  el.querySelector('[data-hills]').onclick = () => { hills = !hills; refresh(); };
  el.querySelectorAll('[data-hostel]').forEach(li => li.onclick = () => {
    const h = places.find(p => p.id === li.dataset.hostel);
    map.flyTo({ center: h.lnglat, zoom: 16, duration: 900 });
    setOrigin(h.lnglat, h.name);
  });
  el.querySelectorAll('[data-place]').forEach(li => {
    const p = places.find(x => x.id === li.dataset.place);
    li.onmouseenter = () => showRoute(p);
    li.onclick = () => { showRoute(p); map.flyTo({ center: p.lnglat, zoom: Math.max(map.getZoom(), 16), duration: 800 }); };
  });
}

// Travel mode or hills changed: new step costs, new league, same origin and tab.
function refresh() {
  SPEED = SPEEDS[travel];
  setCosts();
  computeLeague();
  const keepTab = tab, keepRoute = routeTo;
  if (result) setOrigin(result.origin, result.label);
  tab = keepTab;
  routeTo = keepRoute;
  render();
  if (keepRoute) showRoute(keepRoute);
}

function setTravel(t) {
  travel = t;
  refresh();
}

// ---------- mode switch ----------
function setMode(on) {
  if (on) { pulseOff(); seasonsOff(); }
  ui.mode = on ? 'walk' : 'explore';
  document.getElementById('toggle-walk').setAttribute('aria-pressed', on);
  document.body.classList.toggle('walking', on);
  document.getElementById('walk-panel').hidden = !on;
  if (on) {
    closePopup();
    if (!COST) setCosts();
    computeLeague();
    addLayers(getTheme());
    render();
    if (!result && league[0]) setOrigin(league[0].hostel.lnglat, league[0].hostel.name);
    tab = 'league';
    render();
  } else {
    cancelAnimationFrame(animFrame);
    removeLayers();
    marker?.remove();
  }
}

// Used by search: in walk mode, a searched place becomes the starting point.
export function walkFrom(lnglat, label) {
  map.flyTo({ center: lnglat, zoom: Math.max(map.getZoom(), 16), duration: 900 });
  setOrigin(lnglat, label);
}

export async function initWalk() {
  await loadGraph();
  const panel = Object.assign(document.createElement('aside'), { id: 'walk-panel', className: 'panel walk', hidden: true });
  document.body.append(panel);
  sheet(panel);
  const btn = document.getElementById('toggle-walk');
  btn.onclick = () => setMode(ui.mode !== 'walk');
  map.on('click', e => {
    if (ui.mode !== 'walk') return;
    setOrigin([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)], null);
  });
  onStyle(theme => {
    if (ui.mode !== 'walk') return;
    addLayers(theme);
    render();
  });
  if (new URLSearchParams(location.search).has('walk')) setMode(true);
}
