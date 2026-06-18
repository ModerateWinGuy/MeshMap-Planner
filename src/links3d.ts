// A MapLibre custom layer that draws links as true 3D objects flying straight through the air
// between node antenna tops, instead of the 2D lines draped on the terrain (links-solid/-dashed in
// store.ts). Segments of a link that pass BELOW the terrain surface — i.e. the path clips into a
// hill — are coloured yellow so blocked line-of-sight stands out against the green→red viability
// palette; the rest keeps the link's quality colour. A thin vertical "mast" per node runs from the
// ground up to the antenna top, giving the line a visible origin and conveying each node's AGL
// height (MapLibre's DOM Marker can't be raised off the ground, so the interactive pin stays on the
// surface and the mast shows the height).
//
// Everything is computed in the map's *exaggerated* vertical space: queryTerrainElevation already
// returns elevation × terrainExaggeration, so antenna heights are multiplied by the same factor and
// the resulting metres are handed to MercatorCoordinate.fromLngLat, whose conformal z matches the
// rendered terrain mesh exactly. See the approved plan and [[3d-terrain-source]].
//
// Lines use three's fat-line classes (LineSegments2/LineMaterial) so they can be a few pixels wide —
// the basic GL line is locked to 1px on most drivers. The layer also stores the per-frame projection
// matrix and exposes project(), so store.ts can hit-test clicks against the elevated geometry (the
// 2D click target is offset from the visible 3D line once the camera tilts).
import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import {
  Scene,
  Camera,
  WebGLRenderer,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  MeshBasicMaterial,
  DoubleSide,
  Matrix4,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LinkResult, Node } from './types.ts';

// Neutral light grey for the AGL masts — distinct from the green→red link palette so it reads as
// structure, not signal quality.
const MAST_COLOR: [number, number, number] = [0.82, 0.85, 0.9];
// Path below terrain (blocked LOS). Bright yellow: unmistakable against both the green→red links and
// the terrain itself.
const CLIP_COLOR: [number, number, number] = [1, 0.85, 0];
const LINE_WIDTH_PX = 3.5;
// Initial opacity of the vertical drop-curtain hanging from each link down to the terrain. This is
// just the material default; the live value is driven by the Terrain panel slider (store's
// linkCurtainOpacity, set via Links3DLayer.setCurtainOpacity).
const CURTAIN_OPACITY = 0.5;
// The curtain's bottom edge is dropped this far (metres, pre-exaggeration) below the lowest terrain on
// the link, so it's safely buried and the depth test clips it against the terrain mesh rather than
// z-fighting a surface-hugging edge. See buildLinkGeometry.
const CURTAIN_FLOOR_MARGIN_M = 600;

// Earth-curvature bulge for the line-of-sight chord (4/3 effective-earth-radius model, standard
// refractivity). MapLibre renders terrain on a flat mercator plane with true elevations — neither the
// mesh nor a straight chord carries the curvature, so a long link's mid-span clearance reads
// optimistically (~13 m too high at 30 km, ~37 m at 50 km) unless we sag the chord by this amount.
// Mirrors ProfilePanel.vue so the 3D blocked-LOS (yellow) test agrees with the profile chart.
const EARTH_RADIUS_M = 6371000;
const K_FACTOR = 4 / 3;

// linkColor (store.ts) returns either 'rgb(r, g, b)' or a '#rrggbb' hex; normalise both to 0..1.
// Done by hand rather than via THREE.Color to sidestep three's sRGB/linear colour management, which
// would subtly shift these deliberately-chosen shades.
function parseRgb01(s: string): [number, number, number] {
  if (s.startsWith('#')) {
    const n = parseInt(s.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) {
    return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  }
  return [0.5, 0.5, 0.5];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Project a lng/lat at an (already-exaggerated) altitude in metres to the [0..1] mercator world
// coords with conformal z that defaultProjectionData.mainMatrix expects.
function mercator(lng: number, lat: number, altExagMeters: number): [number, number, number] {
  const mc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], altExagMeters);
  return [mc.x, mc.y, mc.z];
}

