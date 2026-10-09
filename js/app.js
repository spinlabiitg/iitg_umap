// IITG Campus uMap (u = unofficial). Renders OSM + footprint layers in a custom style, overlays curated places,
// and (with ?edit in the URL) offers a click-to-tag tool for placing places on the map.
import { startEditor } from './editor.js';
import { initWalk } from './walk.js';
import { initPulse } from './pulse.js';
import { initSearch } from './search.js';
import { initSeasons } from './seasons.js';
import { CATEGORIES, BASE, catColor as catColorFor, tierOf, labelOf, replacedKeys, pointInRing } from './config.js';

const DATA = 'data/osm/';
const layerNames = ['boundary', 'buildings', 'buildings_ml', 'roads', 'paths', 'water', 'green', 'sports', 'pois'];
const EDIT = new URLSearchParams(location.search).has('edit');
// Revalidate data files on each load so edits to data/ show up without a hard refresh.
export const FRESH = { cache: 'no-cache' };
export const BUILDING_LAYERS = ['bld', 'bld-ml', 'bld-custom'];
export const PATH_LAYERS = ['custom-paths', 'custom-roads'];
const ROAD_TYPES = ['road', 'service'];

export { CATEGORIES };

let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
export const getTheme = () => theme;
export const ui = { mode: 'explore' };  // 'explore' | 'walk'
const styleHooks = [];
export const onStyle = fn => styleHooks.push(fn);

// Side panels (walk, seasons) become bottom sheets on phones: tapping the title folds the sheet down to its header,
// and --sheet-h follows the sheet's height so the toolbar and credits stay just above it (see style.css).
const PHONE = matchMedia('(max-width: 640px)');
export function sheet(panel) {
  panel.addEventListener('click', e => { if (PHONE.matches && e.target.closest('h2')) panel.classList.toggle('collapsed'); });
  new ResizeObserver(() => {
    const h = panel.getBoundingClientRect().height;
    if (h) document.documentElement.style.setProperty('--sheet-h', `${Math.round(h)}px`);
    // centre the map in the part the sheet leaves visible (header strip on top, sheet + toolbar below)
    const open = Math.max(0, ...[...document.querySelectorAll('.walk')].map(p => p.getBoundingClientRect().height));
    if (PHONE.matches) map.setPadding(open ? { top: 70, bottom: open + 50, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 });
  }).observe(panel);
}
const C = () => BASE[theme];
const catColor = cat => catColorFor(cat, theme);

export const loaded = Object.fromEntries(await Promise.all(layerNames.map(async n =>
  [n, await fetch(DATA + n + '.geojson', FRESH).then(r => r.json())])));
for (const f of loaded.buildings.features) f.properties.fid = f.properties.key = f.properties.osm_id;
// OSM outlines that were swapped for finer Microsoft footprints (see scripts/fetch_footprints.py).
const replaced = replacedKeys(loaded.buildings_ml);
const placesFile = await fetch('data/places.json', FRESH).then(r => r.json());
let places = placesFile.places;
// Bumped each time browser edits are merged into data/, so the editor can tell a stale draft (see editor.js).
export const PLACES_REV = placesFile.revision || 0;
// Hand-drawn buildings, hidden (wrong) footprints and hand-drawn paths/roads, made in the editor.
const FC = () => ({ type: 'FeatureCollection', features: [] });
const EMPTY = () => ({ added: FC(), hidden: [], paths: FC() });
let custom = await fetch('data/custom_buildings.json', FRESH).then(r => r.ok ? r.json() : EMPTY()).catch(EMPTY);
custom.paths ||= FC();

const ring = loaded.boundary.features[0].geometry.coordinates[0];
const insideCampus = pt => pointInRing(pt, ring);
// Campus lakes are named by places.json (editable); OSM water names are only shown outside campus (the Brahmaputra).
for (const f of loaded.water.features) {
  const g = f.geometry, pt = g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[0]
    : g.type === 'Polygon' ? g.coordinates[0][0] : g.coordinates[0][0][0];
  f.properties.on_campus = insideCampus(pt);
}
const mask = { type: 'Feature', geometry: { type: 'Polygon',
  coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ring] } };

