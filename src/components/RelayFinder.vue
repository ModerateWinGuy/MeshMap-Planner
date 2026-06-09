<template>
    <div style="min-width: 260px;">
        <p v-if="store.nodes.length < 2" class="text-muted small mb-0">
            Add at least two nodes to find a relay site.
        </p>

        <template v-else>
            <div class="mb-2">
                <label class="form-label small mb-1">Node A</label>
                <select v-model="store.relayA" class="form-select form-select-sm">
                    <option v-for="n in store.nodes" :key="n.id" :value="n.id">{{ n.transmitter.name }}</option>
                </select>
            </div>
            <div class="mb-2">
                <label class="form-label small mb-1">Node B</label>
                <select v-model="store.relayB" class="form-select form-select-sm">
                    <option v-for="n in store.nodes" :key="n.id" :value="n.id">{{ n.transmitter.name }}</option>
                </select>
            </div>

            <div class="d-flex gap-2 mb-2 align-items-center">
                <button
                    :disabled="store.relayState === 'running' || !canRun"
                    @click="run"
                    type="button"
                    class="btn btn-success btn-sm"
                >
                    <span v-if="store.relayState === 'running'" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                    {{ buttonText }}
                </button>
                <button
                    v-if="store.relayResult"
                    @click="store.clearRelay"
                    type="button"
                    class="btn btn-outline-light btn-sm"
                >Clear</button>
            </div>

            <p v-if="sameNode" class="text-warning small mb-2">Pick two different nodes.</p>

            <p v-if="store.relayState === 'failed'" class="text-danger small mb-0">
                Relay search failed. See console.
            </p>

            <template v-else-if="store.relayResult">
                <p v-if="store.relayResult.empty" class="text-muted small mb-0">
                    {{ store.relayResult.warning }}
                </p>
                <template v-else>
                    <p class="small text-muted mb-2">
                        Sensitivity <strong>{{ store.relayResult.sensitivity_dbm }} dBm</strong>.
                        Each suggested point can be promoted into a real node.
                    </p>
                    <div class="d-flex gap-2 mb-2 small">
                        <span><span class="legend-swatch" style="background:#2e9e3f"></span> &gt;20 dB</span>
                        <span><span class="legend-swatch" style="background:#d9c021"></span> 10–20</span>
                        <span><span class="legend-swatch" style="background:#e08326"></span> 0–10</span>
                    </div>
                    <ul class="list-group list-group-flush small">
                        <li
                            v-for="pt in store.relayResult.points.features"
                            :key="pt.properties.rank"
                            class="list-group-item bg-transparent text-light px-0 d-flex justify-content-between align-items-center gap-2"
                        >
                            <span role="button" class="text-truncate" @click="panTo(pt)" title="Pan to point">
                                #{{ pt.properties.rank }} · {{ pt.properties.min_margin }} dB
                            </span>
                            <button type="button" class="btn btn-sm btn-success py-0" @click="promote(pt)">Promote</button>
                        </li>
                    </ul>
                </template>
            </template>

            <p v-else class="text-muted small mb-0">Pick two nodes and search for a relay site.</p>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useStore } from '../store.ts'

const store = useStore()

// Default the two selectors to the first two nodes when unset / stale.
watchEffect(() => {
    const ids = store.nodes.map((n) => n.id)
    if (!store.relayA || !ids.includes(store.relayA)) {
        store.relayA = ids[0] ?? null
    }
    if (!store.relayB || !ids.includes(store.relayB)) {
        store.relayB = ids.find((id) => id !== store.relayA) ?? null
    }
})

const sameNode = computed(() => !!store.relayA && store.relayA === store.relayB)
const canRun = computed(() => !!store.relayA && !!store.relayB && !sameNode.value)

const buttonText = computed(() => {
    if (store.relayState === 'running') return 'Searching…'
    if (store.relayState === 'failed') return 'Retry'
    return 'Find relay zone'
})

function run() {
    if (store.relayA && store.relayB) {
        store.runRelay(store.relayA, store.relayB)
    }
}

function pointLatLon(pt: { geometry: { coordinates: [number, number] } }): [number, number] {
    const [lon, lat] = pt.geometry.coordinates
    return [lat, lon]
}

function panTo(pt: { geometry: { coordinates: [number, number] } }) {
    const [lat, lon] = pointLatLon(pt)
    store.map?.setView([lat, lon], Math.max(store.map.getZoom(), 12))
}

function promote(pt: { geometry: { coordinates: [number, number] } }) {
    const [lat, lon] = pointLatLon(pt)
    store.promoteRelayPoint(lat, lon)
}
</script>

<style scoped>
.legend-swatch {
    display: inline-block;
    width: 0.8em;
    height: 0.8em;
    border-radius: 2px;
    vertical-align: middle;
}
</style>
