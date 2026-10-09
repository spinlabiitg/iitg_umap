# Data licences

The code of this site is MIT-licensed (see `../LICENSE`). The data files here come from several open sources and keep
their own terms. When you reuse a file, give the credit listed for it.

| Files | Source | Licence | Credit to give |
|---|---|---|---|
| `osm/*.geojson` (boundary, roads, paths, water, green, landuse, sports, pois, buildings) | OpenStreetMap | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | © OpenStreetMap contributors |
| `osm/buildings_ml.geojson` | Google Open Buildings and Microsoft Building Footprints, via the VIDA combined dataset | ODbL 1.0 (Microsoft) with CC BY 4.0 (Google) | © Google Open Buildings (CC BY 4.0); © Microsoft (ODbL) |
| `network.json` (walking graph) | Built from the OpenStreetMap roads and paths | ODbL 1.0 | © OpenStreetMap contributors |
| `places.json`, `custom_buildings.json` (place names, pins, categories, descriptions; drawn buildings and paths) | Collected and drawn by SPIN Lab on top of the OpenStreetMap base | ODbL 1.0 | © SPIN Lab, IIT Guwahati, and OpenStreetMap contributors |
| `terrain/` (contours, summits, elevation tiles) | Copernicus DEM GLO-30 | Copernicus DEM licence (free use with credit) | Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved |
| `greenness/` (monthly NDVI overlays and summary) | Sentinel-2 L2A via Microsoft Planetary Computer | Copernicus Sentinel data terms (free use with credit) | Contains modified Copernicus Sentinel data 2020-2024 |
| `climate.json`, rain fields | CHIRPS v2.0, Climate Hazards Center, UC Santa Barbara | Public domain (CC0) | Funk et al. (2015), CHIRPS, Scientific Data 2, 150066 |
| `climate.json`, temperature and humidity fields | ERA5 reanalysis via the Open-Meteo historical weather API | CC BY 4.0 (Open-Meteo); Copernicus licence (ERA5) | Weather data by Open-Meteo.com; contains modified Copernicus Climate Change Service information 1995-2024 |

ODbL is a share-alike licence: if you publish a database made from the ODbL files above, it must also be under ODbL.
Maps and images made from them (a produced work) only need the credit.

The satellite view on the site loads Esri World Imagery tiles straight from Esri. No imagery is stored here; it is
© Esri, Maxar, Earthstar Geographics, and the GIS User Community, and shown under Esri's terms.

These data are provided as they are, with no guarantee of accuracy. A line on the map does not mean a usable path, and
this is not an official IIT Guwahati map. The campus area in `osm/boundary.geojson` is approximate and is not an official boundary.
