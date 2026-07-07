// The WebGL2 fallback for the Viewshed compute pass. See ./gpu.ts for the primary WebGPU engine, the
// full algorithm/curvature-model writeup, and ComputeOptions/ComputeResult — this mirrors that
// algorithm exactly, just on a backend with no compute shaders. WebGL2's classic GPGPU trick stands in
// for @compute: render a full-screen triangle sized to the output grid and let the fragment shader do
// the same per-cell ray-march, one fragment per output cell (no shared memory or atomics are needed —
// the WGSL kernel never used them either, every cell is independent).
//
// Why this exists: WebGPU has near-zero mobile coverage today (no Android Firefox, only the newest
// Chrome/Safari). WebGL2 has shipped on virtually every phone since ~2017, and both the input height
// texture and the output visibility mask are already plain byte RGBA — no WebGL2 extensions needed.
//
// Y-axis note: Heightmap.data is row-major top-down (row 0 = north). texImage2D's default (unflipped)
// upload keeps that order addressable via texelFetch 1:1, so terrainAt() below needs no flip — same
// indexing as gpu.ts's textureLoad. But WebGL's fragment/window coordinates are bottom-up
// (gl_FragCoord.y = 0 at the framebuffer's bottom row), so the shader flips gl_FragCoord.y back to the
// same top-down convention used everywhere else (obsTexel, the geometry helper, gpu.ts); the rendered
// framebuffer is therefore bottom-up, so compute() flips the rows back on readback before building the
// top-down ImageData/canvas.

import { type Heightmap, viewshedOutputGeometry } from './heightmap.ts';
import type { ComputeOptions, ComputeResult, ViewshedComputeEngine } from './gpu.ts';

// 1 / (2 · k · R) with k = 4/3, R = 6371000 m. Mirrors gpu.ts/links3d.ts so all three LOS models agree.
const INV_KR2 = 1 / (2 * (4 / 3) * 6371000);

const VERTEX_SRC = `#version 300 es
// One full-screen triangle (covers the whole clip-space square, no shared edge seams); gl_VertexID
// needs no bound attributes.
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D heightTex;
uniform vec2 outSize;
uniform vec2 mosaicSize;
uniform vec2 obsTexel;      // observer position in OUTPUT-pixel space (top-down)
uniform vec2 outToMosaic;   // mosaicPx = outPx * outToMosaic
uniform float mpp;          // metres per OUTPUT pixel (horizontal)
uniform float txHeight;     // observer antenna AGL (m)
uniform float targetHeight; // receiver AGL at each tested cell (m)
uniform float invKR2;       // curvature coefficient 1/(2kR)
uniform float maxSteps;     // ray-march step budget (long rays sub-sample)

out vec4 outColor;

float terrainAt(vec2 outPx) {
  vec2 mp = outPx * outToMosaic;
  int mx = int(clamp(mp.x, 0.0, mosaicSize.x - 1.0));
  int my = int(clamp(mp.y, 0.0, mosaicSize.y - 1.0));
  vec3 e = texelFetch(heightTex, ivec2(mx, my), 0).rgb * 255.0; // undo unorm -> 0..255 bytes
  return (e.r * 256.0 + e.g + e.b / 256.0) - 32768.0;           // Terrarium metres
}

void main() {
  // Flip window-space (bottom-up) back to the top-down convention everything else uses.
  vec2 tgt = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);
  vec2 d = tgt - obsTexel;
  float dist = length(d);
  float eye = terrainAt(obsTexel) + txHeight;
  // Opaque green for visible, transparent for hidden (matches gpu.ts's packed 0xff00ff00u / 0u).
  if (dist < 0.5) { outColor = vec4(0.0, 1.0, 0.0, 1.0); return; } // observer's own cell

  vec2 dir = d / dist;
  float steps = min(dist, maxSteps);
  float stride = dist / steps;
  float maxTan = -1.0e30;
  for (float i = 1.0; i < steps; i += 1.0) {
    float s = i * stride * mpp;                                  // ground metres from observer
    float h = terrainAt(obsTexel + dir * (i * stride)) - s * s * invKR2;
    maxTan = max(maxTan, (h - eye) / s);
  }
  float sT = dist * mpp;
  float tH = terrainAt(tgt) + targetHeight - sT * sT * invKR2;
  bool visible = ((tH - eye) / sT) >= (maxTan - 1.0e-4);          // epsilon: target may BE the last ridge
  outColor = visible ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(0.0);
}
`;

