"""
Signal Coverage Prediction API

Provides endpoints to predict radio signal coverage
using the ITM (Irregular Terrain Model) via SPLAT! (https://github.com/jmcmellen/splat).

Endpoints:
    - /predict: Accepts a signal coverage prediction request and starts a background task.
    - /status/{task_id}: Retrieves the status of a given prediction task.
    - /result/{task_id}: Retrieves the result (GeoTIFF file) of a given prediction task.
"""

import redis
from fastapi import FastAPI, BackgroundTasks
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from uuid import uuid4
from itertools import combinations
from app.services.splat import Splat
from app.services.dem_providers import build_providers
from app.services.terrain_tiles_xyz import TerrainXyzService
from app.services.terrain_sim_tiles import TerrainSimService
from app.services.progress import set_progress_sink, clear_progress_sink, report as report_progress
from app.services.link_budget import receiver_sensitivity_dbm
from app.models.CoveragePredictionRequest import CoveragePredictionRequest
from app.models.LinkRequest import LinkRequest
from app.models.MatrixRequest import MatrixRequest, MatrixNode
from app.models.RelayRequest import RelayRequest
import json
import logging
import io
import math
import os

from haversine import haversine, Unit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Redis client for binary data
redis_client = redis.StrictRedis(host="redis", port=6379, decode_responses=False)

# Assemble the terrain (DEM) provider chain from config. DEM_PROVIDERS is the only knob: it names
# the providers and their precedence (e.g. "local,linz,srtm"); each provider reads its own config
# from the environment. main.py never references a concrete provider class.
_provider_order = [n.strip() for n in os.environ.get("DEM_PROVIDERS", "local,linz,srtm").split(",") if n.strip()]
dem_providers = build_providers(_provider_order, os.environ)

# Initialize SPLAT service
splat_service = Splat(splat_path=os.environ.get("SPLAT_PATH", "/app/splat"), dem_providers=dem_providers)

# Terrain XYZ tile service for the 3D map: serves LINZ DEM/DSM as terrarium raster-dem tiles over NZ
# (reusing the LINZ provider's cached COG discovery) and redirects to AWS Terrarium elsewhere. If
# LINZ isn't in the chain it's None and the endpoint always redirects to Terrarium.
_linz_provider = next((p for p in dem_providers if getattr(p, "name", "") == "linz"), None)
terrain_tiles = TerrainXyzService.from_env(_linz_provider, os.environ)

# "Simulation terrain" tiles: the exact coarse SDF grid SPLAT! analyses, rendered low-poly so users
# can see (and resolve) the terrain that causes a coverage shadow. Reuses the SPLAT service's DEM
# provider chain / SDF cache, so it routes identically to a prediction (srtm/dem/dsm).
terrain_sim_tiles = TerrainSimService.from_env(splat_service, os.environ)

# SRTM gives cheap global bare-earth point elevations for the radio-horizon link pre-filter. Using
# bare earth everywhere (regardless of the run's terrain_source) is fine for a generous LOS bound.
_srtm_provider = next((p for p in dem_providers if getattr(p, "name", "") == "srtm"), None)

# Distance to the geometric line-of-sight horizon, with the standard k=4/3 effective-Earth radius
# (R=6 371 000 m): d_km = sqrt(2·k·R·h)/1000 = 4.1225·sqrt(h_m), summed over both antennas. Heights
# are above sea level (ground + AGL), making the bound generous so only impossible pairs are dropped.
_RADIO_HORIZON_KM_PER_SQRT_M = math.sqrt(2 * (4 / 3) * 6_371_000) / 1000  # ~4.1225


def _radio_horizon_km(height_amsl_a_m: float, height_amsl_b_m: float) -> float:
    """Max line-of-sight distance (km) between two antennas at the given heights above sea level."""
    return _RADIO_HORIZON_KM_PER_SQRT_M * (math.sqrt(height_amsl_a_m) + math.sqrt(height_amsl_b_m))
_TERRARIUM_TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/v2/terrarium/{z}/{x}/{y}.png"

# Initialize FastAPI app
app = FastAPI()


def _progress_sink(task_id: str):
    """Build a progress sink that publishes job progress to Redis under `{task_id}:progress`.

    Keeps the last known fraction so steps that only update the message (fraction=None) don't make
    the bar jump backwards. Read back by GET /status and rendered by the frontend.
    """
    state = {"fraction": 0.0}

    def sink(message: str, fraction=None):
        if fraction is not None:
            state["fraction"] = fraction
        redis_client.setex(
            f"{task_id}:progress", 3600,
            json.dumps({"message": message, "fraction": state["fraction"]}),
        )

    return sink

