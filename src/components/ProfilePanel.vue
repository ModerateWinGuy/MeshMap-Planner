<template>
    <div
        :class="['profile-strip', embedded ? 'profile-embedded' : 'text-bg-dark']"
        :data-bs-theme="embedded ? null : 'dark'"
    >
        <ShareButton
            v-if="linkPayload()"
            :payload="linkPayload"
            class="profile-share"
            title="Copy a share link for this link profile"
            label="Share link"
            :size="18"
        />
        <!-- Redundant with the sheet's own close affordances (scrim tap / swipe down / chevron) when
             embedded — hidden there rather than wired to a second close path. -->
        <button v-if="!embedded" type="button" class="btn btn-sm p-0 border-0 bg-transparent lh-1 profile-close" aria-label="Close profile" title="Close" @click="store.clearProfile()">
            <X :size="20" />
        </button>
        <button
            type="button"
            class="btn btn-sm p-0 border-0 bg-transparent lh-1 profile-refresh"
            aria-label="Recalculate link profile"
            title="Recalculate (after changing a node setting)"
            @click="store.runProfile(store.profileFromId, store.profileToId)"
        >
            <RefreshCw :size="18" />
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
                <div class="text-start profile-left">
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
                    <div class="text-muted" v-if="reverseBearing !== null">← {{ reverseBearing.toFixed(1) }}°</div>
                    <div class="text-muted" v-if="fromNode">{{ fromNode.transmitter.tx_freq }} MHz</div>
                </div>
            </div>

            <!-- Inline SVG chart. viewBox + 100% width keeps it crisp and responsive without a chart lib. -->
            <div v-if="chart" class="profile-chart">
                <svg class="profile-svg" :viewBox="`0 0 ${VB_W} ${VB_H}`" preserveAspectRatio="none" @click="onChartClick" @mousemove="onChartMove" @mouseleave="onChartLeave">
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
                        <text :x="t.x" :y="VB_H - PAD_B + 24" text-anchor="middle" class="axis-label">{{ t.v }}</text>
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
                <!-- Hover dot riding the signal line, marking the point a click will fly the camera to.
                     An HTML overlay (not an SVG circle) so preserveAspectRatio="none" can't squash it. -->
                <span v-if="hoverMarker" class="profile-cursor" :style="{ left: hoverMarker.left + '%', top: hoverMarker.top + '%' }"></span>
            </div>
            <div v-else class="profile-status text-muted">No terrain profile data returned.</div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { X, RefreshCw } from '@lucide/vue'
import { useStore } from '../store.ts'
import { interpGreatCircle } from '../sim/profile.ts'
import { nodeToShared, type SharePayload } from '../utils.ts'
import ShareButton from './ShareButton.vue'
import type { ProfileCurve } from '../types.ts'

const { embedded = false } = defineProps<{ embedded?: boolean }>()

const store = useStore()

// Share link for the open profile's two endpoints, built fresh on click so it reflects any edits to
// the nodes. Returns null until both endpoints resolve, which hides the button.
const linkPayload = (): SharePayload | null => {
    const a = fromNode.value
    const b = toNode.value
    if (!a || !b) {
        return null
    }
    return { v: 1, t: 'link', n: [nodeToShared(a), nodeToShared(b)], lp: store.splatParams.lora?.preset }
}

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

function bearingDeg(lat1d: number, lon1d: number, lat2d: number, lon2d: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180
    const toDeg = (rad: number) => (rad * 180) / Math.PI
    const lat1 = toRad(lat1d), lat2 = toRad(lat2d)
    const dLon = toRad(lon2d - lon1d)
    const y = Math.sin(dLon) * Math.cos(lat2)
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
    return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const bearing = computed<number | null>(() => {
    const a = fromNode.value, b = toNode.value
    if (!a || !b) return null
    return bearingDeg(a.transmitter.tx_lat, a.transmitter.tx_lon, b.transmitter.tx_lat, b.transmitter.tx_lon)
})

// Back-azimuth B→A — not simply forward+180° on a great circle.
const reverseBearing = computed<number | null>(() => {
    const a = fromNode.value, b = toNode.value
    if (!a || !b) return null
    return bearingDeg(b.transmitter.tx_lat, b.transmitter.tx_lon, a.transmitter.tx_lat, a.transmitter.tx_lon)
})

// Path fraction (0..1) under the pointer. The chart's x-axis is linear in fraction, so the x-pixel
// inverts straight to f. preserveAspectRatio="none" → client-x maps linearly onto the 0..VB_W viewBox.
function fractionFromEvent(evt: MouseEvent): number {
    const rect = (evt.currentTarget as SVGSVGElement).getBoundingClientRect()
    const vbX = ((evt.clientX - rect.left) / rect.width) * VB_W
    const plotW = VB_W - PAD_L - PAD_R
    return Math.min(1, Math.max(0, (vbX - PAD_L) / plotW))
}

// Fraction the hover dot tracks; null when the pointer is off the chart. Mirrored onto the 3D
// line-of-sight beam (store.setBeamCursor) so the chart dot and the map indicator stay in lockstep.
const hoverF = ref<number | null>(null)
const onChartMove = (evt: MouseEvent) => {
    hoverF.value = fractionFromEvent(evt)
    store.setBeamCursor(hoverF.value)
}
const onChartLeave = () => {
    hoverF.value = null
    store.setBeamCursor(null)
}

// Position the dot (as % of the chart box) on the signal line at the hovered fraction.
const hoverMarker = computed<{ left: number; top: number } | null>(() => {
    const c = chart.value
    if (!c || hoverF.value === null) return null
    const [x, y] = c.losPx(hoverF.value)
    return { left: (x / VB_W) * 100, top: (y / VB_H) * 100 }
})

// Clicking flies the map camera to that spot on the path, viewed side-on (perpendicular to the link)
// so the user can see where the beam meets the terrain.
function onChartClick(evt: MouseEvent) {
    const a = fromNode.value, b = toNode.value
    if (!a || !b || bearing.value === null) return
    const f = fractionFromEvent(evt)
    const [lng, lat] = interpGreatCircle(
        a.transmitter.tx_lon, a.transmitter.tx_lat,
        b.transmitter.tx_lon, b.transmitter.tx_lat, f,
    )
    const viewBearing = (bearing.value - 90 + 360) % 360
    store.focusTerrainView(lng, lat, viewBearing)
}

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

    // Pixel position on the line-of-sight curve at path fraction f (0..1) — mirrors the loop above so
    // the hover dot rides exactly on the drawn signal line.
    const losPx = (f: number): [number, number] => {
        const d = f * xMax
        const d1 = Math.min(Math.max(d * 1000, 0), dM)
        const bulge = (d1 * (dM - d1)) / (2 * K_FACTOR * EARTH_RADIUS_M)
        const losV = topA + (topB - topA) * (d1 / dM) - bulge
        return [sx(d), sy(losV)]
    }

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

    return { terrainLine, terrainFill, losLine: toPath(los), fresnelBand, fresnel60Line, xTicks, xMinorTicks, yTicks, losPx }
})

