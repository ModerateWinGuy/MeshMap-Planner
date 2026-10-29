// Client-side colorization of a raw Float32 coverage dBm grid to RGBA. Each LUT is a piecewise-linear
// interpolation between evenly-spaced anchor stops taken from matplotlib's 256-entry colormaps: 32
// stops for viridis/plasma/turbo/jet (within ~8/255 of the original), and the exact knots for
// CMRmap/cool, which matplotlib itself defines as linear segments.

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

const VIRIDIS: RGB[] = [
  [68, 1, 84],
  [70, 12, 95],
  [71, 24, 106],
  [72, 35, 116],
  [70, 45, 124],
  [68, 55, 129],
  [65, 65, 134],
  [61, 75, 137],
  [57, 84, 139],
  [53, 92, 140],
  [49, 100, 141],
  [46, 108, 142],
  [42, 117, 142],
  [39, 124, 142],
  [36, 132, 141],
  [34, 139, 141],
  [31, 148, 139],
  [30, 155, 137],
  [31, 163, 134],
  [36, 170, 130],
  [46, 178, 124],
  [57, 185, 118],
  [71, 192, 110],
  [87, 198, 101],
  [105, 204, 91],
  [126, 210, 78],
  [146, 215, 65],
  [167, 219, 51],
  [189, 222, 38],
  [212, 225, 26],
  [233, 228, 25],
  [253, 231, 36],
];
const PLASMA: RGB[] = [
  [12, 7, 134],
  [33, 5, 143],
  [49, 4, 150],
  [64, 3, 156],
  [78, 2, 161],
  [90, 0, 165],
  [103, 0, 167],
  [117, 0, 168],
  [129, 4, 167],
  [140, 10, 164],
  [151, 19, 160],
  [162, 28, 154],
  [173, 38, 146],
  [182, 47, 139],
  [190, 56, 131],
  [198, 65, 124],
  [207, 75, 116],
  [214, 85, 109],
  [220, 94, 102],
  [227, 103, 95],
  [233, 114, 87],
  [238, 124, 80],
  [243, 134, 73],
  [246, 145, 66],
  [250, 156, 59],
  [252, 169, 52],
  [253, 181, 45],
  [253, 193, 40],
  [252, 206, 37],
  [248, 221, 36],
  [244, 234, 38],
  [239, 248, 33],
];
// Turbo (Google's improved rainbow): higher-contrast than jet, no muddy band.
const TURBO: RGB[] = [
  [48, 18, 59],
  [57, 41, 114],
  [64, 64, 161],
  [68, 88, 203],
  [70, 109, 230],
  [70, 130, 248],
  [64, 150, 254],
  [51, 172, 246],
  [37, 192, 230],
  [26, 209, 210],
  [24, 224, 189],
  [34, 235, 169],
  [59, 244, 141],
  [89, 251, 114],
  [120, 254, 89],
  [149, 254, 68],
  [174, 249, 55],
  [195, 241, 51],
  [214, 229, 53],
  [231, 215, 56],
  [244, 196, 58],
  [251, 179, 54],
  [254, 158, 46],
  [252, 134, 36],
  [247, 110, 26],
  [237, 85, 15],
  [226, 66, 9],
  [212, 50, 5],
  [195, 36, 2],
  [172, 22, 1],
  [148, 12, 1],
  [122, 4, 2],
];
// Classic jet / rainbow: blue -> cyan -> green -> yellow -> red.
const JET: RGB[] = [
  [0, 0, 127],
  [0, 0, 163],
  [0, 0, 200],
  [0, 0, 241],
  [0, 4, 255],
  [0, 36, 255],
  [0, 68, 255],
  [0, 104, 255],
  [0, 136, 255],
  [0, 168, 255],
  [0, 200, 255],
  [2, 232, 244],
  [31, 255, 215],
  [57, 255, 189],
  [83, 255, 163],
  [108, 255, 137],
  [137, 255, 108],
  [163, 255, 83],
  [189, 255, 57],
  [215, 255, 31],
  [244, 248, 2],
  [255, 218, 0],
  [255, 189, 0],
  [255, 159, 0],
  [255, 129, 0],
  [255, 96, 0],
  [255, 66, 0],
  [255, 37, 0],
  [241, 7, 0],
  [200, 0, 0],
  [163, 0, 0],
  [127, 0, 0],
];
// matplotlib "cool": a straight cyan -> magenta ramp (R 0->1, G 1->0, B held at 1).
const COOL: RGB[] = [
  [0, 255, 255],
  [255, 0, 255],
];
// matplotlib "CMRmap" (Carey Rappaport): black -> blue -> purple -> red -> orange -> white.
// Nine evenly-spaced anchors taken straight from matplotlib's _CMRmap_data (values * 255).
const CMRMAP: RGB[] = [
  [0, 0, 0],
  [38, 38, 128],
  [77, 38, 191],
  [153, 51, 128],
  [255, 64, 38],
  [230, 128, 0],
  [230, 191, 26],
  [230, 230, 128],
  [255, 255, 255],
];
const GREYS: RGB[] = [
  [0, 0, 0],
  [255, 255, 255],
];
// Hypsometric tinting. Not perceptually uniform, deliberately: the familiar atlas colours are what
// make a heightmap read as terrain at a glance.
const TERRAIN: RGB[] = [
  [26, 92, 48],
  [74, 140, 60],
  [150, 178, 78],
  [214, 196, 124],
  [178, 140, 92],
  [140, 100, 72],
  [160, 155, 150],
  [255, 255, 255],
];

