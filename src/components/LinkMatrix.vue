<template>
    <div>
        <div class="d-flex gap-2 mb-2 align-items-center">
            <button
                :disabled="store.matrixState === 'running' || store.nodes.length < 2"
                @click="store.runMatrix"
                type="button"
                class="btn btn-success btn-sm"
            >
                <span v-if="store.matrixState === 'running'" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                {{ buttonText }}
            </button>
        </div>

        <p v-if="store.nodes.length < 2" class="text-muted small mb-0">Add at least two nodes to compute links.</p>

        <template v-else-if="store.matrixResult">
            <p class="small text-muted mb-2">
                Preset <strong>{{ store.matrixResult.preset }}</strong> ·
                sensitivity <strong>{{ store.matrixResult.sensitivity_dbm }} dBm</strong>.
                Cells show link margin (dB); green = viable, red = not.
            </p>
            <div class="table-responsive" style="max-height: 50vh; overflow: auto;">
                <table class="table table-sm table-dark table-bordered text-center small mb-0">
                    <thead>
                        <tr>
                            <th></th>
                            <th v-for="n in store.nodes" :key="n.id" class="text-truncate" style="max-width: 90px;">
                                {{ n.transmitter.name }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="row in store.nodes" :key="row.id">
                            <th class="text-truncate text-start" style="max-width: 90px;">{{ row.transmitter.name }}</th>
                            <td
                                v-for="col in store.nodes"
                                :key="col.id"
                                :style="cellStyle(row.id, col.id)"
                                :title="cellTitle(row.id, col.id)"
                            >
                                {{ cellText(row.id, col.id) }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </template>

        <p v-else-if="store.matrixState === 'failed'" class="text-danger small mb-0">Matrix computation failed. See console.</p>
        <p v-else class="text-muted small mb-0">Click "Compute Links" to analyse every node pair.</p>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStore } from '../store.ts'
import { type LinkResult } from '../types.ts'

const store = useStore()

const buttonText = computed(() => {
    if (store.matrixState === 'running') return 'Computing…'
    if (store.matrixState === 'failed') return 'Retry'
    return 'Compute Links'
})

function linkFor(a: string, b: string): LinkResult | undefined {
    return store.matrixResult?.links.find(
        (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a)
    )
}

function cellText(a: string, b: string): string {
    if (a === b) return '—'
    const link = linkFor(a, b)
    if (!link) return ''
    if (link.error) return '!'
    return link.margin_db === null ? '?' : `${link.margin_db}`
}

function cellStyle(a: string, b: string): Record<string, string> {
    if (a === b) return { background: '#222' }
    const link = linkFor(a, b)
    if (!link || link.margin_db === null) return {}
    const t = Math.max(0, Math.min(1, link.margin_db / 30))
    const r = Math.round(200 * (1 - t))
    const g = Math.round(40 + 140 * t)
    return { background: `rgb(${r}, ${g}, 50)`, color: '#fff' }
}

function cellTitle(a: string, b: string): string {
    if (a === b) return ''
    const link = linkFor(a, b)
    if (!link) return ''
    if (link.error) return `Error: ${link.error}`
    return `Margin ${link.margin_db ?? '?'} dB · path loss ${link.path_loss_db ?? '?'} dB · `
        + `Fresnel ${link.fresnel_pct ?? '?'} % clear · ${link.distance_km ?? '?'} km`
}
</script>
