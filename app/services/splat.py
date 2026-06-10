import glob
import logging
import math
import os
import io
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from typing import Literal, List, Optional, Tuple

from haversine import haversine, Unit

import matplotlib.pyplot as plt
import numpy as np
import rasterio
from rasterio.transform import from_bounds, from_origin
from rasterio.features import shapes as rasterio_shapes
from PIL import Image

from app.models.CoveragePredictionRequest import CoveragePredictionRequest
from app.models.LinkRequest import LinkRequest
from app.models.RelayRequest import RelayRequest
from app.services.terrain_tiles import calculate_required_tiles, calculate_p2p_tiles
from app.services.dem_providers.base import TerrainTile
from app.services.progress import report as report_progress


logger = logging.getLogger(__name__)
logging.getLogger("boto3").setLevel(logging.WARNING)
logging.getLogger("botocore").setLevel(logging.WARNING)
logging.getLogger("s3transfer").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)


class Splat:
    def __init__(self, splat_path: str, dem_providers):
        """
        SPLAT! wrapper class. Generates RF coverage maps and point-to-point link reports.

        SPLAT! and its optional high-resolution variant (`splat`, `splat-hd`) must be installed in
        the `splat_path` directory and be executable. Terrain provisioning — locating/fetching and
        converting the `.sdf` tiles SPLAT! reads — is delegated to a chain of DEM providers; see
        `app.services.dem_providers`.

        See the SPLAT! documentation: https://www.qsl.net/kd2bd/splat.html
        Additional details: https://github.com/jmcmellen/splat

        Args:
            splat_path (str): Path to the directory containing the SPLAT! binaries.
            dem_providers (list[DEMProvider]): Terrain sources in precedence order. The first to
                supply a given 1-degree tile wins. Assembled by `dem_providers.build_providers`.
        """

        # Check the provided SPLAT! path exists
        if not os.path.isdir(splat_path):
            raise FileNotFoundError(
                f"Provided SPLAT! path '{splat_path}' is not a valid directory."
            )

        # SPLAT! binaries: core program and the 1-arcsecond / 30 m high-resolution variant. The
        # srtm2sdf converters live with the DEM providers that need them, not here.
        self.splat_binary = os.path.join(splat_path, "splat")
        self.splat_hd_binary = os.path.join(splat_path, "splat-hd")
        for binary in (self.splat_binary, self.splat_hd_binary):
            if not os.path.isfile(binary) or not os.access(binary, os.X_OK):
                raise FileNotFoundError(f"SPLAT! binary not found or not executable at '{binary}'")

        if not dem_providers:
            raise ValueError("Splat requires at least one DEM provider.")
        self.dem_providers = dem_providers

        logger.info(
            "Initialized SPLAT! with DEM providers (in precedence order): %s",
            [p.name for p in dem_providers],
        )

    def _provision_sdf_tiles(self, tmpdir, required_tiles, high_resolution, terrain_source):
        """Ensure every required `.sdf` tile exists in `tmpdir`, consulting DEM providers in
        precedence order.

        The first provider to return bytes for a tile wins; if none can supply a tile, the request
        fails (terrain is mandatory). SPLAT! later finds the tiles purely by filename in its working
        directory, so each provider only has to emit the canonical SDF name.
        """
        total = len(required_tiles)
        for index, tile_tuple in enumerate(required_tiles):
            tile = TerrainTile.from_tile_tuple(tile_tuple, high_resolution, terrain_source)
            # Terrain provisioning is the slow phase; map it onto 5%..60% of the overall bar.
            report_progress(
                f"Preparing terrain tile {index + 1}/{total}…",
                0.05 + 0.55 * (index / total) if total else 0.05,
            )
            for provider in self.dem_providers:
                sdf = provider.try_get_sdf(tile)
                if sdf is not None:
                    with open(os.path.join(tmpdir, tile.sdf_filename), "wb") as sdf_file:
                        sdf_file.write(sdf)
                    break
            else:
                raise RuntimeError(
                    f"No DEM provider could supply terrain tile {tile.sdf_filename} "
                    f"(cell {tile.lat},{tile.lon})."
                )

    def coverage_prediction(self, request: CoveragePredictionRequest) -> bytes:
        """
        Execute a SPLAT! coverage prediction using the provided CoveragePredictionRequest.

        Args:
            request (CoveragePredictionRequest): The coverage prediction request object.

        Returns:
            bytes: the SPLAT! coverage prediction as a GeoTIFF.

        Raises:
            RuntimeError: If SPLAT! fails to execute.
        """
        logger.debug(f"Coverage prediction request: {request.json()}")

        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                logger.debug(f"Temporary directory created: {tmpdir}")

                # Set hard limit of 100 km radius
                if request.radius > 100000:
                    logger.debug(f"User tried to set radius of {request.radius} meters, setting to 100 km.")
                    request.radius = 100000

                # provision terrain: required 1-degree tiles, each supplied by the DEM provider chain
                required_tiles = calculate_required_tiles(request.lat, request.lon, request.radius)
                self._provision_sdf_tiles(
                    tmpdir, required_tiles, request.high_resolution, request.terrain_source
                )

                # write transmitter / qth file
                with open(os.path.join(tmpdir, "tx.qth"), "wb") as qth_file:
                    qth_file.write(Splat._create_splat_qth("tx",request.lat,request.lon,request.tx_height))

                # write model parameter / lrp file
                with open(os.path.join(tmpdir,"splat.lrp"), "wb") as lrp_file:
                    lrp_file.write(Splat._create_splat_lrp(
                        ground_dielectric=request.ground_dielectric,
                        ground_conductivity=request.ground_conductivity,
                        atmosphere_bending=request.atmosphere_bending,
                        frequency_mhz=request.frequency_mhz,
                        radio_climate=request.radio_climate,
                        polarization=request.polarization,
                        situation_fraction=request.situation_fraction,
                        time_fraction=request.time_fraction,
                        tx_power=request.tx_power,
                        tx_gain=request.tx_gain,
                        system_loss=request.system_loss))

                # write colorbar / dcf file
                with open(os.path.join(tmpdir, "splat.dcf"), "wb") as dcf_file:
                    dcf_file.write(Splat._create_splat_dcf(
                        colormap_name=request.colormap,
                        min_dbm=request.min_dbm,
                        max_dbm=request.max_dbm
                    ))

                logger.debug(f"Contents of {tmpdir}: {os.listdir(tmpdir)}")

                splat_command = [
                    (
                        self.splat_hd_binary
                        if request.high_resolution
                        else self.splat_binary
                    ),
                    "-t",
                    "tx.qth",
                    "-L",
                    str(request.rx_height),
                    "-metric",
                    "-R",
                    str(request.radius / 1000.0),
                    "-sc",
                    "-gc",
                    str(request.clutter_height),
                    "-ngs",
                    "-N",
                    "-o",
                    "output.ppm",
                    "-dbm",
                    "-db",
                    str(request.signal_threshold),
                    "-kml",
                    "-olditm"
                ] # flag "olditm" uses the standard ITM model instead of ITWOM, which has produced unrealistic results.
                logger.debug(f"Executing SPLAT! command: {' '.join(splat_command)}")

                report_progress("Running SPLAT! propagation model…", 0.7)
                splat_result = subprocess.run(
                    splat_command,
                    cwd=tmpdir,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                logger.debug(f"SPLAT! stdout:\n{splat_result.stdout}")
                logger.debug(f"SPLAT! stderr:\n{splat_result.stderr}")

                if splat_result.returncode != 0:
                    logger.error(
                        f"SPLAT! execution failed with return code {splat_result.returncode}"
                    )
                    raise RuntimeError(
                        f"SPLAT! execution failed with return code {splat_result.returncode}\n"
                        f"Stdout: {splat_result.stdout}\nStderr: {splat_result.stderr}"
                    )

                report_progress("Rendering coverage map…", 0.9)
                with open(os.path.join(tmpdir, "output.ppm"), "rb") as ppm_file:
                    with open(os.path.join(tmpdir, "output.kml"), "rb") as kml_file:
                        ppm_data = ppm_file.read()
                        kml_data = kml_file.read()
                        geotiff_data = Splat._create_splat_geotiff(ppm_data,kml_data,request.colormap,request.min_dbm,request.max_dbm)

                logger.info("SPLAT! coverage prediction completed successfully.")
                return geotiff_data

            except Exception as e:
                logger.error(f"Error during coverage prediction: {e}")
                raise RuntimeError(f"Error during coverage prediction: {e}")

    def point_to_point(self, request: LinkRequest) -> dict:
        """
        Run a SPLAT! point-to-point path analysis between a transmitter and a receiver and
        return the parsed link metrics.

        Mirrors `coverage_prediction` but invokes SPLAT! with both `-t` and `-r` so it emits a
        path-analysis report instead of a coverage raster. Reuses the same .qth / .lrp writers
        and the terrain tile download/convert/cache pipeline.

        Args:
            request (LinkRequest): The point-to-point link request.

        Returns:
            dict: Parsed metrics with keys: distance_km, path_loss_db, free_space_db,
                rx_power_dbm, fresnel_pct. Any field SPLAT! does not report is None. Viability
                margin is NOT computed here — the caller combines rx_power_dbm with the LoRa
                receiver sensitivity.

        Raises:
            RuntimeError: If SPLAT! fails to execute or the link exceeds the 100 km limit.
        """
        logger.debug(f"Point-to-point request: {request.json()}")

        distance_km = haversine(
            (request.tx_lat, request.tx_lon),
            (request.rx_lat, request.rx_lon),
            unit=Unit.KILOMETERS,
        )
        # SPLAT! coverage caps at 100 km; keep point-to-point consistent.
        if distance_km > 100:
            raise RuntimeError(
                f"Link distance {distance_km:.1f} km exceeds the 100 km maximum."
            )

        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                logger.debug(f"Temporary directory created: {tmpdir}")

                # Terrain tiles covering both endpoints (and a small margin around them).
                required_tiles = calculate_p2p_tiles(
                    request.tx_lat, request.tx_lon, request.rx_lat, request.rx_lon
                )
                self._provision_sdf_tiles(
                    tmpdir, required_tiles, request.high_resolution, request.terrain_source
                )

                # Transmitter and receiver .qth files (names drive the report filename).
                with open(os.path.join(tmpdir, "tx.qth"), "wb") as qth_file:
                    qth_file.write(
                        Splat._create_splat_qth("tx", request.tx_lat, request.tx_lon, request.tx_height)
                    )
                with open(os.path.join(tmpdir, "rx.qth"), "wb") as qth_file:
                    qth_file.write(
                        Splat._create_splat_qth("rx", request.rx_lat, request.rx_lon, request.rx_height)
                    )

                # Model parameter / lrp file (ERP comes from the transmitter side here).
                with open(os.path.join(tmpdir, "splat.lrp"), "wb") as lrp_file:
                    lrp_file.write(Splat._create_splat_lrp(
                        ground_dielectric=request.ground_dielectric,
                        ground_conductivity=request.ground_conductivity,
                        atmosphere_bending=request.atmosphere_bending,
                        frequency_mhz=request.frequency_mhz,
                        radio_climate=request.radio_climate,
                        polarization=request.polarization,
                        situation_fraction=request.situation_fraction,
                        time_fraction=request.time_fraction,
                        tx_power=request.tx_power,
                        tx_gain=request.tx_gain,
                        system_loss=request.system_loss))

                range_km = min(max(distance_km + 1.0, 1.0), 100.0)
                splat_command = [
                    (
                        self.splat_hd_binary
                        if request.high_resolution
                        else self.splat_binary
                    ),
                    "-t",
                    "tx.qth",
                    "-r",
                    "rx.qth",
                    "-metric",
                    "-R",
                    str(range_km),
                    "-gc",
                    str(request.clutter_height),
                    "-olditm",
                ]
                logger.debug(f"Executing SPLAT! P2P command: {' '.join(splat_command)}")

                splat_result = subprocess.run(
                    splat_command,
                    cwd=tmpdir,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                logger.debug(f"SPLAT! stdout:\n{splat_result.stdout}")
                logger.debug(f"SPLAT! stderr:\n{splat_result.stderr}")

                if splat_result.returncode != 0:
                    raise RuntimeError(
                        f"SPLAT! P2P execution failed with return code {splat_result.returncode}\n"
                        f"Stdout: {splat_result.stdout}\nStderr: {splat_result.stderr}"
                    )

                report_text = Splat._read_p2p_report(tmpdir)
                metrics = Splat._parse_p2p_report(report_text)
                metrics["distance_km"] = round(distance_km, 3)

                logger.info("SPLAT! point-to-point analysis completed successfully.")
                return metrics

            except Exception as e:
                logger.error(f"Error during point-to-point analysis: {e}")
                raise RuntimeError(f"Error during point-to-point analysis: {e}")

    def coverage_dbm_points(self, request: CoveragePredictionRequest) -> np.ndarray:
        """
        Run a SPLAT! coverage pass and return the per-cell received signal as an (N, 3) array
        of ``[latitude, longitude, dbm]`` (longitude in standard WGS84, west negative).

        Mirrors `coverage_prediction` (same terrain/qth/lrp setup and tile cache) but adds the
        ``-ano`` flag so SPLAT! writes its alphanumeric per-cell signal report, which we parse
        directly for exact dBm values instead of decoding the colorized PPM/GeoTIFF.

        Note: SPLAT! samples radially from the transmitter, so the returned points are dense
        near the site and sparser at the periphery. Callers bin these onto a coarse grid.
        """
        if request.radius > 100000:
            request.radius = 100000

        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                required_tiles = calculate_required_tiles(request.lat, request.lon, request.radius)
                self._provision_sdf_tiles(
                    tmpdir, required_tiles, request.high_resolution, request.terrain_source
                )

                with open(os.path.join(tmpdir, "tx.qth"), "wb") as qth_file:
                    qth_file.write(Splat._create_splat_qth("tx", request.lat, request.lon, request.tx_height))

                with open(os.path.join(tmpdir, "splat.lrp"), "wb") as lrp_file:
                    lrp_file.write(Splat._create_splat_lrp(
                        ground_dielectric=request.ground_dielectric,
                        ground_conductivity=request.ground_conductivity,
                        atmosphere_bending=request.atmosphere_bending,
                        frequency_mhz=request.frequency_mhz,
                        radio_climate=request.radio_climate,
                        polarization=request.polarization,
                        situation_fraction=request.situation_fraction,
                        time_fraction=request.time_fraction,
                        tx_power=request.tx_power,
                        tx_gain=request.tx_gain,
                        system_loss=request.system_loss))

                splat_command = [
                    (self.splat_hd_binary if request.high_resolution else self.splat_binary),
                    "-t", "tx.qth",
                    "-L", str(request.rx_height),
                    "-metric",
                    "-R", str(request.radius / 1000.0),
                    "-sc",
                    "-gc", str(request.clutter_height),
                    "-ngs",
                    "-N",
                    "-dbm",
                    "-ano", "output.ano",
                    "-olditm",
                ]
                logger.debug(f"Executing SPLAT! -ano command: {' '.join(splat_command)}")

                splat_result = subprocess.run(
                    splat_command, cwd=tmpdir, capture_output=True, text=True, check=False,
                )
                if splat_result.returncode != 0:
                    raise RuntimeError(
                        f"SPLAT! -ano execution failed with return code {splat_result.returncode}\n"
                        f"Stdout: {splat_result.stdout}\nStderr: {splat_result.stderr}"
                    )

                with open(os.path.join(tmpdir, "output.ano"), "r") as ano_file:
                    points = Splat._parse_splat_ano(ano_file.read())

                logger.info(f"SPLAT! -ano pass produced {len(points)} signal points.")
                return points

            except Exception as e:
                logger.error(f"Error during coverage dBm pass: {e}")
                raise RuntimeError(f"Error during coverage dBm pass: {e}")

    def relay_overlap(self, request: RelayRequest, sensitivity: float) -> dict:
        """
        Find the candidate relay zone between two nodes: every location that receives BOTH
        node A and node B above the LoRa receiver sensitivity (after adding the relay's rx gain).

        Runs two `coverage_dbm_points` passes, bins each onto a shared, globally-aligned coarse
        grid (so A and B cells coincide and radial sampling gaps are filled), computes
        `marginS = dbmS + relay_rx_gain - sensitivity` per cell, keeps cells where both margins
        are >= 0, ranks by `min(marginA, marginB)`, and returns the zone as one GeoJSON Polygon
        Feature per disconnected island plus the top-N suggested points.
        """
        points_a = self.coverage_dbm_points(Splat._coverage_request_for_node(request, request.node_a, sensitivity))
        points_b = self.coverage_dbm_points(Splat._coverage_request_for_node(request, request.node_b, sensitivity))

        # Coarse grid cell size: ~150 m hi-res, ~300 m standard, in degrees of latitude.
        cell_m = 150.0 if request.high_resolution else 300.0
        cell_deg = cell_m / 111320.0

        gain = request.relay_rx_gain
        bin_a = Splat._bin_points_to_margin(points_a, cell_deg, sensitivity, gain)
        bin_b = Splat._bin_points_to_margin(points_b, cell_deg, sensitivity, gain)

        empty_result = {
            "sensitivity_dbm": round(sensitivity, 2),
            "node_a": request.node_a.id,
            "node_b": request.node_b.id,
            "relay_rx_gain": gain,
            "zone": {"type": "FeatureCollection", "features": []},
            "points": {"type": "FeatureCollection", "features": []},
            "empty": True,
            "warning": "No location receives both A and B above sensitivity.",
        }

        # Zone cells: present in both passes and viable to both (margin >= 0).
        zone_cells = {}
        for key, (margin_a, _) in bin_a.items():
            if key not in bin_b:
                continue
            margin_b, _ = bin_b[key]
            if margin_a >= 0 and margin_b >= 0:
                zone_cells[key] = (min(margin_a, margin_b), margin_a, margin_b)
        if not zone_cells:
            return empty_result

        iys = [iy for (iy, ix) in zone_cells]
        ixs = [ix for (iy, ix) in zone_cells]
        iy_min, iy_max, ix_min, ix_max = min(iys), max(iys), min(ixs), max(ixs)
        rows = iy_max - iy_min + 1
        cols = ix_max - ix_min + 1

        grid_mm = np.full((rows, cols), np.nan, dtype=np.float64)
        grid_ma = np.full((rows, cols), np.nan, dtype=np.float64)
        grid_mb = np.full((rows, cols), np.nan, dtype=np.float64)
        for (iy, ix), (mm, ma, mb) in zone_cells.items():
            r = iy_max - iy  # north (largest iy) at row 0
            c = ix - ix_min
            grid_mm[r, c] = mm
            grid_ma[r, c] = ma
            grid_mb[r, c] = mb

        west = ix_min * cell_deg
        north = (iy_max + 1) * cell_deg
        transform = from_origin(west, north, cell_deg, cell_deg)

        island_features, island_labels = Splat._island_polygons(
            grid_mm, transform, request.band_edges_db, cell_deg
        )
        point_features = Splat._rank_points(
            grid_mm, grid_ma, grid_mb, island_labels, transform, request.top_n
        )

        return {
            "sensitivity_dbm": round(sensitivity, 2),
            "node_a": request.node_a.id,
            "node_b": request.node_b.id,
            "relay_rx_gain": gain,
            "zone": {"type": "FeatureCollection", "features": island_features},
            "points": {"type": "FeatureCollection", "features": point_features},
            "empty": False,
            "warning": None,
        }

    @staticmethod
    def _coverage_request_for_node(request: RelayRequest, node, sensitivity: float) -> CoveragePredictionRequest:
        """Build a coverage request for one relay endpoint, reusing the shared relay params.

        The relay receiver gain is applied to the margin in `relay_overlap` (SPLAT! coverage
        does not apply rx_gain), so it is NOT baked into the SPLAT! run here. The signal
        threshold only affects the (ignored) PPM, not the -ano output.
        """
        return CoveragePredictionRequest(
            lat=node.lat,
            lon=node.lon,
            tx_height=node.height,
            tx_power=node.tx_power,
            tx_gain=node.tx_gain,
            frequency_mhz=node.frequency_mhz,
            rx_height=2.0,  # hypothetical relay antenna height (m AGL)
            rx_gain=request.relay_rx_gain,  # unused by coverage; margin gain added separately
            signal_threshold=sensitivity - request.relay_rx_gain,
            clutter_height=request.clutter_height,
            ground_dielectric=request.ground_dielectric,
            ground_conductivity=request.ground_conductivity,
            atmosphere_bending=request.atmosphere_bending,
            radius=request.search_radius_m,
            system_loss=node.system_loss,
            radio_climate=request.radio_climate,
            polarization=request.polarization,
            situation_fraction=request.situation_fraction,
            time_fraction=request.time_fraction,
            colormap="plasma",  # ignored (we parse -ano, not the PPM)
            min_dbm=-130.0,
            max_dbm=-80.0,
            high_resolution=request.high_resolution,
            terrain_source=request.terrain_source,
        )

    @staticmethod
    def _parse_splat_ano(text: str) -> np.ndarray:
        """
        Parse a SPLAT! ``-ano`` alphanumeric report into an (N, 3) array of
        ``[latitude, longitude, dbm]`` with longitude converted to standard WGS84 (west negative).

        The file begins with two header lines (``max_west, min_west`` / ``max_north, min_north``,
        each containing a ``;`` comment) followed by data rows
        ``lat, lon, azimuth, elevation, signal`` where ``lon`` is SPLAT!'s west-positive degrees
        and a row may end with a `` *`` marker. Header/blank/short rows are skipped.
        """
        out = []
        for raw in text.splitlines():
            line = raw.strip()
            if not line or ";" in line:
                continue
            if line.endswith("*"):
                line = line[:-1].strip()
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 5:
                continue
            try:
                lat = float(parts[0])
                splat_lon = float(parts[1])
                dbm = float(parts[4])
            except ValueError:
                continue
            # SPLAT! stores west longitude as a positive number (0..360); convert back.
            lon = -splat_lon if splat_lon <= 180.0 else 360.0 - splat_lon
            out.append((lat, lon, dbm))
        if not out:
            return np.empty((0, 3), dtype=np.float64)
        return np.array(out, dtype=np.float64)

    @staticmethod
    def _bin_points_to_margin(points: np.ndarray, cell_deg: float, sensitivity: float, gain: float) -> dict:
        """
        Bin radial signal points onto a globally-aligned coarse grid, keeping the strongest
        signal per cell. Returns ``{(iy, ix): (margin_db, dbm)}`` where ``iy = floor(lat/cell)``
        and ``ix = floor(lon/cell)`` (so two passes share the same cells), and
        ``margin = dbm + gain - sensitivity``.
        """
        binned: dict = {}
        for lat, lon, dbm in points:
            iy = int(math.floor(lat / cell_deg))
            ix = int(math.floor(lon / cell_deg))
            key = (iy, ix)
            prev = binned.get(key)
            if prev is None or dbm > prev[1]:
                binned[key] = (dbm + gain - sensitivity, dbm)
        return binned

    @staticmethod
    def _label_components(mask: np.ndarray) -> Tuple[np.ndarray, int]:
        """Label 4-connected components of a boolean mask (dependency-free flood fill).

        Returns ``(labels, count)`` where background is -1 and islands are 0..count-1.
        """
        rows, cols = mask.shape
        labels = np.full((rows, cols), -1, dtype=np.int32)
        count = 0
        for r0 in range(rows):
            for c0 in range(cols):
                if not mask[r0, c0] or labels[r0, c0] != -1:
                    continue
                stack = [(r0, c0)]
                labels[r0, c0] = count
                while stack:
                    r, c = stack.pop()
                    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < rows and 0 <= nc < cols and mask[nr, nc] and labels[nr, nc] == -1:
                            labels[nr, nc] = count
                            stack.append((nr, nc))
                count += 1
        return labels, count

    @staticmethod
    def _margin_band(peak: float, band_edges: List[float]) -> int:
        """Band index for a margin: number of ascending edges it meets or exceeds, minus one."""
        band = sum(1 for e in band_edges if peak >= e) - 1
        return max(band, 0)

    @staticmethod
    def _band_label(band: int, band_edges: List[float]) -> str:
        if band >= len(band_edges) - 1:
            return f">{band_edges[-1]:.0f} dB"
        return f"{band_edges[band]:.0f}–{band_edges[band + 1]:.0f} dB"

    @staticmethod
    def _island_polygons(grid_mm: np.ndarray, transform, band_edges: List[float], cell_deg: float
                         ) -> Tuple[List[dict], np.ndarray]:
        """
        Turn the min-margin grid into one GeoJSON Polygon Feature per disconnected island,
        coloured by the island's peak margin band. Returns ``(features, island_labels)`` where
        ``island_labels`` is an int grid (-1 background) used by `_rank_points`.
        """
        mask = ~np.isnan(grid_mm)
        labels, count = Splat._label_components(mask)
        features: List[dict] = []
        for island_id in range(count):
            island_mask = labels == island_id
            cells = grid_mm[island_mask]
            peak = float(np.max(cells))
            band = Splat._margin_band(peak, band_edges)
            # Mean latitude of the island for an approximate area in km^2.
            rows_idx = np.where(island_mask)[0]
            north = transform.f
            mean_lat = north + (rows_idx.mean() + 0.5) * transform.e  # transform.e is negative
            cell_w_km = cell_deg * 111.320 * math.cos(math.radians(mean_lat))
            cell_h_km = cell_deg * 110.574
            area_km2 = float(island_mask.sum()) * cell_w_km * cell_h_km

            geoms = [
                geom for geom, val in rasterio_shapes(
                    island_mask.astype(np.uint8), mask=island_mask, transform=transform, connectivity=4
                ) if val == 1
            ]
            if not geoms:
                continue
            if len(geoms) == 1:
                geometry = geoms[0]
            else:
                geometry = {"type": "MultiPolygon", "coordinates": [g["coordinates"] for g in geoms]}
            features.append({
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "island_id": island_id,
                    "peak_margin": round(peak, 2),
                    "area_km2": round(area_km2, 3),
                    "band": band,
                    "label": Splat._band_label(band, band_edges),
                },
            })
        # Strongest island first for stable, useful ordering.
        features.sort(key=lambda f: f["properties"]["peak_margin"], reverse=True)
        return features, labels

    @staticmethod
    def _rank_points(grid_mm: np.ndarray, grid_ma: np.ndarray, grid_mb: np.ndarray,
                     island_labels: np.ndarray, transform, top_n: int) -> List[dict]:
        """
        Select suggested relay points: the single best cell of EACH island first (sorted by
        margin), then, if fewer islands than `top_n`, fill remaining slots with the next-best
        cells globally, keeping a minimum separation so fillers don't sit on a chosen peak.
        """
        count = int(island_labels.max()) + 1 if island_labels.size else 0

        def cell_lonlat(r: int, c: int) -> Tuple[float, float]:
            lon, lat = transform * (c + 0.5, r + 0.5)
            return lon, lat

        chosen: List[Tuple[int, int]] = []  # (row, col)
        island_peaks: List[Tuple[float, int, int, int]] = []  # (mm, island_id, r, c)
        for island_id in range(count):
            ys, xs = np.where(island_labels == island_id)
            vals = grid_mm[ys, xs]
            k = int(np.argmax(vals))
            island_peaks.append((float(vals[k]), island_id, int(ys[k]), int(xs[k])))
        island_peaks.sort(key=lambda t: t[0], reverse=True)

        features: List[dict] = []
        for mm, island_id, r, c in island_peaks:
            if len(features) >= top_n:
                break
            chosen.append((r, c))
            lon, lat = cell_lonlat(r, c)
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {
                    "rank": len(features) + 1,
                    "island_id": island_id,
                    "min_margin": round(mm, 2),
                    "margin_a": round(float(grid_ma[r, c]), 2),
                    "margin_b": round(float(grid_mb[r, c]), 2),
                },
            })

        # Fill remaining slots with next-best cells anywhere, spaced apart.
        if len(features) < top_n:
            min_sep = 3  # cells
            ys, xs = np.where(~np.isnan(grid_mm))
            order = np.argsort(grid_mm[ys, xs])[::-1]
            for idx in order:
                if len(features) >= top_n:
                    break
                r, c = int(ys[idx]), int(xs[idx])
                if any(abs(r - rr) < min_sep and abs(c - cc) < min_sep for rr, cc in chosen):
                    continue
                chosen.append((r, c))
                lon, lat = cell_lonlat(r, c)
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                    "properties": {
                        "rank": len(features) + 1,
                        "island_id": int(island_labels[r, c]),
                        "min_margin": round(float(grid_mm[r, c]), 2),
                        "margin_a": round(float(grid_ma[r, c]), 2),
                        "margin_b": round(float(grid_mb[r, c]), 2),
                    },
                })
        return features

    @staticmethod
    def _read_p2p_report(tmpdir: str) -> str:
        """
        Read SPLAT!'s point-to-point path-analysis report. The report is named from the .qth
        site names (`tx-to-rx.txt`); fall back to a glob in case the build alters the casing.
        """
        report_path = os.path.join(tmpdir, "tx-to-rx.txt")
        if not os.path.isfile(report_path):
            matches = glob.glob(os.path.join(tmpdir, "*-to-*.txt"))
            if not matches:
                raise RuntimeError("SPLAT! did not produce a point-to-point report file.")
            report_path = matches[0]
        with open(report_path, "r", encoding="utf-8", errors="replace") as report_file:
            return report_file.read()

    @staticmethod
    def _parse_p2p_report(text: str) -> dict:
        """
        Parse the metrics of interest out of a SPLAT! point-to-point report.

        Each field is best-effort: a field SPLAT! does not emit (e.g. received power when no ERP
        is set, or Fresnel clearance on a fully clear path) comes back as None rather than
        failing the parse. The exact report wording varies between SPLAT! builds, so these
        patterns are validated against a captured fixture in the test suite.
        """
        def search_float(pattern: str) -> Optional[float]:
            match = re.search(pattern, text, re.IGNORECASE)
            return float(match.group(1)) if match else None

        metrics: dict = {
            "free_space_db": search_float(r"Free space path loss[^:]*:\s*([\d.]+)\s*dB"),
            # -olditm forces the ITM model; older builds label it "Longley-Rice".
            "path_loss_db": search_float(
                r"(?:Longley-Rice|ITWOM|ITM)[^\n]*?path loss[^:]*:\s*([\d.]+)\s*dB"
            ),
            "rx_power_dbm": search_float(
                r"(?:Received|Signal) power level[^:]*:\s*(-?[\d.]+)\s*dBm"
            ),
            "fresnel_pct": None,
        }

        # Fresnel-zone clearance wording differs between builds; try both orderings.
        fresnel = re.search(r"first Fresnel zone[^%\d]*?([\d.]+)\s*%", text, re.IGNORECASE)
        if not fresnel:
            fresnel = re.search(r"([\d.]+)\s*%[^%]*?first Fresnel zone", text, re.IGNORECASE)
        if fresnel:
            metrics["fresnel_pct"] = float(fresnel.group(1))

        return metrics

    @staticmethod
    def _create_splat_qth(name: str, latitude: float, longitude: float, elevation: float) -> bytes:
        """
        Generate the contents of a SPLAT! .qth file describing a transmitter or receiver site.

        Args:
            name (str): Name of the site (unused but required for SPLAT!).
            latitude (float): Latitude of the site in degrees.
            longitude (float): Longitude of the site in degrees.
            elevation (float): Elevation (AGL) of the site in meters.

        Returns:
            bytes: The content of the .qth file formatted for SPLAT!.
        """
        logger.debug(f"Generating .qth file content for site '{name}'.")

        try:
            # Create the .qth file content
            contents = (
                f"{name}\n"
                f"{latitude:.6f}\n"
                f"{abs(longitude) if longitude < 0 else 360 - longitude:.6f}\n"  # SPLAT! expects west longitude as a positive number.
                f"{elevation:.2f}\n"
            )
            logger.debug(f"Generated .qth file contents:\n{contents}")
            return contents.encode('utf-8')  # Return as bytes
        except Exception as e:
            logger.error(f"Error generating .qth file content: {e}")
            raise ValueError(f"Failed to generate .qth content: {e}")

    @staticmethod
    def _create_splat_lrp(
            ground_dielectric: float,
            ground_conductivity: float,
            atmosphere_bending: float,
            frequency_mhz: float,
            radio_climate: Literal[
                "equatorial",
                "continental_subtropical",
                "maritime_subtropical",
                "desert",
                "continental_temperate",
                "maritime_temperate_land",
                "maritime_temperate_sea",
            ],
            polarization: Literal["horizontal", "vertical"],
            situation_fraction: float,
            time_fraction: float,
            tx_power: float,
            tx_gain: float,
            system_loss: float,

    ) -> bytes:
        """
        Generate the contents of a SPLAT! .lrp file describing environment and propagation parameters.

        Args:
            ground_dielectric (float): Earth's dielectric constant.
            ground_conductivity (float): Earth's conductivity (Siemens per meter).
            atmosphere_bending (float): Atmospheric bending constant.
            frequency_mhz (float): Frequency in MHz.
            radio_climate (str): Radio climate type.
            polarization (str): Antenna polarization.
            situation_fraction (float): Fraction of situations (percentage, 0-100).
            time_fraction (float): Fraction of time (percentage, 0-100).
            tx_power (float): Transmitter power in dBm.
            tx_gain (float): Transmitter antenna gain in dB.
            system_loss (float): System losses in dB (e.g., cable loss).

        Returns:
            bytes: The content of the .lrp file formatted for SPLAT!.
        """
        logger.debug("Generating .lrp file content.")

        # Mapping for radio climate and polarization to SPLAT! enumerations
        climate_map = {
            "equatorial": 1,
            "continental_subtropical": 2,
            "maritime_subtropical": 3,
            "desert": 4,
            "continental_temperate": 5,
            "maritime_temperate_land": 6,
            "maritime_temperate_sea": 7,
        }
        polarization_map = {"horizontal": 0, "vertical": 1}

        # Calculate ERP in Watts
        erp_watts = 10 ** ((tx_power + tx_gain - system_loss - 30) / 10)
        logger.debug(
            f"Calculated ERP in Watts: {erp_watts:.2f} "
            f"(tx_power={tx_power}, tx_gain={tx_gain}, system_loss={system_loss})"
        )

        # Generate the content, maintaining the SPLAT! format
        try:
            contents = (
                f"{ground_dielectric:.3f}  ; Earth Dielectric Constant\n"
                f"{ground_conductivity:.6f}  ; Earth Conductivity\n"
                f"{atmosphere_bending:.3f}  ; Atmospheric Bending Constant\n"
                f"{frequency_mhz:.3f}  ; Frequency in MHz\n"
                f"{climate_map[radio_climate]}  ; Radio Climate\n"
                f"{polarization_map[polarization]}  ; Polarization\n"
                f"{situation_fraction / 100.0:.2f} ; Fraction of situations\n"
                f"{time_fraction / 100.0:.2f}  ; Fraction of time\n"
                f"{erp_watts:.2f}  ; ERP in Watts\n"
            )
            logger.debug(f"Generated .lrp file contents:\n{contents}")
            return contents.encode('utf-8')  # Return as bytes
        except Exception as e:
            logger.error(f"Error generating .lrp file content: {e}")
            raise

    @staticmethod
    def _create_splat_dcf(
            colormap_name: str, min_dbm: float, max_dbm: float
    ) -> bytes:
        """
        Generate the content of a SPLAT! .dcf file controlling the signal level contours
        using the specified Matplotlib color map.

        Args:
            colormap_name (str): The name of the Matplotlib colormap.
            min_dbm (float): The minimum signal strength value for the colormap in dBm.
            max_dbm (float): The maximum signal strength value for the colormap in dBm.

        Returns:
            bytes: The content of the .dcf file formatted for SPLAT!.
        """
        logger.debug(
            f"Generating .dcf file content using colormap '{colormap_name}', min_dbm={min_dbm}, max_dbm={max_dbm}."
        )

        try:
            # Generate color map values and normalization
            cmap = plt.get_cmap(colormap_name)
            cmap_values = np.linspace(max_dbm, min_dbm, 32)  # SPLAT! supports up to 32 levels
            cmap_norm = plt.Normalize(vmin=min_dbm, vmax=max_dbm)

            # Generate RGB values
            rgb_colors = (cmap(cmap_norm(cmap_values))[:, :3] * 255).astype(int)

            # Prepare .dcf content
            contents = "; SPLAT! Auto-generated DBM Signal Level Color Definition\n;\n"
            contents += "; Format: dBm: red, green, blue\n;\n"
            for value, rgb in zip(cmap_values, rgb_colors):
                contents += f"{int(value):+4d}: {rgb[0]:3d}, {rgb[1]:3d}, {rgb[2]:3d}\n"

            logger.debug(f"Generated .dcf file contents:\n{contents}")
            return contents.encode("utf-8")

        except Exception as e:
            logger.error(f"Error generating .dcf file content: {e}")
            raise ValueError(f"Failed to generate .dcf content: {e}")

    @staticmethod
    def create_splat_colorbar(
        colormap_name: str,
        min_dbm: float,
        max_dbm: float,
    ) -> list:
        """Generate a list of RGB color values corresponding to the color map, min and max RSSI values in dBm."""
        cmap = plt.get_cmap(colormap_name, 256)  # colormap with 256 levels
        cmap_norm = plt.Normalize(vmin=min_dbm, vmax=max_dbm)  # Normalize based on dBm range
        cmap_values = np.linspace(min_dbm, max_dbm, 255)

        # Map data values to RGB for visible colors
        rgb_colors = list(cmap(cmap_norm(cmap_values))[:, :3] * 255).astype(int)
        return rgb_colors


    @staticmethod
    def _create_splat_geotiff(
            ppm_bytes: bytes,
            kml_bytes: bytes,
            colormap_name: str,
            min_dbm: float,
            max_dbm: float,
            null_value: int = 255  # Define the null value for transparency
    ) -> bytes:
        """
        Generate GeoTIFF file content from SPLAT! PPM and KML data, with transparency for null areas.

        Args:
            ppm_bytes (bytes): Binary content of the SPLAT-generated PPM file.
            kml_bytes (bytes): Binary content of the KML file containing geospatial bounds.
            colormap_name (str): Name of the matplotlib colormap to use for the GeoTIFF.
            min_dbm (float): Minimum dBm value for the colormap scale.
            max_dbm (float): Maximum dBm value for the colormap scale.
            null_value (int): Pixel value in the PPM that represents null areas. Defaults to 255.

        Returns:
            bytes: The binary content of the resulting GeoTIFF file.

        Raises:
            RuntimeError: If the conversion process fails.
        """
        logger.info("Starting GeoTIFF generation from SPLAT! PPM and KML data.")

        try:
            # Parse KML and extract bounding box
            logger.debug("Parsing KML content.")
            tree = ET.ElementTree(ET.fromstring(kml_bytes))
            namespace = {"kml": "http://earth.google.com/kml/2.1"}
            box = tree.find(".//kml:LatLonBox", namespace)

            north = float(box.find("kml:north", namespace).text)
            south = float(box.find("kml:south", namespace).text)
            east = float(box.find("kml:east", namespace).text)
            west = float(box.find("kml:west", namespace).text)

            logger.debug(
                f"Extracted bounding box: north={north}, south={south}, east={east}, west={west}"
            )

            # Read PPM content
            logger.debug("Reading PPM content.")
            with Image.open(io.BytesIO(ppm_bytes)) as img:
                img_array = np.array(
                    img.convert("L")
                )  # Convert to single-channel grayscale
                img_array = np.clip(img_array, 0, 255).astype("uint8")

            logger.debug(f"PPM image dimensions: {img_array.shape}")

            # Mask null values
            img_array = np.where(img_array == null_value, 255, img_array)  # Optionally set to 0
            no_data_value = null_value

            # Create GeoTIFF using Rasterio
            height, width = img_array.shape
            transform = from_bounds(west, south, east, north, width, height)
            logger.debug(f"GeoTIFF transform matrix: {transform}")

            # Generate colormap with transparency
            cmap = plt.get_cmap(colormap_name, 256)  # colormap with 256 levels
            cmap_norm = plt.Normalize(vmin=min_dbm, vmax=max_dbm)  # Normalize based on dBm range
            cmap_values = np.linspace(min_dbm, max_dbm, 255)

            # Map data values to RGB for visible colors
            rgb_colors = (cmap(cmap_norm(cmap_values))[:, :3] * 255).astype(int)

            # Initialize GDAL-compatible colormap with transparency for null values
            gdal_colormap = {i: tuple(rgb) + (255,) for i, rgb in enumerate(rgb_colors)}

            # Write GeoTIFF to memory
            with io.BytesIO() as buffer:
                with rasterio.open(
                        buffer,
                        "w",
                        driver="GTiff",
                        height=height,
                        width=width,
                        count=1,  # Single-band data
                        dtype="uint8",
                        crs="EPSG:4326",
                        transform=transform,
                        photometric="palette",  # Colormap interpretation
                        compress="lzw",
                        nodata=no_data_value,  # Set NoData value
                ) as dst:
                    dst.write(img_array, 1)  # Write the raster data
                    dst.write_colormap(1, gdal_colormap)  # Attach the colormap

                buffer.seek(0)
                geotiff_bytes = buffer.read()

            logger.info("GeoTIFF generation successful.")
            return geotiff_bytes

        except Exception as e:
            logger.error(f"Error during GeoTIFF generation: {e}")
            raise RuntimeError(f"Error during GeoTIFF generation: {e}")

