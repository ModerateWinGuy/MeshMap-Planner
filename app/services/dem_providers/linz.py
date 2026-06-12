"""
LINZ (Land Information New Zealand) live LIDAR provider.

Fetches 1 m DEM/DSM tiles on demand from the public ``nz-elevation`` AWS Open Data bucket
(anonymous, Cloud-Optimised GeoTIFF, EPSG:2193), mosaics the tiles covering a 1-degree cell,
reprojects to WGS84, downsamples to the SPLAT! grid, and converts to ``.sdf`` with srtm2sdf. No
bulk download: only the COGs intersecting a request are touched, and the resulting SDF is cached.

Coverage is New Zealand only; for any cell outside NZ (or any unmapped/failed cell) the provider
returns ``None`` so the chain falls through to the global SRTM source. Because it is never the last
provider, **any** failure here (discovery, network, GDAL) degrades to ``None`` rather than raising,
so a LINZ hiccup can never break a prediction that SRTM could otherwise serve.

The data resolution caveat is real: SPLAT!'s SDF format caps at ~1 arc-second (~30 m), so 1 m
LIDAR is downsampled. The gain is LIDAR vertical accuracy and — with DSM — real building/canopy
heights, not true 1 m-grid propagation.

STAC layout (https://github.com/linz/elevation): a root ``catalog.json`` links down through
region catalogs to per-survey ``Collection`` JSONs, each with a spatial ``extent.bbox`` and
``item`` links; each item is one COG tile with its own ``bbox`` and a GeoTIFF asset. Product
(DEM vs DSM) and resolution are encoded in the asset path (``.../{dem,dsm}_1m/2193/<tile>.tiff``).
"""

import json
import logging
import os
import subprocess
import tempfile
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import List, Mapping, Optional, Tuple
from urllib.parse import urljoin

from diskcache import Cache

from app.services.dem_providers.base import DEMProvider, TerrainTile
from app.services.dem_providers import register_provider
from app.services.progress import report as report_progress

logger = logging.getLogger(__name__)

# Default NZ mainland + offshore bounding box (west, south, east, north) in WGS84.
_DEFAULT_NZ_BBOX = (166.0, -47.5, 179.5, -34.0)
_DEFAULT_CATALOG = "https://nz-elevation.s3-ap-southeast-2.amazonaws.com/catalog.json"
# Public HTTPS base for COG assets, used with GDAL's /vsicurl/ so only needed windows are read.
_HTTPS_BASE = "https://nz-elevation.s3-ap-southeast-2.amazonaws.com/"
_S3_BASE = "s3://nz-elevation/"

_INDEX_TTL_SECONDS = 7 * 24 * 3600  # re-walk the catalog weekly
_ITEM_FETCH_WORKERS = 24            # concurrent item.json fetches when indexing a survey

# GDAL settings that make /vsicurl reads of COGs fast: skip directory probing, only consider the
# COG extensions, cache reads, and merge adjacent byte-range requests into far fewer HTTP calls.
_GDAL_VSICURL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff",
    "VSI_CACHE": "TRUE",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_NUM_THREADS": "ALL_CPUS",
    "AWS_NO_SIGN_REQUEST": "YES",
}


