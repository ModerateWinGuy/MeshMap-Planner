<template>
    <div class="profile-strip text-bg-dark" data-bs-theme="dark">
        <button type="button" class="btn btn-sm p-0 border-0 bg-transparent lh-1 profile-close" aria-label="Close profile" title="Close" @click="store.clearProfile()">
            <X :size="20" />
        </button>

        <!-- Running / failed states replace the chart. -->
        <div v-if="store.profileState === 'running'" class="profile-status">
            <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
            {{ store.progress?.message || 'Computing terrain profile…' }}
        </div>
        <div v-else-if="store.profileState === 'failed'" class="profile-status text-danger">
            {{ store.profileError || 'Profile computation failed.' }}
        </div>

        <template v-else-if="store.profileResult">
            <!-- Header: endpoint identity on the corners, headline link budget across the middle. -->
            <div class="profile-header">
                <div class="text-start">
                    <div class="fw-bold text-info">{{ fromNode?.transmitter.name || 'Point A' }}</div>
                    <div class="text-muted">{{ fromCoord }} · {{ fromNode?.transmitter.tx_height ?? '?' }} m AGL</div>
                    <div class="text-muted" v-if="bearing !== null">{{ bearing.toFixed(1) }}° →</div>
                </div>

                <div class="profile-stats">
                    <span><span class="text-muted">TX EIRP</span> <strong>{{ fmt(r.tx_eirp_dbm) }} dBm</strong></span>
                    <span><span class="text-muted">Est. RX</span> <strong>{{ fmt(r.rx_signal_dbm) }} dBm</strong></span>
                    <span><span class="text-muted">Distance</span> <strong>{{ fmt(r.distance_km) }} km</strong></span>
                    <span><span class="text-muted">Path loss</span> <strong>{{ fmt(r.path_loss_db) }} dB</strong></span>
                    <span><span class="text-muted">Fresnel clear</span> <strong>{{ fresnelPct === null ? '—' : fresnelPct + '%' }}</strong></span>
                    <span class="badge" :style="{ background: marginColor }">
                        {{ r.margin_db === null ? 'no signal' : `${r.margin_db >= 0 ? '+' : ''}${r.margin_db} dB ${r.viable ? 'viable' : 'fail'}` }}
                    </span>
                </div>

                <div class="text-end profile-right">
                    <div class="fw-bold text-info">{{ toNode?.transmitter.name || 'Point B' }}</div>
                    <div class="text-muted">{{ toCoord }} · {{ toNode?.transmitter.tx_height ?? '?' }} m AGL</div>
                    <div class="text-muted" v-if="fromNode">{{ fromNode.transmitter.tx_freq }} MHz</div>
                </div>
            </div>

            <!-- Inline SVG chart. viewBox + 100% width keeps it crisp and responsive without a chart lib. -->
            <svg v-if="chart" class="profile-svg" :viewBox="`0 0 ${VB_W} ${VB_H}`" preserveAspectRatio="none">
                <!-- y grid + labels -->
                <g v-for="t in chart.yTicks" :key="'y' + t.v">
                    <line :x1="PAD_L" :y1="t.y" :x2="VB_W - PAD_R" :y2="t.y" stroke="#ffffff14" stroke-width="1" />
                    <text :x="PAD_L - 8" :y="t.y + 5" text-anchor="end" class="axis-label">{{ t.v }}</text>
                </g>
                <!-- minor distance ticks (ruler dashes) -->
                <line v-for="(mx, i) in chart.xMinorTicks" :key="'xm' + i" :x1="mx" :y1="VB_H - PAD_B" :x2="mx" :y2="VB_H - PAD_B + 8" stroke="#ffffff45" stroke-width="1" />
                <!-- x grid + labels -->
                <g v-for="t in chart.xTicks" :key="'x' + t.v">
                    <line :x1="t.x" :y1="PAD_T" :x2="t.x" :y2="VB_H - PAD_B + 13" stroke="#ffffff10" stroke-width="1" />
                    <text :x="t.x" :y="VB_H - PAD_B + 30" text-anchor="middle" class="axis-label">{{ t.v }}</text>
                </g>

                <!-- terrain -->
                <path :d="chart.terrainFill" fill="#6b563f" fill-opacity="0.85" />
                <path :d="chart.terrainLine" fill="none" stroke="#9acd32" stroke-width="2" />
                <!-- first Fresnel zone band + 60% boundary -->
                <path v-if="chart.fresnelBand" :d="chart.fresnelBand" fill="#d83a4b" fill-opacity="0.30" />
                <path v-if="chart.fresnel60Line" :d="chart.fresnel60Line" fill="none" stroke="#ff8a8a" stroke-width="1.5" stroke-dasharray="6 5" />
                <!-- line of sight -->
                <path :d="chart.losLine" fill="none" stroke="#f2e205" stroke-width="2" />

                <text :x="PAD_L" :y="VB_H - 4" class="axis-title">Distance (km) →</text>
                <text :x="6" :y="PAD_T - 8" class="axis-title">Elevation (m)</text>
            </svg>
            <div v-else class="profile-status text-muted">No terrain profile data returned.</div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { X } from '@lucide/vue'