const TIER_ZOOM = [0, 15.8, 16.9];

// Elevation (Copernicus GLO-30, built by scripts/build_terrain.py): contours, summits and local terrain tiles.
// REGION also limits panning, so the map never shows ground without elevation data.
const terrainMeta = await fetch('data/terrain/meta.json', FRESH).then(r => r.json());
const [contours, peaks] = await Promise.all(['contours', 'peaks'].map(n => fetch(`data/terrain/${n}.geojson`, FRESH).then(r => r.json())));
const DEM_SOURCE = { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, minzoom: terrainMeta.zooms[0], maxzoom: terrainMeta.zooms[1],
  bounds: terrainMeta.region, tiles: [new URL('data/terrain/tiles/{z}/{x}/{y}.png', location.href).href.replace('%7Bz%7D', '{z}').replace('%7Bx%7D', '{x}').replace('%7By%7D', '{y}')] };

export const map = new maplibregl.Map({
  container: 'map',
  center: [91.6935, 26.1915], zoom: 15.2, pitch: 45, bearing: -12, maxPitch: 70,
  maxBounds: [[terrainMeta.region[0], terrainMeta.region[1]], [terrainMeta.region[2], terrainMeta.region[3]]],
  style: {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      sat: { type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
      mask: { type: 'geojson', data: mask },
      // two sources on the same tiles: MapLibre advises separate ones for hillshade and 3D terrain
      dem: DEM_SOURCE,
      'dem-terrain': { ...DEM_SOURCE },
      contours: { type: 'geojson', data: contours },
      peaks: { type: 'geojson', data: peaks },
      places: { type: 'geojson', data: placesGeoJSON() },
      buildings_custom: { type: 'geojson', data: custom.added },
      paths_custom: { type: 'geojson', data: custom.paths },
      ...Object.fromEntries(layerNames.map(n => [n, { type: 'geojson', data: loaded[n] }])),
    },
    layers: [],
  },
});
window.map = map;
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

function placesGeoJSON() {
  return { type: 'FeatureCollection', features: places.filter(p => p.lnglat).map(p => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: p.lnglat },
    properties: { id: p.id, name: p.name, label: labelOf(p), category: p.category, tier: tierOf(p) },
  })) };
}

// Colour each footprint by the category of the place linked to it.
function buildingColor() {
  // First place wins if two places share a building (match labels must be unique).
  const byKey = new Map();
  for (const p of places) if (p.feature && !byKey.has(p.feature)) byKey.set(p.feature, catColor(p.category));
  const pairs = [...byKey].flat();
  // A place can point at one footprint (fid) or at a whole group such as a hostel (key).
  return pairs.length ? ['match', ['get', 'fid'], ...pairs, ['match', ['get', 'key'], ...pairs, C().building]] : C().building;
}

const notHidden = () => ['!', ['in', ['get', 'fid'], ['literal', custom.hidden]]];
const bldFilter = () => ['all', ['!', ['in', ['get', 'key'], ['literal', replaced]]], notHidden()];
export const getCustom = () => custom;
export function setCustomBuildings(next) {
  custom = next;
  custom.paths ||= FC();
  map.getSource('buildings_custom').setData(custom.added);
  map.getSource('paths_custom').setData(custom.paths);
  map.setFilter('bld', bldFilter());
  map.setFilter('bld-ml', notHidden());
}

