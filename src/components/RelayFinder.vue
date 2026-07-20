<template>
  <div class="panel-min-width">
    <p v-if="store.nodes.length < 2" class="text-muted small mb-0">{{ t('relayFinder.needTwoNodes') }}</p>

    <template v-else>
      <div class="mb-2">
        <label class="form-label small mb-1">{{ t('relayFinder.nodeA') }}</label>
        <select v-model="store.relayA" class="form-select form-select-sm">
          <option v-for="n in store.nodes" :key="n.id" :value="n.id">
            {{ n.transmitter.name }}
          </option>
        </select>
      </div>
      <div class="mb-2">
        <label class="form-label small mb-1">{{ t('relayFinder.nodeB') }}</label>
        <select v-model="store.relayB" class="form-select form-select-sm">
          <option v-for="n in store.nodes" :key="n.id" :value="n.id">
            {{ n.transmitter.name }}
          </option>
        </select>
      </div>

      <div class="d-grid gap-2 mb-2">
        <button
          :disabled="store.relayState === 'running' || !canRun"
          @click="run"
          type="button"
          class="btn btn-success btn-sm"
        >
          <span
            v-if="store.relayState === 'running'"
            class="spinner-border spinner-border-sm"
            role="status"
            aria-hidden="true"
          ></span>
          {{ buttonText }}
        </button>
        <button v-if="store.relayResult" @click="store.clearRelay" type="button" class="btn btn-outline-light btn-sm">
          {{ t('common.clear') }}
        </button>
      </div>

      <p v-if="sameNode" class="text-warning small mb-2">{{ t('relayFinder.pickDifferentNodes') }}</p>

      <p v-if="store.relayState === 'failed'" class="text-danger small mb-0">{{ t('relayFinder.searchFailed') }}</p>

      <template v-else-if="store.relayResult">
        <p v-if="store.relayResult.empty" class="text-muted small mb-0">
          {{ store.relayResult.warning === 'NO_OVERLAP' ? t('relayFinder.noOverlap') : store.relayResult.warning }}
        </p>
        <template v-else>
          <p class="small text-muted mb-2">
            {{ t('relayFinder.sensitivityPrefix') }} <strong>{{ store.relayResult.sensitivity_dbm }} dBm</strong>.
            {{ t('relayFinder.promoteHint') }}
          </p>
          <div class="mb-2 small">
            <div class="legend-bar mb-1" :style="{ background: gradientCss }"></div>
            <div class="d-flex justify-content-between text-muted">
              <span>0 dB</span>
              <span>{{ t('relayFinder.linkMargin') }}</span>
              <span>{{ peakMargin != null ? peakMargin + ' dB' : t('relayFinder.higher') }}</span>
            </div>
          </div>
          <ul class="list-group list-group-flush small">
            <li
              v-for="pt in store.relayResult.points.features"
              :key="pt.properties.rank"
              class="list-group-item bg-transparent text-light px-0 d-flex justify-content-between align-items-center gap-2"
            >
              <span role="button" class="text-truncate" @click="panTo(pt)" :title="t('relayFinder.panToPoint')">
                #{{ pt.properties.rank }} · {{ pt.properties.min_margin }} dB
              </span>
              <button type="button" class="btn btn-sm btn-success py-0" @click="promote(pt)">
                {{ t('relayFinder.promote') }}
              </button>
            </li>
          </ul>
        </template>
      </template>

      <p v-else class="text-muted small mb-0">{{ t('relayFinder.pickTwoAndSearch') }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { gradientCss as gradientCssFor } from '../sim/colormap.ts';

const { t } = useI18n();
const store = useStore();

// Legend gradient mirrors the draped heatmap: the active colormap sampled left (0 dB margin, the zone
// edge) to right (peak margin). Kept in sync with display.color_scale so it matches what's on the map.
const gradientCss = computed(() => gradientCssFor(store.splatParams.display.color_scale));

// Peak margin (dB) over the zone — the right end of the legend's range. Max of the per-island peaks,
// which equals the grid peak the heatmap's colour ramp tops out at.
const peakMargin = computed(() => {
  const feats = store.relayResult?.zone?.features ?? [];
  if (!feats.length) return null;
  return Math.round(Math.max(...feats.map((f) => f.properties.peak_margin)));
});

// Default the two selectors to the first two nodes when unset / stale.
watchEffect(() => {
  const ids = store.nodes.map((n) => n.id);
  if (!store.relayA || !ids.includes(store.relayA)) {
    store.relayA = ids[0] ?? null;
  }
  if (!store.relayB || !ids.includes(store.relayB)) {
    store.relayB = ids.find((id) => id !== store.relayA) ?? null;
  }
});

const sameNode = computed(() => !!store.relayA && store.relayA === store.relayB);
const canRun = computed(() => !!store.relayA && !!store.relayB && !sameNode.value);

const buttonText = computed(() => {
  if (store.relayState === 'running') return t('relayFinder.searching');
  if (store.relayState === 'failed') return t('linkMatrix.retry');
  return t('contextMenu.findRelayZone');
});

function run() {
  if (store.relayA && store.relayB) {
    store.runRelay(store.relayA, store.relayB);
  }
}

function pointLatLon(pt: { geometry: { coordinates: [number, number] } }): [number, number] {
  const [lon, lat] = pt.geometry.coordinates;
  return [lat, lon];
}

function panTo(pt: { geometry: { coordinates: [number, number] } }) {
  const [lat, lon] = pointLatLon(pt);
  store.map?.flyTo({ center: [lon, lat], zoom: Math.max(store.map.getZoom(), 12) }); // [lng, lat]
}

function promote(pt: { geometry: { coordinates: [number, number] } }) {
  const [lat, lon] = pointLatLon(pt);
  store.promoteRelayPoint(lat, lon);
}
</script>