# Add CORS middleware to allow requests from your frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*/", "http://your-domain.example"],  # Replace the placeholder with your deployed origin(s) for security
    allow_credentials=True,
    allow_methods=["*"],  # Allow all HTTP methods
    allow_headers=["*"],  # Allow all headers
)

def run_splat(task_id: str, request: CoveragePredictionRequest):
    """
    Execute the SPLAT! coverage prediction and store the resulting GeoTIFF data in Redis.

    Args:
        task_id (str): UUID identifier for the task.
        request (CoveragePredictionRequest): The parameters for the SPLAT! prediction.

    Workflow:
        - Runs the SPLAT! coverage prediction.
        - Stores the resulting GeoTIFF data and the task status ("completed") in Redis.
        - On failure, stores the task status as "failed" and logs the error in Redis.

    Raises:
        Exception: If SPLAT! fails during execution.
    """
    try:
        set_progress_sink(_progress_sink(task_id))
        logger.info(f"Starting SPLAT! coverage prediction for task {task_id}.")
        geotiff_data = splat_service.coverage_prediction(request)

        # Log before storing in Redis
        logger.info(f"Storing result in Redis for task {task_id}")
        redis_client.setex(task_id, 3600, geotiff_data)
        redis_client.setex(f"{task_id}:status", 3600, "completed")
        logger.info(f"Task {task_id} marked as completed.")
    except Exception as e:
        logger.error(f"Error in SPLAT! task {task_id}: {e}")
        redis_client.setex(f"{task_id}:status", 3600, "failed")
        redis_client.setex(f"{task_id}:error", 3600, str(e))
        raise
    finally:
        clear_progress_sink()

def _link_request_for_pair(tx: MatrixNode, rx: MatrixNode, request: MatrixRequest) -> LinkRequest:
    """Build a LinkRequest for the directed pair tx -> rx, applying the matrix's shared params."""
    return LinkRequest(
        tx_lat=tx.lat, tx_lon=tx.lon, tx_height=tx.height, tx_power=tx.tx_power, tx_gain=tx.tx_gain,
        rx_lat=rx.lat, rx_lon=rx.lon, rx_height=rx.height, rx_gain=rx.rx_gain,
        frequency_mhz=tx.frequency_mhz, system_loss=tx.system_loss,
        clutter_height=request.clutter_height,
        # Carry the matrix's sensitivity basis so the per-pair model validates; point_to_point
        # itself does not use it (margin is computed once at the matrix level).
        lora_preset=request.lora_preset, rx_sensitivity=request.rx_sensitivity,
        ground_dielectric=request.ground_dielectric,
        ground_conductivity=request.ground_conductivity,
        atmosphere_bending=request.atmosphere_bending,
        radio_climate=request.radio_climate,
        polarization=request.polarization,
        situation_fraction=request.situation_fraction,
        time_fraction=request.time_fraction,
        high_resolution=request.high_resolution,
        terrain_source=request.terrain_source,
    )

