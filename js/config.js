// Shared look and data rules for the live map (app.js) and the printable poster (poster.js).

export const CATEGORIES = {
  academic:    { label: 'Academic',      light: '#e2725b', dark: '#f08a6c' },
  hostel:      { label: 'Hostels',       light: '#3d9a8b', dark: '#4fc1ad' },
  food:        { label: 'Food',          light: '#ef9b3a', dark: '#f6b25e' },
  facility:    { label: 'Facilities',    light: '#d9a521', dark: '#f4c95d' },
  sports:      { label: 'Sports',        light: '#6aa84f', dark: '#8fd16f' },
  services:    { label: 'Shops & banks', light: '#8e6cc0', dark: '#b39ae0' },
  admin:       { label: 'Admin',         light: '#3f5f8a', dark: '#7fa4d6' },
  gate:        { label: 'Gates & buses', light: '#5b6b66', dark: '#a9b8b2' },
  residential: { label: 'Residential',   light: '#b8936a', dark: '#c9a57c' },
  nature:      { label: 'Lakes & parks', light: '#4a9fb8', dark: '#6cc3db' },
  landmark:    { label: 'Landmarks',     light: '#c0569e', dark: '#e08cc4' },
};

export const BASE = {
  light: {
    outside: '#efe8d8', campus: '#e6eedb', green: '#cfe0b8', sports: '#bcd99a',
    water: '#8ec5d6', waterLine: '#5aa6bf', road: '#ffffff', roadCase: '#d8cdb6', path: '#b9a98a',
    building: '#ddd0b4', label: '#23302b', labelSoft: '#55625b', halo: '#fffaf0', edge: '#e2725b',
    hillShadow: 'rgba(70, 80, 50, .35)', hillLight: 'rgba(255, 252, 235, .25)',
    contour: '#a98b5f', contourText: '#7d6440',
  },
  dark: {
    outside: '#0c1519', campus: '#14252a', green: '#1c3a2f', sports: '#25482f',
    water: '#1f5b73', waterLine: '#2f86a6', road: '#3a4d52', roadCase: '#0c1519', path: '#4f5f5a',
    building: '#4a5955', label: '#e8efe9', labelSoft: '#a9b8b2', halo: '#0f1a1f', edge: '#f4a261',
    hillShadow: 'rgba(0, 0, 0, .45)', hillLight: 'rgba(160, 200, 190, .10)',
    contour: '#7f8f77', contourText: '#b7c4b0',
  },
};

export const catColor = (cat, theme) => (CATEGORIES[cat] || CATEGORIES.residential)[theme];

// Label tiers: 0 = labelled from the campus overview, 1 = from mid zoom, 2 = only close in (see TIER_ZOOM in app.js).
const TIER0 = new Set(['academic-complex', 'library', 'lecture-halls', 'admin', 'hospital', 'food-court', 'sac', 'new-sac',
  'market-complex', 'main-gate', 'auditorium', 'khokha', 'rhino-circle', 'serpentine', 'admin-lake']);
const TIER1 = new Set(['sbi', 'canara', 'post-office', 'kv', 'guest-house-1', 'guest-house-2']);
const TIER2 = new Set(['water-purification-plant', 'electric-power-station', 'd-type-community-hall', 'midpoint',
  'badminton-court', 'basketball-court', 'tennis-court', 'volleyball-court']);
const MINOR_CATS = new Set(['services', 'admin', 'residential']);
export const tierOf = p => TIER0.has(p.id) || p.category === 'hostel' ? 0
  : TIER2.has(p.id) || (MINOR_CATS.has(p.category) && !TIER1.has(p.id)) ? 2 : 1;

// Map labels are shorter than card titles where the full name is long.
const LABELS = { library: 'Central Library', ccc: 'Computer Centre' };
export const labelOf = p => p.short || LABELS[p.id] || (p.category === 'hostel' ? p.name.replace(/ Hostel$/, '') : p.name);

// OSM outlines that were swapped for finer footprints (see scripts/fetch_footprints.py) are hidden.
export const replacedKeys = buildingsMl => [...new Set(buildingsMl.features.map(f => f.properties.part_of).filter(Boolean))];

export function pointInRing([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
