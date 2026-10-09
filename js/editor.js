// Map editor (open index.html?edit). Four tools:
//   📍 Place     — pick (or add) a place, click the map to drop its pin exactly there (drag to fine-tune).
//   🏠 Building  — trace a missing building: freeform corners, or a quick rectangle in three clicks.
//   〰 Path      — draw a missing road, footpath or steps; clicks snap onto existing roads so routes connect.
//   🚫 Hide      — click a wrong footprint to hide it (click again to restore); click a drawn item to delete it.
// Edits autosave in this browser; the Download buttons export data/places.json and data/custom_buildings.json
// (which holds drawn buildings, hidden footprints and drawn paths).
import { map, loaded, refreshPlaces, getPlaces, getCustom, setCustomBuildings, onStyle, PLACES_REV,
  CATEGORIES, BUILDING_LAYERS, PATH_LAYERS } from './app.js';

const KEY = 'iitg-map-places-draft';
const KEY_BLD = 'iitg-map-buildings-draft';
const SNAP_PX = 12;
const PATH_TYPES = [['footway', 'Footpath'], ['road', 'Road'], ['service', 'Service lane'], ['steps', 'Steps']];
let places, custom, selected = null, filter = 'todo', query = '';
let tool = 'place', linkBuilding = true, floors = 3, shape = 'free', pathType = 'footway';
let verts = [], cursor = null, snapped = null, pin = null, snapPts = [];