def run_matrix(task_id: str, request: MatrixRequest):
    """
    Compute every unordered pair of nodes as a point-to-point link and store the resulting
    matrix as JSON in Redis. Mirrors `run_splat` but produces JSON rather than a GeoTIFF.

    A bad pair (e.g. one beyond the distance limit) is recorded with an `error` and `viable:false`
    rather than failing the whole matrix.
    """
    try:
        set_progress_sink(_progress_sink(task_id))
        logger.info(f"Starting link matrix for task {task_id} ({len(request.nodes)} nodes).")

        # Receiver sensitivity is shared across all pairs: explicit override wins, else preset.
        if request.rx_sensitivity is not None:
            sensitivity = request.rx_sensitivity
        else:
            sensitivity = receiver_sensitivity_dbm(request.lora_preset)

        all_pairs = list(combinations(request.nodes, 2))
        # Pre-filter pairs beyond the line-of-sight radio horizon (Earth curvature) so we never run
        # SPLAT! on physically impossible links. Ground elevation is sampled once per node from SRTM
        # bare earth; a node we can't sample (or no SRTM provider at all) skips filtering for its
        # pairs, so an unknown elevation never drops a link we're unsure about.
        if request.filter_radio_horizon and _srtm_provider is not None:
            ground_by_id: dict = {}
            for node in request.nodes:
                try:
                    ground_by_id[node.id] = _srtm_provider.sample_elevation(node.lat, node.lon)
                except Exception as elev_error:
                    logger.warning(f"Elevation sample failed for node {node.id}: {elev_error}")
                    ground_by_id[node.id] = None

            def _within_horizon(tx: MatrixNode, rx: MatrixNode) -> bool:
                ground_a, ground_b = ground_by_id.get(tx.id), ground_by_id.get(rx.id)
                if ground_a is None or ground_b is None:
                    return True
                horizon_km = _radio_horizon_km(ground_a + tx.height, ground_b + rx.height)
                distance_km = haversine((tx.lat, tx.lon), (rx.lat, rx.lon), unit=Unit.KILOMETERS)
                return distance_km <= horizon_km

            pairs = [(tx, rx) for tx, rx in all_pairs if _within_horizon(tx, rx)]
            skipped = len(all_pairs) - len(pairs)
            if skipped:
                logger.info(f"Radio-horizon filter skipped {skipped}/{len(all_pairs)} pair(s).")
        else:
            pairs = all_pairs

        links = []
        node_ids = [n.id for n in request.nodes]
        sensitivity_rounded = round(sensitivity, 2)

        def _publish():
            # Republish the growing matrix after every link so the frontend can render each one as
            # it lands (polled via GET /matrix/result) rather than waiting for the whole job.
            redis_client.setex(task_id, 3600, json.dumps({
                "nodes": node_ids,
                "preset": request.lora_preset,
                "sensitivity_dbm": sensitivity_rounded,
                "links": links,
            }))

        for pair_index, (tx, rx) in enumerate(pairs):
            report_progress(
                f"Analysing link {pair_index + 1}/{len(pairs)} ({tx.id}↔{rx.id})…",
                (pair_index / len(pairs)) if pairs else 0.0,
            )
            link = {"a": tx.id, "b": rx.id, "distance_km": None, "path_loss_db": None,
                    "rx_power_dbm": None, "fresnel_pct": None, "margin_db": None,
                    "viable": False, "error": None}
            try:
                metrics = splat_service.point_to_point(_link_request_for_pair(tx, rx, request))
                link.update(metrics)
                rx_power = metrics.get("rx_power_dbm")
                if rx_power is not None:
                    # SPLAT! received power does not include the receive antenna gain.
                    margin = (rx_power + rx.rx_gain) - sensitivity
                    link["margin_db"] = round(margin, 2)
                    link["viable"] = margin >= 0
            except Exception as pair_error:
                logger.warning(f"Pair {tx.id}-{rx.id} failed: {pair_error}")
                link["error"] = str(pair_error)
            links.append(link)
            _publish()

        _publish()
        redis_client.setex(f"{task_id}:status", 3600, "completed")
        logger.info(f"Link matrix task {task_id} marked as completed.")
    except Exception as e:
        logger.error(f"Error in link matrix task {task_id}: {e}")
        redis_client.setex(f"{task_id}:status", 3600, "failed")
        redis_client.setex(f"{task_id}:error", 3600, str(e))
        raise
    finally:
        clear_progress_sink()

@app.post("/predict")
async def predict(payload: CoveragePredictionRequest, background_tasks: BackgroundTasks) -> JSONResponse:
    """
    Predict signal coverage using SPLAT!.
    Accepts a CoveragePredictionRequest and processes it in the background.

    - Generates a unique task ID.
    - Sets the initial task status to "processing" in Redis.
    - Adds the `run_splat` function to the background task queue.

    Args:
        payload (CoveragePredictionRequest): The parameters required for the SPLAT! coverage prediction.
        background_tasks (BackgroundTasks): FastAPI background tasks.

    Returns:
        JSONResponse: A response containing the unique task ID to track the prediction progress.
    """
    task_id = str(uuid4())
    redis_client.setex(f"{task_id}:status", 3600, "processing")
    background_tasks.add_task(run_splat, task_id, payload)
    return JSONResponse({"task_id": task_id})

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    """
    Retrieve the status of a given SPLAT! task.

    - Checks Redis for the task status.
    - Returns "processing", "completed", or "failed" based on the status.
    - Returns a 404 error if the task ID is not found.

    Args:
        task_id (str): The unique identifier for the task.

    Returns:
        JSONResponse: The task status or an error message if the task is not found.
    """
    status = redis_client.get(f"{task_id}:status")
    if not status:
        logger.warning(f"Task {task_id} not found in Redis.")
        return JSONResponse({"error": "Task not found"}, status_code=404)

    progress_raw = redis_client.get(f"{task_id}:progress")
    progress = json.loads(progress_raw) if progress_raw else None
    return JSONResponse({"task_id": task_id, "status": status.decode("utf-8"), "progress": progress})