if __name__ == "__main__":

    import os as _os
    from app.services.dem_providers import build_providers

    logging.basicConfig(level=logging.DEBUG)
    try:
        # Replace SPLAT_PATH with the actual SPLAT! binary path before running this harness.
        providers = build_providers(["local", "linz", "srtm"], _os.environ)
        splat_service = Splat(splat_path=_os.environ.get("SPLAT_PATH", "/app/splat"), dem_providers=providers)

        # Create a test coverage prediction request
        test_coverage_request = CoveragePredictionRequest(
            lat=51.4408448,
            lon=-0.8994816,
            tx_height=1.0,
            ground_dielectric=15.0,
            ground_conductivity=0.005,
            atmosphere_bending=301.0,
            frequency_mhz=868.0,
            radio_climate="continental_temperate",
            polarization="vertical",
            situation_fraction=95.0,
            time_fraction=95.0,
            tx_power=30.0,
            tx_gain=1.0,
            system_loss=2.0,
            rx_height=1.0,
            radius=50000.0,
            colormap="CMRmap",
            min_dbm=-130.0,
            max_dbm=-80.0,
            signal_threshold=-130.0,
            high_resolution=False,
        )

        # Execute coverage prediction
        logger.info("Starting SPLAT! coverage prediction...")
        result = splat_service.coverage_prediction(test_coverage_request)

        # Save GeoTIFF output for inspection
        output_path = "splat_output.tif"
        with open(output_path, "wb") as output_file:
            output_file.write(result)
        logger.info(f"GeoTIFF saved to: {output_path}")

    except Exception as e:
        logger.error(f"Error during SPLAT! test: {e}")
        raise