@register_provider
class LinzProvider(DEMProvider):
    name = "linz"

    def __init__(
        self,
        splat_path: str,
        cache_dir: str = ".splat_tiles",
        bbox: Tuple[float, float, float, float] = _DEFAULT_NZ_BBOX,
        catalog_url: str = _DEFAULT_CATALOG,
        resample: str = "bilinear",
        fill_voids: bool = True,
        max_catalog_nodes: int = 5000,
    ):
        self.srtm2sdf_binary = os.path.join(splat_path, "srtm2sdf")
        self.srtm2sdf_hd_binary = os.path.join(splat_path, "srtm2sdf-hd")
        self.cache = Cache(cache_dir)
        self.bbox = bbox
        self.catalog_url = catalog_url
        self.resample = resample
        self.fill_voids = fill_voids
        self.max_catalog_nodes = max_catalog_nodes
        logger.info("LINZ provider ready (coverage bbox %s, catalog %s).", bbox, catalog_url)

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "LinzProvider":
        bbox_str = env.get("LINZ_BBOX")
        bbox = _DEFAULT_NZ_BBOX
        if bbox_str:
            try:
                parts = tuple(float(x) for x in bbox_str.split(","))
                if len(parts) == 4:
                    bbox = parts  # type: ignore[assignment]
                else:
                    logger.warning("LINZ_BBOX '%s' is not 'w,s,e,n'; using default.", bbox_str)
            except ValueError:
                logger.warning("LINZ_BBOX '%s' is not parseable; using default.", bbox_str)
        return cls(
            splat_path=env.get("SPLAT_PATH", "/app/splat"),
            cache_dir=env.get("SPLAT_CACHE_DIR", ".splat_tiles"),
            bbox=bbox,
            catalog_url=env.get("LINZ_CATALOG_URL", _DEFAULT_CATALOG),
            resample=env.get("LINZ_RESAMPLE", "bilinear"),
            fill_voids=env.get("LINZ_FILL_VOIDS", "1") == "1",
        )

    # ------------------------------------------------------------------ #
    # Provider contract
    # ------------------------------------------------------------------ #
    def try_get_sdf(self, tile: TerrainTile) -> Optional[bytes]:
        # 0. Only serve when the caller asked for a LINZ product. 'srtm' (or anything else) means the
        # user explicitly wants the global SRTM baseline, so defer to the next provider in the chain.
        if tile.terrain_source not in ("dem", "dsm"):
            return None

        # 1. Cheap coverage gate — no network for the rest of the planet.
        if not self._cell_intersects(tile.lat, tile.lon, self.bbox):
            return None

        product = "dsm_1m" if tile.terrain_source == "dsm" else "dem_1m"
        cache_key = f"linz:{product}:{tile.sdf_filename}"
        if cache_key in self.cache:
            logger.info("Cache hit: %s.", cache_key)
            return self.cache[cache_key]

        # 2. Any failure past here degrades to None (fall through to SRTM), never raises.
        try:
            cog_urls = self._discover_cog_urls(tile, product)
            if not cog_urls:
                logger.info("LINZ has no %s coverage for cell (%d,%d); deferring.", product, tile.lat, tile.lon)
                return None
            sdf = self._build_sdf(tile, cog_urls)
            if sdf is None:
                return None
            self.cache[cache_key] = sdf
            logger.info("Built and cached LINZ %s SDF %s from %d COG(s).", product, tile.sdf_filename, len(cog_urls))
            return sdf
        except Exception as e:  # noqa: BLE001 — deliberate: LINZ must never break the chain.
            logger.warning("LINZ provider failed for cell (%d,%d), deferring to next source: %s", tile.lat, tile.lon, e)
            return None

    # ------------------------------------------------------------------ #
    # Coverage
    # ------------------------------------------------------------------ #
    def covers(self, west: float, south: float, east: float, north: float) -> bool:
        """True if a WGS84 ``(w, s, e, n)`` box intersects this provider's NZ coverage bbox.

        Public so the map's XYZ tile endpoint can gate on the configured ``LINZ_BBOX`` (honouring
        any override) before doing any network work, exactly as ``try_get_sdf`` gates per cell.
        """
        return _bbox_intersects((west, south, east, north), self.bbox)

    # ------------------------------------------------------------------ #
    # STAC discovery
    # ------------------------------------------------------------------ #
    def discover_cog_urls_for_bbox(self, bbox: Tuple[float, float, float, float], product: str) -> List[str]:
        """COG asset URLs (as /vsicurl/ paths) for ``product`` intersecting an arbitrary WGS84
        ``(w, s, e, n)`` bbox. Shares the weekly-cached STAC index with the SDF cell path, so the
        map endpoint and the simulation pay the catalog walk only once between them."""
        collections = self._collection_index()  # cached survey extents
        matching = [
            c for c in collections
            if c.get("product") == product and _bbox_intersects(bbox, c["bbox"])
        ]
        urls: List[str] = []
        for coll in matching:
            items = self._collection_items(coll["url"])  # cached per collection
            hits = [it for it in items if it.get("href") and _bbox_intersects(bbox, it["bbox"])]
            urls.extend(_to_vsicurl(it["href"]) for it in hits)
        return urls

    def _discover_cog_urls(self, tile: TerrainTile, product: str) -> List[str]:
        """COG asset URLs (as /vsicurl/ paths) for ``product`` intersecting this 1-degree cell."""
        cell = (tile.lon, tile.lat, tile.lon + 1, tile.lat + 1)  # (w, s, e, n)
        collections = self._collection_index()  # cached survey extents

        matching = [
            c for c in collections
            if c.get("product") == product and _bbox_intersects(cell, c["bbox"])
        ]
        logger.info(
            "LINZ: %d %s survey(s) intersect cell (%d,%d); indexing their tiles "
            "(first build of a cell is slow, then cached)...",
            len(matching), product, tile.lat, tile.lon,
        )

        urls: List[str] = []
        for coll in matching:
            items = self._collection_items(coll["url"])  # cached per collection
            hits = [it for it in items if it.get("href") and _bbox_intersects(cell, it["bbox"])]
            logger.info("LINZ:   %d/%d tiles of %s intersect the cell.", len(hits), len(items), _survey_label(coll["url"]))
            urls.extend(_to_vsicurl(it["href"]) for it in hits)
        return urls

    def _collection_index(self) -> List[dict]:
        """Walk the catalog once (cached) into a flat list of survey collections, each with its
        product, WGS84 bbox, and self URL. Cached for a week so only the first NZ request pays."""
        cached = self.cache.get("linz:index")
        if cached is not None:
            return cached

        logger.info("LINZ: building the survey index from %s (one-off, cached for a week)...", self.catalog_url)
        report_progress("Building LINZ survey index (first run only)…")
        collections: List[dict] = []
        seen = 0
        stack = [self.catalog_url]
        visited = set()
        while stack:
            if seen and seen % 100 == 0:
                logger.info("LINZ: walked %d catalog nodes, %d surveys so far...", seen, len(collections))
                # Surveys are found sparsely, so report the node count too — it advances every batch
                # and reassures the user the walk is progressing between survey hits.
                report_progress(
                    f"Building LINZ survey index ({len(collections)} surveys found, "
                    f"{seen} nodes scanned)…"
                )
            if seen >= self.max_catalog_nodes:
                logger.warning(
                    "LINZ catalog walk hit the %d-node cap; index may be incomplete.", self.max_catalog_nodes
                )
                break
            url = stack.pop()
            if url in visited:
                continue
            visited.add(url)
            seen += 1
            doc = _fetch_json(url)
            if doc is None:
                continue
            doc_type = doc.get("type")
            if doc_type == "Collection":
                bbox = _collection_bbox(doc)
                if bbox:
                    collections.append({"url": url, "bbox": bbox, "product": _product_of(url, doc)})
                continue
            # Catalog: descend into child links only. Items are fetched lazily, per collection,
            # in _collection_items — queuing them here would waste fetches on the whole dataset.
            for link in doc.get("links", []):
                if link.get("rel") == "child" and link.get("href"):
                    stack.append(urljoin(url, link["href"]))

        self.cache.set("linz:index", collections, expire=_INDEX_TTL_SECONDS)
        logger.info("Indexed %d LINZ survey collections.", len(collections))
        return collections

    def _collection_items(self, collection_url: str) -> List[dict]:
        """Item bboxes + asset hrefs for a survey collection (cached per collection).

        A survey lists each 1 m tile as a separate STAC item whose bbox we need, so this fetches
        many small JSONs. They're fetched concurrently (and the whole result cached for a week) so
        the first build of a cell is minutes, not tens of minutes, and later builds are instant.
        """
        key = f"linz:items:{collection_url}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        doc = _fetch_json(collection_url)
        if doc is None:
            return []
        item_urls = [
            urljoin(collection_url, link["href"])
            for link in doc.get("links", [])
            if link.get("rel") == "item" and link.get("href")
        ]
        logger.info("LINZ:   fetching %d tile records for %s ...", len(item_urls), _survey_label(collection_url))
        report_progress(f"Indexing LINZ survey {_survey_label(collection_url)} (0/{len(item_urls)} tiles)…")

        items: List[dict] = []
        done = 0
        with ThreadPoolExecutor(max_workers=_ITEM_FETCH_WORKERS) as pool:
            for result in pool.map(_fetch_item_record, item_urls):
                done += 1
                if result is not None:
                    items.append(result)
                if done % 250 == 0:
                    logger.info("LINZ:     indexed %d/%d tiles...", done, len(item_urls))
                    report_progress(f"Indexing LINZ survey {_survey_label(collection_url)} ({done}/{len(item_urls)} tiles)…")

        self.cache.set(key, items, expire=_INDEX_TTL_SECONDS)
        return items

    # ------------------------------------------------------------------ #
    # GDAL: mosaic -> warp/reproject/downsample -> SRTMHGT -> srtm2sdf
    # ------------------------------------------------------------------ #
    def _build_sdf(self, tile: TerrainTile, cog_urls: List[str]) -> Optional[bytes]:
        samples = 3601 if tile.high_resolution else 1201  # SDF grid cap: 1-arcsec / 3-arcsec
        hgt_name = tile.hgt_name.replace(".gz", "")  # e.g. "S41E174.hgt"
        with tempfile.TemporaryDirectory() as tmp:
            list_path = os.path.join(tmp, "cogs.txt")
            with open(list_path, "w", encoding="utf-8") as f:
                f.write("\n".join(cog_urls))

            vrt = os.path.join(tmp, "mosaic.vrt")
            cell_tif = os.path.join(tmp, "cell.tif")
            hgt_path = os.path.join(tmp, hgt_name)

            logger.info("LINZ: mosaicking %d COG(s) for %s (gdalbuildvrt)...", len(cog_urls), tile.sdf_filename)
            report_progress(f"Mosaicking {len(cog_urls)} LINZ LIDAR tiles…")
            _run(["gdalbuildvrt", "-input_file_list", list_path, vrt])
            logger.info(
                "LINZ: warping to %dx%d EPSG:4326 — reading windows from %d remote COG(s); "
                "this is the slow step on a cold cell...", samples, samples, len(cog_urls),
            )
            total = len(cog_urls)
            report_progress(f"Downloading & warping LINZ terrain (0/{total} tiles)…")
            # gdalwarp reads the whole mosaic in one pass, so there's no literal per-tile loop to
            # count; -progress gives us a 0..100% meter on stdout, which we map onto the tile total
            # so the message visibly advances ("47/312 tiles") through this slow remote-read step.
            _run_progress([
                "gdalwarp", "-progress",
                "-t_srs", "EPSG:4326",
                "-te", str(tile.lon), str(tile.lat), str(tile.lon + 1), str(tile.lat + 1),
                "-ts", str(samples), str(samples),
                "-r", self.resample,
                "-dstnodata", "-32768",
                "-multi", "-overwrite", vrt, cell_tif,
            ], on_fraction=lambda frac: report_progress(
                f"Downloading & warping LINZ terrain ({round(frac * total)}/{total} tiles)…"
            ))
            if self.fill_voids:
                self._fill_voids(cell_tif)
            logger.info("LINZ: writing SRTMHGT and converting with srtm2sdf...")
            report_progress("Converting LINZ terrain to SPLAT! format…")
            _run(["gdal_translate", "-of", "SRTMHGT", cell_tif, hgt_path])

            cmd = self.srtm2sdf_hd_binary if tile.high_resolution else self.srtm2sdf_binary
            _run([cmd, os.path.basename(hgt_path)], cwd=tmp)

            sdf_path = os.path.join(tmp, tile.sdf_filename)
            if not os.path.isfile(sdf_path):
                logger.warning("srtm2sdf did not produce expected SDF %s for LINZ cell.", tile.sdf_filename)
                return None
            with open(sdf_path, "rb") as sdf_file:
                return sdf_file.read()

    @staticmethod
    def _fill_voids(tif_path: str) -> None:
        """Fill nodata gaps where COG coverage is partial within the cell, so SPLAT! doesn't see
        ``-32768`` sinks. Best-effort and non-fatal: gdal_fillnodata ships under a few entry-point
        names and is happier writing a new file than editing in place, so we write a sibling and
        swap it in. If none of the variants work, we keep the unfilled tile and move on."""
        filled = tif_path + ".filled.tif"
        variants = (
            ["gdal_fillnodata", "-md", "50", "-of", "GTiff", tif_path, filled],
            ["gdal_fillnodata.py", "-md", "50", "-of", "GTiff", tif_path, filled],
            ["python3", "-m", "osgeo_utils.gdal_fillnodata", "-md", "50", "-of", "GTiff", tif_path, filled],
        )
        for cmd in variants:
            try:
                _run(cmd)
                os.replace(filled, tif_path)
                logger.info("LINZ: filled nodata gaps in the cell raster.")
                return
            except FileNotFoundError:
                continue  # this entry point isn't installed; try the next
            except subprocess.CalledProcessError as e:
                logger.debug("gdal_fillnodata via %s failed: %s", cmd[0], (e.stderr or "").strip()[:300])
                continue
        logger.info("LINZ: void fill unavailable; leaving minor gaps as nodata (non-fatal).")

    @staticmethod
    def _cell_intersects(lat: int, lon: int, bbox: Tuple[float, float, float, float]) -> bool:
        return _bbox_intersects((lon, lat, lon + 1, lat + 1), bbox)


