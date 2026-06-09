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
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from uuid import uuid4
from itertools import combinations
from app.services.splat import Splat
from app.services.link_budget import receiver_sensitivity_dbm
from app.models.CoveragePredictionRequest import CoveragePredictionRequest
from app.models.LinkRequest import LinkRequest
from app.models.MatrixRequest import MatrixRequest, MatrixNode
from app.models.RelayRequest import RelayRequest
import json
import logging
import io
# import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Redis client for binary data
redis_client = redis.StrictRedis(host="redis", port=6379, decode_responses=False)

# Initialize SPLAT service
splat_service = Splat(splat_path="/app/splat")

# Initialize FastAPI app
app = FastAPI()

# Add CORS middleware to allow requests from your frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*/", "http://site.meshtastic.org"],  # Replace '*' with specific origins like ["http://localhost:3000"] for security
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
    )

def run_matrix(task_id: str, request: MatrixRequest):
    """
    Compute every unordered pair of nodes as a point-to-point link and store the resulting
    matrix as JSON in Redis. Mirrors `run_splat` but produces JSON rather than a GeoTIFF.

    A bad pair (e.g. one beyond the 100 km limit) is recorded with an `error` and `viable:false`
    rather than failing the whole matrix.
    """
    try:
        logger.info(f"Starting link matrix for task {task_id} ({len(request.nodes)} nodes).")

        # Receiver sensitivity is shared across all pairs: explicit override wins, else preset.
        if request.rx_sensitivity is not None:
            sensitivity = request.rx_sensitivity
        else:
            sensitivity = receiver_sensitivity_dbm(request.lora_preset)

        links = []
        for tx, rx in combinations(request.nodes, 2):
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

        result = {
            "nodes": [n.id for n in request.nodes],
            "preset": request.lora_preset,
            "sensitivity_dbm": round(sensitivity, 2),
            "links": links,
        }
        redis_client.setex(task_id, 3600, json.dumps(result))
        redis_client.setex(f"{task_id}:status", 3600, "completed")
        logger.info(f"Link matrix task {task_id} marked as completed.")
    except Exception as e:
        logger.error(f"Error in link matrix task {task_id}: {e}")
        redis_client.setex(f"{task_id}:status", 3600, "failed")
        redis_client.setex(f"{task_id}:error", 3600, str(e))
        raise

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

    return JSONResponse({"task_id": task_id, "status": status.decode("utf-8")})

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
    if status == "completed":
        data = redis_client.get(task_id)
        if not data:
            logger.error(f"No data found for completed matrix task {task_id}.")
            return JSONResponse({"error": "No result found"}, status_code=500)
        return JSONResponse(json.loads(data.decode("utf-8")))
    elif status == "failed":
        error = redis_client.get(f"{task_id}:error")
        return JSONResponse({"status": "failed", "error": error.decode("utf-8") if error else "unknown error"})

    return JSONResponse({"status": "processing"})

def run_relay(task_id: str, request: RelayRequest):
    """
    Find the candidate relay zone between two nodes and store the resulting GeoJSON as JSON in
    Redis. Mirrors `run_matrix`: runs two SPLAT! coverage passes, intersects them, and produces
    a pure-JSON result (zone polygons + ranked points).
    """
    try:
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

app.mount("/", StaticFiles(directory="app/ui", html=True), name="ui")
