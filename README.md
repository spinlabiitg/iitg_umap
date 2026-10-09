# IITG Campus uMap

*The **u** stands for **unofficial**.*

An interactive, illustrated map of the IIT Guwahati campus for visitors, freshers, students and staff.
Designed by [SPIN Lab](https://spinlabiitg.github.io/), Mehta Family School of DSAI, IIT Guwahati. **Not an official IIT Guwahati map.**

> **Use with care.** Roads, paths and buildings come from open data (OpenStreetMap, Google/Microsoft footprints) and hand edits.
> They may be incomplete, out of date, closed or private: a line on the map does not guarantee a usable path, and walking
> times assume every mapped path is open. Follow campus signs, gates and security instructions, and use your own judgement.

## Run locally

```bash
python serve.py
```
Then open http://localhost:8765. No build step; MapLibre GL is loaded from a CDN.
`serve.py` is a plain static server that disables browser caching, so edits show up on a normal reload.

## Data pipeline

| Step | Script | Output |
|---|---|---|
| OSM extract (boundary, roads, water, buildings, POIs) | `python scripts/fetch_osm.py` | `data/osm/*.geojson` (raw cache in `data/raw/`, git-ignored) |
| Google + Microsoft open footprints around campus | `python scripts/fetch_open_buildings.py` | `data/raw/open_buildings.geojson` |
| Fill missing building outlines; refine hostels + Academic Complex | `python scripts/fetch_footprints.py` | `data/osm/buildings_ml.geojson` |
| Hand-drawn / hidden buildings (from the editor) | — | `data/custom_buildings.json` |
| Check place → building colour links after each merge | `python scripts/check_links.py [--fix]` | `data/places.json` |
| Walkable graph for walking/cycling times | `python scripts/build_network.py` | `data/network.json` |
| Elevation: contours, summits, terrain tiles (Copernicus GLO-30) | `python scripts/build_terrain.py` | `data/terrain/` |
| Climate normals for the Seasons card (CHIRPS rain, ERA5 temperature) | `python scripts/build_climate.py` | `data/climate.json` |
| Greenness by month (Sentinel-2 NDVI; per-image cache in `.cache/s2_ndvi/`, ~40 min first run, then seconds; `--refresh` fetches new images) | `python scripts/build_greenness.py` | `data/greenness/` |
| Curated places: first draft from iitg.ac.in + Freshers Portal | `python scripts/build_places.py` (once) | `data/places.json` — now hand-edited |

## Map editor
Open http://localhost:8765/?edit. Four tools:
- **📍 Place** — pick a place (or **＋ New place**), click the map to drop its pin exactly there, drag to fine-tune.
  "Also colour the building under the pin" links that one footprint for colouring.
- **🏠 Building** — *Freeform*: click each corner, then the first corner / Enter. *Rectangle*: two corners along a wall,
  then click to set the depth. Satellite view helps tracing.
- **〰 Path** — footpath, road, service lane or steps. Clicks snap (white ring) onto existing roads so walking routes
  connect; double-click or Enter to finish. Drawn paths are included in walking/cycling times.
- **🚫 Hide** — click a wrong footprint to hide it (click again to restore); click anything you drew to delete it.

Edits autosave in your browser. Use **⬇ places.json** and **⬇ map edits** to export, then replace
`data/places.json` and `data/custom_buildings.json` (drawn buildings, drawn paths, hidden footprints).

## Roadmap
1. ✅ Data pull + first styled preview
2. ✅ Draft place list + click-to-tag editor
2b. ✅ Walking/cycling-time rings + hostel league (🚶 Walk button, or `?walk`)
3. ✅ Style polish: label tiers (overview → close-up), road hierarchy, hillshade, selection ring, soft 3D lighting
4. ✅ Search (names, short forms, aliases, categories; `/` to focus), category filters on the legend,
   shareable links (`#place=<id>`), cards with Directions and Copy link
5. ✅ Printable poster (`poster.html`, or 🖨 Poster in the map): vector SVG at true paper size (A4/A3/A2, landscape/portrait,
   light/dark/🎨 cartoon), numbered places + index, north arrow, scale bar; Download PNG (150/300 dpi) or Print → Save as PDF.
   Cartoon (`poster.html?theme=cartoon`, or 🎨 Cartoon in the map): wobbly ink outlines, doodled trees and waves,
   sticker labels with emoji, Fredoka font
5b. ⏸ Pulse of campus — parked until real timetable/movement data is available; preview with `?pulse`: agent-based simulation of a day of student movement on the walking
   network (`js/pulse.js`, rules in `PURPOSES` and `WAVES`), path-traffic glow, people-on-the-move sparkline, and a
   new-canteen location optimiser. Simulated, not tracking data.
5c. ✅ Elevation (Copernicus GLO-30): 5 m contours with labelled 25 m lines, summit heights, hillshade, and a ⛰ Terrain
   toggle for 3D ground (hills ×2.5); contours and summits also on all posters
5d. ✅ Hill-aware walking/cycling times (⛰ Hills in the walk panel, on by default). Network points get heights from the
   terrain tiles (`js/graph.js`), smoothed along the network because the DEM is a surface model (trees, roofs). Each
   step costs time by direction: walking uses Tobler's hiking function (scaled to 4.8 km/h on the flat), cycling loses
   8% speed per 1% climb down to pushing pace and gains up to 1.5× downhill. The route card shows distance, ↑climb /
   ↓descent (2 m dead band), the time to come back the same way, and a height profile. The hostel league averages
   there-and-back trips and marks rank changes against flat ground (none at present: hostels and academic
   buildings all sit on the flat 47–57 m core; the hills matter for View Point and the hill roads)
5e. ✅ Seasons (🌦 Seasons, or `?seasons=7` for July): month picker; climate card (afternoon/night temperature, "feels like",
   rain and rainy days, humidity, dew point); daylight bar with sunrise/sunset (NOAA solar equations, IST); sunrise and
   sunset directions drawn on the map; a year wheel (rain bars, temperature ring); practical tips read off the numbers.
   Rain from CHIRPS (matches IMD's ~1720 mm/yr Guwahati normal; ERA5 rain was ~60% too high), the rest from ERA5.
   Greenness by month (🌿 in the Seasons panel, on the map by default): Sentinel-2 NDVI 2020-2024, cloud-masked (SCL),
   per-pixel 75th percentile of each month's views (17-70 per month; favours clear days over winter haze),
   with the processing-baseline 04.00 reflectance offset (−1000, from 2022) removed;
   mapped lakes and river are cut out of the overlay and the numbers (floating plants cover most of the lakes Apr-Oct), shown as a colour overlay; campus goes from 0.39
   (February) to 0.79 (August), and stays a little greener than the land around it all year.
   (Monthly river/lake extent from Sentinel-1 radar was tried and dropped: the river here is rock-bound, ~1.0-1.1 km
   wide all year, so the maps showed little change.)
6. GitHub Pages deploy

## Credits
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL
- Building footprints © [Google Open Buildings](https://sites.research.google/open-buildings/) (CC BY 4.0) and [Microsoft Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints) (ODbL), via [VIDA on Source Cooperative](https://source.coop/vida/google-microsoft-open-buildings)
- Satellite imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community (Esri World Imagery, loaded live; credited on the map while shown)
- Greenness: contains modified Copernicus Sentinel data (2020-2024), ESA; Sentinel-2 L2A via [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/)
- Rainfall: [CHIRPS v2.0](https://www.chc.ucsb.edu/data/chirps), Climate Hazards Center, UC Santa Barbara
- Temperature, humidity, "feels like": ERA5 reanalysis via [Open-Meteo](https://open-meteo.com/) (CC BY 4.0); contains modified Copernicus Climate Change Service information 1995-2024
- Elevation (contours, summits, hillshade, 3D terrain): Copernicus DEM GLO-30, produced using Copernicus WorldDEM-30
  © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA
- Fonts: Fraunces, Inter, Fredoka (Google Fonts) and Open Sans map labels, all under the SIL Open Font License
- Map rendering: [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause)

## Licence
Designed by **SPIN Lab, Mehta Family School of Data Science and Artificial Intelligence, IIT Guwahati**.

- **Code** (HTML, CSS, JavaScript, Python scripts): [MIT](LICENSE), © 2026 SPIN Lab. Reuse freely; keep the copyright
  notice, which credits SPIN Lab.
- **Data** in `data/`: each file keeps its source's licence (OpenStreetMap and footprints: ODbL; Copernicus and CHIRPS:
  free with credit). See [data/LICENSE.md](data/LICENSE.md) for the file-by-file list and the credit to give.

This is an unofficial map, not endorsed by IIT Guwahati. The campus area (the soft tint) is taken from OpenStreetMap and is
approximate; it is not an official boundary, so no outline is drawn.
