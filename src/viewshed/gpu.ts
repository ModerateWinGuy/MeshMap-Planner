/// <reference types="@webgpu/types" />
// The WebGPU compute engine behind the Viewshed mode. It runs in its OWN GPUDevice, fully decoupled
// from MapLibre's WebGL renderer (contrast src/links3d.ts, which must share MapLibre's GL context
// because it draws into MapLibre's framebuffer every frame). Here the compute is a one-shot pass
// that produces a CPU-side RGBA image; store.ts drapes that image with the existing coverage
// canvas-source + raster-layer path, so nothing about MapLibre staying on WebGL is affected.
//
// Algorithm (visBrute) — one thread per output cell, the [numthreads(16,16,1)] model: each cell
// ray-marches the straight line back to the observer, tracking the running max elevation angle, and
// is "visible" iff its own elevation angle (from the observer's eye) is ≥ that running max. Heights
// are TRUE metres and the line of sight is sagged by the 4/3 effective-earth-radius curvature drop
// (s²/(2·k·R)), so cells hidden below the curved horizon correctly read as not-visible. The same
// K_FACTOR/EARTH_RADIUS as links3d.ts, so the green footprint agrees with the 3D blocked-LOS test.
//
// This brute-force pass is artifact-free and already real-time at the nearby radii this mode targets
// (≤ ~1024² grids). The running-horizon-cache optimization (Xdraw / per-ring sweep) for full-screen
// 4096² live-drag is a documented follow-up — it must be validated to match this pass pixel-for-
// pixel before replacing it; that's the whole point of keeping this one as the oracle.

import { type Heightmap, viewshedOutputGeometry } from './heightmap.ts';

// 1 / (2 · k · R) with k = 4/3, R = 6371000 m. Mirrors links3d.ts so the two LOS models agree.
const INV_KR2 = 1 / (2 * (4 / 3) * 6371000);

const WORKGROUP = 16;

const SHADER = /* wgsl */ `
struct Params {
  outSize: vec2<f32>,
  mosaicSize: vec2<f32>,
  obsTexel: vec2<f32>,      // observer position in OUTPUT-pixel space
  outToMosaic: vec2<f32>,   // mosaicPx = outPx * outToMosaic
  mpp: f32,                 // metres per OUTPUT pixel (horizontal)
  txHeight: f32,            // observer antenna AGL (m)
  targetHeight: f32,        // receiver AGL at each tested cell (m)
  invKR2: f32,              // curvature coefficient 1/(2kR)
  maxSteps: f32,            // ray-march step budget (long rays sub-sample)
  _p0: f32, _p1: f32, _p2: f32,
};

@group(0) @binding(0) var heightTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outVis: array<u32>;
@group(0) @binding(2) var<uniform> U: Params;

fn terrainAt(outPx: vec2<f32>) -> f32 {
  let mp = outPx * U.outToMosaic;
  let mx = clamp(i32(mp.x), 0, i32(U.mosaicSize.x) - 1);
  let my = clamp(i32(mp.y), 0, i32(U.mosaicSize.y) - 1);
  let e = textureLoad(heightTex, vec2<i32>(mx, my), 0).rgb * 255.0;   // undo unorm → 0..255 bytes
  return (e.r * 256.0 + e.g + e.b / 256.0) - 32768.0;                 // Terrarium metres
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ow = u32(U.outSize.x);
  let oh = u32(U.outSize.y);
  if (gid.x >= ow || gid.y >= oh) { return; }
  let idx = gid.y * ow + gid.x;

  let tgt = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let d = tgt - U.obsTexel;
  let dist = length(d);
  let eye = terrainAt(U.obsTexel) + U.txHeight;
  // Opaque green for visible, transparent for hidden; the on-map translucency is the layer's
  // raster-opacity, not this alpha. 0xff00ff00 little-endian = bytes R=0,G=255,B=0,A=255.
  if (dist < 0.5) { outVis[idx] = 0xff00ff00u; return; }   // observer's own cell

  let dir = d / dist;
  let steps = min(dist, U.maxSteps);
  let stride = dist / steps;
  var maxTan = -1.0e30;
  var i = 1.0;
  loop {
    if (i >= steps) { break; }
    let s = i * stride * U.mpp;                              // ground metres from observer
    let h = terrainAt(U.obsTexel + dir * (i * stride)) - s * s * U.invKR2;
    maxTan = max(maxTan, (h - eye) / s);
    i = i + 1.0;
  }
  let sT = dist * U.mpp;
  let tH = terrainAt(tgt) + U.targetHeight - sT * sT * U.invKR2;
  let visible = ((tH - eye) / sT) >= (maxTan - 1.0e-4);      // epsilon: target may BE the last ridge
  outVis[idx] = select(0u, 0xff00ff00u, visible);
}
`;

export interface ComputeOptions {
  heightmap: Heightmap;
  obsLon: number;
  obsLat: number;
  txHeight: number; // observer antenna height AGL (m)
  targetHeight: number; // receiver height AGL at tested cells (m)
  outW: number; // output grid width (cells)
  outH: number; // output grid height (cells)
  maxSteps: number; // ray-march budget
}