// Worst-point first-Fresnel-zone clearance for the header. Computed in the shared sim (so the link
// matrix and this chart always agree) as (LOS - terrain) / Fresnel-radius at the worst point:
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
/* Embedded in App.vue's phone BottomSheet instead of docked under the map — the sheet supplies the
   background/scroll/close chrome, so this drops its own fixed height/border in favour of sizing to
   content within the sheet's scrollable body. Higher specificity than the plain .profile-strip rules
   above (including inside the max-width:767px block, since this is the only regime it's used in) so
   it always wins regardless of source order. */
.profile-strip.profile-embedded {
    position: relative;
    height: auto;
    border-top: 0;
    padding: 0;
}
.profile-embedded .profile-chart {
    flex: none;
    height: 20vh;
}
/* The chart's viewBox (1600x320, ~5:1) no longer matches the embedded box's much-squarer aspect
   ratio now that it's short — preserveAspectRatio="none" scales x/y independently to fill the box, so
   text glyphs get squished horizontally along with the chart lines. Counter-scale just the text back
   out; fill-box/center keeps each label anchored at its own midpoint instead of sliding it. */
.profile-embedded .profile-svg text {
    transform-box: fill-box;
    transform-origin: center;
    transform: scaleX(1.3);
}
/* Desktop's 3-column header (endpoint A | stats | endpoint B) squeezes all three into one row —
   fine in a wide docked strip, too tight in a phone-width sheet. Reflow into two rows instead: the
   signal-budget stats get their own full-width row up top, with the two endpoints' name/coords/AGL
   side by side underneath, so neither competes with the other for horizontal space. */
.profile-embedded .profile-header {
    flex-wrap: wrap;
    row-gap: 0.4rem;
}
.profile-embedded .profile-stats {
    order: -1;
    flex: 1 1 100%;
    justify-content: flex-start;
}
.profile-embedded .profile-left,
.profile-embedded .profile-right {
    flex: 1 1 0;
    min-width: 0;
}
.profile-close {
    position: absolute;
    top: 4px;
    right: 6px;
    z-index: 2;
    color: #ccc;
}
/* Sits below the close button, sharing its top-right corner. */
.profile-share {
    position: absolute;
    top: 28px;
    right: 6px;
    z-index: 2;
    color: #ccc;
}
/* Sits below the share button, same top-right stack. */
.profile-refresh {
    position: absolute;
    top: 52px;
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
/* Positioning context + layout slot for the SVG and its hover-dot overlay. */
.profile-chart {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    margin-top: 4px;
}
.profile-svg {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    background: #0b1f33;
    border-radius: 4px;
    cursor: crosshair;
}
/* Hover dot on the signal line; left/top set inline as % of the chart box. */
.profile-cursor {
    position: absolute;
    width: 13px;
    height: 13px;
    border: 2px solid #f2e205;
    background: rgba(242, 226, 5, 0.25);
    border-radius: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
}
.profile-svg .axis-label {
    fill: #9fb3c8;
    font-size: 16px;
}
.profile-svg .axis-title {
    fill: #c7d4e0;
    font-size: 16px;
}

/* 500px is taller than many phone screens in portrait — cap it (shorter than the desktop/tablet cap
   above, since the smaller font sizes below need less room) so it can't push the bottom tab bar/sheet
   off-screen. Sized close to the sheet's own "swipe down / tap map to close" hint text (10.5px in
   style.css) so the header reads as secondary detail, not a desktop-sized headline crammed into a
   drawer. Placed at the end of this block (not alongside .profile-strip near the top) so its rules
   come after the unconditional .profile-header/.profile-stats declarations above — equal-specificity
   CSS resolves ties by source order, so an earlier media query here would otherwise lose to those
   later base rules regardless of the viewport width. */
@media (max-width: 767px) {
    .profile-strip {
        height: 36vh;
        font-size: 10px;
    }
    .profile-header {
        font-size: 11px;
    }
    .profile-header .fw-bold {
        font-size: 13px;
    }
    .profile-stats {
        gap: 0.2rem 0.7rem;
        font-size: 12px;
    }
    .profile-stats .badge {
        font-size: 11px;
    }
}
</style>
