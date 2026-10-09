"""Climate normals for the Seasons card, month by month, at the campus.

    python scripts/build_climate.py

Rain: CHIRPS v2.0 (Climate Hazards Center, UC Santa Barbara; station-blended satellite rainfall, 0.05 deg, public
domain). Monthly totals 1995-2024; rainy days (>= 2.5 mm, IMD's definition) and heavy-rain days (>= 64.5 mm, IMD's
"heavy") from the daily files 2010-2024. CHIRPS gives ~1740 mm a year here, in line with IMD's Guwahati normal
(~1720 mm); ERA5 rain was rejected because it drizzles too often (~2800 mm, 160 rainy days).
Temperature, "feels like", humidity, dew point: ERA5 / ERA5-Land reanalysis (Copernicus C3S / ECMWF) 1995-2024 via
the Open-Meteo historical weather API (CC BY 4.0). Area averages on a ~10-25 km grid; ERA5 runs ~2 C warm on winter
nights compared with the Guwahati airport normals.
Raw downloads are cached in .cache/ (the CHIRPS daily pass reads ~5500 files and takes ~20 min the first time).
Output: data/climate.json.
"""
import datetime
import json
import os
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import mean

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
import rasterio  # noqa: E402
import requests  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
LAT, LON = 26.1915, 91.6935          # campus centre
YEARS = (1995, 2024)                 # ERA5 and CHIRPS monthly
DAILY_YEARS = (2010, 2024)           # CHIRPS daily (rainy-day counts)
RAIN_DAY_MM, HEAVY_MM = 2.5, 64.5
ERA5 = ["temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
        "relative_humidity_2m_mean", "dew_point_2m_mean"]
CHC = "/vsicurl/https://data.chc.ucsb.edu/products/CHIRPS-2.0"


def cached(name, make):
    f = CACHE / name
    if not f.exists():
        CACHE.mkdir(exist_ok=True)
        f.write_text(json.dumps(make()), encoding="utf-8")
    return json.loads(f.read_text(encoding="utf-8"))


def era5():
    r = requests.get("https://archive-api.open-meteo.com/v1/archive", timeout=300, params={
        "latitude": LAT, "longitude": LON, "start_date": f"{YEARS[0]}-01-01", "end_date": f"{YEARS[1]}-12-31",
        "daily": ",".join(ERA5), "timezone": "Asia/Kolkata"})
    r.raise_for_status()
    return r.json()["daily"]


def pixel(url):
    for _ in range(3):
        try:
            with rasterio.open(url) as ds:
                return float(next(ds.sample([(LON, LAT)]))[0])
        except Exception:
            time.sleep(2)
    return None


def chirps_monthly():
    keys = [(y, m) for y in range(YEARS[0], YEARS[1] + 1) for m in range(1, 13)]
    with ThreadPoolExecutor(12) as ex:
        vals = ex.map(lambda k: pixel(f"{CHC}/global_monthly/cogs/chirps-v2.0.{k[0]}.{k[1]:02d}.cog"), keys)
        return [[y, m, v] for (y, m), v in zip(keys, vals)]


def chirps_daily():
    d0, d1 = datetime.date(DAILY_YEARS[0], 1, 1), datetime.date(DAILY_YEARS[1], 12, 31)
    days = [d0 + datetime.timedelta(i) for i in range((d1 - d0).days + 1)]
    with ThreadPoolExecutor(24) as ex:
        vals = ex.map(lambda d: pixel(f"{CHC}/global_daily/cogs/p05/{d.year}/chirps-v2.0.{d:%Y.%m.%d}.cog"), days)
        return [[d.year, d.month, d.day, v] for d, v in zip(days, vals)]


def main():
    e = cached("era5_daily.json", era5)
    mon = cached("chirps_monthly.json", chirps_monthly)
    day = cached("chirps_daily.json", chirps_daily)
    by = defaultdict(lambda: defaultdict(list))
    for i, t in enumerate(e["time"]):
        for v in ERA5:
            if e[v][i] is not None:
                by[int(t[5:7])][v].append(e[v][i])
    rain = defaultdict(list)
    for y, m, v in mon:
        if v is not None:
            rain[m].append(v)
    rainy, heavy = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
    for y, m, d, v in day:
        rainy[m][y] += 0                                  # every month-year counts, even a dry one
        heavy[m][y] += 0
        if v is not None:
            rainy[m][y] += v >= RAIN_DAY_MM
            heavy[m][y] += v >= HEAVY_MM
    missing = sum(v is None for *_, v in day) + sum(v is None for *_, v in mon)
    months = []
    for m in range(1, 13):
        b = by[m]
        months.append({
            "month": m,
            "tmax": round(mean(b["temperature_2m_max"]), 1),
            "tmin": round(mean(b["temperature_2m_min"]), 1),
            "feels": round(mean(b["apparent_temperature_max"]), 1),       # typical afternoon "feels like"
            "humidity": round(mean(b["relative_humidity_2m_mean"])),
            "dew": round(mean(b["dew_point_2m_mean"]), 1),
            "rain_mm": round(mean(rain[m])),
            "rain_days": round(mean(rainy[m].values()), 1),
            "heavy_days": round(mean(heavy[m].values()), 1),
        })
    out = {"lat": LAT, "lon": LON, "years": list(YEARS), "rain_years": list(YEARS), "rain_day_years": list(DAILY_YEARS),
           "rain_day_mm": RAIN_DAY_MM, "heavy_mm": HEAVY_MM,
           "source": "Rain: CHIRPS v2.0 (UCSB Climate Hazards Center). Temperature/humidity: ERA5 via Open-Meteo (CC BY 4.0); contains modified Copernicus Climate Change Service information 1995-2024.",
           "months": months}
    (ROOT / "data" / "climate.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"missing values: {missing}")
    print(f"annual rain {sum(x['rain_mm'] for x in months)} mm, rainy days {sum(x['rain_days'] for x in months):.0f}, "
          f"heavy-rain days {sum(x['heavy_days'] for x in months):.1f}")
    for x in months:
        print(x)


if __name__ == "__main__":
    main()
