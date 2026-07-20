<!-- Bottom-of-map progress bar for the heavy in-browser sims — the link matrix, coverage sweep, and
     relay search. A sibling to MapLoadingBar (which counts tiles): this surfaces store.progress
     GLOBALLY, so a coverage run triggered by the C shortcut (or any sim started from one tab) stays
     visible after switching tabs, instead of only inside the panel that launched it. Hidden when no
     heavy sim is running. -->
<template>
  <div
    v-if="running"
    class="sim-loading"
    :class="{ stacked: store.mapTiles.inFlight > 0 }"
    role="status"
    aria-live="polite"
  >
    <LoaderCircle :size="14" class="spin" />
    <span class="label">{{ store.progress?.message || t('common.starting') }}</span>
    <div class="track">
      <div
        class="fill"
        :class="{ indeterminate: pct === null }"
        :style="pct !== null ? { width: pct + '%' } : undefined"
        role="progressbar"
        :aria-valuenow="pct ?? undefined"
        aria-valuemin="0"
        aria-valuemax="100"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { LoaderCircle } from '@lucide/vue';
import { useStore } from '../store.ts';

const { t } = useI18n();
const store = useStore();

// The heavy batch sims that populate store.progress: matrix (link calc), coverage, and relay. The
// lightweight point-to-point profile is intentionally excluded — it runs often (e.g. on every drag) and
// already has its own bottom strip, so flashing a global bar for it would just be noise.
const running = computed(
  () => store.matrixState === 'running' || store.simulationState === 'running' || store.relayState === 'running',
);

// Fill percentage, or null when the active job hasn't reported a fraction yet (→ indeterminate stripe).
const pct = computed(() => {
  const f = store.progress?.fraction;
  return typeof f === 'number' ? Math.round(Math.min(Math.max(f, 0), 1) * 100) : null;
});
</script>

<style scoped>
.sim-loading {
  position: absolute;
  /* Sits above the tile loader (MapLoadingBar) only while that one is showing; otherwise drops to
       the bottom so a compute-only phase isn't left floating with a gap beneath it. */
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
  transition: bottom 0.15s ease;
}

.sim-loading.stacked {
  bottom: 44px;
}

/* Phone's fixed bottom tab bar covers this corner — push above it (same --tabbar-clearance offset
   as MapLoadingBar). Was previously an inline :style binding for the stacked/unstacked bottom value,
   which would have out-prioritized any CSS override here — moved to a class so this can apply. */
@media (max-width: 767px) {
  .sim-loading {
    bottom: calc(var(--tabbar-clearance) + 10px + env(safe-area-inset-bottom));
  }
  .sim-loading.stacked {
    bottom: calc(var(--tabbar-clearance) + 44px + env(safe-area-inset-bottom));
  }
}

.label {
  white-space: nowrap;
}

.track {
  width: 120px;
  height: 4px;
  background: rgba(255, 255, 255, 0.25);
  overflow: hidden;
}

/* Blue (vs the tile bar's orange) so the two stacked bars read as distinct jobs at a glance. */
.fill {
  height: 100%;
  background: #1c7ed6;
  transition: width 0.15s linear;
}

/* No fraction yet: a stripe that sweeps across so the bar reads as "working", not stalled or complete. */
.fill.indeterminate {
  width: 40%;
  transition: none;
  animation: slb-indeterminate 1.1s ease-in-out infinite;
}

@keyframes slb-indeterminate {
  0% {
    transform: translateX(-100%);
  }

  100% {
    transform: translateX(260%);
  }
}

.spin {
  animation: slb-spin 0.9s linear infinite;
  flex-shrink: 0;
}

@keyframes slb-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
