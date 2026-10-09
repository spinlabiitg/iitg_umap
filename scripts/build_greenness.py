"""How green the land is, month by month: Sentinel-2 NDVI over the map window, 2020-2024.

    python scripts/build_greenness.py

NDVI = (near-infrared − red) / (near-infrared + red), from Sentinel-2 L2A surface reflectance (bands B08, B04; 10 m;
Microsoft Planetary Computer). Scenes from processing baseline 04.00 on (25 Jan 2022) store reflectance with a
+1000 offset (BOA_ADD_OFFSET); it is removed here, otherwise NDVI from 2022 on is pulled towards zero. Clouds, cloud shadows and cirrus are removed with the scene classification layer
(SCL). Haze, smog and thin cloud slip through that mask (often in Jan-Feb over Guwahati) and can only lower NDVI, so
each month's map is the per-pixel 75th percentile (PCT) of all views of that calendar month over the five years
rather than the median: it leans on the clearest days, as maximum-value compositing does, without picking outliers.
Check: on near-cloudless haze-free days the forested hills read ~0.55-0.7 in Jan-Feb; the median read ~0.35-0.45.
Outputs:
  data/greenness/ndvi_MM.png   colour overlay for month MM (water and missing data transparent), REGION corners
  data/greenness/greenness.json   per month: views used, median NDVI on campus and on land around it
Each scene's NDVI is cached in .cache/s2_ndvi/ (uint8, ~0.4 MB per scene; too-cloudy scenes leave a .skip marker),
with the scene list in scenes.json. The first run reads ~700 scenes (~40 min); after that a rebuild, for example with
another PCT or colour ramp, takes under 10 seconds and needs no network. `--refresh` searches the archive again and
fetches only new scenes (say, after extending YEARS).
"""
import sys
import json
import os
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
import requests  # noqa: E402
from PIL import Image  # noqa: E402
from rasterio.enums import Resampling  # noqa: E402
from rasterio.features import geometry_mask  # noqa: E402
from rasterio.transform import from_bounds  # noqa: E402
from rasterio.vrt import WarpedVRT  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "greenness"
CACHE = ROOT / ".cache" / "s2_ndvi"                 # one file per scene; delete it if the NDVI recipe changes
SKIP = "skip"
REGION = (91.655, 26.150, 91.735, 26.235)       # same window as the terrain
PCT = 75
RES = 0.0001                                     # degrees, ~10 m
W, H = round((REGION[2] - REGION[0]) / RES), round((REGION[3] - REGION[1]) / RES)
T = from_bounds(*REGION, W, H)
YEARS = (2020, 2024)
CLEAR = [4, 5, 6, 7]                             # SCL: vegetation, bare soil, water, unclassified
PC = "https://planetarycomputer.microsoft.com/api"
# NDVI colour ramp: bare/dry → straw → green → deep forest green
RAMP = [(.05, (166, 124, 82)), (.25, (222, 200, 120)), (.45, (128, 178, 84)), (.65, (52, 128, 60)), (.85, (20, 82, 40))]


def get_json(fn):
    for k in range(5):
        try:
            return fn().json()
        except Exception:
            time.sleep(3 * (k + 1))
    raise RuntimeError("Planetary Computer not answering")


def scenes():
    out, url = [], f"{PC}/stac/v1/search"
    body = {"collections": ["sentinel-2-l2a"], "bbox": list(REGION), "limit": 200,
            "datetime": f"{YEARS[0]}-01-01/{YEARS[1]}-12-31", "query": {"eo:cloud_cover": {"lt": 80}}}
    while url:
        r = get_json(lambda: requests.post(url, json=body, timeout=120))
        out += r["features"]
        nxt = next((ln for ln in r.get("links", []) if ln["rel"] == "next"), None)
        url, body = (nxt["href"], nxt.get("body", body)) if nxt else (None, None)
    return out


def warp(href, token, resampling):
    with rasterio.open("/vsicurl/" + href + "?" + token) as src, \
            WarpedVRT(src, crs="EPSG:4326", transform=T, width=W, height=H, resampling=resampling, nodata=0) as v:
        return v.read(1)


def offset(feature):
    """Reflectance offset in digital numbers: 1000 from processing baseline 04.00, else 0."""
    pb = feature["properties"].get("s2:processing_baseline")
    if pb is None:
        return 1000 if feature["properties"]["datetime"] >= "2022-01-25" else 0
    return 1000 if float(pb) >= 4 else 0


def ndvi(feature, token):
    """NDVI of one scene as uint8 (0 = missing; 1..255 ↔ −1..1), clear pixels only."""
    for _ in range(3):
        try:
            scl = warp(feature["assets"]["SCL"]["href"], token, Resampling.nearest)
            ok = np.isin(scl, CLEAR)
            if ok.mean() < .05:
                return SKIP
            r = warp(feature["assets"]["B04"]["href"], token, Resampling.bilinear).astype("float32")
            n = warp(feature["assets"]["B08"]["href"], token, Resampling.bilinear).astype("float32")
            nodata = r == 0
            off = offset(feature)
            r, n = np.maximum(r - off, 1), np.maximum(n - off, 1)
            v = (n - r) / (n + r)
            q = np.clip(np.round((v + 1) * 127) + 1, 1, 255).astype("uint8")
            q[~ok | nodata] = 0
            return q
        except Exception:
            time.sleep(3)
    return None


