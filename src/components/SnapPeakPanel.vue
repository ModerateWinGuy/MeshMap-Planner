<template>
  <!-- absolute within .map-col so it pins to the map's top-right, not the viewport's (which would
       sit over the sidebar). Same shape as MeasurePanel.vue. -->
  <div class="snap-peak-panel shadow text-bg-dark" data-bs-theme="dark">
    <div class="d-flex align-items-center gap-2 mb-1">
      <Mountain :size="16" />
      <strong>{{ t('snapPeakPanel.title') }}</strong>
    </div>
    <div class="form-text mt-0 mb-2">{{ t('snapPeakPanel.hint') }}</div>
    <label for="snap_peak_range" class="form-label mb-0">
      {{ t('snapPeakPanel.rangeLabel', { m: store.snapToPeakRangeM }) }}
    </label>
    <input
      type="range"
      class="form-range mb-2"
      id="snap_peak_range"
      min="10"
      max="500"
      step="10"
      :value="store.snapToPeakRangeM"
      @input="store.setSnapToPeakRangeM(Number(($event.target as HTMLInputElement).value))"
    />
    <button type="button" class="btn btn-light btn-sm w-100" @click="store.toggleSnapToPeak()">
      <X :size="14" /> {{ t('snapPeakPanel.done') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Mountain, X } from '@lucide/vue';
import { useStore } from '../store.ts';

const { t } = useI18n();
const store = useStore();
</script>

<style scoped>
.snap-peak-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1000;
  width: 220px;
  padding: 8px 10px;
  border-radius: 6px;
}

/* Phone's fixed .map-tool-row sits right over this corner (see style.css) — push below it. A scoped
   rule, not style.css, because Vue compiles scoped selectors with a [data-v-xxx] attribute, which
   out-specifies a plain .snap-peak-panel rule in the global stylesheet regardless of source order. */
@media (max-width: 767px) {
  .snap-peak-panel {
    top: 60px;
  }
}
</style>
