"""Fetch OpenStreetMap data for the IIT Guwahati campus and split it into GeoJSON layers.

Usage:  python scripts/fetch_osm.py            # fetch + convert
        python scripts/fetch_osm.py --offline  # reconvert from data/raw/osm.json

Data (c) OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright
"""
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "osm.json"
OUT = ROOT / "data" / "osm"

# Generous box around campus (south, west, north, east); the boundary polygon trims it later.
BBOX = (26.170, 91.670, 26.210, 91.715)

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

QUERY = """[out:json][timeout:180];
(
  nwr({s},{w},{n},{e})[~"."~"."];
);
out geom;"""


def fetch():
    q = QUERY.format(s=BBOX[0], w=BBOX[1], n=BBOX[2], e=BBOX[3])
    for url in MIRRORS:
        try:
            print("trying", url, flush=True)
            r = requests.post(url, data={"data": q}, timeout=200,
                              headers={"User-Agent": "iitg-campus-map/0.1 (personal project)"})
            if r.ok and r.text.lstrip().startswith("{"):
                RAW.parent.mkdir(parents=True, exist_ok=True)
                RAW.write_text(r.text, encoding="utf-8")
                print("saved", RAW, len(r.text) // 1024, "KB")
                return
            print("  status", r.status_code, r.text[:120].replace("\n", " "))
        except requests.RequestException as ex:
            print("  failed:", ex)
        time.sleep(2)
    sys.exit("All Overpass mirrors failed")


def classify(tags):
    """Map OSM tags to a layer name (or None to skip)."""
    if tags.get("amenity") == "university" or tags.get("landuse") == "education":
        return "boundary"
    if "building" in tags:
        return "buildings"
    if "highway" in tags:
        return "paths" if tags["highway"] in ("footway", "path", "steps", "pedestrian", "cycleway", "track") else "roads"
    if tags.get("natural") == "water" or "waterway" in tags or tags.get("water"):
        return "water"
    if tags.get("natural") in ("wood", "scrub", "grassland", "tree_row", "wetland", "heath") \
            or tags.get("landuse") in ("forest", "grass", "meadow", "farmland", "orchard", "recreation_ground", "village_green") \
            or tags.get("leisure") in ("park", "garden", "nature_reserve"):
        return "green"
    if tags.get("leisure") in ("pitch", "stadium", "sports_centre", "track", "swimming_pool", "playground"):
        return "sports"
    if tags.get("landuse") in ("residential",):
        return "landuse"
    if any(k in tags for k in ("amenity", "shop", "tourism", "office", "leisure", "historic", "public_transport")) \
            or tags.get("highway") == "bus_stop":
        return "pois"
    if tags.get("natural") in ("peak", "hill"):
        return "pois"
    return None


def ring(geom):
    return [[round(p["lon"], 7), round(p["lat"], 7)] for p in geom]


def is_area(el, tags):
    g = el.get("geometry") or []
    if len(g) < 4 or g[0] != g[-1]:
        return False
    if tags.get("area") == "no":
        return False
    return "highway" not in tags or tags.get("area") == "yes"


def stitch(ways):
    """Join way segments of a multipolygon member list into closed rings."""
    segs = [ring(w) for w in ways if w]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
    return rings


def to_feature(el):
    tags = el.get("tags", {})
    t = el["type"]
    if t == "node":
        geom = {"type": "Point", "coordinates": [round(el["lon"], 7), round(el["lat"], 7)]}
    elif t == "way":
        g = el.get("geometry")
        if not g:
            return None
        geom = {"type": "Polygon", "coordinates": [ring(g)]} if is_area(el, tags) \
            else {"type": "LineString", "coordinates": ring(g)}
    elif t == "relation" and tags.get("type") in ("multipolygon", "boundary"):
        members = el.get("members", [])
        outers = stitch([m.get("geometry") for m in members if m.get("role") == "outer"])
        inners = stitch([m.get("geometry") for m in members if m.get("role") == "inner"])
        if not outers:
            return None
        # Attach inner rings to the first outer (good enough for campus-scale data).
        polys = [[o] for o in outers]
        polys[0].extend(inners)
        geom = {"type": "MultiPolygon", "coordinates": polys}
    else:
        return None
    return {"type": "Feature", "id": f"{t}/{el['id']}", "properties": dict(tags, osm_id=f"{t}/{el['id']}"),
            "geometry": geom}


def convert():
    data = json.loads(RAW.read_text(encoding="utf-8"))
    layers = {}
    for el in data["elements"]:
        tags = el.get("tags")
        if not tags:
            continue
        layer = classify(tags)
        if not layer:
            continue
        f = to_feature(el)
        if f:
            layers.setdefault(layer, []).append(f)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, feats in sorted(layers.items()):
        path = OUT / f"{name}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False),
                        encoding="utf-8")
        named = sum(1 for f in feats if f["properties"].get("name"))
        print(f"{name:10s} {len(feats):5d} features ({named} named)")


if __name__ == "__main__":
    if "--offline" not in sys.argv:
        fetch()
    convert()
