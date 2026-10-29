<template>
  <!-- absolute within .map-col so it pins to the map's top-right, not the viewport's (which would
       sit over the sidebar). Same shape as MeasurePanel.vue. -->
  <div class="map-float-panel" data-bs-theme="dark">
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
    <button type="button" class="btn btn-outline-secondary btn-sm w-100" @click="store.toggleSnapToPeak()">
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
