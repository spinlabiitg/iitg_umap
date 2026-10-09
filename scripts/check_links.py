"""Audit (and optionally fix) the place → building links that colour buildings on the map and posters.

    python scripts/check_links.py          # report only
    python scripts/check_links.py --fix    # rewrite data/places.json (bumps "revision")

A building is coloured by the category of the place linked to it (place["feature"] = a footprint id, or the key of a
group of footprints such as a hostel). Rules:
  stale    a place linked to a building more than STALE_M from its pin is relinked to the building under its pin
           (or unlinked). Group links (hostels, Academic Complex) are always valid: pins often sit in courtyards.
  owner    every building with pins on it goes to the most important of those places (and any place already linked
           to it); a less important place of another category loses its link but keeps its marker.
  shared   listed for review: pins on a building that is coloured by another category (a canteen in a bigger block).
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STALE_M = 25
TIER0 = {'academic-complex', 'library', 'lecture-halls', 'admin', 'hospital', 'food-court', 'sac', 'new-sac',
         'market-complex', 'main-gate', 'auditorium', 'khokha', 'rhino-circle', 'serpentine', 'admin-lake'}
MINOR = {'services', 'admin', 'residential'}


def inside(pt, ring):
    x, y = pt
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def dist_to_ring(pt, ring):
    """Metres from a point to a polygon ring (0 if inside)."""
    if inside(pt, ring):
        return 0.0
    kx, ky = 111320 * math.cos(math.radians(pt[1])), 110540
    px, py = pt[0] * kx, pt[1] * ky
    best = math.inf
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        ax, ay, bx, by = x1 * kx, y1 * ky, x2 * kx, y2 * ky
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(ax + t * dx - px, ay + t * dy - py))
    return best


def rings(g):
    if g["type"] == "Polygon":
        return [g["coordinates"][0]]
    if g["type"] == "MultiPolygon":
        return [poly[0] for poly in g["coordinates"]]
    return []


def importance(p):
    """Lower = more important: the main occupant of a building keeps its colour."""
    tier = 0 if p["id"] in TIER0 or p["category"] == "hostel" else 2 if p["category"] in MINOR else 1
    return (tier, 1 if p.get("subcategory") else 0, 1 if p.get("user_added") else 0)


def main(fix):
    load = lambda n: json.loads((ROOT / n).read_text(encoding="utf-8"))
    places_file = load("data/places.json")
    places = [p for p in places_file["places"] if p.get("lnglat")]
    custom = load("data/custom_buildings.json")
    hidden = set(custom.get("hidden", []))
    ml = load("data/osm/buildings_ml.geojson")["features"]
    groups = {f["properties"]["part_of"] for f in ml if f["properties"].get("part_of")}
    blds = []
    for f in load("data/osm/buildings.geojson")["features"]:
        oid = f["properties"]["osm_id"]
        if oid not in groups and oid not in hidden:
            blds.append({"fid": oid, "key": oid, "rings": rings(f["geometry"])})
    for f in ml:
        if f["properties"]["fid"] not in hidden:
            blds.append({"fid": f["properties"]["fid"], "key": f["properties"]["key"], "rings": rings(f["geometry"])})
    for f in custom["added"]["features"]:
        blds.append({"fid": f["properties"]["fid"], "key": f["properties"]["key"], "rings": rings(f["geometry"])})
    by_fid = {b["fid"]: b for b in blds}
    under = lambda pt: [b for b in blds if any(inside(pt, r) for r in b["rings"])]
    report = []

    # 1. stale single-building links
    for p in places:
        feat = p.get("feature")
        if feat not in by_fid or feat in groups:
            continue
        if min(dist_to_ring(p["lnglat"], r) for r in by_fid[feat]["rings"]) <= STALE_M:
            continue
        hits = under(p["lnglat"])
        report.append(("stale", p["name"], f"{feat} is {min(dist_to_ring(p['lnglat'], r) for r in by_fid[feat]['rings']):.0f} m away -> {hits[0]['fid'] if hits else 'unlinked'}"))
        if hits:
            p["feature"] = hits[0]["fid"]
        else:
            p.pop("feature")

    # 2. one owner per building: the most important place pinned on it or linked to it
    def links(p, b):
        return p.get("feature") in (b["fid"], b["key"]) if b["key"] != b["fid"] and b["key"] in groups else p.get("feature") == b["fid"]
    for b in blds:
        pinned = [p for p in places if any(inside(p["lnglat"], r) for r in b["rings"])]
        linked = [p for p in places if p.get("feature") == b["fid"]]
        candidates = {id(p): p for p in pinned + linked}.values()
        if not candidates:
            continue
        # a place with a valid link to another building is not a candidate for this one
        free = [p for p in candidates if links(p, b) or p.get("feature") not in by_fid and p.get("feature") not in groups]
        if not free:
            continue
        keep = min(free, key=lambda p: (*importance(p), 0 if p.get("feature") == b["fid"] else 1))   # ties: current owner
        group = next((p for p in places if b["key"] in groups and p.get("feature") == b["key"]), None)
        if group and keep["category"] == group["category"]:
            keep = group   # a block of a hostel / the Academic Complex: its group colours it
        elif keep.get("feature") != b["fid"]:
            report.append(("owner", keep["name"], f"now colours {b['fid']}"))
            keep["feature"] = b["fid"]
        for p in linked:
            if p is not keep and p["category"] != keep["category"]:
                report.append(("owner", p["name"], f"unlinked from {b['fid']} (it belongs to {keep['name']})"))
                p.pop("feature")

    # 3. what still differs, for review
    colour = {}
    for q in places:
        if q.get("feature"):
            colour.setdefault(q["feature"], q)
    for p in places:
        for b in under(p["lnglat"]):
            owner = colour.get(b["fid"]) or colour.get(b["key"])
            if owner and owner is not p and owner["category"] != p["category"]:
                report.append(("shared", p["name"], f"inside {owner['name']} ({owner['category']}); marker is {p['category']}"))

    for kind, name, what in report:
        print(f"{kind:7s} {name:44s} {what}")
    if not report:
        print("all links consistent")
    if fix and any(k != "shared" for k, *_ in report):
        places_file["revision"] = places_file.get("revision", 0) + 1
        (ROOT / "data/places.json").write_text(json.dumps(places_file, ensure_ascii=False, indent=1), encoding="utf-8")
        custom["revision"] = places_file["revision"]
        (ROOT / "data/custom_buildings.json").write_text(json.dumps(custom, ensure_ascii=False, indent=1), encoding="utf-8")
        print("fixed; revision", places_file["revision"])


if __name__ == "__main__":
    main("--fix" in sys.argv)