// One link's elevated polyline (flat mercator xyz) kept for click hit-testing in store.ts.
export interface LinkPick {
  a: string;
  b: string;
  pts: Float32Array;
}

export interface LinkGeometry {
  positions: Float32Array; // gl.LINES vertex pairs (chords + masts), RELATIVE to origin
  colors: Float32Array; // matching per-vertex rgb
  curtainPositions: Float32Array; // drop-curtain triangles, RELATIVE to origin
  curtainColors: Float32Array; // matching per-vertex rgb
  // The mercator point the vertex buffers are relative to; render() folds it back into the matrix.
  origin: { x: number; y: number; z: number };
  picks: LinkPick[]; // absolute mercator polylines (used for click hit-testing, projected on CPU)
}

// Build the line vertex/colour buffers for every link plus one mast per referenced node, and the
// per-link polylines for picking. queryElev returns the rendered (exaggerated) terrain elevation in
// metres at a point, or null when the covering tile hasn't loaded / terrain is off — callers should
// rebuild on terrain 'data' and 'moveend' so nulls resolve. exaggeration is the active factor.
export function buildLinkGeometry(
  links: LinkResult[],
  nodesById: Record<string, Node>,
  queryElev: (lngLat: [number, number]) => number | null,
  exaggeration: number,
): LinkGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const curtainPositions: number[] = [];
  const curtainColors: number[] = [];
  const picks: LinkPick[] = [];

  // Render vertices RELATIVE to a near-data origin (the centroid of the referenced nodes), folding
  // the big offset back into the projection matrix on the CPU in render(). MapLibre hands custom
  // layers a float64 mainMatrix, but three uploads the camera matrix to the GPU as float32 — so
  // absolute mercator coords (~0.5) lose their low bits in the shader and the lines twitch as the
  // camera moves. Small relative coords keep that float32 precision where it matters.
  let sx = 0;
  let sy = 0;
  let cnt = 0;
  const seenOrigin = new Set<string>();
  for (const link of links) {
    for (const id of [link.a, link.b]) {
      const node = nodesById[id];
      if (node && !seenOrigin.has(id)) {
        seenOrigin.add(id);
        const mc = maplibregl.MercatorCoordinate.fromLngLat([node.transmitter.tx_lon, node.transmitter.tx_lat], 0);
        sx += mc.x;
        sy += mc.y;
        cnt++;
      }
    }
  }
  const ox = cnt ? sx / cnt : 0;
  const oy = cnt ? sy / cnt : 0;
  const oz = 0; // altitude-derived z is tiny; only x/y carry the large offset
  const pushRel = (arr: number[], p: [number, number, number]): void => {
    arr.push(p[0] - ox, p[1] - oy, p[2] - oz);
  };

  // Per-node ground + antenna-top altitude (exaggerated metres), computed once and shared by the
  // node's mast and every link that touches it so the line springs exactly from the mast tip.
  type Top = { lon: number; lat: number; ground: number; top: number };
  const tops = new Map<string, Top>();
  const topFor = (id: string): Top | null => {
    const cached = tops.get(id);
    if (cached) {
      return cached;
    }
    const node = nodesById[id];
    if (!node) {
      return null;
    }
    const lon = node.transmitter.tx_lon;
    const lat = node.transmitter.tx_lat;
    const ground = queryElev([lon, lat]) ?? 0;
    // Both link endpoints use tx_height as antenna height (matches the link-matrix convention).
    const top = ground + node.transmitter.tx_height * exaggeration;
    const t: Top = { lon, lat, ground, top };
    tops.set(id, t);
    return t;
  };

  for (const link of links) {
    const a = topFor(link.a);
    const b = topFor(link.b);
    if (!a || !b) {
      continue; // a node was deleted since the matrix ran
    }
    const color = parseRgb01(linkColorString(link.margin_db));

    // Sample the chord between the two antenna tops, denser for longer links. The horizontal track is
    // interpolated in MERCATOR space, not raw lng/lat: MapLibre draws the 2D draped link line straight
    // between the two projected endpoints, and web-mercator northing is non-linear in latitude — so
    // linear lng/lat interpolation bows away from that 2D line, worst at mid-span on long N–S links.
    // Lerping mercator x/y keeps the 3D line and its curtain sitting on top of the 2D line; each sample
    // is unprojected back to lng/lat only for the terrain query.
    const distKm = link.distance_km ?? 0;
    const dM = distKm * 1000;
    const n = clamp(Math.round(distKm * 2), 16, 64);
    const mcA = maplibregl.MercatorCoordinate.fromLngLat([a.lon, a.lat], 0);
    const mcB = maplibregl.MercatorCoordinate.fromLngLat([b.lon, b.lat], 0);
    const lngs: number[] = [];
    const lats: number[] = [];
    const terrs: number[] = []; // sampled terrain (exaggerated metres) under each chord point
    const top: Array<[number, number, number]> = []; // chord (line through the air)
    const below: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const ll = new maplibregl.MercatorCoordinate(
        mcA.x + (mcB.x - mcA.x) * t,
        mcA.y + (mcB.y - mcA.y) * t,
        0,
      ).toLngLat();
      const lng = ll.lng;
      const lat = ll.lat;
      // Sag the straight chord by the earth-curvature bulge at this point. The bulge is a real-world
      // metre quantity, so scale it by exaggeration to live in the map's exaggerated vertical space
      // (a.top and queryElev already are). Zero at both ends, maximal mid-span.
      const d1 = dM * t;
      const bulge = (d1 * (dM - d1)) / (2 * K_FACTOR * EARTH_RADIUS_M);
      const alt = a.top + (b.top - a.top) * t - bulge * exaggeration;
      const terr = queryElev([lng, lat]) ?? alt; // fallback: treat unknown terrain as clear
      lngs.push(lng);
      lats.push(lat);
      terrs.push(terr);
      top.push(mercator(lng, lat, alt));
      below.push(alt < terr);
    }
    // Curtain bottom: a flat edge dropped well below the lowest terrain on the link (by the relief
    // plus a margin), NOT resting on the surface. The depth test then clips the curtain against the
    // terrain mesh, so the visible bottom edge is the terrain's own silhouette — stable under camera
    // motion — instead of a coarsely-sampled coplanar edge that z-fights and crawls.
    let gMin = Infinity;
    let gMax = -Infinity;
    for (const e of terrs) {
      if (e < gMin) gMin = e;
      if (e > gMax) gMax = e;
    }
    const floorAlt = gMin - (gMax - gMin) - CURTAIN_FLOOR_MARGIN_M * exaggeration;
    const bot: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      bot.push(mercator(lngs[i], lats[i], floorAlt));
    }
    const flat = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      flat[i * 3] = top[i][0];
      flat[i * 3 + 1] = top[i][1];
      flat[i * 3 + 2] = top[i][2];
      if (i > 0) {
        // A segment is the clip colour if either endpoint is below ground; one-sample slop at the
        // boundary is acceptable at this sample density.
        const segColor = below[i - 1] || below[i] ? CLIP_COLOR : color;
        pushRel(positions, top[i - 1]);
        pushRel(positions, top[i]);
        colors.push(...segColor, ...segColor);
        // Drop-curtain quad between the chord edge (top) and the ground edge (bot), two triangles,
        // so the line's ground track is readable and it visibly descends into terrain on a clip.
        pushRel(curtainPositions, top[i - 1]);
        pushRel(curtainPositions, bot[i - 1]);
        pushRel(curtainPositions, top[i]);
        pushRel(curtainPositions, top[i]);
        pushRel(curtainPositions, bot[i - 1]);
        pushRel(curtainPositions, bot[i]);
        for (let k = 0; k < 6; k++) {
          curtainColors.push(...segColor);
        }
      }
    }
    picks.push({ a: link.a, b: link.b, pts: flat });
  }

  // One mast per referenced node (tops map already deduped them).
  for (const t of tops.values()) {
    pushRel(positions, mercator(t.lon, t.lat, t.ground));
    pushRel(positions, mercator(t.lon, t.lat, t.top));
    colors.push(...MAST_COLOR, ...MAST_COLOR);
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    curtainPositions: new Float32Array(curtainPositions),
    curtainColors: new Float32Array(curtainColors),
    origin: { x: ox, y: oy, z: oz },
    picks,
  };
}