import { useStore } from '../store.ts'
import type { ProfileCurve } from '../types.ts'

const store = useStore()

const VB_W = 1600, VB_H = 320
const PAD_L = 70, PAD_R = 20, PAD_T = 24, PAD_B = 44

// `r` is only read inside v-else-if="store.profileResult", so it's non-null there; the cast keeps
// the template terse without a guard on every access.
const r = computed(() => store.profileResult!)
const fromNode = computed(() => store.nodes.find((n) => n.id === store.profileFromId))
const toNode = computed(() => store.nodes.find((n) => n.id === store.profileToId))

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v)

const fromCoord = computed(() =>
    fromNode.value ? `${fromNode.value.transmitter.tx_lat.toFixed(4)}, ${fromNode.value.transmitter.tx_lon.toFixed(4)}` : ''
)
const toCoord = computed(() =>
    toNode.value ? `${toNode.value.transmitter.tx_lat.toFixed(4)}, ${toNode.value.transmitter.tx_lon.toFixed(4)}` : ''
)

const bearing = computed<number | null>(() => {
    const a = fromNode.value, b = toNode.value
    if (!a || !b) return null
    const toRad = (d: number) => (d * Math.PI) / 180
    const toDeg = (rad: number) => (rad * 180) / Math.PI
    const lat1 = toRad(a.transmitter.tx_lat), lat2 = toRad(b.transmitter.tx_lat)
    const dLon = toRad(b.transmitter.tx_lon - a.transmitter.tx_lon)
    const y = Math.sin(dLon) * Math.cos(lat2)
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
    return (toDeg(Math.atan2(y, x)) + 360) % 360
})

const marginColor = computed(() => {
    const m = store.profileResult?.margin_db
    if (m === null || m === undefined) return '#6c757d'
    return m >= 0 ? '#2e9e3f' : '#c0392b'
})

// "Nice" tick step for an axis range so labels land on round numbers.
function niceStep(range: number, target: number): number {
    const raw = range / target
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const norm = raw / mag
    const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
    return step * mag
}

// Effective earth radius (4/3 model, standard refractivity) for the line-of-sight curvature bulge.
const EARTH_RADIUS_M = 6371000
const K_FACTOR = 4 / 3

