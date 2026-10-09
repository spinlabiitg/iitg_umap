// Pulse of campus: a simulated day of student movement on the walking network.
// About 760 dots (each = 10 students, from hostel capacities) follow a modelled timetable — classes, lunch at the
// hostel mess, evening sport and food, the library at night — walking or cycling along shortest paths.
// Paths glow with recent traffic. Nothing here is tracking data: every trip is generated from the rules below.
// Also answers one planning question: where would one new canteen save the most walking?
import { map, ui, loaded, getPlaces, getTheme, onStyle, closePopup, CATEGORIES } from './app.js';
import { G, loadGraph, snap, dijkstra, metres } from './graph.js';
import { pointInRing } from './config.js';

const PER_DOT = 10;                      // students per dot
const SPEED = { walk: 80, cycle: 200 };  // metres per minute
const CYCLE_SHARE = 0.45;
const DAY = [6 * 60, 24 * 60];           // simulated window, minutes since midnight
const SIM_PER_SEC = 4;                   // simulated minutes per real second at 1×
const FLOW_HALF_LIFE = 6;                // simulated minutes for the path glow to fade by half
const MIN_GAP = 100;                     // metres a proposed canteen keeps from hostels and existing food places

// Where people go, by purpose. Weights are relative within each purpose; missing places are skipped.
const PURPOSES = {
  class: { label: 'to class', color: 'academic', where: [
    ['lecture-halls', 12], ['l1-l2-l3-l4', 8], ['core-1', 7], ['core-2', 7], ['core-3', 7], ['core-4', 7], ['core-5', 4],
    ['dept-cse', 4], ['dept-eee', 4], ['dept-me', 4], ['dept-ce', 3], ['dept-che', 3], ['dept-chem', 2], ['dept-phy', 2],
    ['dept-math', 3], ['dept-bsbe', 2], ['dept-design', 2], ['dept-hss', 2], ['school-msdsai', 2], ['school-sese', 1],
    ['centre-nano', 1], ['cif', 1], ['library', 3]] },
  home: { label: 'back to hostel', color: 'hostel' },
  evening: { label: 'to sport & food', color: 'sports', where: [
    ['sports-field', 8], ['new-sac', 7], ['sac', 5], ['gym', 5], ['pool', 2], ['football-ground', 3], ['hockey-ground', 2],
    ['cricket-ground', 3], ['basketball-court', 2], ['food-court', 8], ['market-complex', 2], ['khokha', 3],
    ['admin-lake', 1], ['view-point', 1], ['duck-point', 1]] },
  night: { label: 'to library & late food', color: 'food', where: [
    ['library', 10], ['food-court', 8], ['khokha', 4], ['lake-view-canteen', 2], ['hashtag-canteen', 2], ['ccc', 2]] },
};

// The modelled day: each wave sends a share of people, departing uniformly within a window.
const WAVES = [
  { from: 'hostel', to: 'class', share: .85, t: [8 * 60 + 33, 8 * 60 + 56], caption: 'Morning rush to the 9 o\'clock classes' },
  { from: 'here', to: 'class', share: .30, t: [10 * 60 + 54, 11 * 60 + 2], caption: 'Changing rooms between classes' },
  { from: 'here', to: 'home', share: .70, t: [12 * 60 + 55, 13 * 60 + 10], caption: 'Lunch at the hostel mess' },
  { from: 'hostel', to: 'class', share: .60, t: [13 * 60 + 42, 13 * 60 + 57], caption: 'Back for afternoon classes' },
  { from: 'here', to: 'home', share: 1, t: [17 * 60, 17 * 60 + 35], caption: 'Classes over: heading back' },
  { from: 'hostel', to: 'evening', share: .45, t: [17 * 60 + 45, 18 * 60 + 30], caption: 'Evening: grounds, gyms and the Food Court' },
  { from: 'here', to: 'home', share: 1, t: [19 * 60 + 15, 20 * 60], caption: 'Dinner time at the hostels' },
  { from: 'hostel', to: 'night', share: .35, t: [20 * 60 + 30, 21 * 60 + 30], caption: 'Night owls: library and late-night food' },
  { from: 'here', to: 'home', share: 1, t: [22 * 60 + 30, 23 * 60 + 30], caption: 'Lights out: back to the hostels' },
];