@app.get("/result/{task_id}")
async def get_result(task_id: str):
    """
    Retrieve SPLAT! task status or GeoTIFF result.

    - Checks the task status in Redis.
    - If "completed," retrieves the GeoTIFF data and serves it as a downloadable file.
    - If "failed," returns the error message stored in Redis.
    - If "processing", indicate the same in the response.

    Args:
        task_id (str): The unique identifier for the task.

    Returns:
        JSONResponse: Task status if the task is still "processing" or "failed."
        StreamingResponse: A downloadable GeoTIFF file if the task is "completed."
    """
    status = redis_client.get(f"{task_id}:status")
    if not status:
        logger.warning(f"Task {task_id} not found in Redis.")
        return JSONResponse({"error": "Task not found"}, status_code=404)

    status = status.decode("utf-8")
    if status == "completed":
        geotiff_data = redis_client.get(task_id)
        if not geotiff_data:
            logger.error(f"No data found for completed task {task_id}.")
            return JSONResponse({"error": "No result found"}, status_code=500)

        geotiff_file = io.BytesIO(geotiff_data)
        return StreamingResponse(
            geotiff_file,
            media_type="image/tiff",
            headers={"Content-Disposition": f"attachment; filename={task_id}.tif"}
        )
    elif status == "failed":
        error = redis_client.get(f"{task_id}:error")
        return JSONResponse({"status": "failed", "error": error.decode("utf-8")})

    logger.info(f"Task {task_id} is still processing.")
    return JSONResponse({"status": "processing"})

@app.post("/matrix")
async def matrix(payload: MatrixRequest, background_tasks: BackgroundTasks) -> JSONResponse:
    """
    Compute the pairwise link matrix for a set of nodes.

    Submits a single background task that runs SPLAT! point-to-point for every unordered pair
    and stores one JSON result. Poll progress with GET /status/{task_id} and fetch the result
    with GET /matrix/result/{task_id}.
    """
    task_id = str(uuid4())
    redis_client.setex(f"{task_id}:status", 3600, "processing")
    background_tasks.add_task(run_matrix, task_id, payload)
    return JSONResponse({"task_id": task_id})

@app.get("/matrix/result/{task_id}")
async def get_matrix_result(task_id: str):
    """
    Retrieve the JSON link-matrix result for a given task.

    - If "completed": returns the stored matrix JSON.
    - If "failed": returns the error message.
    - If "processing": indicates the task is still running.
    - Returns 404 if the task ID is not found.
    """
    status = redis_client.get(f"{task_id}:status")
    if not status:
        logger.warning(f"Task {task_id} not found in Redis.")
        return JSONResponse({"error": "Task not found"}, status_code=404)

    status = status.decode("utf-8")
    if status == "failed":
        error = redis_client.get(f"{task_id}:error")
        return JSONResponse({"status": "failed", "error": error.decode("utf-8") if error else "unknown error"})

    # Serve whatever is stored so far. run_matrix republishes the growing links list after every
    # pair, so this returns the partial matrix while still processing and the full one when complete
    # (same shape either way). Only "processing with nothing computed yet" has no data to return.
    data = redis_client.get(task_id)
    if data:
        return JSONResponse(json.loads(data.decode("utf-8")))
    if status == "completed":
        logger.error(f"No data found for completed matrix task {task_id}.")
        return JSONResponse({"error": "No result found"}, status_code=500)
    return JSONResponse({"status": "processing"})