const chart = computed(() => {
    const terrain = store.profileResult?.profile?.terrain
    if (!terrain || !terrain.length) return null

    // Antenna heights (AGL) and frequency from the two nodes; ground at each end from the terrain
    // profile (TX at distance 0, RX at the far end).
    const hA = fromNode.value?.transmitter.tx_height ?? 0
    const hB = toNode.value?.transmitter.tx_height ?? 0
    const freqMhz = fromNode.value?.transmitter.tx_freq ?? 900
    const dKm = store.profileResult?.distance_km ?? terrain[terrain.length - 1][0]
    const dM = Math.max(dKm * 1000, 1)
    const wavelength = 299.792458 / freqMhz // metres

    const groundA = terrain[0][1]
    const groundB = terrain[terrain.length - 1][1]
    const topA = groundA + hA // antenna tops above sea level: the LOS endpoints
    const topB = groundB + hB

    // Build the line-of-sight, first-Fresnel-zone bounds and 60% boundary at each terrain sample.
    // The LOS is the straight chord between antenna tops, sagged by the earth-curvature bulge so a
    // long path's clearance reads correctly against the (true elevation) terrain.
    const los: ProfileCurve = []
    const fresUpper: ProfileCurve = []
    const fresLower: ProfileCurve = []
    const fres60: ProfileCurve = []
    for (const [d] of terrain) {
        const d1 = Math.min(Math.max(d * 1000, 0), dM)
        const frac = d1 / dM
        const bulge = (d1 * (dM - d1)) / (2 * K_FACTOR * EARTH_RADIUS_M)
        const losV = topA + (topB - topA) * frac - bulge
        const f1 = Math.sqrt(Math.max(wavelength * (d1 * (dM - d1)) / dM, 0))
        los.push([d, losV])
        fresUpper.push([d, losV + f1])
        fresLower.push([d, losV - f1])
        fres60.push([d, losV - 0.6 * f1])
    }

    const xMax = Math.max(terrain[terrain.length - 1][0], 0.001)
    const ys = [...terrain, ...fresUpper, ...fresLower].map((d) => d[1])
    let yMin = Math.min(...ys)
    let yMax = Math.max(...ys)
    if (yMax - yMin < 1) yMax = yMin + 1 // avoid a zero range on a perfectly flat slice
    const pad = (yMax - yMin) * 0.08
    yMin -= pad
    yMax += pad

    const plotW = VB_W - PAD_L - PAD_R
    const plotH = VB_H - PAD_T - PAD_B
    const sx = (d: number) => PAD_L + (d / xMax) * plotW
    const sy = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * plotH

    const toPath = (pts: ProfileCurve) =>
        pts.map((pt, i) => `${i ? 'L' : 'M'}${sx(pt[0]).toFixed(1)},${sy(pt[1]).toFixed(1)}`).join(' ')
    const reversePts = (pts: ProfileCurve) =>
        [...pts].reverse().map((pt) => `L${sx(pt[0]).toFixed(1)},${sy(pt[1]).toFixed(1)}`).join(' ')

    const terrainLine = toPath(terrain)
    const baseY = sy(yMin).toFixed(1)
    const terrainFill = `${terrainLine} L${sx(xMax).toFixed(1)},${baseY} L${sx(0).toFixed(1)},${baseY} Z`

    // Fresnel band: upper boundary out, lower boundary back.
    const fresnelBand = `${toPath(fresUpper)} ${reversePts(fresLower)} Z`
    const fresnel60Line = toPath(fres60)

    const xStep = niceStep(xMax, 8)
    const xTicks: Array<{ v: number; x: number }> = []
    for (let v = 0; v <= xMax + 1e-6; v += xStep) xTicks.push({ v: Math.round(v), x: sx(v) })

    // Minor "ruler" dashes: subdivide each labelled interval into 5, so the spacing scales with
    // path length (≈1 km on short links, coarser on long ones) without crowding the labels.
    const minorStep = xStep / 5
    const xMinorTicks: number[] = []
    for (let v = 0; v <= xMax + 1e-6; v += minorStep) xMinorTicks.push(sx(v))

    const yStep = niceStep(yMax - yMin, 5)
    const yTicks: Array<{ v: number; y: number }> = []
    const yStart = Math.ceil(yMin / yStep) * yStep
    for (let v = yStart; v <= yMax; v += yStep) yTicks.push({ v: Math.round(v), y: sy(v) })

    return { terrainLine, terrainFill, losLine: toPath(los), fresnelBand, fresnel60Line, xTicks, xMinorTicks, yTicks }
})

// Worst-point first-Fresnel-zone clearance for the header. Computed once on the backend (so the
// link matrix and this chart always agree) as (LOS - terrain) / Fresnel-radius at the worst point:
// 100% = fully clear, 60% = the rule-of-thumb boundary, 0% = grazing the LOS, negative = blocked.
const fresnelPct = computed<number | null>(() => store.profileResult?.fresnel_pct ?? null)
</script>

<style scoped>
.profile-strip {
    position: relative;
    flex: 0 0 auto;
    height: 500px;
    border-top: 1px solid #ffffff22;
    padding: 0.4rem 0.6rem 0.2rem;
    display: flex;
    flex-direction: column;
    font-size: 12px;
}
.profile-close {
    position: absolute;
    top: 4px;
    right: 6px;
    z-index: 2;
    color: #ccc;
}
.profile-status {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
}
.profile-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    line-height: 1.3;
    font-size: 15px;
}
/* Endpoint names: the largest text in the header. */
.profile-header .fw-bold {
    font-size: 19px;
}
/* Keep the right-hand endpoint details clear of the absolutely-positioned close button. */
.profile-right {
    padding-right: 1.75rem;
}
.profile-stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.3rem 1.25rem;
    padding-top: 2px;
    font-size: 15px;
}
.profile-stats .badge {
    font-size: 14px;
}
.profile-svg {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    background: #0b1f33;
    border-radius: 4px;
    margin-top: 4px;
}
.profile-svg .axis-label {
    fill: #9fb3c8;
    font-size: 16px;
}
.profile-svg .axis-title {
    fill: #c7d4e0;
    font-size: 16px;
}
</style>