const store = {
  load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  clear(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const round = ll => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
const drawing = () => tool === 'building' || tool === 'path';

function commit() {
  store.save(KEY, { rev: PLACES_REV, places });
  refreshPlaces(places);
  render();
}

function commitBuildings() {
  store.save(KEY_BLD, custom);
  setCustomBuildings(custom);
  rebuildSnapPoints();
  render();
}

// ---------- panel ----------
function render() {
  const el = document.getElementById('editor');
  const tools = [['place', '📍 Place'], ['building', '🏠 Building'], ['path', '〰 Path'], ['hide', '🚫 Hide']];
  const panel = { place: placePanel, building: buildingPanel, path: pathPanel, hide: hidePanel }[tool];
  el.innerHTML = `
    <div class="ed-head">
      <h2>Map editor</h2>
      <div class="ed-tabs ed-tools">${tools.map(([k, t]) => `<button data-tool="${k}" aria-pressed="${tool === k}">${t}</button>`).join('')}</div>
    </div>
    ${panel()}
    <div class="ed-foot">
      <button id="ed-download" class="primary">⬇ places.json</button>
      <button id="ed-download-bld" class="primary" title="Drawn buildings, drawn paths and hidden footprints">⬇ map edits</button>
      <button id="ed-reset" title="Discard browser edits and reload the files">Reset</button>
    </div>`;

  el.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  el.querySelector('#ed-download').onclick = () => download('places.json', { version: 1, revision: PLACES_REV, places });
  el.querySelector('#ed-download-bld').onclick = () => download('custom_buildings.json', custom);
  el.querySelector('#ed-reset').onclick = () => {
    if (!confirm('Discard ALL edits (places, buildings and paths) made in this browser? Download them first if you want to keep them.')) return;
    store.clear(KEY); store.clear(KEY_BLD);
    location.reload();
  };
  ({ place: bindPlace, building: bindBuilding, path: bindPath, hide: bindHide })[tool](el);
}

function placePanel() {
  // Built-in places are never dropped from the list: deleting marks them deleted (restorable, see bindPlace).
  const live = places.filter(p => !p.deleted), nDeleted = places.length - live.length;
  if (filter === 'deleted' && !nDeleted) filter = 'all';
  const done = live.filter(p => p.lnglat).length;
  const shown = (filter === 'deleted' ? places.filter(p => p.deleted) : live).filter(p =>
    (filter === 'all' || filter === 'deleted' || (filter === 'todo' ? !p.lnglat : p.lnglat)) &&
    (!query || (p.name + ' ' + (p.short || '') + ' ' + (p.aliases || []).join(' ')).toLowerCase().includes(query)));
  const sel = places.find(p => p.id === selected);
  return `
    <div class="ed-sub">
      <div class="ed-progress"><span style="width:${(100 * done / live.length).toFixed(0)}%"></span></div>
      <small>${done} of ${live.length} places on the map</small>
      <div class="ed-tabs">
        ${[['todo', 'Needs location'], ['done', 'Placed'], ['all', 'All'], ...(nDeleted ? [['deleted', `Deleted (${nDeleted})`]] : [])].map(([k, t]) =>
          `<button data-filter="${k}" aria-pressed="${filter === k}">${t}</button>`).join('')}
        <button id="ed-new" title="Add a place that isn't in the list">＋ New place</button>
      </div>
      <input id="ed-search" type="search" placeholder="Search places…" value="${esc(query)}">
    </div>
    ${sel ? `
    <div class="ed-selected">
      <div class="ed-banner">${sel.deleted ? `<b>${esc(sel.name)}</b> is deleted: hidden on the map, and removed for good when your downloaded edits are merged.`
        : `Click the map to put <b>${esc(sel.name)}</b>'s pin exactly there. Drag the pin to fine-tune.`}</div>
      ${sel.hint ? `<div class="ed-hint">💡 ${esc(sel.hint)}</div>` : ''}
      <label class="ed-check"><input type="checkbox" id="ed-link" ${linkBuilding ? 'checked' : ''}>
        Also colour the building under the pin</label>
      <label>Name<input data-field="name" value="${esc(sel.name)}"></label>
      <label>Description<textarea data-field="description" rows="3">${esc(sel.description)}</textarea></label>
      <label>Category<select data-field="category">${Object.entries(CATEGORIES).map(([k, v]) =>
        `<option value="${k}" ${k === sel.category ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <div class="ed-row">
        <button id="ed-unlink" ${sel.feature ? '' : 'disabled'}>Unlink building</button>
        <button id="ed-clear">Remove pin</button>
        ${sel.deleted ? '<button id="ed-restore">Restore</button>' : '<button id="ed-delete" class="danger">Delete place</button>'}
        <button id="ed-done">Done</button>
      </div>
    </div>` : ''}
    <ul class="ed-list">
      ${shown.map(p => `<li data-id="${p.id}" class="${p.id === selected ? 'sel' : ''}">
        <i style="background:${CATEGORIES[p.category]?.light}"></i>
        <span>${esc(p.name)}${p.hint ? `<small>${esc(p.hint)}</small>` : ''}</span>
        <em>${p.user_added ? 'new · ' : ''}${p.lnglat ? (p.status === 'from_osm' ? 'OSM' : '✓') : '—'}</em></li>`).join('') || '<li class="empty">Nothing here 🎉</li>'}
    </ul>`;
}

function bindPlace(el) {
  const sel = places.find(p => p.id === selected);
  el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter; render(); });
  el.querySelector('#ed-new').onclick = addPlace;
  const search = el.querySelector('#ed-search');
  search.oninput = () => { query = search.value.toLowerCase(); render(); el.querySelector('#ed-search').focus(); };
  search.setSelectionRange(query.length, query.length);
  el.querySelectorAll('.ed-list li[data-id]').forEach(li => li.onclick = () => select(li.dataset.id));
  if (!sel) return;
  el.querySelector('#ed-link').onchange = e => { linkBuilding = e.target.checked; };
  el.querySelectorAll('[data-field]').forEach(inp => inp.onchange = () => { sel[inp.dataset.field] = inp.value; commit(); });
  el.querySelector('#ed-unlink').onclick = () => { delete sel.feature; commit(); };
  el.querySelector('#ed-clear').onclick = () => {
    Object.assign(sel, { lnglat: null, status: 'needs_location' });
    delete sel.feature;
    showPin();
    commit();
  };
  el.querySelector('#ed-delete')?.addEventListener('click', () => {
    if (!confirm(`Delete "${sel.name}" from the map?`)) return;
    if (sel.user_added) places = places.filter(p => p.id !== sel.id);   // added here: just drop it
    else sel.deleted = true;                                             // built-in: keep a marker so it stays deleted
    selected = null;
    showPin();
    commit();
  });
  el.querySelector('#ed-restore')?.addEventListener('click', () => { delete sel.deleted; commit(); });
  el.querySelector('#ed-done').onclick = () => { selected = null; showPin(); render(); };
}

function addPlace() {
  const p = { id: `user-${Date.now().toString(36)}`, name: 'New place', category: 'facility',
    description: '', lnglat: null, status: 'needs_location', user_added: true };
  places.push(p);
  filter = 'all';
  query = '';
  selected = p.id;
  commit();
  const name = document.querySelector('[data-field="name"]');
  name?.focus();
  name?.select();
}

function buildingPanel() {
  const drawn = custom.added.features;
  const help = shape === 'rect'
    ? ['Click one corner of the building.', 'Click the next corner along one wall.', 'Move to set the depth, then click.'][Math.min(verts.length, 2)]
    : verts.length
      ? `${verts.length} corner${verts.length > 1 ? 's' : ''} so far. Click the first corner (or press Enter) to finish · Backspace undoes · Esc cancels.`
      : 'Click each corner of the building in turn. Tip: switch on Satellite to trace from the photo.';
  return `
    <div class="ed-selected">
      <div class="ed-tabs">
        <button data-shape="free" aria-pressed="${shape === 'free'}">Freeform</button>
        <button data-shape="rect" aria-pressed="${shape === 'rect'}">▭ Rectangle</button>
      </div>
      <div class="ed-banner">${help}</div>
      <div class="ed-row">
        <label>Floors <input id="ed-floors" type="number" min="1" max="20" value="${floors}"></label>
        <label>Name (optional)<input id="ed-bname" placeholder="e.g. Core 3"></label>
      </div>
    </div>
    <ul class="ed-list">
      ${drawn.map(f => `<li data-fid="${esc(f.properties.fid)}"><i style="background:#999"></i>
        <span>${esc(f.properties.name || 'Drawn building')}<small>${f.properties.floors} floors</small></span>
        <em class="ed-del" title="Delete">✕</em></li>`).join('') || '<li class="empty">No drawn buildings yet</li>'}
    </ul>`;
}

function bindBuilding(el) {
  el.querySelectorAll('[data-shape]').forEach(b => b.onclick = () => { shape = b.dataset.shape; verts = []; drawPreview(); render(); });
  el.querySelector('#ed-floors').onchange = e => { floors = Math.max(1, +e.target.value || 1); };
  bindDrawnList(el, 'added');
}

function pathPanel() {
  const drawn = custom.paths.features;
  const label = Object.fromEntries(PATH_TYPES);
  return `
    <div class="ed-selected">
      <label>Type<select id="ed-ptype">${PATH_TYPES.map(([k, t]) =>
        `<option value="${k}" ${k === pathType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="ed-banner">${verts.length
        ? `${verts.length} point${verts.length > 1 ? 's' : ''}. Double-click or press Enter to finish · Backspace undoes · Esc cancels.`
        : 'Click along the route. Clicks snap (white ring) onto existing roads and paths so walking routes connect.'}</div>
      <label>Name (optional)<input id="ed-pname" placeholder="e.g. Lake promenade"></label>
    </div>
    <ul class="ed-list">
      ${drawn.map(f => `<li data-fid="${esc(f.properties.fid)}"><i style="background:#b9a98a"></i>
        <span>${esc(f.properties.name || label[f.properties.highway] || 'Path')}<small>${label[f.properties.highway] || ''} · ${lengthM(f.geometry.coordinates)} m</small></span>
        <em class="ed-del" title="Delete">✕</em></li>`).join('') || '<li class="empty">No drawn paths yet</li>'}
    </ul>`;
}

function bindPath(el) {
  el.querySelector('#ed-ptype').onchange = e => { pathType = e.target.value; };
  bindDrawnList(el, 'paths');
}

function bindDrawnList(el, which) {
  el.querySelectorAll('[data-fid]').forEach(li => {
    const f = custom[which].features.find(x => x.properties.fid === li.dataset.fid);
    li.onclick = () => {
      const c = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
      map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 17.5), duration: 700 });
    };
    li.querySelector('.ed-del').onclick = e => {
      e.stopPropagation();
      custom[which].features = custom[which].features.filter(x => x !== f);
      commitBuildings();
    };
  });
}

function hidePanel() {
  return `
    <div class="ed-selected"><div class="ed-banner">Click a footprint that is wrong or doesn't exist to hide it (red outline) — click again to restore.
      Clicking something you drew deletes it.</div></div>
    <ul class="ed-list">
      ${custom.hidden.map(fid => `<li data-hidden="${esc(fid)}"><i style="background:#c0392b"></i><span>${esc(fid)}</span>
        <em class="ed-del" title="Restore">↺</em></li>`).join('') || '<li class="empty">Nothing hidden</li>'}
    </ul>`;
}

function bindHide(el) {
  el.querySelectorAll('[data-hidden]').forEach(li => li.querySelector('.ed-del').onclick = () => toggleHidden(li.dataset.hidden));
}

// ---------- tools ----------
function setTool(t) {
  tool = t;
  verts = [];
  drawPreview();
  map.doubleClickZoom[drawing() ? 'disable' : 'enable']();
  for (const id of ['hidden-outline', 'hidden-outline-fill']) map.setLayoutProperty(id, 'visibility', t === 'hide' ? 'visible' : 'none');
  showPin();
  render();
}

function select(id) {
  selected = id;
  const p = places.find(x => x.id === id);
  if (p.lnglat) map.flyTo({ center: p.lnglat, zoom: Math.max(map.getZoom(), 17), duration: 800 });
  showPin();
  render();
}

// A draggable pin for the selected place, for precise positioning.
function showPin() {
  const p = tool === 'place' && places.find(x => x.id === selected);
  if (!p || !p.lnglat || p.deleted) { pin?.remove(); return; }
  if (!pin) {
    pin = new maplibregl.Marker({ draggable: true, color: '#e2725b' });
    pin.on('dragend', () => {
      const s = places.find(x => x.id === selected);
      if (!s) return;
      s.lnglat = round(pin.getLngLat());
      s.status = 'tagged';
      commit();
    });
  }
  pin.setLngLat(p.lnglat).addTo(map);
}

function placeAt(e) {
  const p = places.find(x => x.id === selected);
  if (!p || p.deleted) return;
  p.lnglat = round(e.lngLat);
  p.status = 'tagged';
  const hit = map.queryRenderedFeatures(e.point, { layers: BUILDING_LAYERS })[0];
  // Link the single footprint under the pin (not a whole hostel/complex group).
  if (linkBuilding && hit) p.feature = hit.properties.fid;
  else if (linkBuilding) delete p.feature;
  showPin();
  commit();
}

// ---------- drawing ----------
function metres(p, q) {
  const lat = (p[1] + q[1]) / 2 * Math.PI / 180;
  return Math.hypot((q[0] - p[0]) * Math.cos(lat), q[1] - p[1]) * Math.PI / 180 * 6371000;
}
const lengthM = cs => Math.round(cs.slice(1).reduce((a, c, i) => a + metres(cs[i], c), 0));

// Every road and path (OSM and drawn): path clicks snap onto a vertex, or else onto the nearest point of a segment,
// so new paths join existing ones exactly (the walking network joins lines that share a point).
let snapLines = [];
function rebuildSnapPoints() {
  snapLines = [...loaded.roads.features, ...loaded.paths.features, ...custom.paths.features]
    .filter(f => f.geometry.type === 'LineString').map(f => f.geometry.coordinates);
  snapPts = snapLines.flat();
}

function snap(point) {
  if (tool !== 'path') return null;
  const b = map.getBounds();
  let best = null, bd = SNAP_PX;
  for (const c of snapPts) {
    if (!b.contains(c)) continue;
    const q = map.project(c), d = Math.hypot(q.x - point.x, q.y - point.y);
    if (d < bd) { bd = d; best = c; }
  }
  if (best) return best;
  bd = SNAP_PX * 0.7;
  for (const cs of snapLines) for (let i = 1; i < cs.length; i++) {
    if (!b.contains(cs[i]) && !b.contains(cs[i - 1])) continue;
    const p = map.project(cs[i - 1]), q = map.project(cs[i]);
    const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((point.x - p.x) * dx + (point.y - p.y) * dy) / L2)) : 0;
    const x = p.x + t * dx, y = p.y + t * dy, d = Math.hypot(x - point.x, y - point.y);
    if (d < bd) { bd = d; best = round(map.unproject([x, y])); }
  }
  return best;
}

