<template>
  <!-- Desktop/tablet: absolute within .map-col, anchored beside the bottom-left control stack its
       button lives in. Phone: embedded, plain content inside App.vue's BottomSheet, which already
       supplies the dark theme/background/shadow/position. -->
  <div
    ref="panelRef"
    :class="embedded ? null : 'location-search-panel shadow text-bg-dark'"
    :data-bs-theme="embedded ? null : 'dark'"
  >
    <form class="d-flex gap-2" @submit.prevent="onSubmit">
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="form-control form-control-sm"
        :placeholder="t('locationSearch.placeholder')"
        :aria-label="t('locationSearch.placeholder')"
      />
      <button
        type="submit"
        class="btn btn-light btn-sm flex-shrink-0"
        :disabled="!query.trim() || loading"
        :aria-label="t('locationSearch.search')"
      >
        <span v-if="loading" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
        <Search v-else :size="14" />
      </button>
    </form>
    <div v-if="error" class="form-text text-danger mt-1 mb-0">{{ error }}</div>
    <div v-else-if="searched && !loading && !results.length" class="form-text mt-1 mb-0">
      {{ t('locationSearch.noResults') }}
    </div>
    <ul v-if="results.length" class="list-group mt-2 location-search-results">
      <li
        v-for="(r, i) in results"
        :key="i"
        class="list-group-item list-group-item-action"
        role="button"
        @click="selectResult(r)"
      >
        <span class="d-block text-truncate">{{ r.name }}</span>
      </li>
    </ul>
    <!-- Required by Nominatim's usage policy whenever results are shown. -->
    <div v-if="results.length" class="form-text mt-1 mb-0">© OpenStreetMap contributors</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Search } from '@lucide/vue';
import { useStore } from '../store.ts';
import { trackEvent } from '../analytics.ts';

interface LocationResult {
  name: string;
  lat: number;
  lon: number;
}

const { embedded = false } = defineProps<{ embedded?: boolean }>();

const { t } = useI18n();
const store = useStore();
const panelRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

const query = ref('');
const results = ref<LocationResult[]>([]);
const loading = ref(false);
const error = ref('');
const searched = ref(false);

// Guards against a slow earlier request clobbering a faster later one.
let requestId = 0;

const SEARCH_TIMEOUT_MS = 10000;
let activeController: AbortController | null = null;
// Submit-only (no live search) per Nominatim's usage policy.
async function onSubmit() {
  const q = query.value.trim();
  if (!q || loading.value) {
    return;
  }
  trackEvent('search-location-submit');
  const id = ++requestId;
  loading.value = true;
  error.value = '';
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Search failed (${res.status})`);
    }
    const data: Array<{ display_name: string; lat: string; lon: string }> = await res.json();
    if (id !== requestId) {
      return; // superseded by a newer search
    }
    results.value = data.map((d) => ({
      name: d.display_name,
      lat: Number(d.lat),
      lon: Number(d.lon),
    }));
  } catch {
    if (id !== requestId) {
      return;
    }
    error.value = t('locationSearch.searchFailed');
    results.value = [];
  } finally {
    clearTimeout(timer);
    if (activeController === controller) {
      activeController = null;
    }
    if (id === requestId) {
      loading.value = false;
      searched.value = true;
    }
  }
}

function selectResult(r: LocationResult) {
  store.flyToLocation(r.lat, r.lon);
  store.closeLocationSearch();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    store.closeLocationSearch();
  }
}

function onOutsideClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  // The trigger button already toggles on its own click; closing here too would fight it.
  if (target.closest('.location-search-btn')) {
    return;
  }
  if (panelRef.value && !panelRef.value.contains(target)) {
    store.closeLocationSearch();
  }
}

onMounted(() => {
  inputRef.value?.focus();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('mousedown', onOutsideClick);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('mousedown', onOutsideClick);
  activeController?.abort(); // closing the panel mid-search shouldn't leave a dangling request
});
</script>

<style scoped>
.location-search-panel {
  position: absolute;
  left: 50px;
  bottom: 10px;
  z-index: 1000;
  width: min(440px, calc(100vw - 70px));
  padding: 8px 10px;
  border-radius: 6px;
}
.location-search-results {
  max-height: 200px;
  overflow-y: auto;
}
.location-search-results .list-group-item {
  min-width: 0;
}
</style>
