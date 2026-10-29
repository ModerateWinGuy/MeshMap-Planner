<template>
  <!-- absolute within .map-col so it pins to the map's top-right, not the viewport's (which would
       sit over the sidebar). -->
  <div class="map-float-panel" data-bs-theme="dark">
    <div class="d-flex align-items-center gap-2 mb-1">
      <Ruler :size="16" />
      <strong>{{ t('measurePanel.title') }}</strong>
      <span class="ms-auto fs-6 fw-semibold">{{ formatted }}</span>
    </div>
    <div class="form-text mt-0 mb-2">
      <template v-if="store.measurePoints.length === 0">{{ t('measurePanel.clickToStart') }}</template>
      <template v-else>{{ t('measurePanel.clickToAddPoints') }}</template>
    </div>
    <div class="d-flex gap-2">
      <button
        type="button"
        class="btn btn-outline-secondary btn-sm flex-fill"
        :disabled="!store.measurePoints.length"
        @click="store.clearMeasure()"
      >
        <Eraser :size="14" /> {{ t('common.clear') }}
      </button>
      <button type="button" class="btn btn-outline-secondary btn-sm flex-fill" @click="store.toggleMeasure()">
        <X :size="14" /> {{ t('measurePanel.done') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Ruler, Eraser, X } from '@lucide/vue';
import { useStore } from '../store.ts';

const { t } = useI18n();
const store = useStore();

const formatted = computed(() => {
  const m = store.measureDistanceM;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
});
</script>
