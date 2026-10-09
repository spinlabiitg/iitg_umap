"""Elevation for the map: contours, summit spot heights and terrain tiles from the Copernicus GLO-30 DEM.

    python scripts/build_terrain.py

Reads only the campus window of the 1°x1° Copernicus tile over HTTP (needs: rasterio, numpy, scipy, contourpy, Pillow).
Outputs, all covering REGION (campus plus surroundings, also the map's pan limit):
  data/terrain/contours.geojson   5 m contour lines near campus, 25 m (idx=true) beyond; short noisy fragments dropped
  data/terrain/peaks.geojson      summits: local maxima standing at least PROMINENCE m above their surroundings
  data/terrain/tiles/{z}/{x}/{y}.png   terrarium-encoded elevation tiles (z 10-14) for 3D terrain and hillshade
Also prints a comparison with the SRTM-based AWS Terrain Tiles used before.

Elevation: Copernicus DEM GLO-30, produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and
Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved. Free to use with credit.
"""
import io
import json
import math
from pathlib import Path

import contourpy
import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.windows import from_bounds
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "terrain"
SRC = ("/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N26_00_E091_00_DEM/"
       "Copernicus_DSM_COG_10_N26_00_E091_00_DEM.tif")
REGION = (91.655, 26.150, 91.735, 26.235)   # W, S, E, N
STEP, INDEX = 5, 25                          # contour interval and index-line interval, metres
MIN_LEN_M = 120                              # drop contour fragments shorter than this (noise on flat ground)
PROMINENCE = 15                              # metres a summit must stand above the lowest point within 300 m
NEAR_DEG = 0.004                             # 5 m contours within ~400 m of campus; 25 m lines only beyond
ZOOMS = range(10, 15)


def read_dem():
    with rasterio.open(SRC) as ds:
        win = from_bounds(*REGION, transform=ds.transform)
        dem = ds.read(1, window=win).astype("float64")
        tr = ds.window_transform(win)
    # pixel centres: lon = c + (col + .5) * a, lat = f + (row + .5) * e
    return dem, tr


def compare_with_srtm(dem, tr):
    """Mean and spread of Copernicus minus SRTM (AWS terrarium z15) at a grid of points inside the region."""
    cache, diffs = {}, []
    n = 2 ** 15
    for lat in np.linspace(26.183, 26.201, 12):
        for lon in np.linspace(91.687, 91.703, 12):
            x = (lon + 180) / 360 * n
            y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
            tx, ty = int(x), int(y)
            if (tx, ty) not in cache:
                r = requests.get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/{tx}/{ty}.png", timeout=30)
                cache[(tx, ty)] = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype="float64")
            px = cache[(tx, ty)][min(int((y - ty) * 256), 255), min(int((x - tx) * 256), 255)]
            srtm = px[0] * 256 + px[1] + px[2] / 256 - 32768
            col, row = ~tr * (lon, lat)
            diffs.append(dem[int(row), int(col)] - srtm)
    d = np.array(diffs)
    print(f"Copernicus - SRTM over campus: mean {d.mean():+.1f} m, std {d.std():.1f} m, |max| {np.abs(d).max():.0f} m")


