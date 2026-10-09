"""Fill gaps in OSM buildings with Google + Microsoft open footprints.

Input:  data/raw/open_buildings.geojson   (from scripts/fetch_open_buildings.py)
Output: data/osm/buildings_ml.geojson

Keeps footprints whose centre lies inside the campus boundary and that don't overlap an OSM building.
OSM outlines of hostels (rough boxes in OSM) and REPLACE_EXTRA are swapped out instead: footprints
inside them are kept and tagged part_of=<osm id>, and the app hides the OSM outline.

Data: Google Open Buildings (CC BY 4.0 / ODbL) and Microsoft Building Footprints (ODbL).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data/raw/open_buildings.geojson"
MIN_CONFIDENCE = 0.70   # Google's detector score; below this many "buildings" are trees or sheds
MIN_AREA = 15           # m²

# Other coarse OSM outlines to refine with open footprints.
REPLACE_EXTRA = {"way/121451174"}  # Academic Complex


def inside(pt, poly):
    x, y = pt
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def centre(ring):
    xs, ys = zip(*ring[:-1])
    return sum(xs) / len(xs), sum(ys) / len(ys)


def guess_height(area):
    return 12 if area > 600 else 9 if area > 150 else 5


def main():
    if not SRC.exists():
        sys.exit(f"{SRC} missing — run scripts/fetch_open_buildings.py first")
    poly = json.loads((ROOT / "data/osm/boundary.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"]["coordinates"][0]

    osm = [f for n in ("buildings", "landuse")
           for f in json.loads((ROOT / f"data/osm/{n}.geojson").read_text(encoding="utf-8"))["features"]
           if f["geometry"]["type"] == "Polygon"]
    places = json.loads((ROOT / "data/places.json").read_text(encoding="utf-8"))["places"]
    replace = {p["feature"] for p in places if p["category"] == "hostel" and p.get("feature", "").startswith(("way/", "relation/"))}
    replace |= REPLACE_EXTRA
    replace_rings = {f["id"]: f["geometry"]["coordinates"][0] for f in osm if f["id"] in replace}
    osm_rings = [f["geometry"]["coordinates"][0] for f in osm
                 if f["id"] not in replace and "building" in f["properties"]]

    keep, skipped = [], 0
    for feat in json.loads(SRC.read_text(encoding="utf-8"))["features"]:
        p, g = feat["properties"], feat["geometry"]
        if (p["source"] == "google" and p["confidence"] < MIN_CONFIDENCE) or p["area"] < MIN_AREA:
            skipped += 1
            continue
        c = centre(g["coordinates"][0])
        if not inside(c, poly):
            continue
        part_of = next((k for k, r in replace_rings.items() if inside(c, r)), None)
        if not part_of and any(inside(c, r) for r in osm_rings):
            continue  # OSM already has this building
        g["coordinates"] = [[[round(x, 7), round(y, 7)] for x, y in r] for r in g["coordinates"]]
        prefix = "g" if p["source"] == "google" else "ms"
        fid = f"{prefix}/{c[1]:.5f},{c[0]:.5f}"  # stable id: source + centroid lat,lon
        keep.append({"type": "Feature", "id": fid,
                     "properties": {"fid": fid, "key": part_of or fid, "part_of": part_of, "source": p["source"],
                                    "height": guess_height(p["area"])},
                     "geometry": g})
    out = ROOT / "data/osm/buildings_ml.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": keep}), encoding="utf-8")
    print(f"kept {len(keep)} footprints inside campus ({skipped} low-confidence/tiny skipped) -> {out}")
    for k in sorted(replace):
        n = sum(f["properties"]["part_of"] == k for f in keep)
        print(f"  {k:18s} {n:3d} footprints" + ("   <- none found, OSM outline stays" if not n else ""))


if __name__ == "__main__":
    main()
