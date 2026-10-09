"""Pull Google + Microsoft open building footprints around campus from the VIDA combined dataset.

Unlike Overture, this keeps Google/Microsoft outlines that overlap coarse OSM shapes, which is exactly
what we need inside the Academic Complex and hostel boxes. Only the campus row groups are read over HTTP.
Output: data/raw/open_buildings.geojson
Requires: pip install duckdb
Data: Google Open Buildings (CC BY 4.0 / ODbL) and Microsoft Building Footprints (ODbL), via
https://source.coop/vida/google-microsoft-open-buildings
"""
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
URL = ("https://data.source.coop/vida/google-microsoft-open-buildings/geoparquet/by_country_s2/"
       "country_iso=IND/3988781894966706176.parquet")  # S2 level-6 cell containing IITG
W, S, E, N = 91.684, 26.180, 91.706, 26.204

con = duckdb.connect()
for ext in ("httpfs", "spatial"):
    con.install_extension(ext)
    con.load_extension(ext)
rows = con.execute(f"""
    SELECT bf_source, confidence, area_in_meters, ST_AsGeoJSON(geometry)
    FROM read_parquet('{URL}')
    WHERE bbox.xmin >= {W} AND bbox.xmax <= {E} AND bbox.ymin >= {S} AND bbox.ymax <= {N}
""").fetchall()
feats = [{"type": "Feature", "properties": {"source": s, "confidence": c, "area": a}, "geometry": json.loads(g)}
         for s, c, a, g in rows]
out = ROOT / "data/raw/open_buildings.geojson"
out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
by = {}
for f in feats:
    by[f["properties"]["source"]] = by.get(f["properties"]["source"], 0) + 1
print(len(feats), "footprints", by, "->", out)