// Rectangle from corners a, b and a third point that sets the depth (perpendicular to a→b).
function rectangle(a, b, c) {
  const k = Math.cos(a[1] * Math.PI / 180);          // work in locally-square units
  const ax = a[0] * k, bx = b[0] * k, cx = c[0] * k;
  const ux = bx - ax, uy = b[1] - a[1], len = Math.hypot(ux, uy) || 1;
  const nx = -uy / len, ny = ux / len;
  const depth = (cx - ax) * nx + (c[1] - a[1]) * ny;
  const off = [nx * depth / k, ny * depth];
  const r = p => [+p[0].toFixed(6), +p[1].toFixed(6)];
  return [a, b, r([b[0] + off[0], b[1] + off[1]]), r([a[0] + off[0], a[1] + off[1]])];
}

function drawPreview() {
  const src = map.getSource('draw-preview');
  if (!src) return;
  let line = [...verts];
  if (tool === 'building' && shape === 'rect' && verts.length === 2 && cursor) line = [...rectangle(verts[0], verts[1], cursor), verts[0]];
  else if (cursor && verts.length) line.push(cursor);
  if (tool === 'building' && shape === 'free' && verts.length > 2 && cursor) line.push(verts[0]);
  const feats = verts.map(v => ({ type: 'Feature', geometry: { type: 'Point', coordinates: v }, properties: {} }));
  if (line.length > 1) feats.unshift({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
  if (snapped) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: snapped }, properties: { snap: true } });
  src.setData({ type: 'FeatureCollection', features: feats });
}

