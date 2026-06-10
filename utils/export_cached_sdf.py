"""Export already-built SDF tiles from the runtime diskcache into a flat folder.

The DEM providers cache finished SPLAT! ``.sdf`` tiles inside an opaque diskcache (SQLite + blobs).
This pulls the valuable, slow-to-build ones out as plain, canonically-named ``.sdf`` files so they
can be dropped into ``local_sdf/`` and baked into the image (served first by the ``local`` DEM
provider) — instant terrain for areas you've already downloaded, with no re-fetch.

Only depends on ``diskcache`` (pure Python). Run it on the host against ``./splat_cache``, or in
the container against ``/app/.splat_tiles``:

    pip install diskcache
    python utils/export_cached_sdf.py --cache ./splat_cache --out ./local_sdf --products dem

By default it exports LINZ DEM tiles (the expensive ones). Use ``--products dsm`` or ``both``, and
``--include-srtm`` if you also want the cheap-to-refetch global SRTM tiles. LINZ DEM and DSM share
the same SPLAT! filename, so exporting ``both`` into one folder collides — keep them separate or
pick one (the ``local`` provider can't tell DEM from DSM; it serves whatever file matches).
"""

import argparse
import os
import sys

try:
    from diskcache import Cache
except ImportError:
    sys.exit("This script needs diskcache:  pip install diskcache")

_PRODUCT_MAP = {"dem": "dem_1m", "dsm": "dsm_1m"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", default="./splat_cache", help="diskcache directory (default: ./splat_cache)")
    parser.add_argument("--out", default="./local_sdf", help="output folder for .sdf files (default: ./local_sdf)")
    parser.add_argument(
        "--products", choices=["dem", "dsm", "both"], default="dem",
        help="which LINZ product(s) to export (default: dem)",
    )
    parser.add_argument("--include-srtm", action="store_true", help="also export cached SRTM-derived SDFs")
    parser.add_argument("--overwrite", action="store_true", help="overwrite existing files in --out")
    args = parser.parse_args()

    if not os.path.isdir(args.cache):
        return _fail(f"Cache directory '{args.cache}' does not exist.")
    os.makedirs(args.out, exist_ok=True)

    wanted_products = set(_PRODUCT_MAP.values()) if args.products == "both" else {_PRODUCT_MAP[args.products]}

    cache = Cache(args.cache)
    written, skipped, collisions = 0, 0, 0
    try:
        for key in cache:
            sdf_name = _sdf_name_for(key, wanted_products, args.include_srtm)
            if sdf_name is None:
                continue
            # SPLAT! SDF names contain ':' (illegal in Windows filenames). Store the Windows-safe
            # form (':' -> '_'); the `local` DEM provider recognises both. Kept in sync with
            # app.services.terrain_tiles.sdf_disk_name.
            disk_name = sdf_name.replace(":", "_")
            dest = os.path.join(args.out, disk_name)
            if os.path.exists(dest) and not args.overwrite:
                collisions += 1
                print(f"  skip (exists): {disk_name}")
                continue
            data = cache.get(key)
            if not isinstance(data, (bytes, bytearray)):
                skipped += 1
                continue
            with open(dest, "wb") as f:
                f.write(data)
            written += 1
            print(f"  wrote: {disk_name} ({len(data) // 1024} KiB)")
    finally:
        cache.close()

    print(f"\nExported {written} SDF tile(s) to {args.out}. "
          f"{collisions} already present, {skipped} non-tile entries skipped.")
    if collisions and not args.overwrite:
        print("Re-run with --overwrite to replace existing files.")
    return 0


def _sdf_name_for(key, wanted_products, include_srtm):
    """Return the canonical .sdf filename to write for a cache key, or None to skip it."""
    if not isinstance(key, str):
        return None
    if key.startswith("linz:"):
        # "linz:<product>:<sdf-name>"  — sdf-name itself contains colons, so split only twice.
        parts = key.split(":", 2)
        if len(parts) == 3 and parts[1] in wanted_products and parts[2].endswith(".sdf"):
            return parts[2]
        return None
    # SRTM-derived entries are cached under the bare SDF name; raw .hgt.gz tiles and the LINZ
    # index/item lists are skipped.
    if include_srtm and key.endswith(".sdf"):
        return key
    return None


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