// Resolve a link's quality colour. Injected from store.ts (which owns linkColor) via setLinkColorFn
// so the 2D and 3D links stay in lockstep without a circular import.
let linkColorString: (margin: number | null) => string = () => '#888888';
export function setLinkColorFn(fn: (margin: number | null) => string): void {
  linkColorString = fn;
}

// The custom layer. Hosts a minimal three.js scene (one fat LineSegments2 with per-vertex colours)
// drawn into MapLibre's own GL context each frame, with the camera driven by MapLibre's projection
// matrix.
export class Links3DLayer implements CustomLayerInterface {
  readonly id = 'links-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: Camera;
  private material!: LineMaterial;
  private lines!: LineSegments2;
  private curtainMat!: MeshBasicMaterial;
  private curtainMesh!: Mesh;
  private vertexCount = 0;
  // The most recent projection matrix (column-major mat4), captured each render so project() can
  // hit-test clicks against the elevated geometry between frames.
  private lastMatrix: number[] | null = null;
  // Origin the vertex buffers are relative to (see buildLinkGeometry). Folded back into the camera
  // matrix each frame so the float32 GPU upload only carries small numbers (no twitch).
  private origin = { x: 0, y: 0, z: 0 };
  private readonly projM = new Matrix4();
  private readonly transM = new Matrix4();
  // A small DOM dot riding the 3D line-of-sight beam, kept in sync with the profile chart's hover dot.
  // Positioned each frame by projecting cursorPoint (absolute mercator xyz) to canvas pixels (see
  // updateCursor / setBeamCursor); null = hidden.
  private cursorEl: HTMLDivElement | null = null;
  private cursorPoint: [number, number, number] | null = null;

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.camera = new Camera();
    this.scene = new Scene();
    // depthTest off: the yellow below-ground portions stay visible through the hill (user choice)
    // rather than being occluded by the terrain mesh. Lines are opaque (alpha 1). alphaToCoverage
    // gives smooth (anti-aliased) edges via MSAA sample coverage — the map is created with
    // antialias:true so the framebuffer is multisampled.
    this.material = new LineMaterial({
      vertexColors: true,
      linewidth: LINE_WIDTH_PX, // pixels (worldUnits defaults to false)
      depthTest: false,
      transparent: false,
      alphaToCoverage: true,
    });
    this.lines = new LineSegments2(new LineSegmentsGeometry(), this.material);
    this.lines.frustumCulled = false; // vertices live in mercator space, not three's world bounds
    this.scene.add(this.lines);