function saveBuilding(ring) {
  const fid = `draw/${Date.now().toString(36)}`;
  const name = document.getElementById('ed-bname')?.value.trim();
  custom.added.features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    properties: { fid, key: fid, source: 'drawn', floors, height: floors * 3.5, ...(name ? { name } : {}) } });
}

function finishDrawing() {
  if (tool === 'building' && shape === 'free' && verts.length >= 3) saveBuilding(verts);
  else if (tool === 'path' && verts.length >= 2) {
    const fid = `path/${Date.now().toString(36)}`;
    const name = document.getElementById('ed-pname')?.value.trim();
    custom.paths.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: verts },
      properties: { fid, highway: pathType, source: 'drawn', ...(name ? { name } : {}) } });
  } else return;
  verts = [];
  drawPreview();
  commitBuildings();
}

function drawClick(e) {
  const p = (tool === 'path' && snap(e.point)) || round(e.lngLat);
  if (tool === 'building' && shape === 'rect') {
    if (verts.length < 2) verts.push(p);
    else { saveBuilding(rectangle(verts[0], verts[1], p)); verts = []; drawPreview(); return commitBuildings(); }
    drawPreview();
    return render();
  }
  if (tool === 'building' && verts.length >= 3) {
    const first = map.project(verts[0]);
    if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) return finishDrawing();
  }
  const last = verts.length && map.project(verts.at(-1));
  if (last && Math.hypot(last.x - e.point.x, last.y - e.point.y) < 4) return;  // double-click repeats
  verts.push(p);
  drawPreview();
  render();
}

