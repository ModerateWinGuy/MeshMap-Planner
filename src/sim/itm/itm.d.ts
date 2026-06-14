// Hand-written types for the Emscripten-generated itm.js (built by wasm/itm/build.sh; vendored).
// itm.js is a single-file ES module (MODULARIZE + EXPORT_ES6 + SINGLE_FILE) whose default export is
// a factory returning the ready module. TypeScript resolves `import … from './itm.js'` to this file.

export interface ItmModule {
  // Heap view onto the module's linear memory as Float64. Re-read after any _malloc that may grow
  // memory (ALLOW_MEMORY_GROWTH detaches old views).
  HEAPF64: Float64Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  // extern "C" itm_p2p — see wasm/itm/itm_wrap.cpp. All pointers are byte offsets into HEAPF64*8.
  _itm_p2p(
    elevPtr: number,
    tht_m: number,
    rht_m: number,
    eps_dielect: number,
    sgm_conductivity: number,
    eno_ns_surfref: number,
    frq_mhz: number,
    radio_climate: number,
    pol: number,
    conf: number,
    rel: number,
    outPtr: number,
  ): number;
}

declare const createItmModule: (opts?: Record<string, unknown>) => Promise<ItmModule>;
export default createItmModule;