# --------------------------------------------------------------------------- #
# Module helpers (pure / IO), kept free of provider state for easy testing.
# --------------------------------------------------------------------------- #
def _bbox_intersects(a: Tuple[float, float, float, float], b) -> bool:
    """True if two ``(west, south, east, north)`` boxes overlap (shared edges count)."""
    aw, as_, ae, an = a
    bw, bs, be, bn = b[0], b[1], b[2], b[3]
    return not (ae < bw or aw > be or an < bs or as_ > bn)


def _fetch_json(url: str, timeout: float = 20.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # nosec B310 — fixed https host
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 — discovery is best-effort; caller degrades to None.
        logger.debug("LINZ fetch failed for %s: %s", url, e)
        return None


def _collection_bbox(doc: dict):
    """Extract the first WGS84 ``[w, s, e, n]`` from a STAC Collection's spatial extent."""
    try:
        bbox = doc["extent"]["spatial"]["bbox"][0]
        return (bbox[0], bbox[1], bbox[2], bbox[3])
    except (KeyError, IndexError, TypeError):
        return None


def _product_of(url: str, doc: dict) -> Optional[str]:
    """Classify a collection as ``dem_1m`` or ``dsm_1m`` from its URL or asset paths."""
    hay = url.lower()
    if "dsm_1m" in hay:
        return "dsm_1m"
    if "dem_1m" in hay:
        return "dem_1m"
    # Fall back to scanning a sample asset/link href.
    for link in doc.get("links", []):
        href = (link.get("href") or "").lower()
        if "dsm_1m" in href:
            return "dsm_1m"
        if "dem_1m" in href:
            return "dem_1m"
    return None


def _first_geotiff_asset(item_doc: dict, item_url: str) -> Optional[str]:
    """Absolute href of the first GeoTIFF asset in a STAC item."""
    for asset in (item_doc.get("assets") or {}).values():
        href = asset.get("href")
        if not href:
            continue
        media = (asset.get("type") or "").lower()
        if "tiff" in media or href.lower().endswith((".tif", ".tiff")):
            return urljoin(item_url, href)
    return None


def _to_vsicurl(href: str) -> str:
    """Turn an S3/HTTPS COG href into a GDAL ``/vsicurl/`` path for windowed anonymous reads."""
    if href.startswith("s3://"):
        href = href.replace(_S3_BASE, _HTTPS_BASE, 1) if href.startswith(_S3_BASE) else href
    if href.startswith("/vsicurl/"):
        return href
    return "/vsicurl/" + href


def _survey_label(collection_url: str) -> str:
    """Short human label for a survey from its collection URL (the survey folder name)."""
    parts = [p for p in collection_url.split("/") if p and not p.endswith(".json")]
    return parts[-3] if len(parts) >= 3 else collection_url


def _fetch_item_record(item_url: str) -> Optional[dict]:
    """Fetch one STAC item and reduce it to ``{bbox, href}`` (or None). Used in the thread pool."""
    item_doc = _fetch_json(item_url)
    if item_doc is None or "bbox" not in item_doc:
        return None
    href = _first_geotiff_asset(item_doc, item_url)
    return {"bbox": item_doc["bbox"], "href": href} if href else None


def _run(cmd: List[str], cwd: Optional[str] = None) -> None:
    """Run a GDAL/srtm2sdf command with /vsicurl-tuned env, raising captured stderr on failure."""
    env = {**os.environ, **_GDAL_VSICURL_ENV}
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, cmd, result.stdout, result.stderr)


def _run_progress(cmd: List[str], on_fraction, cwd: Optional[str] = None) -> None:
    """Like :func:`_run`, but streams GDAL's ``-progress`` meter and calls ``on_fraction(0..1)`` as
    it advances, so a long-running warp surfaces live progress instead of a frozen message.

    GDAL prints the meter to stdout as ``0...10...20...100 - done.`` and flushes after each token,
    so we read a character at a time and emit a fraction whenever a complete percent integer lands.
    stderr is drained on a side thread to avoid a full-pipe deadlock and reused for the error on a
    non-zero exit, matching :func:`_run`'s contract.
    """
    env = {**os.environ, **_GDAL_VSICURL_ENV}
    proc = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
    )
    stderr_chunks: List[str] = []
    stderr_thread = threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read() or ""))
    stderr_thread.start()

    digits = ""
    last_pct = -1
    while True:
        ch = proc.stdout.read(1)
        if not ch:
            break
        if ch.isdigit():
            digits += ch
            continue
        if digits:
            pct = int(digits)
            digits = ""
            if 0 <= pct <= 100 and pct != last_pct:
                last_pct = pct
                on_fraction(pct / 100.0)

    proc.wait()
    stderr_thread.join()
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd, "", "".join(stderr_chunks))