// ---------------------------------------------------------------- simulation
function rng(seed) {            // mulberry32: same day every time
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pickWeighted = (list, r) => {
  const total = list.reduce((a, x) => a + x.w, 0);
  let u = r() * total;
  for (const x of list) if ((u -= x.w) <= 0) return x;
  return list[list.length - 1];
};

let sim = null;   // { agents, counts, paths, edgeIndex, hostels, maxCount, peak }

function build() {
  const places = getPlaces(), byId = new Map(places.map(p => [p.id, p]));
  const node = p => snap(p.lnglat).node;
  const hostels = places.filter(p => p.category === 'hostel' && p.lnglat).map(p => ({ p, node: node(p), cap: p.capacity || 400 }));
  const dests = Object.fromEntries(Object.entries(PURPOSES).filter(([, v]) => v.where).map(([k, v]) =>
    [k, v.where.filter(([id]) => byId.get(id)?.lnglat).map(([id, w]) => ({ p: byId.get(id), node: node(byId.get(id)), w }))]));

  // shortest-path trees from every place a trip can start at, computed once
  const trees = new Map();
  const tree = s => { if (!trees.has(s)) trees.set(s, dijkstra(s)); return trees.get(s); };
  const paths = new Map();
  const pathBetween = (s, t) => {
    const key = s + '>' + t;
    if (paths.has(key)) return paths.get(key);
    const { prev } = tree(s), ids = [];
    for (let v = t; v !== -1; v = prev[v]) ids.push(v);
    ids.reverse();
    if (ids[0] !== s) { paths.set(key, null); return null; }
    const cum = [0];
    for (let i = 1; i < ids.length; i++) cum.push(cum[i - 1] + metres(G.nodes[ids[i - 1]], G.nodes[ids[i]]));
    const path = { ids, cum, len: cum[cum.length - 1] };
    paths.set(key, path);
    return path;
  };

  const r = rng(20261009);
  const agents = [];
  for (const h of hostels) for (let i = 0; i < Math.round(h.cap / PER_DOT); i++) {
    const a = { home: h.node, at: h.node, speed: r() < CYCLE_SHARE ? SPEED.cycle : SPEED.walk, trips: [] };
    for (const wave of WAVES) {
      const atHome = a.at === a.home;
      if (wave.from === 'hostel' && !atHome) continue;
      if (wave.from === 'here' && atHome) continue;
      if (r() > wave.share) continue;
      const target = wave.to === 'home' ? a.home : pickWeighted(dests[wave.to], r).node;
      if (target === a.at) continue;
      const path = pathBetween(a.at, target);
      if (!path || path.len < 30) continue;
      const depart = wave.t[0] + r() * (wave.t[1] - wave.t[0]);
      a.trips.push({ depart, arrive: depart + path.len / a.speed, path, purpose: wave.to });
      a.at = target;
    }
    agents.push(a);
  }

  // people on the move, per minute of the day (for the sparkline and the peak)
  const counts = new Float32Array(24 * 60);
  for (const a of agents) for (const t of a.trips) for (let m = Math.floor(t.depart); m <= Math.min(t.arrive, 24 * 60 - 1); m++) counts[m] += PER_DOT;
  let peak = DAY[0];
  for (let m = DAY[0]; m < DAY[1]; m++) if (counts[m] > counts[peak]) peak = m;

  const edgeIndex = new Map(G.edges.map(([a, b], i) => [a < b ? a + '-' + b : b + '-' + a, i]));
  sim = { agents, counts, paths, edgeIndex, hostels, peak, maxCount: counts[peak], trees, dests };
}

// position and current edge of an agent at time T (null when not travelling)
function where(a, T) {
  for (const t of a.trips) {
    if (T < t.depart) return null;
    if (T >= t.arrive) continue;
    const s = (T - t.depart) * a.speed, { cum, ids } = t.path;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const f = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    const A = G.nodes[ids[lo]], B = G.nodes[ids[hi]];
    return { lnglat: [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f], a: ids[lo], b: ids[hi], purpose: t.purpose };
  }
  return null;
}

// ---------------------------------------------------------------- new-canteen question
// Each hostel resident makes one food trip in the evening; a new canteen helps everyone for whom it is closer than
// the nearest existing food place. Try every network node on campus; keep the one with the largest saving.
function bestCanteen() {
  const ring = loaded.boundary.features[0].geometry.coordinates[0];
  const food = getPlaces().filter(p => p.category === 'food' && p.lnglat).map(p => snap(p.lnglat).node);
  const rows = sim.hostels.map(h => {
    const { dist } = sim.trees.get(h.node) || dijkstra(h.node);
    return { h, dist, nearest: Math.min(...food.map(f => dist[f])) };
  });
  // Hostels already have their own canteens, so the new place must stand apart (a shared spot, not inside one
  // hostel) and away from existing food places.
  const keepAway = [...sim.hostels.map(h => h.p.lnglat), ...getPlaces().filter(p => p.category === 'food' && p.lnglat).map(p => p.lnglat)];
  let best = -1, bestSave = 0;
  for (let v = 0; v < G.nodes.length; v++) {
    if (!G.inMain[v] || !pointInRing(G.nodes[v], ring)) continue;
    if (keepAway.some(q => metres(G.nodes[v], q) < MIN_GAP)) continue;
    let save = 0;
    for (const r of rows) if (r.dist[v] < r.nearest) save += r.h.cap * (r.nearest - r.dist[v]);
    if (save > bestSave) { bestSave = save; best = v; }
  }
  const helped = rows.filter(r => r.dist[best] < r.nearest).map(r => ({ name: r.h.p.name.replace(/ Hostel$/, ''), from: r.nearest, to: r.dist[best] }))
    .sort((x, y) => (y.from - y.to) - (x.from - x.to));
  const before = rows.reduce((a, r) => a + r.h.cap * r.nearest, 0) / rows.reduce((a, r) => a + r.h.cap, 0);
  const after = rows.reduce((a, r) => a + r.h.cap * Math.min(r.nearest, r.dist[best]), 0) / rows.reduce((a, r) => a + r.h.cap, 0);
  return { node: best, lnglat: G.nodes[best], kmPerEvening: 2 * bestSave / 1000, helped, before, after };
}

// ---------------------------------------------------------------- map layers
let flowGeo, flow, dotsGeo, T = 8 * 60 + 25, playing = true, speed = 1, raf = 0, last = 0, lastFlowPush = 0, canteen = null;
const color = k => CATEGORIES[PURPOSES[k].color][getTheme()];

function addLayers() {
  if (!map.getSource('pulse-flow')) {
    map.addSource('pulse-flow', { type: 'geojson', data: flowGeo });
    map.addSource('pulse-dots', { type: 'geojson', data: dotsGeo });
    map.addSource('pulse-best', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (map.getLayer('pulse-dots')) return;
  const before = map.getLayer('bld-ml') ? 'bld-ml' : undefined, dark = getTheme() === 'dark';
  map.addLayer({ id: 'pulse-flow', type: 'line', source: 'pulse-flow', filter: ['>', ['get', 'f'], .5],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#ffd27a' : '#e76f51', 'line-blur': 1.5,
      'line-width': ['interpolate', ['linear'], ['get', 'f'], 0, 0, 5, 2.5, 40, 7, 150, 12],
      'line-opacity': ['interpolate', ['linear'], ['get', 'f'], 0, 0, 3, .25, 40, .7] } }, before);
  map.addLayer({ id: 'pulse-dots', type: 'circle', source: 'pulse-dots',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 18, 4.5],
      'circle-color': ['match', ['get', 'k'], ...Object.keys(PURPOSES).flatMap(k => [k, color(k)]), '#888'],
      'circle-stroke-color': dark ? '#0f1a1f' : '#fffaf0', 'circle-stroke-width': .8, 'circle-opacity': .95 } });
  map.addLayer({ id: 'pulse-best', type: 'circle', source: 'pulse-best',
    paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3,
      'circle-stroke-color': CATEGORIES.food[getTheme()] } });
  map.addLayer({ id: 'pulse-best-label', type: 'symbol', source: 'pulse-best',
    layout: { 'text-field': 'new canteen here?', 'text-font': ['Open Sans Bold'], 'text-size': 13, 'text-offset': [0, -1.8] },
    paint: { 'text-color': dark ? '#f6b25e' : '#b8561d', 'text-halo-color': dark ? '#0f1a1f' : '#fffaf0', 'text-halo-width': 2 } });
}
function removeLayers() {
  for (const id of ['pulse-best-label', 'pulse-best', 'pulse-dots', 'pulse-flow']) if (map.getLayer(id)) map.removeLayer(id);
}