def scene_list(refresh):
    """The scenes to use: from the cache, or searched afresh (--refresh, or no cache yet)."""
    f = CACHE / "scenes.json"
    if f.exists() and not refresh:
        return json.loads(f.read_text(encoding="utf-8"))
    sc = scenes()
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(sc), encoding="utf-8")
    return sc


def cached_ndvi(feature, token):
    """One scene's NDVI from .cache, fetching and saving it first if needed. None = too cloudy or fetch failed."""
    hit, skip = CACHE / f"{feature['id']}.npz", CACHE / f"{feature['id']}.skip"
    if hit.exists():
        return np.load(hit)["q"]
    if skip.exists():
        return None
    q = ndvi(feature, token)
    if isinstance(q, np.ndarray):
        np.savez_compressed(hit, q=q)
        return q
    if q is SKIP:
        skip.touch()                       # too cloudy: remembered, never fetched again
    return None                            # fetch failed: not remembered, retried next run


def monthly_composites(refresh=False):
    sc = scene_list(refresh)
    todo = [f for f in sc if not (CACHE / f"{f['id']}.npz").exists() and not (CACHE / f"{f['id']}.skip").exists()]
    print(f"{len(sc)} scenes {YEARS[0]}-{YEARS[1]}; {len(sc) - len(todo)} cached, {len(todo)} to fetch")
    token = get_json(lambda: requests.get(f"{PC}/sas/v1/token/sentinel-2-l2a", timeout=60))["token"] if todo else None
    by = defaultdict(list)
    with ThreadPoolExecutor(8) as ex:
        for f, q in zip(sc, ex.map(lambda f: cached_ndvi(f, token), sc)):
            if q is not None:
                by[int(f["properties"]["datetime"][5:7])].append(q)
    comp, views = {}, {}
    for m in range(1, 13):
        comp[m] = percentile_u8(np.stack(by[m]), PCT)
        views[m] = len(by[m])
        by[m] = None
    return comp, views


def percentile_u8(a, pct):
    """Per-pixel percentile of a (views, rows, cols) uint8 stack where 0 = missing, as NDVI (NaN where never clear).
    Same linear interpolation as np.nanpercentile, but sorting small integers is far faster than its NaN handling."""
    s = np.sort(a, axis=0)                                  # missing (0) values sort first
    gap = (s == 0).sum(axis=0)
    k = a.shape[0] - gap                                    # clear views per pixel
    pos = gap + pct / 100 * np.maximum(k - 1, 0)
    lo = np.minimum(np.floor(pos).astype(int), a.shape[0] - 1)   # pixels never clear: any index, set to NaN below
    hi = np.minimum(lo + 1, a.shape[0] - 1)
    f = pos - lo
    v = np.take_along_axis(s, lo[None], 0)[0] * (1 - f) + np.take_along_axis(s, hi[None], 0)[0] * f
    out = (v - 1) / 127 - 1                                 # back to NDVI
    out[k == 0] = np.nan
    return out.astype("float32")


def colour(v, water):
    xs = np.array([x for x, _ in RAMP])
    cols = np.array([c for _, c in RAMP], "float32")
    rgba = np.zeros(v.shape + (4,), "uint8")
    for ch in range(3):
        rgba[..., ch] = np.interp(np.nan_to_num(v, nan=0), xs, cols[:, ch])
    # open water, bare sand and gaps stay transparent; so do the mapped lakes and river, whatever floats on them
    rgba[..., 3] = np.where(np.isfinite(v) & (v > .05) & ~water, 255, 0)
    return rgba


def mapped_water():
    """Lakes and river as mapped in OSM. Floating plants (water hyacinth, lotus, algal mats) cover much of the campus
    lakes from April to October and read as vegetation; the overlay is about land, so these areas are left out."""
    feats = json.loads((ROOT / "data/osm/water.geojson").read_text(encoding="utf-8"))["features"]
    polys = [f["geometry"] for f in feats if f["geometry"]["type"] in ("Polygon", "MultiPolygon")]
    return ~geometry_mask(polys, (H, W), T)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    med, views = monthly_composites(refresh="--refresh" in sys.argv)
    ring = json.loads((ROOT / "data/osm/boundary.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"]
    campus = ~geometry_mask([ring], (H, W), T)
    water = mapped_water()
    stats = []
    for m in range(1, 13):
        v = med[m]
        land = np.isfinite(v) & (v > .05) & ~water
        stats.append({"month": m, "views": views[m],
                      "campus": round(float(np.median(v[land & campus])), 3),
                      "around": round(float(np.median(v[land & ~campus])), 3)})
        img = Image.fromarray(colour(v, water), "RGBA").quantize(colors=48, method=Image.Quantize.FASTOCTREE)
        img.save(OUT / f"ndvi_{m:02d}.png", optimize=True)
        print(stats[-1])
    meta = {"years": list(YEARS), "region": REGION,
            "composite": f"per-pixel {PCT}th percentile of each month's cloud-masked views",
            "source": f"Sentinel-2 L2A, contains modified Copernicus Sentinel data {YEARS[0]}-{YEARS[1]}, via Microsoft Planetary Computer",
            "months": stats}
    (OUT / "greenness.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
