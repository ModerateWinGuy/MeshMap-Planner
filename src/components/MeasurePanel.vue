<template>
  <!-- absolute within .map-col so it pins to the map's top-right, not the viewport's (which would
       sit over the sidebar). -->
  <div class="measure-panel shadow text-bg-dark" data-bs-theme="dark">
    <div class="d-flex align-items-center gap-2 mb-1">
      <Ruler :size="16" />
      <strong>Measure</strong>
      <span class="ms-auto fs-6 fw-semibold">{{ formatted }}</span>
    </div>
    <div class="form-text mt-0 mb-2">
      <template v-if="store.measurePoints.length === 0">Click the map to start measuring.</template>
      <template v-else>Click to add points; double-click to finish.</template>
    </div>
    <div class="d-flex gap-2">
      <button
        type="button"
        class="btn btn-outline-light btn-sm flex-fill"
        :disabled="!store.measurePoints.length"
        @click="store.clearMeasure()"
      >
        <Eraser :size="14" /> Clear
      </button>
      <button type="button" class="btn btn-light btn-sm flex-fill" @click="store.toggleMeasure()">
        <X :size="14" /> Done
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Ruler, Eraser, X } from '@lucide/vue';
import { useStore } from '../store.ts';

const store = useStore();

const formatted = computed(() => {
  const m = store.measureDistanceM;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
});
</script>

<style scoped>
.measure-panel {
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
   out-specifies a plain .measure-panel rule in the global stylesheet regardless of source order. */
@media (max-width: 767px) {
  .measure-panel {
    top: 60px;
  }
}
</style>