// Dots and labels, one layer per tier: a layer's minzoom is exact (filters only see whole zoom levels), and
// layers later in the list win label collisions, so the most important names are placed first.
export const PLACE_DOT_LAYERS = ['place-dots-2', 'place-dots-1', 'place-dots-0'];
function placeLayers(c) {
  const color = ['match', ['get', 'category'], ...Object.keys(CATEGORIES).flatMap(k => [k, catColor(k)]), c.building];
  const font = ['Open Sans Bold', 'Open Sans Semibold', 'Open Sans Regular'];
  const size = [[14, 11, 18, 15], [15, 10.5, 18, 13], [16, 10, 18, 12]];
  const out = [];
  for (const t of [2, 1, 0]) out.push({ id: `place-dots-${t}`, type: 'circle', source: 'places', minzoom: Math.max(TIER_ZOOM[t] - .6, 0),
    filter: ['all', catFilter(), ['==', ['get', 'tier'], t]],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, t ? 2.5 : 3.5, 18, t ? 6 : 8], 'circle-color': color,
      'circle-stroke-color': c.halo, 'circle-stroke-width': t ? 1.4 : 2 } });
  for (const t of [2, 1, 0]) {
    const [z0, s0, z1, s1] = size[t];
    out.push({ id: `place-labels-${t}`, type: 'symbol', source: 'places', minzoom: TIER_ZOOM[t],
      filter: ['all', catFilter(), ['==', ['get', 'tier'], t]],
      layout: { 'text-field': ['get', 'label'], 'text-font': [font[t]],
        'text-size': ['interpolate', ['linear'], ['zoom'], z0, s0, z1, s1], 'text-max-width': t ? 8 : 9,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': t ? .6 : .8, 'text-padding': 3 },
      paint: { 'text-color': t === 2 ? c.labelSoft : c.label, 'text-halo-color': c.halo, 'text-halo-width': t ? 1.4 : 1.8 } });
  }
  return out;
}

// Road widths by class: through roads widest, campus streets normal, service lanes narrow.
const isLine = ['==', ['geometry-type'], 'LineString'];
const ROAD_SCALE = ['match', ['get', 'highway'], ['trunk', 'trunk_link', 'primary', 'secondary'], 1.7,
  ['tertiary', 'unclassified'], 1.25, 'service', .7, 1];
const roadWidth = (w14, w18) => ['interpolate', ['exponential', 1.5], ['zoom'], 14, ['*', w14, ROAD_SCALE], 18, ['*', w18, ROAD_SCALE]];