function step(now) {
  const dt = last ? Math.min((now - last) / 1000, .25) : 0;
  last = now;
  if (playing) {
    T += dt * SIM_PER_SEC * speed;
    if (T >= DAY[1]) T = DAY[0];
  }
  const dSim = playing ? dt * SIM_PER_SEC * speed : 0;
  const decay = Math.pow(0.5, dSim / FLOW_HALF_LIFE);
  for (let i = 0; i < flow.length; i++) flow[i] *= decay;
  const feats = [];
  for (const a of sim.agents) {
    const w = where(a, T);
    if (!w) continue;
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: w.lnglat }, properties: { k: w.purpose } });
    const e = sim.edgeIndex.get(w.a < w.b ? w.a + '-' + w.b : w.b + '-' + w.a);
    if (e !== undefined) flow[e] += PER_DOT * dSim;
  }
  dotsGeo.features = feats;
  map.getSource('pulse-dots')?.setData(dotsGeo);
  if (now - lastFlowPush > 250) {
    lastFlowPush = now;
    flowGeo.features.forEach((f, i) => { f.properties.f = flow[i]; });
    map.getSource('pulse-flow')?.setData(flowGeo);
  }
  renderClock(feats.length * PER_DOT);
  raf = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- panel
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
function captionAt(m) {
  const w = WAVES.find(w => m >= w.t[0] - 4 && m <= w.t[1] + 12);
  if (w) return w.caption;
  if (m < WAVES[0].t[0]) return 'Early morning: breakfast in the hostels';
  if (m > 23 * 60 + 40) return 'The campus sleeps';
  return 'In class, at work or in the hostels';
}