export type ColormapFn = (t: number) => RGB;

export const viridis: ColormapFn = (t) => sampleStops(VIRIDIS, t);
export const plasma: ColormapFn = (t) => sampleStops(PLASMA, t);
export const turbo: ColormapFn = (t) => sampleStops(TURBO, t);
export const jet: ColormapFn = (t) => sampleStops(JET, t);
export const cool: ColormapFn = (t) => sampleStops(COOL, t);
export const cmrmap: ColormapFn = (t) => sampleStops(CMRMAP, t);
export const greys: ColormapFn = (t) => sampleStops(GREYS, t);
export const terrain: ColormapFn = (t) => sampleStops(TERRAIN, t);

// Map the matplotlib names the display config uses (and a couple of aliases) onto our LUTs. Unknown
// names fall back to turbo — a sensible high-contrast default rather than a hard failure.
const BY_NAME: Record<string, ColormapFn> = {
  viridis,
  plasma,
  turbo,
  jet,
  rainbow: jet,
  cool,
  cmrmap,
  greys,
  grays: greys,
  gray: greys,
  grey: greys,
  terrain,
};

export function colormap(name: string): ColormapFn {
  return BY_NAME[name?.toLowerCase()] ?? turbo;
}

// The color-scale choices offered in the display-settings UI (Display.vue's global panel and the
// per-layer coverage editor in App.vue).
export const COLOR_SCALE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'plasma', label: 'Plasma' },
  { value: 'CMRmap', label: 'CMR map' },
  { value: 'cool', label: 'Cool' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'turbo', label: 'Turbo' },
  { value: 'jet', label: 'Jet' },
];

// Separate from COLOR_SCALE_OPTIONS: 'terrain' and 'greys' suit elevation but not coverage.
export const HEIGHTMAP_GRADIENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'terrain', label: 'Terrain' },
  ...COLOR_SCALE_OPTIONS,
  { value: 'greys', label: 'Greys' },
];

// CSS linear-gradient sampling a colormap left (t=0) to right (t=1), for a legend swatch.
export function gradientCss(name: string): string {
  const fn = colormap(name);
  const stops: string[] = [];
  const N = 32;
  for (let i = 0; i <= N; i++) {
    const [r, g, b] = fn(i / N);
    stops.push(`rgb(${r},${g},${b}) ${Math.round((i / N) * 100)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
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
  // falloff instead of a hard 1-pixel cliff.
  const FADE_BAND = 0.15;
  for (let i = 0; i < dbm.length; i++) {
    const v = dbm[i];
    const o = i * 4;
    // NaN (no usable ITM result) and signal below the floor are not coverage: leave fully transparent
    // so the basemap shows through.
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