function buildLayers() {
  const c = C();
  const height = ['coalesce', ['get', 'height'],
    ['*', ['to-number', ['coalesce', ['get', 'building:levels'], 3]], 3.5]];
  return [
    { id: 'bg', type: 'background', paint: { 'background-color': c.outside } },
    { id: 'campus', type: 'fill', source: 'boundary', paint: { 'fill-color': c.campus } },
    { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
    { id: 'green', type: 'fill', source: 'green', paint: { 'fill-color': c.green, 'fill-opacity': .9 } },
    { id: 'sports', type: 'fill', source: 'sports', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': c.sports, 'fill-outline-color': c.waterLine } },
    { id: 'water', type: 'fill', source: 'water', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': c.water } },
    { id: 'water-line', type: 'line', source: 'water', paint: { 'line-color': c.waterLine, 'line-width': 1.2 } },
    { id: 'hills', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-exaggeration': .45, 'hillshade-shadow-color': c.hillShadow, 'hillshade-highlight-color': c.hillLight,
        'hillshade-accent-color': c.hillShadow, 'hillshade-illumination-direction': 315 } },
    { id: 'contours', type: 'line', source: 'contours', minzoom: 13,
      paint: { 'line-color': c.contour, 'line-opacity': ['case', ['get', 'idx'], .75, .45],
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, ['case', ['get', 'idx'], 1, .5], 18, ['case', ['get', 'idx'], 1.8, 1]] } },
    { id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': c.outside, 'fill-opacity': .72 } },
    // no outline is drawn: the campus shape (OpenStreetMap, approximate) only sets the soft tint and the fade outside
    { id: 'paths', type: 'line', source: 'paths',
      paint: { 'line-color': c.path, 'line-width': 1.2, 'line-dasharray': [1, 1.5] } },
    { id: 'roads-case', type: 'line', source: 'roads', filter: isLine, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.roadCase, 'line-width': roadWidth(2.5, 14) } },
    { id: 'roads', type: 'line', source: 'roads', filter: isLine, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.road, 'line-width': roadWidth(1.5, 11) } },
    { id: 'custom-paths', type: 'line', source: 'paths_custom', filter: ['!', ['in', ['get', 'highway'], ['literal', ROAD_TYPES]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.path, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.2, 18, 3],
        'line-dasharray': [1, 1.5] } },
    { id: 'custom-roads-case', type: 'line', source: 'paths_custom', filter: ['in', ['get', 'highway'], ['literal', ROAD_TYPES]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.roadCase, 'line-width': roadWidth(2.5, 14) } },
    { id: 'custom-roads', type: 'line', source: 'paths_custom', filter: ['in', ['get', 'highway'], ['literal', ROAD_TYPES]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.road, 'line-width': roadWidth(1.5, 11) } },
    { id: 'custom-path-labels', type: 'symbol', source: 'paths_custom', filter: ['has', 'name'], minzoom: 15.5,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Open Sans Italic'], 'text-size': 11 },
      paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.4 } },
    { id: 'contour-labels', type: 'symbol', source: 'contours', minzoom: 15, filter: ['get', 'idx'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-field': ['concat', ['to-string', ['get', 'elev']], ' m'],
        'text-font': ['Open Sans Regular'], 'text-size': 10, 'text-keep-upright': true },
      paint: { 'text-color': c.contourText, 'text-halo-color': c.halo, 'text-halo-width': 1.4 } },
    { id: 'peaks', type: 'circle', source: 'peaks', minzoom: 13,
      paint: { 'circle-radius': 3, 'circle-color': c.contourText, 'circle-stroke-color': c.halo, 'circle-stroke-width': 1.2 } },
    { id: 'peak-labels', type: 'symbol', source: 'peaks', minzoom: 13,
      layout: { 'text-field': ['concat', ['to-string', ['get', 'elev']], ' m'], 'text-font': ['Open Sans Semibold'], 'text-size': 11,
        'text-offset': [0, -1.1], 'text-allow-overlap': false },
      paint: { 'text-color': c.contourText, 'text-halo-color': c.halo, 'text-halo-width': 1.6 } },
    { id: 'bld-ml', type: 'fill-extrusion', source: 'buildings_ml', filter: notHidden(),
      paint: { 'fill-extrusion-color': buildingColor(), 'fill-extrusion-opacity': .92,
        'fill-extrusion-height': ['coalesce', ['get', 'height'], 8] } },
    { id: 'bld', type: 'fill-extrusion', source: 'buildings', filter: bldFilter(),
      paint: { 'fill-extrusion-color': buildingColor(), 'fill-extrusion-opacity': .95, 'fill-extrusion-height': height } },
    { id: 'bld-custom', type: 'fill-extrusion', source: 'buildings_custom',
      paint: { 'fill-extrusion-color': buildingColor(), 'fill-extrusion-opacity': .95,
        'fill-extrusion-height': ['coalesce', ['get', 'height'], 10] } },
    { id: 'water-labels', type: 'symbol', source: 'water', filter: ['all', ['has', 'name'], ['!', ['get', 'on_campus']]], minzoom: 14.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Italic'], 'text-size': 12 },
      paint: { 'text-color': c.waterLine, 'text-halo-color': c.halo, 'text-halo-width': 1.2 } },
    { id: 'place-selected', type: 'circle', source: 'places', filter: ['==', ['get', 'id'], selectedId || ''],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 15], 'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': c.edge, 'circle-stroke-width': 3, 'circle-stroke-opacity': .9 } },
    ...placeLayers(c),
  ];
}

