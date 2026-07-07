<template>
  <div>
    <h2 class="h6 d-flex align-items-center gap-2">
      <FileUp :size="18" /> Import contacts
      <InfoTip>
        Pick a MeshCore <strong>contacts export</strong> (JSON). Repeaters and room servers that carry a location are
        added as nodes in an <strong>Imported</strong> folder; companions and contacts without a location are skipped.
        You can review and deselect before importing.
      </InfoTip>
    </h2>

    <!-- Native picker kept off-screen; the styled button proxies the click so it matches the sidebar. -->
    <input ref="fileInput" type="file" accept=".json,application/json" class="d-none" @change="onFile" />
    <button
      type="button"
      class="btn btn-sm btn-success shadow w-100 d-flex align-items-center justify-content-center gap-1"
      @click="pickFile"
    >
      <Upload :size="16" /> Import MeshCore contacts…
    </button>

    <div v-if="error" class="alert alert-danger py-1 px-2 small mt-2 mb-0">{{ error }}</div>
    <div v-if="summary" class="alert alert-success py-1 px-2 small mt-2 mb-0">{{ summary }}</div>

    <!-- Preview: confirm (and optionally deselect) before anything is added to the map. -->
    <template v-if="parsed">
      <div class="d-flex align-items-center justify-content-between mt-3 mb-1">
        <span class="small fw-semibold"
          >{{ candidates.length }} contact{{ candidates.length === 1 ? '' : 's' }} found</span
        >
        <div class="d-flex gap-2">
          <button
            type="button"
            class="btn btn-outline-secondary btn-sm py-0 px-1"
            :disabled="allSelected"
            @click="setAll(true)"
          >
            All
          </button>
          <button
            type="button"
            class="btn btn-outline-secondary btn-sm py-0 px-1"
            :disabled="noneSelected"
            @click="setAll(false)"
          >
            None
          </button>
        </div>
      </div>
      <ul class="list-group">
        <li v-for="(c, i) in candidates" :key="i" class="list-group-item d-flex align-items-start gap-2 py-1">
          <input :id="'imp-' + i" v-model="include[i]" class="form-check-input mt-1 flex-shrink-0" type="checkbox" />
          <label class="flex-grow-1 lh-sm" :for="'imp-' + i" :class="{ 'text-muted': !include[i] }">
            <span class="d-block text-truncate">{{ c.name }}</span>
            <span class="contact-meta">{{ c.typeLabel }} · {{ c.lat.toFixed(5) }}, {{ c.lon.toFixed(5) }}</span>
          </label>
          <span
            v-if="c.isDuplicate"
            class="badge bg-warning-subtle text-warning-emphasis rounded-pill flex-shrink-0 align-self-center"
            title="A node with this name and location already exists"
            >duplicate</span
          >
        </li>
      </ul>
      <p v-if="skippedNoLocation" class="text-muted small mt-1 mb-0">
        {{ skippedNoLocation }} contact{{ skippedNoLocation === 1 ? '' : 's' }} skipped (no location).
      </p>
      <div class="d-flex gap-2 mt-2">
        <button type="button" class="btn btn-success btn-sm w-100" :disabled="!selectedCount" @click="confirmImport">
          Import {{ selectedCount }} selected
        </button>
        <button type="button" class="btn btn-outline-secondary btn-sm w-100" @click="cancel">Cancel</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useStore } from '../store.ts';
import { parseMeshcoreContacts, type ContactCandidate } from '../meshcore.ts';
import { FileUp, Upload } from '@lucide/vue';
import InfoTip from './InfoTip.vue';
import { trackEvent } from '../analytics.ts';

const store = useStore();

const fileInput = ref<HTMLInputElement | null>(null);
const parsed = ref<ContactCandidate[] | null>(null);
const include = ref<boolean[]>([]);
const skippedNoLocation = ref(0);
const error = ref<string | null>(null);
const summary = ref<string | null>(null);

const candidates = computed(() => parsed.value ?? []);
const selectedCount = computed(() => include.value.filter(Boolean).length);
const allSelected = computed(() => candidates.value.length > 0 && include.value.every(Boolean));
const noneSelected = computed(() => include.value.every((v) => !v));

function pickFile() {
  error.value = null;
  summary.value = null;
  fileInput.value?.click();
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // reset so re-picking the same file fires change again
  if (!file) {
    return;
  }
  error.value = null;
  summary.value = null;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(String(reader.result));
      const result = parseMeshcoreContacts(json, store.nodes);
      skippedNoLocation.value = result.skippedNoLocation;
      if (!result.candidates.length) {
        reset();
        error.value = result.skippedNoLocation
          ? `No repeaters or room servers with a location (${result.skippedNoLocation} had none).`
          : 'No repeaters or room servers found in this file.';
        return;
      }
      parsed.value = result.candidates;
      include.value = result.candidates.map((c) => !c.isDuplicate); // pre-check all but duplicates
    } catch (err) {
      reset();
      error.value = err instanceof Error ? err.message : 'Could not read this file as JSON.';
    }
  };
  reader.onerror = () => {
    reset();
    error.value = 'Could not read the selected file.';
  };
  reader.readAsText(file);
}

function setAll(value: boolean) {
  include.value = candidates.value.map(() => value);
}

function confirmImport() {
  trackEvent('import-contacts');
  const rows = candidates.value
    .filter((_, i) => include.value[i])
    .map((c) => ({ name: c.name, lat: c.lat, lon: c.lon }));
  const added = store.importContacts(rows);
  const extras: string[] = [];
  const notImported = candidates.value.length - added;
  if (notImported) {
    extras.push(`${notImported} not imported`);
  }
  if (skippedNoLocation.value) {
    extras.push(`${skippedNoLocation.value} without location`);
  }
  summary.value = `Imported ${added} node${added === 1 ? '' : 's'} into "Imported"${extras.length ? ` (${extras.join(', ')})` : ''}.`;
  reset();
}

function cancel() {
  reset();
}

function reset() {
  parsed.value = null;
  include.value = [];
  skippedNoLocation.value = 0;
}
</script>

<style scoped>
.contact-meta {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
}
</style>
