// Client-side colorization of a coverage dBm grid. The server baked a matplotlib colormap into its
// GeoTIFF palette; computing coverage in the browser instead means we hold a raw Float32 dBm grid and
// must map it to RGBA ourselves. These LUTs are piecewise-linear interpolations between a handful of
// anchor stops per colormap — close enough to read like the matplotlib originals, not bit-exact.

import type { CoverageGrid } from './coverageTypes.ts';

type RGB = [number, number, number];

// Sample a list of evenly-spaced RGB anchor stops at t in [0,1], linearly interpolating between the
// two bracketing stops. With N stops the segment boundaries sit at i/(N-1).
function sampleStops(stops: RGB[], t: number): RGB {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

// Anchor stops sampled off the matplotlib originals (perceptually-ordered low->high).
const VIRIDIS: RGB[] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88],
  [181, 222, 43], [253, 231, 37],
];
const PLASMA: RGB[] = [
  [13, 8, 135], [75, 3, 161], [125, 3, 168], [168, 34, 150],
  [203, 70, 121], [229, 107, 93], [248, 148, 65], [253, 195, 40],
  [240, 249, 33],
];
// Turbo (Google's improved rainbow): higher-contrast than jet, no muddy band.
const TURBO: RGB[] = [
  [48, 18, 59], [70, 107, 227], [40, 187, 213], [53, 233, 119],
  [165, 254, 60], [240, 199, 47], [253, 121, 32], [213, 47, 14],
  [122, 4, 3],
];
// Classic jet / rainbow: blue -> cyan -> green -> yellow -> red.
const JET: RGB[] = [
  [0, 0, 131], [0, 60, 170], [5, 255, 255], [255, 255, 0],
  [250, 0, 0], [128, 0, 0],
];
const GREYS: RGB[] = [[0, 0, 0], [255, 255, 255]];

export type ColormapFn = (t: number) => RGB;

export const viridis: ColormapFn = (t) => sampleStops(VIRIDIS, t);
export const plasma: ColormapFn = (t) => sampleStops(PLASMA, t);
export const turbo: ColormapFn = (t) => sampleStops(TURBO, t);
export const jet: ColormapFn = (t) => sampleStops(JET, t);
export const greys: ColormapFn = (t) => sampleStops(GREYS, t);

// Map the matplotlib names the display config uses (and a couple of aliases) onto our LUTs. Unknown
// names fall back to turbo — a sensible high-contrast default rather than a hard failure.
const BY_NAME: Record<string, ColormapFn> = {
  viridis,
  plasma,
  turbo,
  jet,
  rainbow: jet,
  greys,
  grays: greys,
  gray: greys,
  grey: greys,
};

export function colormap(name: string): ColormapFn {
  return BY_NAME[name?.toLowerCase()] ?? turbo;
}

// Colorize a coverage grid into a width×height RGBA canvas, ready to drape as a MapLibre canvas
// source. Row 0 of the grid is the NORTH edge, which is exactly how a canvas's first pixel row maps
// to the top of an image source, so no vertical flip is needed.
export function colorizeGrid(
  grid: CoverageGrid,
  minDbm: number,
  maxDbm: number,
  colormapName: string,
): HTMLCanvasElement {
  const { width, height, dbm } = grid;
  const fn = colormap(colormapName);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  const data = img.data;
  // A degenerate range (min==max) would divide by zero; guard so every finite cell lands at t=0.
  const span = maxDbm - minDbm;
  // Fade the weakest band of signal in over the bottom FADE_BAND of the dBm range rather than cutting
  // off at full opacity, so the coverage perimeter (where signal ≈ min_dbm) is a soft translucent
  // falloff instead of a hard 1-pixel cliff. The old server overlay looked soft mostly because it was
  // low-res and got smooth-scaled when draped; this reproduces that edge at the new higher resolution.
  const FADE_BAND = 0.15;
  for (let i = 0; i < dbm.length; i++) {
    const v = dbm[i];
    const o = i * 4;
    // NaN (no usable ITM result) and signal below the floor are not coverage: leave fully transparent
    // so the basemap shows through, matching the server palette's nodata handling.
    if (Number.isNaN(v) || v < minDbm) {
      data[o + 3] = 0;
      continue;
    }
    const t = span > 0 ? Math.min(1, (v - minDbm) / span) : 0;
    const [r, g, b] = fn(t);
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = t < FADE_BAND ? Math.round(255 * (t / FADE_BAND)) : 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
