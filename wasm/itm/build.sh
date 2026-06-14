#!/usr/bin/env sh
# Build the ITM (Longley-Rice) WASM artifact from SPLAT's vendored propagation core.
#
# Uses the official emscripten/emsdk Docker image so no toolchain is installed on the host (the
# same Docker-centric approach the repo already uses to build the SPLAT binaries). Run from the
# REPO ROOT:
#
#     sh wasm/itm/build.sh
#
# Output (committed to the repo so a normal `pnpm build` never needs emcc):
#     src/sim/itm/itm.js   — ES module, single-file (wasm embedded as base64)
#
# We embed the wasm (SINGLE_FILE=1) rather than ship a separate .wasm: the artifact is small (only
# the ITM path survives dead-code elimination) and a single self-locating ES module drops cleanly
# into Vite AND into a Web Worker with zero asset-path/locateFile plumbing in either dev or the
# Docker-built SPA. -O3 does NOT imply -ffast-math, so the IEEE-754 results stay faithful to SPLAT.
set -e

OUT_DIR="src/sim/itm"
mkdir -p "$OUT_DIR"

docker run --rm -v "$(pwd):/src" -w /src emscripten/emsdk:latest \
  emcc wasm/itm/itwom3.0.cpp wasm/itm/itm_wrap.cpp -O3 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sENVIRONMENT=web,worker \
    -sEXPORTED_FUNCTIONS=_itm_p2p,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=HEAPF64 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sSINGLE_FILE=1 \
    -sEXPORT_NAME=createItmModule \
    -o "$OUT_DIR/itm.js"

echo "Built $OUT_DIR/itm.js"