// Legend entries double as category filters.
const hiddenCats = new Set();
const catFilter = () => ['!', ['in', ['get', 'category'], ['literal', [...hiddenCats]]]];
function setCategoryShown(cat, shown) {
  if (shown) hiddenCats.delete(cat); else hiddenCats.add(cat);
  for (const t of [0, 1, 2]) for (const kind of ['dots', 'labels'])
    map.setFilter(`place-${kind}-${t}`, ['all', catFilter(), ['==', ['get', 'tier'], t]]);
  renderLegend();
}
function renderLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = Object.entries(CATEGORIES).map(([k, v]) =>
    `<button type="button" data-cat="${k}" aria-pressed="${!hiddenCats.has(k)}"><i style="background:${v[theme]}"></i>${v.label}</button>`).join('') +
    (hiddenCats.size ? '<button type="button" class="legend-all" data-cat="*">Show all</button>' : '');
  el.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => {
    if (b.dataset.cat === '*') { hiddenCats.clear(); setCategoryShown('', true); return; }
    setCategoryShown(b.dataset.cat, hiddenCats.has(b.dataset.cat));
  });
}

export function refreshPlaces(next) {
  if (next) places = next.filter(p => !p.deleted);   // the editor keeps deleted places as markers
  map.getSource('places').setData(placesGeoJSON());
  for (const id of BUILDING_LAYERS) map.setPaintProperty(id, 'fill-extrusion-color', buildingColor());
}
export const getPlaces = () => places;

function applyStyle() {
  for (const l of map.getStyle().layers) map.removeLayer(l.id);
  for (const l of buildLayers()) map.addLayer(l);
  // Soft light from the north-west so 3D buildings read as volumes.
  map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: theme === 'dark' ? .25 : .38, position: [1.2, 315, 40] });
  document.documentElement.dataset.theme = theme;
  document.getElementById('toggle-theme').textContent = theme === 'dark' ? '☀' : '☾';
  renderLegend();
  for (const fn of styleHooks) fn(theme);
}

map.on('load', () => {
  applyStyle();
  const b = ring.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(ring[0], ring[0]));
  map.fitBounds(b, { padding: 40, pitch: 45, bearing: -12, duration: 0 });
  if (EDIT) { startEditor(); return; }
  initWalk();
  initPulse();
  initSearch();
  initSeasons();
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
});

// Place cards
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const popup = new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: '300px' });
export const closePopup = () => popup.remove();
export function placeCard(p) {
  const facts = [p.established && `Since ${p.established}`, p.residents, p.capacity && `${p.capacity} residents`, p.hours]
    .filter(Boolean).map(esc).join(' · ');
  return `<div class="card"><span class="tag" style="background:${catColor(p.category)}">${esc(CATEGORIES[p.category]?.label || p.category)}</span>
    <b>${esc(p.name)}</b>${p.description ? `<p>${esc(p.description)}</p>` : ''}
    ${facts ? `<small>${facts}</small>` : ''}
    <div class="card-actions">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
      <a href="https://www.google.com/maps/dir/?api=1&amp;destination=${p.lnglat[1]},${p.lnglat[0]}" target="_blank" rel="noopener">Directions ↗</a>
      <button type="button" class="linkbtn" data-copy="${esc(p.id)}">🔗 Copy link</button></div></div>`;
}

// Shareable links: #place=<id> opens that place's card; opening a card updates the address bar.
const placeLink = id => `${location.origin}${location.pathname}#place=${encodeURIComponent(id)}`;
let selectedId = null;
const select = id => { selectedId = id; if (map.getLayer('place-selected')) map.setFilter('place-selected', ['==', ['get', 'id'], id || '']); };
function showCard(p, at) {
  popup.setLngLat(at || p.lnglat).setHTML(placeCard(p)).addTo(map);
  select(p.id);
  history.replaceState(null, '', `#place=${encodeURIComponent(p.id)}`);
}
popup.on('close', () => {
  select(null); if (location.hash.startsWith('#place=')) history.replaceState(null, '', location.pathname + location.search); });
