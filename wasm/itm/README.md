# ITM (Longley-Rice) WASM core

The browser-side RF simulation runs SPLAT!'s classic ITM propagation model directly, compiled to
WebAssembly. This avoids reimplementing Longley-Rice in JS: the `.wasm` is built from `itwom3.0.cpp`
(vendored here from the SPLAT! source — the `-olditm` path), so the physics is identical to a native
SPLAT run.

## What's here

- `itm_wrap.cpp` — a tiny `extern "C"` wrapper (`itm_p2p`) over `point_to_point_ITM`. The browser
  builds the terrain profile (from the same Terrarium tiles the map draws) and passes SPLAT's
  `elev[]` array straight in. We compile the whole `itwom3.0.cpp` and export only this wrapper;
  dead-code elimination strips the unused ITWOM path.
- `build.sh` — builds the artifact via the `emscripten/emsdk` Docker image, so no host C/C++
  toolchain is needed.
- `itwom3.0.cpp` — the vendored SPLAT! ITM source the wrapper compiles against.

## Build (regenerate the vendored artifact)

Requires Docker only. From the repo root:

```sh
sh wasm/itm/build.sh
```

Output: `src/sim/itm/itm.js` — a single-file ES module (the wasm is embedded as base64). It is
**committed**, so a normal `pnpm build` never needs `emcc`. We embed rather than ship a separate
`.wasm` so the module self-loads identically in Vite dev, the production build, and inside a Web
Worker, with no `locateFile`/asset-path plumbing. `-O3` does not imply `-ffast-math`, so results stay
faithful to the native build.

The TypeScript wrapper that drives it is `src/sim/itm/index.ts` (typed by `src/sim/itm/itm.d.ts`).

## Validation

The build was validated by WASM-vs-native parity: compile the same `itwom3.0.cpp` + `itm_wrap.cpp`
natively (g++ inside the emscripten image) and compare `itm_p2p` output to the WASM for identical
profiles. They agree to ~1e-6 dB (last-bit FP), and native == SPLAT's ITM by construction.

Golden values (eps=15, sgm=0.005, ens=301, climate=5, pol=1, conf=0.5, rel=0.9):

| case | profile | tx/rx m | freq | distance | path loss dB | free space dB |
|------|---------|---------|------|----------|--------------|---------------|
| A | flat 0 m, 21 pts @ 500 m | 10 / 2 | 868 MHz | 10 km | 136.185043 | 111.220395 |
| B | A + 50 m ridge at midpoint | 10 / 2 | 868 MHz | 10 km | 154.465255 | 111.220395 |
| C | rising slope 50→110 m, 31 pts @ 1 km | 20 / 5 | 433 MHz | 30 km | 149.241139 | 114.722183 |

To re-validate, build a native harness that calls `itm_p2p` with these inputs and a node-targeted
build of the same sources, and confirm both reproduce the table.
