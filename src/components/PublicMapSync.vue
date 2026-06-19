<template>
  <div>
    <h2 class="h6 d-flex align-items-center gap-2">
      <Globe :size="18" /> Sync public map
      <InfoTip>
        Pulls repeaters &amp; room servers in the <strong>current map view</strong> from the public
        mesh maps into a <strong>Public MeshCore</strong> folder. Pan and zoom to the area you want
        first, then sync. Nodes already on the map are skipped, so you can re-sync freely.
      </InfoTip>
    </h2>

    <!-- One checkbox per registered source — driven by the registry, so new sources appear here for free. -->
    <div class="mb-2">
      <div v-for="src in sources" :key="src.id" class="form-check form-check-sm">
        <input :id="'src-' + src.id" v-model="enabled[src.id]" class="form-check-input" type="checkbox" />
        <label class="form-check-label small" :for="'src-' + src.id">{{ src.label }}</label>
      </div>
    </div>

    <button
      type="button"
      class="btn btn-sm btn-success shadow w-100 d-flex align-items-center justify-content-center gap-1"
      :disabled="loading || !anyEnabled"
      @click="onSync"
    >
      <span v-if="loading" class="spinner-border spinner-border-sm"></span>
      <DownloadCloud v-else :size="16" />
      {{ loading ? 'Syncing…' : 'Sync public map' }}
    </button>

    <p v-if="loading && progress" class="text-muted small mt-2 mb-0">{{ progress }}</p>
    <div v-if="error" class="alert alert-danger py-1 px-2 small mt-2 mb-0">{{ error }}</div>
    <div v-if="summary" class="alert alert-success py-1 px-2 small mt-2 mb-0">{{ summary }}</div>
    <div v-for="(w, i) in warnings" :key="i" class="alert alert-warning py-1 px-2 small mt-2 mb-0">{{ w }}</div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed } from 'vue'
import { useStore } from '../store.ts'
import { PUBLIC_NODE_SOURCES, syncPublicNodes } from '../sources/index.ts'
import { Globe, DownloadCloud } from '@lucide/vue'
import InfoTip from './InfoTip.vue'

// Above this many new nodes in one sync we confirm first — a zoomed-out view can match a lot.
const CONFIRM_THRESHOLD = 300

const store = useStore()
const sources = PUBLIC_NODE_SOURCES

const enabled = reactive<Record<string, boolean>>(
  Object.fromEntries(sources.map((s) => [s.id, s.defaultEnabled ?? true]))
)
const loading = ref(false)
const progress = ref<string | null>(null)
const error = ref<string | null>(null)
const summary = ref<string | null>(null)
const warnings = ref<string[]>([])

const anyEnabled = computed(() => sources.some((s) => enabled[s.id]))

function labelFor(id: string): string {
  return sources.find((s) => s.id === id)?.label ?? id
}

async function onSync() {
  error.value = null
  summary.value = null
  warnings.value = []

  const map = store.map
  if (!map) {
    error.value = 'The map is not ready yet.'
    return
  }
  const b = map.getBounds()
  const bbox = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }
  const enabledIds = sources.filter((s) => enabled[s.id]).map((s) => s.id)

  loading.value = true
  progress.value = 'Fetching public nodes…'
  try {
    const result = await syncPublicNodes(enabledIds, bbox, store.nodes)
    warnings.value = result.warnings

    if (!result.rows.length) {
      summary.value = result.duplicates
        ? `All ${result.duplicates} node${result.duplicates === 1 ? '' : 's'} in view are already on the map.`
        : 'No repeaters or room servers found in the current view.'
      return
    }

    if (result.rows.length > CONFIRM_THRESHOLD) {
      const ok = window.confirm(
        `This will add ${result.rows.length} nodes to "Public MeshCore". Zoom in to narrow the area, or continue?`
      )
      if (!ok) {
        return
      }
    }

    const added = store.importPublicMapNodes(result.rows)
    const perSource = enabledIds
      .map((id) => `${labelFor(id)} ${result.perSource[id] ?? 0}`)
      .join(', ')
    const dupText = result.duplicates ? ` (${result.duplicates} already present skipped)` : ''
    summary.value = `Added ${added} node${added === 1 ? '' : 's'} to "Public MeshCore"${dupText} — ${perSource}.`
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not sync public nodes.'
  } finally {
    loading.value = false
    progress.value = null
  }
}
</script>