export function openPlace(id, { fly = true } = {}) {
  const p = places.find(x => x.id === id);
  if (!p || !p.lnglat) return false;
  if (hiddenCats.has(p.category)) setCategoryShown(p.category, true);
  if (fly) map.flyTo({ center: p.lnglat, zoom: Math.max(map.getZoom(), 17), duration: 1000, essential: true });
  showCard(p);
  return true;
}
function openFromHash() {
  const m = location.hash.match(/^#place=(.+)$/);
  if (m && ui.mode === 'explore') openPlace(decodeURIComponent(m[1]));
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const url = placeLink(b.dataset.copy);
  try { await navigator.clipboard.writeText(url); b.textContent = '✓ Link copied'; }
  catch { prompt('Copy this link:', url); }
});
if (!EDIT) {
  map.on('click', PLACE_DOT_LAYERS, e => {
    if (ui.mode !== 'explore') return;
    showCard(places.find(x => x.id === e.features[0].properties.id));
  });
  const onBuilding = e => {
    if (ui.mode !== 'explore') return;
    if (map.queryRenderedFeatures(e.point, { layers: PLACE_DOT_LAYERS }).length) return;
    const { key, fid } = e.features[0].properties;
    const p = places.find(x => x.feature === fid) || places.find(x => x.feature === key);
    if (p) showCard(p, e.lngLat);
    else popup.setLngLat(e.lngLat).setHTML(`<b>${esc(e.features[0].properties.name || 'Building')}</b>`).addTo(map);
  };
  for (const id of BUILDING_LAYERS) map.on('click', id, onBuilding);
  for (const id of [...PLACE_DOT_LAYERS, ...BUILDING_LAYERS]) {
    map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', id, () => map.getCanvas().style.cursor = '');
  }
}

// On phones the credits footer is clamped to two lines; tap it to read everything.
document.querySelector('.attrib').addEventListener('click', e => {
  if (e.target.closest('a') || !matchMedia('(max-width: 640px)').matches) return;
  e.currentTarget.classList.toggle('open');
});

// Toolbar
const btn3d = document.getElementById('toggle-3d');
btn3d.onclick = () => {
  const on = btn3d.getAttribute('aria-pressed') !== 'true';
  btn3d.setAttribute('aria-pressed', on);
  map.easeTo({ pitch: on ? 45 : 0, bearing: on ? -12 : 0, duration: 900 });
};
// 3D terrain: the ground rises with the hills; exaggerated, since the campus relief is only ~60 m over 2 km.
const TERRAIN_EXAGGERATION = 2.5;
const btnTerrain = document.getElementById('toggle-terrain');
btnTerrain.onclick = () => {
  const on = btnTerrain.getAttribute('aria-pressed') !== 'true';
  btnTerrain.setAttribute('aria-pressed', on);
  map.setTerrain(on ? { source: 'dem-terrain', exaggeration: TERRAIN_EXAGGERATION } : null);
  if (on && map.getPitch() < 50) { map.easeTo({ pitch: 60, duration: 900 }); btn3d.setAttribute('aria-pressed', true); }
};
onStyle(() => { if (btnTerrain.getAttribute('aria-pressed') === 'true') map.setTerrain({ source: 'dem-terrain', exaggeration: TERRAIN_EXAGGERATION }); });
const btnSat = document.getElementById('toggle-sat');
// Esri World Imagery must be credited wherever it is visible, and the footer is hidden in some modes, so a credit
// line sits on the map itself while Satellite is on.
const satCredit = Object.assign(document.createElement('div'), { className: 'sat-credit', hidden: true,
  innerHTML: 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community' });
document.body.append(satCredit);
const attribEl = document.querySelector('.attrib');
new ResizeObserver(() => {                                    // sit just above the footer, whatever its height
  const h = attribEl.getBoundingClientRect().height;
  satCredit.style.bottom = h ? `${Math.round(h) + 8}px` : '';
}).observe(attribEl);
const setSat = on => {
  btnSat.setAttribute('aria-pressed', on);
  satCredit.hidden = !on;
  map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none');
  for (const id of ['campus', 'green', 'sports', 'water', 'hills']) map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
};
btnSat.onclick = () => setSat(btnSat.getAttribute('aria-pressed') !== 'true');
document.getElementById('toggle-theme').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  const sat = btnSat.getAttribute('aria-pressed') === 'true';
  applyStyle();
  setSat(sat);
};
