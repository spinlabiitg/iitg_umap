// Seasons on campus: a month-by-month climate card (data/climate.json, built by scripts/build_climate.py), daylight
// worked out from the sun's position, and sunrise/sunset directions drawn on the map.
import { map, ui, getTheme, onStyle, closePopup, FRESH, sheet } from './app.js';

const CENTRE = [91.6935, 26.1915];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// IMD's four seasons for India
const SEASON = m => m === 12 || m <= 2 ? ['Winter', '❄️'] : m <= 5 ? ['Pre-monsoon', '🌤'] : m <= 9 ? ['Monsoon', '🌧'] : ['Post-monsoon', '🍂'];
const RAY_M = 1400;

let climate = null, green = null, showGreen = true, month = new Date().getMonth() + 1;

// ---------- the sun (NOAA solar position equations; accurate to about a minute) ----------
const rad = Math.PI / 180;
function sunOn(year, m, d, [lon, lat] = CENTRE) {
  const N = Math.round((Date.UTC(year, m - 1, d) - Date.UTC(year, 0, 0)) / 864e5);
  const g = 2 * Math.PI / 365 * (N - 1);
  const eqt = 229.18 * (.000075 + .001868 * Math.cos(g) - .032077 * Math.sin(g) - .014615 * Math.cos(2 * g) - .040849 * Math.sin(2 * g));
  const dec = .006918 - .399912 * Math.cos(g) + .070257 * Math.sin(g) - .006758 * Math.cos(2 * g) + .000907 * Math.sin(2 * g)
    - .002697 * Math.cos(3 * g) + .00148 * Math.sin(3 * g);
  const phi = lat * rad;
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(phi) * Math.cos(dec)) - Math.tan(phi) * Math.tan(dec)) / rad;
  const IST = 330;                                                      // minutes ahead of UTC
  const rise = 720 - 4 * (lon + ha) - eqt + IST, set = 720 - 4 * (lon - ha) - eqt + IST, noon = 720 - 4 * lon - eqt + IST;
  const az = Math.acos(Math.sin(dec) / Math.cos(phi)) / rad;            // compass bearing of sunrise; sunset is 360 − az
  const alt = 90 - Math.abs(lat - dec / rad);                           // height of the sun at noon
  return { rise, set, noon, day: set - rise, az, alt };
}
const fixHm = t => { const r = Math.round(t); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
const dur = t => { const r = Math.round(t); return `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, '0')} min`; };
const compass = a => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(a / 22.5) % 16];

// A point `m` metres from p along compass bearing `a`.
function along([lon, lat], a, m) {
  const dy = m * Math.cos(a * rad) / 110540, dx = m * Math.sin(a * rad) / (111320 * Math.cos(lat * rad));
  return [lon + dx, lat + dy];
}

// ---------- map: sunrise and sunset rays ----------
function sunGeo(s) {
  const ray = (a, kind, label) => [
    { type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: [CENTRE, along(CENTRE, a, RAY_M)] } },
    { type: 'Feature', properties: { kind, label }, geometry: { type: 'Point', coordinates: along(CENTRE, a, RAY_M * 1.06) } }];
  return { type: 'FeatureCollection', features: [
    ...ray(s.az, 'rise', `☀ Sunrise ${fixHm(s.rise)}`), ...ray(360 - s.az, 'set', `Sunset ${fixHm(s.set)}`)] };
}
const SUN_COLORS = { rise: '#e9a23b', set: '#e0603f' };
function addLayers() {
  const s = sunOn(2025, month, 15);
  if (!map.getSource('sun')) map.addSource('sun', { type: 'geojson', data: sunGeo(s) });
  else map.getSource('sun').setData(sunGeo(s));
  if (map.getLayer('sun-rays')) return;
  const color = ['match', ['get', 'kind'], 'rise', SUN_COLORS.rise, SUN_COLORS.set];
  map.addLayer({ id: 'sun-rays', type: 'line', source: 'sun', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round' }, paint: { 'line-color': color, 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': .9 } });
  map.addLayer({ id: 'sun-labels', type: 'symbol', source: 'sun', filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 13, 'text-allow-overlap': true },
    paint: { 'text-color': color, 'text-halo-color': getTheme() === 'dark' ? '#0f1a1f' : '#fffaf0', 'text-halo-width': 2 } });
}
function removeLayers() {
  for (const id of ['sun-labels', 'sun-rays', 'greenness']) if (map.getLayer(id)) map.removeLayer(id);
}

