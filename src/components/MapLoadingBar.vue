<!-- A compact loading indicator pinned to the bottom of the map. Shows how many tiles are in flight
     across all sources — basemap, 3D terrain, and the slower simulation-terrain tiles — so a cold area
     (or a heavy sim-tile build) reads as progress rather than a frozen map. Driven entirely by the
     store's MapLibre tile-event tracker (store.mapTiles); hidden when nothing is loading. -->
<template>
  <div v-if="store.mapTiles.inFlight > 0" class="map-loading" role="status" aria-live="polite">
    <LoaderCircle :size="14" class="spin" />
    <span class="label"
      >Loading {{ store.mapTiles.inFlight }} {{ store.mapTiles.inFlight === 1 ? 'tile' : 'tiles' }}…</span
    >
    <div class="progress">
      <div
        class="progress-bar"
        role="progressbar"
        :style="{ width: pct + '%' }"
        :aria-valuenow="pct"
        aria-valuemin="0"
        aria-valuemax="100"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle } from '@lucide/vue';
import { useStore } from '../store.ts';

const store = useStore();

// (peak - inFlight) / peak: fills as tiles finish, and resets each burst because the store zeroes
// peak when inFlight returns to 0. Falls back to 0 (indeterminate-looking) before any peak is set.
const pct = computed(() => {
  const { inFlight, peak } = store.mapTiles;
  return peak > 0 ? Math.round(((peak - inFlight) / peak) * 100) : 0;
});
</script>

<style scoped>
.map-loading {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
  /* Above the map canvas but below the floating controls (z-index ~1000). */
}

/* Phone's fixed bottom tab bar covers this corner — push above it. A scoped rule, not style.css,
   because Vue compiles scoped selectors with a [data-v-xxx] attribute, which out-specifies a plain
   .map-loading rule in the global stylesheet regardless of source order (see MeasurePanel.vue for the
   same issue). --tabbar-clearance is defined globally in style.css's :root block. */
@media (max-width: 767px) {
  .map-loading {
    bottom: calc(var(--tabbar-clearance) + 10px + env(safe-area-inset-bottom));
  }
}

.label {
  white-space: nowrap;
}

.progress {
  width: 120px;
  height: 4px;
  background: rgba(255, 255, 255, 0.25);
}

.progress-bar {
  background: var(--accent-orange, #e08326);
  transition: width 0.15s linear;
}

.spin {
  animation: mlb-spin 0.9s linear infinite;
  flex-shrink: 0;
}

@keyframes mlb-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
