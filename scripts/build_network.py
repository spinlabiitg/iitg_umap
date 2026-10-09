"""Build a walkable graph of the campus from OSM roads and paths.

Nodes are OSM vertices (junctions share exact coordinates, so coordinates identify nodes).
Only the largest connected component near campus is kept, so every node is reachable.
Output: data/network.json  {"nodes": [[lon, lat], ...], "edges": [[a, b, metres], ...]}
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP = {"motorway", "motorway_link", "trunk", "trunk_link", "construction", "proposed", "bus_stop"}
STEP_PENALTY = 2.0  # steps feel ~2x longer than flat ground
PAD = 0.003         # degrees of slack around the campus bbox (~300 m)


def metres(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(b[0] - a[0]) * math.cos(lat) * 6371000
    dy = math.radians(b[1] - a[1]) * 6371000
    return math.hypot(dx, dy)


def main():
    ring = json.loads((ROOT / "data/osm/boundary.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"]["coordinates"][0]
    xs, ys = zip(*ring)
    box = (min(xs) - PAD, min(ys) - PAD, max(xs) + PAD, max(ys) + PAD)
    near = lambda p: box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]

    index, nodes, edges = {}, [], {}

    def node(p):
        key = tuple(p)
        if key not in index:
            index[key] = len(nodes)
            nodes.append(p)
        return index[key]

    for layer in ("roads", "paths"):
        for f in json.loads((ROOT / f"data/osm/{layer}.geojson").read_text(encoding="utf-8"))["features"]:
            hw = f["properties"].get("highway")
            if f["geometry"]["type"] != "LineString" or hw in SKIP or f["properties"].get("foot") == "no":
                continue
            pts = f["geometry"]["coordinates"]
            k = STEP_PENALTY if hw == "steps" else 1.0
            for a, b in zip(pts, pts[1:]):
                if not (near(a) or near(b)):
                    continue
                i, j = node(a), node(b)
                if i != j:
                    key = (min(i, j), max(i, j))
                    edges[key] = round(metres(a, b) * k, 1)

    # Largest connected component
    adj = {}
    for i, j in edges:
        adj.setdefault(i, []).append(j)
        adj.setdefault(j, []).append(i)
    seen, best = set(), set()
    for s in adj:
        if s in seen:
            continue
        comp, stack = {s}, [s]
        while stack:
            for n in adj[stack.pop()]:
                if n not in comp:
                    comp.add(n)
                    stack.append(n)
        seen |= comp
        if len(comp) > len(best):
            best = comp

    remap = {old: new for new, old in enumerate(sorted(best))}
    out_nodes = [[round(nodes[o][0], 6), round(nodes[o][1], 6)] for o in sorted(best)]
    out_edges = [[remap[i], remap[j], m] for (i, j), m in edges.items() if i in remap]
    path = ROOT / "data/network.json"
    path.write_text(json.dumps({"nodes": out_nodes, "edges": out_edges}, separators=(",", ":")), encoding="utf-8")
    total = sum(e[2] for e in out_edges) / 1000
    print(f"{len(out_nodes)} nodes, {len(out_edges)} edges, {total:.1f} km walkable "
          f"(dropped {len(adj) - len(best)} nodes in disconnected bits) -> {path}")


if __name__ == "__main__":
    main()