def run_relay(task_id: str, request: RelayRequest):
    """
    Find the candidate relay zone between two nodes and store the resulting GeoJSON as JSON in
    Redis. Mirrors `run_matrix`: runs two SPLAT! coverage passes, intersects them, and produces
    a pure-JSON result (zone polygons + ranked points).
    """
    try:
        set_progress_sink(_progress_sink(task_id))
        logger.info(f"Starting relay overlap for task {task_id}.")

        # Shared receiver sensitivity: explicit override wins, else derive from the LoRa preset.
        if request.rx_sensitivity is not None:
            sensitivity = request.rx_sensitivity
        else:
            sensitivity = receiver_sensitivity_dbm(request.lora_preset)

        result = splat_service.relay_overlap(request, sensitivity)
        redis_client.setex(task_id, 3600, json.dumps(result))
        redis_client.setex(f"{task_id}:status", 3600, "completed")
        logger.info(f"Relay task {task_id} marked as completed.")
    except Exception as e:
        logger.error(f"Error in relay task {task_id}: {e}")
        redis_client.setex(f"{task_id}:status", 3600, "failed")
        redis_client.setex(f"{task_id}:error", 3600, str(e))
        raise
    finally:
        clear_progress_sink()

@app.post("/relay")
async def relay(payload: RelayRequest, background_tasks: BackgroundTasks) -> JSONResponse:
    """
    Find the candidate relay zone between two nodes.

    Submits a single background task that runs SPLAT! coverage from each node, intersects the
    two signal fields, and stores one JSON result. Poll progress with GET /status/{task_id} and
    fetch the result with GET /relay/result/{task_id}.
    """
    task_id = str(uuid4())
    redis_client.setex(f"{task_id}:status", 3600, "processing")
    background_tasks.add_task(run_relay, task_id, payload)
    return JSONResponse({"task_id": task_id})

@app.get("/relay/result/{task_id}")
async def get_relay_result(task_id: str):
    """
    Retrieve the JSON relay-overlap result for a given task.

    - If "completed": returns the stored zone/points JSON.
    - If "failed": returns the error message.
    - If "processing": indicates the task is still running.
    - Returns 404 if the task ID is not found.
    """
    status = redis_client.get(f"{task_id}:status")
    if not status:
        logger.warning(f"Task {task_id} not found in Redis.")
        return JSONResponse({"error": "Task not found"}, status_code=404)

    status = status.decode("utf-8")
    if status == "completed":
        data = redis_client.get(task_id)
        if not data:
            logger.error(f"No data found for completed relay task {task_id}.")
            return JSONResponse({"error": "No result found"}, status_code=500)
        return JSONResponse(json.loads(data.decode("utf-8")))
    elif status == "failed":
        error = redis_client.get(f"{task_id}:error")
        return JSONResponse({"status": "failed", "error": error.decode("utf-8") if error else "unknown error"})

    return JSONResponse({"status": "processing"})

def run_profile(task_id: str, request: LinkRequest):
    """
    Run a single point-to-point link with its terrain/LOS/Fresnel profile and store the result
    as JSON in Redis. Mirrors `run_matrix` for one pair, but also asks SPLAT! for the profile
    graph curves and adds the derived link-budget headline figures (TX EIRP, estimated RX signal,
    margin) the chart annotates.
    """
    try:
        set_progress_sink(_progress_sink(task_id))
        logger.info(f"Starting link profile for task {task_id}.")

        # Receiver sensitivity: explicit override wins, else derive from the LoRa preset.
        if request.rx_sensitivity is not None:
            sensitivity = request.rx_sensitivity
        else:
            sensitivity = receiver_sensitivity_dbm(request.lora_preset)

        report_progress("Analysing terrain profile…", 0.1)
        metrics = splat_service.point_to_point(request, include_profile=True)

        result = dict(metrics)
        result["tx_eirp_dbm"] = round(request.tx_power + request.tx_gain, 2)
        result["sensitivity_dbm"] = round(sensitivity, 2)
        rx_power = metrics.get("rx_power_dbm")
        if rx_power is not None:
            # SPLAT! received power excludes the receive antenna gain (matches run_matrix).
            rx_signal = rx_power + request.rx_gain
            margin = rx_signal - sensitivity
            result["rx_signal_dbm"] = round(rx_signal, 2)
            result["margin_db"] = round(margin, 2)
            result["viable"] = margin >= 0
        else:
            result["rx_signal_dbm"] = None
            result["margin_db"] = None
            result["viable"] = False

        redis_client.setex(task_id, 3600, json.dumps(result))
        redis_client.setex(f"{task_id}:status", 3600, "completed")
        logger.info(f"Profile task {task_id} marked as completed.")
    except Exception as e:
        logger.error(f"Error in profile task {task_id}: {e}")
        redis_client.setex(f"{task_id}:status", 3600, "failed")
        redis_client.setex(f"{task_id}:error", 3600, str(e))
        raise
    finally:
        clear_progress_sink()

