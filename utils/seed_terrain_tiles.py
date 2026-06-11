"""Pre-seed the 3D-map terrain tile cache for all of New Zealand at the lower zoom levels.

Live LINZ tiles render on demand (the backend warps a COG window per tile), which is slow the first
time you visit an area. This walks the whole NZ bounding box at a range of zooms and renders every
tile through the same `TerrainXyzService` the API uses, so the cache is warm and the zoomed-out 3D
terrain is there immediately instead of trickling in.

Idempotent and resumable: already-cached tiles are skipped instantly, so you can stop (Ctrl-C) and
re-run, or extend the zoom range later. Ocean tiles with no LINZ coverage are skipped cheaply (no
network). It writes into the SAME diskcache the running app reads (``SPLAT_CACHE_DIR/xyz``), so run
it where the geospatial stack and that cache live — i.e. in the container:

    docker-compose exec app python utils/seed_terrain_tiles.py --sources dem --minzoom 11 --maxzoom 12

Defaults to the LINZ DEM band z11–12 (the lowest-res LINZ levels, a few thousand land tiles). Add
``--sources dsm`` / ``both`` and raise ``--maxzoom`` (e.g. 13) for finer pre-seeding — each extra
zoom is ~4x the tiles. Below the backend's LINZ_TILE_MINZOOM the map already uses fast AWS Terrarium,
so there's nothing to seed there.
"""

import argparse
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# Running `python utils/seed_terrain_tiles.py` puts utils/ on sys.path, not the repo root, so the
# `app` package wouldn't import. Add the repo root (this file's grandparent) so the script works no
# matter how it's launched (plain path, -m, or from another cwd).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_PRODUCT_LABEL = {"dem": "LINZ DEM", "dsm": "LINZ DSM"}


def _lon_to_x(lon: float, z: int) -> int:
    return int((lon + 180.0) / 360.0 * (2 ** z))


def _lat_to_y(lat: float, z: int) -> int:
    lat = max(-85.05112878, min(85.05112878, lat))
    r = math.radians(lat)
    return int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (2 ** z))


def _tiles_for_bbox(west, south, east, north, z):
    """All XYZ tiles intersecting a WGS84 bbox at zoom z (north edge -> smaller y)."""
    x0, x1 = _lon_to_x(west, z), _lon_to_x(east, z)
    y0, y1 = _lat_to_y(north, z), _lat_to_y(south, z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sources", choices=["dem", "dsm", "both"], default="dem",
                        help="which LINZ product(s) to seed (default: dem)")
    parser.add_argument("--minzoom", type=int, default=None, help="lowest zoom (default: the backend LINZ_TILE_MINZOOM)")
    parser.add_argument("--maxzoom", type=int, default=12, help="highest zoom to seed (default: 12)")
    parser.add_argument("--concurrency", type=int, default=8, help="parallel tile renders (default: 8)")
    parser.add_argument("--bbox", default=None, help="override coverage bbox as 'w,s,e,n' (default: the LINZ bbox)")
    args = parser.parse_args()

    # Build only the LINZ provider + the tile service, reading the same env the app uses. Importing the
    # provider package pulls the geospatial stack; fail with a clear message if it's absent (run in the
    # container, not on the host).
    try:
        from app.services.dem_providers import build_providers
        from app.services.terrain_tiles_xyz import TerrainXyzService
    except Exception as e:  # noqa: BLE001
        return _fail(f"Could not import the terrain stack ({e}). Run this in the app container.")

    try:
        linz = build_providers(["linz"], os.environ)[0]
    except Exception as e:  # noqa: BLE001
        return _fail(f"Could not build the LINZ provider: {e}")
    service = TerrainXyzService.from_env(linz, os.environ)

    if service.linz is None:
        return _fail("LINZ provider unavailable — nothing to seed.")

    bbox = _parse_bbox(args.bbox) if args.bbox else linz.bbox
    if bbox is None:
        return _fail(f"--bbox '{args.bbox}' is not 'w,s,e,n'.")

    sources = ["dem", "dsm"] if args.sources == "both" else [args.sources]
    z_lo = args.minzoom if args.minzoom is not None else service.minzoom

    for source in sources:
        z_hi = min(args.maxzoom, service.maxzoom[source])
        lo = max(z_lo, service.minzoom)
        if lo > z_hi:
            print(f"{_PRODUCT_LABEL[source]}: nothing to do (requested z{z_lo}-{args.maxzoom} is outside "
                  f"the served band z{service.minzoom}-{service.maxzoom[source]}).")
            continue
        print(f"\n=== Seeding {_PRODUCT_LABEL[source]} z{lo}-{z_hi} over bbox {bbox} ===")
        for z in range(lo, z_hi + 1):
            _seed_zoom(service, source, z, bbox, args.concurrency)

    print("\nDone.")
    return 0


def _seed_zoom(service, source: str, z: int, bbox, concurrency: int) -> None:
    tiles = list(_tiles_for_bbox(bbox[0], bbox[1], bbox[2], bbox[3], z))
    total = len(tiles)
    print(f"  z{z}: {total} tiles in bbox …")

    rendered = cached = empty = errors = 0
    done = 0
    started = time.monotonic()

    def work(tile):
        x, y = tile
        # Mirror render_tile's cache key so already-warm tiles skip the covers/discover/render path.
        if f"{source}:{z}:{x}:{y}" in service.cache:
            return "cached"
        try:
            return "rendered" if service.render_tile(source, z, x, y) is not None else "empty"
        except Exception:  # noqa: BLE001 — a single bad tile must not abort the whole sweep
            return "error"

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(work, t) for t in tiles]
        for fut in as_completed(futures):
            result = fut.result()
            rendered += result == "rendered"
            cached += result == "cached"
            empty += result == "empty"
            errors += result == "error"
            done += 1
            if done % 200 == 0 or done == total:
                rate = done / max(time.monotonic() - started, 1e-6)
                remaining = (total - done) / rate if rate else 0
                print(f"    {done}/{total}  (new {rendered}, cached {cached}, empty {empty}, "
                      f"err {errors})  {rate:.0f} tiles/s, ~{remaining:.0f}s left", flush=True)

    print(f"  z{z} done: {rendered} rendered, {cached} already cached, {empty} no-coverage, {errors} errors.")


def _parse_bbox(text):
    try:
        parts = tuple(float(v) for v in text.split(","))
        return parts if len(parts) == 4 else None
    except ValueError:
        return None


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