export interface ComputeResult {
  canvas: HTMLCanvasElement; // OW×OH RGBA, ready to drape as a MapLibre canvas source
  coords: [[number, number], [number, number], [number, number], [number, number]]; // TL,TR,BR,BL lng/lat
}

// Shape shared by every viewshed compute backend (this WebGPU engine and the WebGL2 fallback in
// ./webgl2.ts), so store.ts can hold either behind one variable and a factory can try WebGPU first,
// WebGL2 second, without the call sites caring which one it got.
export interface ViewshedComputeEngine {
  init(): Promise<boolean>;
  compute(opts: ComputeOptions): Promise<ComputeResult>;
  destroy(): void;
}

export class ViewshedEngine implements ViewshedComputeEngine {
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private layout: GPUBindGroupLayout | null = null;
  private paramsBuf: GPUBuffer | null = null;

  // Resources resized lazily when the mosaic / output dimensions change.
  private heightTex: GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private outBuf: GPUBuffer | null = null;
  private readBuf: GPUBuffer | null = null;
  private outBytes = 0;

  // Acquire the device and compile the pipeline once. Returns false (rather than throwing) if WebGPU
  // is unavailable or the adapter/device request fails, so the store can mark the mode unsupported.
  async init(): Promise<boolean> {
    if (this.device) {
      return true;
    }
    if (!ViewshedEngine.isSupported()) {
      return false;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        return false;
      }
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: SHADER });
      this.layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: 'float', viewDimension: '2d' },
          },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this.pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        compute: { module, entryPoint: 'main' },
      });
      this.paramsBuf = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device = device;
      return true;
    } catch {
      return false;
    }
  }

  private ensureHeightTex(w: number, h: number): void {
    if (this.heightTex && this.texW === w && this.texH === h) {
      return;
    }
    this.heightTex?.destroy();
    this.heightTex = this.device!.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.texW = w;
    this.texH = h;
  }

  private ensureOutBuffers(bytes: number): void {
    if (this.outBuf && this.outBytes === bytes) {
      return;
    }
    this.outBuf?.destroy();
    this.readBuf?.destroy();
    this.outBuf = this.device!.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuf = this.device!.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.outBytes = bytes;
  }

  async compute(opts: ComputeOptions): Promise<ComputeResult> {
    const device = this.device;
    if (!device || !this.pipeline || !this.layout || !this.paramsBuf) {
      throw new Error('ViewshedEngine.compute called before init()');
    }
    const hm = opts.heightmap;
    const outW = Math.max(1, Math.round(opts.outW));
    const outH = Math.max(1, Math.round(opts.outH));

    // Upload the Terrarium mosaic verbatim (bytesPerRow = width*4 is a multiple of 256 because the
    // mosaic is whole 256-px tiles, so writeTexture needs no row padding).
    this.ensureHeightTex(hm.width, hm.height);
    device.queue.writeTexture(
      { texture: this.heightTex! },
      hm.data,
      { offset: 0, bytesPerRow: hm.width * 4, rowsPerImage: hm.height },
      { width: hm.width, height: hm.height, depthOrArrayLayers: 1 },
    );

    const bytes = outW * outH * 4;
    this.ensureOutBuffers(bytes);

    // Geometry: observer in output-pixel space, metres-per-output-pixel, and the output→mosaic scale.
    const { obsOutX, obsOutY, outToMosaicX, outToMosaicY, mppOut } = viewshedOutputGeometry(
      hm,
      opts.obsLon,
      opts.obsLat,
      outW,
      outH,
    );

    const p = new Float32Array(16);
    p[0] = outW;
    p[1] = outH;
    p[2] = hm.width;
    p[3] = hm.height;
    p[4] = obsOutX;
    p[5] = obsOutY;
    p[6] = outToMosaicX;
    p[7] = outToMosaicY;
    p[8] = mppOut;
    p[9] = opts.txHeight;
    p[10] = opts.targetHeight;
    p[11] = INV_KR2;
    p[12] = Math.max(1, opts.maxSteps);
    device.queue.writeBuffer(this.paramsBuf, 0, p);

    const bindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.heightTex!.createView() },
        { binding: 1, resource: { buffer: this.outBuf! } },
        { binding: 2, resource: { buffer: this.paramsBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(outW / WORKGROUP), Math.ceil(outH / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(this.outBuf!, 0, this.readBuf!, 0, bytes);
    device.queue.submit([encoder.finish()]);

    await this.readBuf!.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8ClampedArray(this.readBuf!.getMappedRange().slice(0));
    this.readBuf!.unmap();

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d')!.putImageData(new ImageData(pixels, outW, outH), 0, 0);

    return {
      canvas,
      coords: [
        [hm.west, hm.north],
        [hm.east, hm.north],
        [hm.east, hm.south],
        [hm.west, hm.south],
      ],
    };
  }

  destroy(): void {
    this.heightTex?.destroy();
    this.outBuf?.destroy();
    this.readBuf?.destroy();
    this.paramsBuf?.destroy();
    this.device?.destroy();
    this.device = null;
    this.pipeline = null;
    this.layout = null;
    this.paramsBuf = null;
    this.heightTex = null;
    this.outBuf = null;
    this.readBuf = null;
    this.texW = this.texH = this.outBytes = 0;
  }
}
