// The walkable network: OSM roads and paths (data/network.json, built by scripts/build_network.py) plus the paths
// drawn in the editor. Loaded once and shared by the walking-times mode (walk.js) and Pulse of campus (pulse.js).
import { getCustom, FRESH } from './app.js';

export const G = { nodes: null, edges: null, adjStart: null, adjTo: null, adjLen: null, inMain: null, edgesGeo: null, elev: null };
let ready = null;
export const loadGraph = () => ready ||= loadNetwork();

async function loadNetwork() {
  const net = await fetch('data/network.json', FRESH).then(r => r.json());
  addCustomPaths(net, getCustom().paths.features);
  const n = net.nodes.length, deg = new Uint32Array(n + 1);
  for (const [a, b] of net.edges) { deg[a + 1]++; deg[b + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adjStart = deg.slice(), adjTo = new Uint32Array(deg[n]), adjLen = new Float32Array(deg[n]);
  const fill = deg.slice(0, n);
  for (const [a, b, m] of net.edges) {
    adjTo[fill[a]] = b; adjLen[fill[a]++] = m;
    adjTo[fill[b]] = a; adjLen[fill[b]++] = m;
  }
  // Node 0 is on the OSM network, which build_network.py keeps as one connected piece.
  const inMain = new Uint8Array(n);
  const stack = [0];
  inMain[0] = 1;
  while (stack.length) {
    const u = stack.pop();
    for (let k = adjStart[u]; k < adjStart[u + 1]; k++) if (!inMain[adjTo[k]]) { inMain[adjTo[k]] = 1; stack.push(adjTo[k]); }
  }
  const edgesGeo = { type: 'FeatureCollection', features: net.edges.map(([a, b, m], i) => ({
    type: 'Feature', id: i, properties: { a, b, m, t: 999 },
    geometry: { type: 'LineString', coordinates: [net.nodes[a], net.nodes[b]] } })) };
  let elev;
  try { elev = smoothAlong(await nodeHeights(net.nodes), adjStart, adjTo, adjLen); }
  catch (e) { console.warn('no heights, hills ignored', e); elev = new Float32Array(n).fill(NaN); }
  Object.assign(G, { nodes: net.nodes, edges: net.edges, adjStart, adjTo, adjLen, inMain, edgesGeo, elev });
  return G;
}

export function metres(p, q) {
  const lat = (p[1] + q[1]) / 2 * Math.PI / 180;
  const dx = (q[0] - p[0]) * Math.PI / 180 * Math.cos(lat) * 6371000;
  const dy = (q[1] - p[1]) * Math.PI / 180 * 6371000;
  return Math.hypot(dx, dy);
}

// Nearest node of the main network (drawn paths that touch nothing else are skipped, so times stay finite).
export function snap(lnglat) {
  let best = 0, bd = Infinity;
  G.nodes.forEach((p, i) => { if (!G.inMain[i]) return; const d = metres(lnglat, p); if (d < bd) { bd = d; best = i; } });
  return { node: best, offset: bd };
}

// Paths and roads drawn in the editor join the graph. Vertices snapped onto existing points share their
// coordinates exactly. A loose end (a line end touching nothing) within JOIN_M of another line is joined to the
// nearest point on it, splitting that segment, so T-junctions drawn mid-road work too.
const JOIN_M = 20;
function addCustomPaths(g, lines) {
  const index = new Map(g.nodes.map((p, i) => [p.join(), i]));
  const nodeOf = p => {
    const k = p.join();
    if (!index.has(k)) { index.set(k, g.nodes.length); g.nodes.push(p); }
    return index.get(k);
  };
  const ends = [];
  for (const f of lines) {
    const pts = f.geometry.coordinates;
    const k = f.properties.highway === 'steps' ? 2 : 1;
    const ids = pts.map(nodeOf);
    for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1]) g.edges.push([ids[i - 1], ids[i], +(metres(pts[i - 1], pts[i]) * k).toFixed(1)]);
    ends.push(ids[0], ids[ids.length - 1]);
  }
  const degree = new Map();
  for (const [a, b] of g.edges) { degree.set(a, (degree.get(a) || 0) + 1); degree.set(b, (degree.get(b) || 0) + 1); }
  for (const e of new Set(ends)) {
    if (degree.get(e) !== 1) continue;                       // already a junction
    const P = g.nodes[e], kx = Math.cos(P[1] * Math.PI / 180) * 111320, ky = 110540;
    let best = null, bd = JOIN_M;
    g.edges.forEach((ed, j) => {
      const [a, b] = ed;
      if (a === e || b === e) return;
      const A = g.nodes[a], B = g.nodes[b];
      const ax = (A[0] - P[0]) * kx, ay = (A[1] - P[1]) * ky, bx = (B[0] - P[0]) * kx, by = (B[1] - P[1]) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < bd) { bd = d; best = { j, t }; }
    });
    if (!best) continue;
    const [a, b, m] = g.edges[best.j];
    const A = g.nodes[a], B = g.nodes[b];
    let target;
    if (best.t * m < 1) target = a;                          // within a metre of an existing point
    else if ((1 - best.t) * m < 1) target = b;
    else {                                                   // split the segment at the foot of the perpendicular
      target = nodeOf([+(A[0] + best.t * (B[0] - A[0])).toFixed(7), +(A[1] + best.t * (B[1] - A[1])).toFixed(7)]);
      g.edges[best.j] = [a, target, +(m * best.t).toFixed(1)];
      g.edges.push([target, b, +(m * (1 - best.t)).toFixed(1)]);
    }
    g.edges.push([e, target, +bd.toFixed(1)]);
  }
}