@app.post("/profile")
async def profile(payload: LinkRequest, background_tasks: BackgroundTasks) -> JSONResponse:
    """
    Compute a single point-to-point link with its terrain profile (terrain, line-of-sight,
    Fresnel zone and earth-curvature curves) plus link-budget figures.

    Submits a background task and stores one JSON result. Poll progress with GET /status/{task_id}
    and fetch the result with GET /profile/result/{task_id}.
    """
    task_id = str(uuid4())
    redis_client.setex(f"{task_id}:status", 3600, "processing")
    background_tasks.add_task(run_profile, task_id, payload)
    return JSONResponse({"task_id": task_id})

@app.get("/profile/result/{task_id}")
async def get_profile_result(task_id: str):
    """
    Retrieve the JSON link-profile result for a given task.

    - If "completed": returns the stored metrics + profile-curve JSON.
    - If "failed": returns the error message.
    - If "processing": indicates the task is still running.
    - Returns 404 if the task ID is not found.
    """
    status = redis_client.get(f"{task_id}:status")
    if not status:
        logger.warning(f"Task {task_id} not found in Redis.")
        return JSONResponse({"error": "Task not found"}, status_code=404)

    status = status.decode("utf-8")
    if status == "completed":
        data = redis_client.get(task_id)
        if not data:
            logger.error(f"No data found for completed profile task {task_id}.")
            return JSONResponse({"error": "No result found"}, status_code=500)
        return JSONResponse(json.loads(data.decode("utf-8")))
    elif status == "failed":
        error = redis_client.get(f"{task_id}:error")
        return JSONResponse({"status": "failed", "error": error.decode("utf-8") if error else "unknown error"})

    return JSONResponse({"status": "processing"})

@app.get("/terrain/config")
async def terrain_config():
    """Zoom band (minzoom gate + per-source maxzoom cap) for the 3D terrain source. The frontend
    fetches this once so the raster-dem source it builds matches the backend's served band; it falls
    back to its own defaults if this is unreachable."""
    return JSONResponse(terrain_tiles.config())

@app.get("/terrain/sim/{source}/{res}/{z}/{x}/{y}.png")
async def terrain_sim_tile(source: str, res: str, z: int, x: int, y: int):
    """Terrarium tile of the exact SDF grid SPLAT! uses for ``source`` at ``res`` (sd/hd), rendered
    nearest-neighbour (flat quads, sharp edges). Declared before the generic terrain route below.
    Anything it can't serve (ocean cell, build failure, bad params) 307-redirects to AWS Terrarium so
    the map source is never left with a hole."""
    if source not in ("srtm", "dem", "dsm") or res not in ("sd", "hd"):
        return JSONResponse({"error": "source must be srtm/dem/dsm and res sd/hd"}, status_code=400)
    # render_tile may build/decode an SDF — run in the threadpool so a cold cell can't stall the loop.
    png = await run_in_threadpool(terrain_sim_tiles.render_tile, source, res, z, x, y)
    if png is None:
        return RedirectResponse(_TERRARIUM_TILE_URL.format(z=z, x=x, y=y), status_code=307)
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})

@app.get("/terrain/{source}/{z}/{x}/{y}.png")
async def terrain_tile(source: str, z: int, x: int, y: int):
    """Terrarium-encoded raster-dem tile for the 3D map. Serves LINZ DEM/DSM over NZ; for anything it
    can't serve (bad source, outside NZ, outside the zoom band, or any failure) it 307-redirects to
    AWS Terrarium so the single MapLibre terrain source is never left with a hole."""
    if source not in ("dem", "dsm"):
        return JSONResponse({"error": "source must be 'dem' or 'dsm'"}, status_code=400)
    # render_tile blocks on remote COG reads — run it in the threadpool so a cold NZ tile can't stall
    # the event loop (and thus /status polling for in-flight predictions).
    png = await run_in_threadpool(terrain_tiles.render_tile, source, z, x, y)
    if png is None:
        return RedirectResponse(_TERRARIUM_TILE_URL.format(z=z, x=x, y=y), status_code=307)
    # Immutable per-survey LIDAR — let the browser/CDN cache hard; our diskcache holds it server-side.
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})

app.mount("/", StaticFiles(directory="app/ui", html=True), name="ui")