// ---------- greenness: Sentinel-2 NDVI for the month, as an image over the map window ----------
const ndviUrl = m => `data/greenness/ndvi_${String(m).padStart(2, '0')}.png`;
let shownUrl = null;
function showNdvi(m) {                                       // swap the image only when the month really changed
  const url = ndviUrl(m), src = map.getSource('greenness');
  if (src && url !== shownUrl) { shownUrl = url; src.updateImage({ url }); }
}
function addGreenLayer() {
  if (!showGreen || map.getLayer('greenness')) return;
  const [w, s, e, n] = green.region;
  if (!map.getSource('greenness')) {
    shownUrl = ndviUrl(month);
    map.addSource('greenness', { type: 'image', url: shownUrl, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
  } else showNdvi(month);
  // above the outside fade (most of the green lies beyond the campus), below paths, roads, labels and buildings
  map.addLayer({ id: 'greenness', type: 'raster', source: 'greenness',
    paint: { 'raster-opacity': .78, 'raster-fade-duration': 250, 'raster-resampling': 'linear' } },
    map.getLayer('paths') ? 'paths' : undefined);
}
function setGreen(on) {
  showGreen = on;
  if (on) addGreenLayer(); else if (map.getLayer('greenness')) map.removeLayer('greenness');
  render();
}

// ---------- the year strip: twelve columns, one per month, that also pick the month ----------
// Rows: rain (bars), afternoon temperature (colour), greenness on campus (colour). The chosen month is outlined.
function tempColor(t) {                                    // 20 °C cool blue → 32 °C warm red
  const k = Math.max(0, Math.min(1, (t - 20) / 12));
  const stops = [[74, 159, 184], [233, 196, 106], [231, 111, 81]];
  const [a, b, f] = k < .5 ? [stops[0], stops[1], k * 2] : [stops[1], stops[2], k * 2 - 1];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`;
}
const RAMP = [[.05, [166, 124, 82]], [.25, [222, 200, 120]], [.45, [128, 178, 84]], [.65, [52, 128, 60]], [.85, [20, 82, 40]]];
function ndviColor(v) {                                    // same ramp as the map overlay (scripts/build_greenness.py)
  const j = Math.max(0, RAMP.findIndex(([x]) => v < x) - 1);
  const [x0, c0] = RAMP[j], [x1, c1] = RAMP[Math.min(j + 1, RAMP.length - 1)];
  const f = Math.max(0, Math.min(1, (v - x0) / ((x1 - x0) || 1)));
  return `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * f)).join(',')})`;
}
function yearStrip() {
  const W = 296, L = 22, cw = (W - L) / 12, ms = climate.months, gs = green?.months;
  const maxRain = Math.max(...ms.map(x => x.rain_mm));
  const rows = gs ? [['🌧', 30], ['🌡', 50], ['🌿', 64]] : [['🌧', 30], ['🌡', 50]];
  const H = gs ? 76 : 62;
  const cols = ms.map((x, i) => {
    const X = L + i * cw, on = x.month === month, bh = Math.max(1.5, 28 * x.rain_mm / maxRain);
    return `<g data-month="${x.month}" class="ys${on ? ' on' : ''}">
      <title>${MONTHS[i]}: ${x.rain_mm} mm rain, ${Math.round(x.tmax)}° afternoons${gs ? `, greenness ${gs[i].campus.toFixed(2)}` : ''}</title>
      <rect class="hit" x="${X.toFixed(1)}" y="0" width="${cw.toFixed(1)}" height="${H}" rx="5"/>
      <text x="${(X + cw / 2).toFixed(1)}" y="10">${MONTHS[i][0]}</text>
      <rect class="rain" x="${(X + 3).toFixed(1)}" y="${(44 - bh).toFixed(1)}" width="${(cw - 6).toFixed(1)}" height="${bh.toFixed(1)}" rx="2"/>
      <rect x="${(X + 1.5).toFixed(1)}" y="47" width="${(cw - 3).toFixed(1)}" height="10" rx="2" fill="${tempColor(x.tmax)}"/>
      ${gs ? `<rect x="${(X + 1.5).toFixed(1)}" y="61" width="${(cw - 3).toFixed(1)}" height="10" rx="2" fill="${ndviColor(gs[i].campus)}"/>` : ''}
    </g>`;
  }).join('');
  return `<svg class="year-strip" viewBox="0 0 ${W} ${H}" role="group" aria-label="The year at a glance; pick a month">
    ${rows.map(([ic, y]) => `<text class="ico" x="10" y="${y + 4}">${ic}</text>`).join('')}${cols}</svg>`;
}

// ---------- the sun arc: the horizon is a 24-hour line; the arc spans sunrise to sunset, as high as the noon sun ----------
function sunArc(s) {
  const W = 120, base = 44, X = t => 8 + t / 1440 * (W - 16);
  const x0 = X(s.rise), x1 = X(s.set), xm = X(s.noon), h = 6 + 30 * s.alt / 90;
  const mid = (x0 + x1) / 2;
  return `<svg class="sun-arc" viewBox="0 0 ${W} 64" role="img"
      aria-label="Sunrise ${fixHm(s.rise)}, sunset ${fixHm(s.set)}, ${dur(s.day)} of daylight, sun ${Math.round(s.alt)} degrees high at noon">
    <title>Rises in the ${compass(s.az)}, sets in the ${compass(360 - s.az)} (rays on the map); ${Math.round(s.alt)}° high at noon (${fixHm(s.noon)})</title>
    <rect x="8" y="${base}" width="${W - 16}" height="3" rx="1.5" class="night"/>
    <rect x="${x0.toFixed(1)}" y="${base}" width="${(x1 - x0).toFixed(1)}" height="3" rx="1.5" class="day"/>
    <path d="M${x0.toFixed(1)} ${base}Q${mid.toFixed(1)} ${(base - 2 * h).toFixed(1)} ${x1.toFixed(1)} ${base}" class="arc"/>
    <circle cx="${xm.toFixed(1)}" cy="${(base - h).toFixed(1)}" r="5" class="sun"/>
    <text x="${x0.toFixed(1)}" y="58" text-anchor="middle">${fixHm(s.rise)}</text>
    <text x="${x1.toFixed(1)}" y="58" text-anchor="middle">${fixHm(s.set)}</text>
  </svg>`;
}

// ---------- tips, read straight off the numbers (the two that matter most) ----------
function tips(x, s) {
  const t = [];
  if (x.rain_days >= 12) t.push(`☔ Rain on ~${Math.round(x.rain_days)} days: carry an umbrella`);
  else if (x.rain_days >= 6) t.push(`🌦 Thunderstorms on ~${Math.round(x.rain_days)} days`);
  if (x.feels >= 36) t.push(`🥵 Feels like ${Math.round(x.feels)}°: walk early or late`);
  if (x.tmin <= 15) t.push(`🧥 Cool nights (~${Math.round(x.tmin)}°): bring a jacket`);
  if (x.rain_mm < 30 && x.feels < 30) t.push('🌄 Dry and pleasant: climb View Point');
  if (s.rise < 300) t.push('🌅 Sun up before 5 am');
  if (s.set < 1020) t.push(`🌇 Dark by ${fixHm(s.set + 25)}: lights on rides`);
  return t.slice(0, 2);
}

// ---------- panel ----------
function render() {
  const el = document.getElementById('seasons-panel');
  const x = climate.months[month - 1], s = sunOn(2025, month, 15), [sname, sicon] = SEASON(month);
  const g = green?.months[month - 1];
  const gNote = g && (() => {
    const ms = green.months, top = ms.reduce((a, b) => b.campus > a.campus ? b : a), low = ms.reduce((a, b) => b.campus < a.campus ? b : a);
    return g === top ? 'greenest' : g === low ? 'least green' : `${Math.round(100 * g.campus / top.campus)}% of ${MONTHS[top.month - 1].slice(0, 3)}`;
  })();
  el.innerHTML = `
    <div class="walk-head">
      <h2>Seasons on campus</h2>
      ${yearStrip()}
    </div>
    <div class="walk-body">
      <div class="mcard">
        <div class="mtitle"><span class="sico">${sicon}</span><div><b>${MONTHS[month - 1]}</b><small>${sname} · ${dur(s.day).replace(' min', ' m')} of daylight</small></div>${sunArc(s)}</div>
        <div class="mstats">
          <div><b>${Math.round(x.tmax)}°<em>/${Math.round(x.tmin)}°</em></b><small>day / night</small></div>
          <div><b>${x.rain_mm}<em>mm</em></b><small>${Math.round(x.rain_days)} rainy day${Math.round(x.rain_days) === 1 ? '' : 's'}</small></div>
          <div><b>${x.humidity}<em>%</em></b><small>humidity</small></div>
          ${g ? `<div><b>${g.campus.toFixed(2)}</b><small>green · ${gNote}</small></div>` : ''}
        </div>
        <div class="mtips">${tips(x, s).map(t => `<span>${t}</span>`).join('')}</div>
      </div>
      <div class="sfoot">
        ${green ? `<button data-green aria-pressed="${showGreen}" title="Greenness overlay on the map">🌿 Greenness on map</button>` : ''}
        <details><summary>ⓘ Sources</summary><p>Typical month, not a forecast: averages for the Guwahati area. Rain: CHIRPS (totals ${climate.rain_years.join('–')};
          rainy days ${climate.rain_day_years.join('–')}, 2.5 mm or more). Temperature and humidity: ERA5 reanalysis (${climate.years.join('–')}) via Open-Meteo
          (contains modified Copernicus Climate Change Service information); ERA5 runs about 2 °C warm on winter nights. Sun times worked out
          for IST at the campus centre (mid-month). "Campus" figures use the campus area as mapped on OpenStreetMap: approximate,
          not an official boundary.${green ? ` Greenness: Sentinel-2 vegetation index (NDVI) ${green.years.join('–')}, the 75th percentile
          of each month's cloud-free views, so hazy winter days don't drag it down; lakes left out (contains modified Copernicus Sentinel data
          ${green.years.join('–')}; via Microsoft Planetary Computer).` : ''}</p></details>
      </div>
    </div>`;
  el.querySelector('[data-green]')?.addEventListener('click', () => setGreen(!showGreen));
  el.querySelectorAll('[data-month]').forEach(c => c.onclick = () => setMonth(+c.dataset.month));
}

function setMonth(m) {
  month = m;
  render();
  if (map.getSource('sun')) map.getSource('sun').setData(sunGeo(sunOn(2025, month, 15)));
  showNdvi(month);
}

// ---------- mode switch ----------
async function setMode(on) {
  if (on && ui.mode === 'walk') document.getElementById('toggle-walk').click();
  ui.mode = on ? 'seasons' : 'explore';
  document.getElementById('toggle-seasons').setAttribute('aria-pressed', on);
  document.body.classList.toggle('seasons', on);
  document.getElementById('seasons-panel').hidden = !on;
  if (!on) { removeLayers(); return; }
  closePopup();
  [climate, green] = await Promise.all([climate || fetch('data/climate.json', FRESH).then(r => r.json()),
    green || fetch('data/greenness/greenness.json', FRESH).then(r => r.ok ? r.json() : null).catch(() => null)]);
  addLayers();
  if (green) addGreenLayer();
  render();
  map.easeTo({ center: CENTRE, zoom: Math.min(map.getZoom(), 14.6), pitch: 0, bearing: 0, duration: 900 });
}
export const seasonsOff = () => { if (ui.mode === 'seasons') setMode(false); };

export function initSeasons() {
  const panel = Object.assign(document.createElement('aside'), { id: 'seasons-panel', className: 'panel walk seasons-panel', hidden: true });
  document.body.append(panel);
  sheet(panel);
  document.getElementById('toggle-seasons').onclick = () => setMode(ui.mode !== 'seasons');
  onStyle(() => { if (ui.mode === 'seasons') { removeLayers(); addLayers(); if (green) addGreenLayer(); render(); } });
  const q = new URLSearchParams(location.search);
  if (q.has('seasons')) { const m = +q.get('seasons'); if (m >= 1 && m <= 12) month = m; setMode(true); }
}
