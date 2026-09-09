// Run: npx vite-node src/terrain/reliefRange.check.mjs
// Checks that the heightmap scan samples the VIEW box, not the enclosing tile block.
import assert from 'node:assert';
import { scanJobs, reliefRampExpression } from './reliefRange.ts';
import { TILE } from './demTiles.ts';

const px2lon = (px, z) => (px / (TILE * 2 ** z)) * 360 - 180;
const px2lat = (py, z) => {
  const t = Math.PI * (1 - (2 * py) / (TILE * 2 ** z));
  return (180 / Math.PI) * Math.atan(Math.sinh(t));
};

// Geographic extent actually sampled, from the union of the clipped per-tile rects.
function sampledBox(z, jobs) {
  let pxW = Infinity,
    pxE = -Infinity,
    pyN = Infinity,
    pyS = -Infinity;
  for (const j of jobs) {
    pxW = Math.min(pxW, j.x * TILE + j.lx0);
    pxE = Math.max(pxE, j.x * TILE + j.lx1);
    pyN = Math.min(pyN, j.y * TILE + j.ly0);
    pyS = Math.max(pyS, j.y * TILE + j.ly1);
  }
  return { west: px2lon(pxW, z), east: px2lon(pxE, z), north: px2lat(pyN, z), south: px2lat(pyS, z) };
}

// Km of terrain sampled beyond each view edge (negative = inside the view).
function overhangKm(view, got) {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = kmPerDegLat * Math.cos((((view.north + view.south) / 2) * Math.PI) / 180);
  return Math.max(
    (view.west - got.west) * kmPerDegLon,
    (got.east - view.east) * kmPerDegLon,
    (got.north - view.north) * kmPerDegLat,
    (view.south - got.south) * kmPerDegLat,
  );
}

// A typical desktop map area over Aoraki/Mt Cook, at several zooms.
const views = [
  { name: 'z13 valley', z: 13, west: 170.05, east: 170.25, south: -43.65, north: -43.55 },
  { name: 'z12 regional', z: 12, west: 170.0, east: 170.4, south: -43.7, north: -43.5 },
  { name: 'z11 wide', z: 11, west: 169.8, east: 170.6, south: -43.9, north: -43.4 },
  { name: 'z9 very wide', z: 9, west: 168.5, east: 172.0, south: -44.5, north: -43.0 },
];

let worst = -Infinity;
for (const v of views) {
  const { z, jobs } = scanJobs(v.west, v.east, v.north, v.south, v.z);
  assert.ok(jobs.length > 0, v.name + ': no jobs');
  const got = sampledBox(z, jobs);
  const over = overhangKm(v, got);
  worst = Math.max(worst, over);
  // One stride step of slack: rects are ceil()ed to whole pixels.
  const slackKm = (40075 / 2 ** z / TILE) * 4;
  assert.ok(over <= slackKm, `${v.name}: overhangs view by ${over.toFixed(2)} km (slack ${slackKm.toFixed(2)})`);
  console.log(
    `ok  ${v.name.padEnd(14)} scan z${z}  ${String(jobs.length).padStart(3)} tiles  overhang ${(over * 1000).toFixed(0).padStart(5)} m`,
  );
}
console.log(`\nworst overhang: ${(worst * 1000).toFixed(0)} m (was up to ~19600 m before clipping)`);

// Antimeridian: a view straddling +/-180 must still produce in-grid tile x values.
{
  const { z, jobs } = scanJobs(179.6, 180.4, -16.5, -17.5, 11);
  const n = 2 ** z;
  assert.ok(jobs.length > 0, 'antimeridian: no jobs');
  for (const j of jobs) assert.ok(j.x >= 0 && j.x < n, `antimeridian: tile x ${j.x} out of grid`);
  assert.ok(new Set(jobs.map((j) => j.x)).size > 1, 'antimeridian: expected columns on both sides');
  console.log('ok  antimeridian   wraps into grid, spans both sides');
}

// Every job must carry a non-empty, in-bounds pixel rect.
{
  const { jobs } = scanJobs(174.0, 175.0, -36.5, -37.5, 12);
  for (const j of jobs) {
    assert.ok(j.lx1 > j.lx0 && j.ly1 > j.ly0, 'empty rect emitted');
    assert.ok(j.lx0 >= 0 && j.lx1 <= TILE && j.ly0 >= 0 && j.ly1 <= TILE, 'rect out of tile');
  }
  console.log('ok  pixel rects   non-empty and within 0..256');
}

// Ramp stops must stay strictly ascending, including a degenerate (flat/ocean) range.
for (const [name, lo, hi] of [
  ['terrain', 0, 3724],
  ['turbo', 412, 486],
  ['greys', 0, 0],
  ['viridis', 1200, 1200.5],
]) {
  const e = reliefRampExpression(name, lo, hi);
  const stops = e.filter((_, i) => i >= 3 && (i - 3) % 2 === 0);
  assert.strictEqual(stops.length, 17, 'stop count');
  assert.strictEqual(stops[0], lo, 'first stop != min');
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i] > stops[i - 1], `not ascending (${name} ${lo}..${hi})`);
}
console.log('ok  ramp stops    strictly ascending, degenerate range widened');

console.log('\nall checks passed');