function sparkline() {
  const W = 292, H = 54, [a, b] = DAY, max = sim.maxCount || 1;
  let d = '';
  for (let m = a; m < b; m += 2) d += `${m === a ? 'M' : 'L'}${((m - a) / (b - a) * W).toFixed(1)} ${(H - sim.counts[m] / max * (H - 4)).toFixed(1)}`;
  const ticks = [8, 12, 16, 20].map(h => { const x = (h * 60 - a) / (b - a) * W; return `<line x1="${x}" x2="${x}" y1="0" y2="${H}" class="tick"/><text x="${x + 2}" y="${H - 2}">${h}:00</text>`; }).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${ticks}<path d="${d}V${H}H0Z" class="area"/><path d="${d}" class="ln"/>
    <line id="sparkNow" x1="0" x2="0" y1="0" y2="${H}" class="now"/></svg>`;
}

function render() {
  const el = document.getElementById('pulse-panel');
  el.innerHTML = `
    <div class="walk-head">
      <h2>Pulse of campus</h2>
      <div class="pulse-clock"><b id="pClock">--:--</b><span id="pCaption"></span></div>
      <div class="walk-tabs">
        <button id="pPlay">${playing ? '❚❚ Pause' : '▶ Play'}</button>
        ${[1, 2, 4].map(s => `<button data-speed="${s}" aria-pressed="${speed === s}">${s}×</button>`).join('')}
      </div>
      <input id="pTime" type="range" min="${DAY[0]}" max="${DAY[1] - 1}" step="1" value="${Math.floor(T)}" aria-label="Time of day">
      <div class="walk-legend">${Object.entries(PURPOSES).map(([k, v]) => `<span><i style="background:${color(k)}"></i>${v.label}</span>`).join('')}</div>
    </div>
    <div class="walk-body">
      <p class="walk-note"><b id="pMoving">0</b> people on the move. Each dot is ${PER_DOT} students; glowing paths carry the most traffic.</p>
      ${sparkline()}
      <p class="walk-note">Busiest minute: <b>${hhmm(sim.peak)}</b>, with about ${Math.round(sim.maxCount / 10) * 10} people moving at once.</p>
      <div class="pulse-q">
        <b>Where would one new canteen save the most walking?</b>
        ${canteen ? `<p>Here (ringed on the map), at least ${MIN_GAP} m from any hostel or food place: about <b>${Math.round(canteen.kmPerEvening)} km</b>
          less walking every evening if each resident makes one food trip there and back. The average distance to food drops from
          ${Math.round(canteen.before)} m to ${Math.round(canteen.after)} m.
          Biggest winners: ${canteen.helped.slice(0, 3).map(h => `${h.name} (${Math.round(h.from)} → ${Math.round(h.to)} m)`).join(', ')}.</p>`
          : '<button id="pCanteen" class="primary">Find the best spot</button>'}
      </div>
    </div>
    <p class="walk-foot">Simulated from hostel capacities and a typical timetable (${Math.round(CYCLE_SHARE * 100)}% cycle); no tracking data is used.</p>`;
  el.querySelector('#pPlay').onclick = () => { playing = !playing; render(); };
  el.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => { speed = +b.dataset.speed; render(); });
  el.querySelector('#pTime').oninput = e => { T = +e.target.value; flow.fill(0); };
  el.querySelector('#pCanteen')?.addEventListener('click', () => {
    canteen = bestCanteen();
    map.getSource('pulse-best').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: canteen.lnglat }, properties: {} });
    map.flyTo({ center: canteen.lnglat, zoom: Math.max(map.getZoom(), 16), duration: 1200 });
    render();
  });
}

function renderClock(moving) {
  const c = document.getElementById('pClock');
  if (!c) return;
  c.textContent = hhmm(T);
  document.getElementById('pCaption').textContent = captionAt(T);
  document.getElementById('pMoving').textContent = moving.toLocaleString('en-IN');
  const slider = document.getElementById('pTime');
  if (document.activeElement !== slider) slider.value = Math.floor(T);
  const x = (T - DAY[0]) / (DAY[1] - DAY[0]) * 292;
  const now = document.getElementById('sparkNow');
  if (now) { now.setAttribute('x1', x); now.setAttribute('x2', x); }
}

// ---------------------------------------------------------------- mode switch
async function setMode(on) {
  const btn = document.getElementById('toggle-pulse');
  if (on && ui.mode === 'walk') document.getElementById('toggle-walk').click();
  ui.mode = on ? 'pulse' : 'explore';
  btn.setAttribute('aria-pressed', on);
  document.body.classList.toggle('pulsing', on);
  document.getElementById('pulse-panel').hidden = !on;
  if (!on) { cancelAnimationFrame(raf); removeLayers(); return; }
  closePopup();
  if (!sim) {
    document.getElementById('pulse-panel').innerHTML = '<p class="walk-note">Simulating a day on campus…</p>';
    await loadGraph();
    build();
    flowGeo = structuredClone(G.edgesGeo);
    flow = new Float32Array(flowGeo.features.length);
    dotsGeo = { type: 'FeatureCollection', features: [] };
  }
  addLayers();
  if (canteen) map.getSource('pulse-best').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: canteen.lnglat }, properties: {} });
  render();
  last = 0;
  raf = requestAnimationFrame(step);
}

// Parked until real movement/timetable data is available: no toolbar button; open with ?pulse to try it.
export function initPulse() {
  if (!new URLSearchParams(location.search).has('pulse')) return;
  const panel = Object.assign(document.createElement('aside'), { id: 'pulse-panel', className: 'panel walk pulse', hidden: true });
  document.body.append(panel);
  const btn = Object.assign(document.createElement('button'), { id: 'toggle-pulse', textContent: '✨ Pulse', title: 'Pulse of campus (preview)' });
  btn.setAttribute('aria-pressed', 'false');
  document.getElementById('toggle-walk').after(btn);
  btn.onclick = () => setMode(ui.mode !== 'pulse');
  onStyle(() => { if (ui.mode === 'pulse') { addLayers(); render(); } });
  setMode(true);
}
export const pulseOff = () => { if (ui.mode === 'pulse') setMode(false); };