def contours(dem, tr):
    smooth = ndimage.gaussian_filter(dem, 1.2)
    fine = ndimage.zoom(smooth, 3, order=3)              # smoother lines than the 30 m grid
    rows, cols = fine.shape
    lon = tr.c + (np.arange(cols) + .5) / 3 * tr.a
    lat = tr.f + (np.arange(rows) + .5) / 3 * tr.e
    levels = np.arange(math.ceil(fine.min() / STEP) * STEP, fine.max(), STEP)
    cg = contourpy.contour_generator(lon, lat, fine, line_type="SeparateCode")
    kx, ky = 111320 * math.cos(math.radians(26.19)), 110750
    ring = json.loads((ROOT / "data/osm/boundary.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"]["coordinates"][0]
    near_box = (min(x for x, _ in ring) - NEAR_DEG, min(y for _, y in ring) - NEAR_DEG,
                max(x for x, _ in ring) + NEAR_DEG, max(y for _, y in ring) + NEAR_DEG)
    feats = []
    for lv in levels:
        lines, _ = cg.lines(lv)
        for ln in lines:
            if len(ln) < 2:
                continue
            length = float(np.sum(np.hypot(np.diff(ln[:, 0]) * kx, np.diff(ln[:, 1]) * ky)))
            if length < MIN_LEN_M:
                continue
            near = ((ln[:, 0] > near_box[0]) & (ln[:, 0] < near_box[2]) & (ln[:, 1] > near_box[1]) & (ln[:, 1] < near_box[3])).any()
            if not near and int(lv) % INDEX:
                continue                                    # away from campus only the 25 m index lines
            pts = np.vstack([ln[::2], ln[-1:]])                 # every 2nd vertex (~10 m apart) is plenty
            coords = [[round(float(x), 5), round(float(y), 5)] for x, y in pts]   # 5 decimals = ~1 m
            feats.append({"type": "Feature", "properties": {"elev": int(lv), "idx": int(lv) % INDEX == 0},
                          "geometry": {"type": "LineString", "coordinates": coords}})
    return feats, smooth


def peaks(smooth, tr):
    px = 300 / 30                                           # 300 m window in pixels
    is_max = smooth == ndimage.maximum_filter(smooth, size=int(2 * px + 1))
    low = ndimage.minimum_filter(smooth, size=int(2 * px + 1))
    feats = []
    for r, c in zip(*np.nonzero(is_max & (smooth - low >= PROMINENCE))):
        if r in (0, smooth.shape[0] - 1) or c in (0, smooth.shape[1] - 1):
            continue                                        # edge of the window, not a real summit
        lon, lat = tr * (c + .5, r + .5)
        feats.append({"type": "Feature", "properties": {"elev": int(round(smooth[r, c]))},
                      "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}})
    return feats


def tiles(dem, tr):
    """Terrarium PNG tiles (elev = R*256 + G + B/256 - 32768) sampled bilinearly from a lightly smoothed DEM."""
    smooth = ndimage.gaussian_filter(dem, .7)
    count = 0
    for z in ZOOMS:
        n = 2 ** z
        tx0 = int((REGION[0] + 180) / 360 * n)
        tx1 = int((REGION[2] + 180) / 360 * n)
        ty0 = int((1 - math.asinh(math.tan(math.radians(REGION[3]))) / math.pi) / 2 * n)
        ty1 = int((1 - math.asinh(math.tan(math.radians(REGION[1]))) / math.pi) / 2 * n)
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                xs = (tx + (np.arange(256) + .5) / 256) / n * 360 - 180
                ys = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (ty + (np.arange(256) + .5) / 256) / n))))
                LON, LAT = np.meshgrid(xs, ys)
                col = (LON - tr.c) / tr.a - .5
                row = (LAT - tr.f) / tr.e - .5
                elev = ndimage.map_coordinates(smooth, [row, col], order=1, mode="nearest")
                v = elev + 32768
                rgb = np.stack([np.floor(v / 256), np.floor(v % 256), np.floor((v - np.floor(v)) * 256)], -1).astype("uint8")
                path = OUT / "tiles" / str(z) / str(tx) / f"{ty}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(path, optimize=True)
                count += 1
    return count


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    dem, tr = read_dem()
    print(f"DEM window {dem.shape[1]}x{dem.shape[0]} px, {dem.min():.0f}-{dem.max():.0f} m")
    compare_with_srtm(dem, tr)
    lines, smooth = contours(dem, tr)
    pk = peaks(smooth, tr)
    fc = lambda fs: {"type": "FeatureCollection", "features": fs}
    (OUT / "contours.geojson").write_text(json.dumps(fc(lines), separators=(",", ":")), encoding="utf-8")
    (OUT / "peaks.geojson").write_text(json.dumps(fc(pk), separators=(",", ":")), encoding="utf-8")
    print(f"{len(lines)} contour lines, {len(pk)} summits: {sorted(p['properties']['elev'] for p in pk)[-8:]}")
    print(f"{tiles(dem, tr)} terrain tiles")
    meta = {"region": REGION, "zooms": [min(ZOOMS), max(ZOOMS)], "step": STEP, "index": INDEX,
            "source": "Copernicus DEM GLO-30 (© DLR e.V., © Airbus Defence and Space; provided under COPERNICUS by the EU and ESA)"}
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