// ---------- hiding ----------
function toggleHidden(fid) {
  custom.hidden = custom.hidden.includes(fid) ? custom.hidden.filter(x => x !== fid) : [...custom.hidden, fid];
  map.getSource('hidden-outline').setData(hiddenGeoJSON());
  commitBuildings();
}

function hideClick(e) {
  const box = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
  const hit = map.queryRenderedFeatures(box, { layers: [...PATH_LAYERS, ...BUILDING_LAYERS, 'hidden-outline-fill'] })[0];
  if (!hit) return;
  if (hit.layer.id === 'bld-custom' || PATH_LAYERS.includes(hit.layer.id)) {  // drawn by us: delete outright
    const which = hit.layer.id === 'bld-custom' ? 'added' : 'paths';
    if (!confirm(`Delete this drawn ${which === 'added' ? 'building' : 'path'}?`)) return;
    custom[which].features = custom[which].features.filter(x => x.properties.fid !== hit.properties.fid);
    return commitBuildings();
  }
  toggleHidden(hit.properties.fid);
}

function hiddenGeoJSON() {
  const all = [...loaded.buildings.features, ...loaded.buildings_ml.features];
  return { type: 'FeatureCollection', features: all.filter(f => custom.hidden.includes(f.properties.fid)) };
}

function addEditorLayers() {
  const vis = tool === 'hide' ? 'visible' : 'none';
  map.addLayer({ id: 'hidden-outline-fill', type: 'fill', source: 'hidden-outline', layout: { visibility: vis },
    paint: { 'fill-color': '#c0392b', 'fill-opacity': .15 } });
  map.addLayer({ id: 'hidden-outline', type: 'line', source: 'hidden-outline', layout: { visibility: vis },
    paint: { 'line-color': '#c0392b', 'line-width': 2, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'draw-line', type: 'line', source: 'draw-preview', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#e2725b', 'line-width': 2.5 } });
  map.addLayer({ id: 'draw-pts', type: 'circle', source: 'draw-preview',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'snap']]],
    paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#e2725b', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'draw-snap', type: 'circle', source: 'draw-preview', filter: ['has', 'snap'],
    paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  setCustomBuildings(custom);
  refreshPlaces(places);
}

// ---------- files ----------
function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Browser edits win for the fields the editor changes; everything else (hints, facts, newly
// added places) comes from data/places.json, so file updates reach an in-progress draft.
const EDITABLE = ['name', 'description', 'category', 'lnglat', 'feature', 'status', 'deleted'];
function merge(filePlaces, draft) {
  const out = structuredClone(filePlaces);
  if (!draft) return out;
  const byId = new Map(out.map(p => [p.id, p]));
  for (const d of draft) {
    const p = byId.get(d.id);
    if (!p) { out.push(d); continue; }
    for (const k of EDITABLE) { if (k in d) p[k] = d[k]; else delete p[k]; }
  }
  // Places deleted in the browser: user-added ones that are gone from the draft stay gone.
  const ids = new Set(draft.map(d => d.id));
  return out.filter(p => !p.user_added || ids.has(p.id));
}

function mergeBuildings(file, draft) {
  const fc = fs => ({ type: 'FeatureCollection', features: fs });
  const union = (a = [], b = []) => [...new Map([...a, ...b].map(f => [f.properties.fid, f])).values()];
  const revision = file.revision || 0;
  if (!draft) return { revision, added: fc(union(file.added.features)), hidden: [...file.hidden], paths: fc(union(file.paths?.features)) };
  return { revision, added: fc(union(file.added.features, draft.added?.features)), hidden: draft.hidden || [],
    paths: fc(union(file.paths?.features, draft.paths?.features)) };
}

// A browser draft saved against an older revision of data/ has (normally) already been merged into the files:
// offer to start from the files, so fixes made while merging are not overwritten by the old draft.
function loadDrafts() {
  let dp = store.load(KEY), db = store.load(KEY_BLD);
  const dpRev = Array.isArray(dp) ? 0 : dp?.rev ?? 0;
  const dbRev = db?.revision ?? 0;
  const fileBld = getCustom().revision || 0;
  if ((dp && dpRev < PLACES_REV) || (db && dbRev < fileBld)) {
    if (confirm('The map data has been updated with your last downloaded edits.\n\n' +
        'OK: start from the updated data (recommended).\nCancel: keep the copy saved in this browser.')) {
      store.clear(KEY); store.clear(KEY_BLD);
      dp = db = null;
    }
  }
  return { draftPlaces: Array.isArray(dp) ? dp : dp?.places, draftBld: db };
}

export function startEditor() {
  const { draftPlaces, draftBld } = loadDrafts();
  places = merge(getPlaces(), draftPlaces);
  custom = mergeBuildings(getCustom(), draftBld);
  refreshPlaces(places);
  setCustomBuildings(custom);
  rebuildSnapPoints();
  document.body.classList.add('editing');
  const panel = Object.assign(document.createElement('aside'), { id: 'editor', className: 'panel editor' });
  document.body.append(panel);

  map.addSource('draw-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('hidden-outline', { type: 'geojson', data: hiddenGeoJSON() });
  addEditorLayers();
  onStyle(addEditorLayers);  // the theme toggle rebuilds the style; put our layers back

  map.on('click', e => {
    if (tool === 'place') placeAt(e);
    else if (drawing()) drawClick(e);
    else hideClick(e);
  });
  map.on('dblclick', e => { if (drawing()) { e.preventDefault(); finishDrawing(); } });
  map.on('mousemove', e => {
    if (drawing()) {
      snapped = snap(e.point);
      cursor = snapped || round(e.lngLat);
      drawPreview();
    }
    const over = tool === 'hide' && map.queryRenderedFeatures(e.point, { layers: [...PATH_LAYERS, ...BUILDING_LAYERS] }).length;
    map.getCanvas().style.cursor = tool === 'hide' ? (over ? 'pointer' : '') : (drawing() || selected) ? 'crosshair' : '';
  });
  map.getCanvas().addEventListener('mouseleave', () => { cursor = snapped = null; drawPreview(); });
  window.addEventListener('keydown', e => {
    if (!drawing() || e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'Enter') finishDrawing();
    if (e.key === 'Escape') { verts = []; drawPreview(); render(); }
    if (e.key === 'Backspace') { verts.pop(); drawPreview(); render(); }
  });
  render();
}