interface UniformLocations {
  heightTex: WebGLUniformLocation | null;
  outSize: WebGLUniformLocation | null;
  mosaicSize: WebGLUniformLocation | null;
  obsTexel: WebGLUniformLocation | null;
  outToMosaic: WebGLUniformLocation | null;
  mpp: WebGLUniformLocation | null;
  txHeight: WebGLUniformLocation | null;
  targetHeight: WebGLUniformLocation | null;
  invKR2: WebGLUniformLocation | null;
  maxSteps: WebGLUniformLocation | null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Viewshed WebGL2 shader compile failed: ${log}`);
  }
  return shader;
}

export class Webgl2ViewshedEngine implements ViewshedComputeEngine {
  static isSupported(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  }

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: UniformLocations | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  private heightTex: WebGLTexture | null = null;
  private texW = 0;
  private texH = 0;

  private fbo: WebGLFramebuffer | null = null;
  private outTex: WebGLTexture | null = null;
  private outW = 0;
  private outH = 0;

  // Acquire the context and compile the program once. Returns false (rather than throwing) on any
  // failure — missing WebGL2, a lost context, or a shader compile error — so the store can mark the
  // mode unsupported and fall further back (or give up) without an unhandled rejection.
  async init(): Promise<boolean> {
    if (this.gl) {
      return true;
    }
    if (!Webgl2ViewshedEngine.isSupported()) {
      return false;
    }
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: true,
        premultipliedAlpha: false,
      });
      if (!gl) {
        return false;
      }
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Viewshed WebGL2 program link failed: ${log}`);
      }
      this.uniforms = {
        heightTex: gl.getUniformLocation(program, 'heightTex'),
        outSize: gl.getUniformLocation(program, 'outSize'),
        mosaicSize: gl.getUniformLocation(program, 'mosaicSize'),
        obsTexel: gl.getUniformLocation(program, 'obsTexel'),
        outToMosaic: gl.getUniformLocation(program, 'outToMosaic'),
        mpp: gl.getUniformLocation(program, 'mpp'),
        txHeight: gl.getUniformLocation(program, 'txHeight'),
        targetHeight: gl.getUniformLocation(program, 'targetHeight'),
        invKR2: gl.getUniformLocation(program, 'invKR2'),
        maxSteps: gl.getUniformLocation(program, 'maxSteps'),
      };
      this.vao = gl.createVertexArray();
      this.heightTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gl = gl;
      this.program = program;
      return true;
    } catch {
      return false;
    }
  }

  private ensureHeightTex(hm: Heightmap): void {
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    if (this.texW === hm.width && this.texH === hm.height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, hm.width, hm.height, gl.RGBA, gl.UNSIGNED_BYTE, hm.data);
      return;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, hm.width, hm.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, hm.data);
    this.texW = hm.width;
    this.texH = hm.height;
  }

  private ensureOutputFbo(w: number, h: number): void {
    const gl = this.gl!;
    if (this.fbo && this.outW === w && this.outH === h) {
      return;
    }
    if (this.outTex) {
      gl.deleteTexture(this.outTex);
    }
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
    }
    this.outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.outTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outTex, 0);
    this.outW = w;
    this.outH = h;
  }

  async compute(opts: ComputeOptions): Promise<ComputeResult> {
    const gl = this.gl;
    if (!gl || !this.program || !this.uniforms || !this.vao) {
      throw new Error('Webgl2ViewshedEngine.compute called before init()');
    }
    if (gl.isContextLost()) {
      throw new Error('WebGL2 context lost');
    }
    const hm = opts.heightmap;
    const outW = Math.max(1, Math.round(opts.outW));
    const outH = Math.max(1, Math.round(opts.outH));

    this.ensureHeightTex(hm);
    this.ensureOutputFbo(outW, outH);

    const { obsOutX, obsOutY, outToMosaicX, outToMosaicY, mppOut } = viewshedOutputGeometry(
      hm,
      opts.obsLon,
      opts.obsLat,
      outW,
      outH,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, outW, outH);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(this.uniforms.heightTex, 0);
    gl.uniform2f(this.uniforms.outSize, outW, outH);
    gl.uniform2f(this.uniforms.mosaicSize, hm.width, hm.height);
    gl.uniform2f(this.uniforms.obsTexel, obsOutX, obsOutY);
    gl.uniform2f(this.uniforms.outToMosaic, outToMosaicX, outToMosaicY);
    gl.uniform1f(this.uniforms.mpp, mppOut);
    gl.uniform1f(this.uniforms.txHeight, opts.txHeight);
    gl.uniform1f(this.uniforms.targetHeight, opts.targetHeight);
    gl.uniform1f(this.uniforms.invKR2, INV_KR2);
    gl.uniform1f(this.uniforms.maxSteps, Math.max(1, opts.maxSteps));

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // readPixels returns rows bottom-up (window-coordinate order); the fragment shader already
    // computed each pixel against the top-down `tgt`, so un-flip rows here to assemble a top-down
    // image for ImageData/canvas (row 0 = north), matching gpu.ts's output convention.
    const flipped = new Uint8ClampedArray(outW * outH * 4);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    const pixels = new Uint8ClampedArray(outW * outH * 4);
    const rowBytes = outW * 4;
    for (let row = 0; row < outH; row++) {
      const src = (outH - 1 - row) * rowBytes;
      pixels.set(flipped.subarray(src, src + rowBytes), row * rowBytes);
    }

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
    const gl = this.gl;
    if (!gl) {
      return;
    }
    if (this.heightTex) {
      gl.deleteTexture(this.heightTex);
    }
    if (this.outTex) {
      gl.deleteTexture(this.outTex);
    }
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
    }
    if (this.program) {
      gl.deleteProgram(this.program);
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
    }
    this.gl = null;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.heightTex = null;
    this.outTex = null;
    this.fbo = null;
    this.texW = this.texH = this.outW = this.outH = 0;
  }
}