// Heights of the network nodes, sampled bilinearly from the local Copernicus terrain tiles (scripts/build_terrain.py;
// terrarium encoding, z14 ≈ 9 m pixels). Nodes without data get NaN and are treated as flat.
const ELEV_Z = 14;
async function nodeHeights(nodes) {
  const n = 2 ** ELEV_Z * 256;
  const px = ([lon, lat]) => [(lon + 180) / 360 * n - .5, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n - .5];
  const need = new Set();
  for (const p of nodes) {
    const [x, y] = px(p);
    for (const X of [x, x + 1]) for (const Y of [y, y + 1]) need.add(`${Math.floor(X / 256)}/${Math.floor(Y / 256)}`);
  }
  const tiles = new Map(), cv = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  await Promise.all([...need].map(async key => {
    const r = await fetch(`data/terrain/tiles/${ELEV_Z}/${key}.png`);
    if (r.ok) tiles.set(key, await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }));
  }));
  const grids = new Map();
  for (const [key, bmp] of tiles) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data, h = new Float32Array(256 * 256);
    for (let i = 0; i < h.length; i++) h[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;
    grids.set(key, h);
  }
  const at = (ix, iy) => grids.get(`${Math.floor(ix / 256)}/${Math.floor(iy / 256)}`)?.[(iy & 255) * 256 + (ix & 255)] ?? NaN;
  return Float32Array.from(nodes, p => {
    const [x, y] = px(p), ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
  });
}

// The DEM is a surface model: tree canopy and buildings make heights along a road wobble by a few metres, which
// would read as false climbs. Averaging each point with its network neighbours (closer ones count more) keeps the
// real slopes and irons out the wobble.
const SMOOTH_PASSES = 6, SMOOTH_M = 40;
function smoothAlong(h, adjStart, adjTo, adjLen) {
  let cur = h;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Float32Array(cur.length);
    for (let u = 0; u < cur.length; u++) {
      if (cur[u] !== cur[u]) { next[u] = NaN; continue; }
      let s = cur[u], w = 1;
      for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
        const v = adjTo[k];
        if (cur[v] !== cur[v]) continue;
        const wk = Math.exp(-adjLen[k] / SMOOTH_M);
        s += wk * cur[v]; w += wk;
      }
      next[u] = s / w;
    }
    cur = next;
  }
  return cur;
}

// Dijkstra with a binary heap. Returns the cost from the source node (metres by default, or any per-adjacency-slot
// weights such as direction-dependent minutes) and the predecessor tree.
export function dijkstra(src, weights = G.adjLen) {
  const { adjStart, adjTo } = G, adjLen = weights;
  const n = G.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = [[0, src]];
  dist[src] = 0;
  const push = item => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
      const v = adjTo[k], nd = d + adjLen[k];
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); }
    }
  }
  return { dist, prev };
}