    // The faint drop-curtain hanging from each link down to the terrain. Unlike the always-visible
    // line, depthTest stays on so terrain occludes it — the curtain visibly descends into a hill at a
    // clip. depthWrite off so its own overlapping translucent quads don't z-fight.
    this.curtainMat = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: CURTAIN_OPACITY,
      side: DoubleSide,
      depthWrite: false,
    });
    this.curtainMesh = new Mesh(new BufferGeometry(), this.curtainMat);
    this.curtainMesh.frustumCulled = false;
    this.scene.add(this.curtainMesh);
    // Share MapLibre's canvas + GL context; never auto-clear (that would wipe the map).
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;

    // The profile-synced beam dot. An HTML overlay in the canvas container (rather than scene
    // geometry) so it's a true pixel-sized circle matching the profile chart's dot, always on top.
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;top:0;width:14px;height:14px;border:2px solid #f2e205;' +
      'background:rgba(242,226,5,0.25);border-radius:50%;pointer-events:none;display:none;will-change:transform;';
    map.getCanvasContainer().appendChild(el);
    this.cursorEl = el;
  }

  setData(g: LinkGeometry): void {
    const count = g.positions.length / 3;
    const geo = new LineSegmentsGeometry();
    if (count > 0) {
      geo.setPositions(g.positions);
      geo.setColors(g.colors);
    }
    this.lines.geometry.dispose();
    this.lines.geometry = geo;
    this.vertexCount = count;
    this.origin = g.origin;

    const cGeo = new BufferGeometry();
    if (g.curtainPositions.length > 0) {
      cGeo.setAttribute('position', new Float32BufferAttribute(g.curtainPositions, 3));
      cGeo.setAttribute('color', new Float32BufferAttribute(g.curtainColors, 3));
    }
    this.curtainMesh.geometry.dispose();
    this.curtainMesh.geometry = cGeo;
  }

  // Live-update the drop-curtain opacity (0..1) from the Terrain panel slider. Guards against being
  // called before onAdd has created the material.
  setCurtainOpacity(opacity: number): void {
    if (this.curtainMat) {
      this.curtainMat.opacity = opacity;
    }
  }

  // Show/hide just the drop-curtain (the lines + masts stay).
  setCurtainVisible(on: boolean): void {
    if (this.curtainMesh) {
      this.curtainMesh.visible = on;
    }
  }

  // Place (point) or hide (null) the beam dot synced to the profile chart's hover. point is absolute
  // mercator xyz on a link's elevated polyline; render() reprojects it each frame so it tracks the
  // beam as the camera moves. Position it now too, so a hover while the camera is idle updates it.
  setBeamCursor(point: [number, number, number] | null): void {
    this.cursorPoint = point;
    this.updateCursor();
  }

  private updateCursor(): void {
    const el = this.cursorEl;
    if (!el) {
      return;
    }
    const p = this.cursorPoint;
    const s = p ? this.project(p[0], p[1], p[2]) : null;
    if (!s) {
      el.style.display = 'none';
      return;
    }
    el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    el.style.display = 'block';
  }

  clear(): void {
    this.setBeamCursor(null);
    this.setData({
      positions: new Float32Array(0),
      colors: new Float32Array(0),
      curtainPositions: new Float32Array(0),
      curtainColors: new Float32Array(0),
      origin: { x: 0, y: 0, z: 0 },
      picks: [],
    });
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (this.vertexCount === 0) {
      return;
    }
    // mainMatrix maps [0..1] mercator world coords (conformal z in 3D mode) to clip space. MapLibre
    // hands it to us in float64; we pre-multiply by the origin translation HERE (in JS double
    // precision) so the matrix uploaded to the GPU as float32 maps our small RELATIVE vertex coords —
    // the offset is absorbed without precision loss, killing the camera-motion twitch.
    this.lastMatrix = Array.from(args.defaultProjectionData.mainMatrix as unknown as number[]);
    this.projM.fromArray(this.lastMatrix);
    this.transM.makeTranslation(this.origin.x, this.origin.y, this.origin.z);
    this.projM.multiply(this.transM);
    this.camera.projectionMatrix.copy(this.projM);
    // LineMaterial sizes its quads in pixels, so it needs the framebuffer resolution each frame.
    const ctx = this.renderer.getContext();
    this.material.resolution.set(ctx.drawingBufferWidth, ctx.drawingBufferHeight);
    this.renderer.resetState(); // three and MapLibre share the context; resync three's cached GL state
    this.renderer.render(this.scene, this.camera);
    this.updateCursor(); // keep the profile-synced beam dot glued to the line as the camera moves
  }

  // Project a mercator world point to CSS pixel coordinates on the map canvas (matching MapLibre's
  // event point), or null if it's behind the camera or no frame has rendered yet.
  project(mx: number, my: number, mz: number): { x: number; y: number } | null {
    const m = this.lastMatrix;
    if (!m) {
      return null;
    }
    const cx = m[0] * mx + m[4] * my + m[8] * mz + m[12];
    const cy = m[1] * mx + m[5] * my + m[9] * mz + m[13];
    const cw = m[3] * mx + m[7] * my + m[11] * mz + m[15];
    if (cw <= 0) {
      return null; // at or behind the camera plane
    }
    const canvas = this.map.getCanvas();
    return {
      x: ((cx / cw) * 0.5 + 0.5) * canvas.clientWidth,
      y: (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.clientHeight,
    };
  }

  onRemove(): void {
    this.cursorEl?.remove();
    this.cursorEl = null;
    this.lines.geometry.dispose();
    this.material.dispose();
    this.curtainMesh.geometry.dispose();
    this.curtainMat.dispose();
    this.renderer.dispose();
  }
}
