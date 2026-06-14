<template>
  <form novalidate style="min-width: 260px;">
    <div class="row">
      <div class="col-12">
        <div class="form-text">
          A fast, in-browser <strong>line-of-sight checker</strong>: everything the selected node can
          see is tinted <span class="text-success fw-semibold">green</span>. It reads whatever surface the map's 3D terrain is currently showing (bare-earth DEM,
          surface DSM, or the simulation grid), so switch terrain source in <strong>Settings</strong> to
          compare. This is a quick approximation - the <strong>Coverage</strong> (SPLAT) run remains the
          authoritative radio model.
        </div>
      </div>
    </div>

    <!-- WebGPU is required for the compute pass; on browsers without it the mode is inert. -->
    <div v-if="store.viewshedState === 'unsupported'" class="row mt-3">
      <div class="col-12">
        <div class="alert alert-warning py-2 px-3 mb-0 d-flex align-items-start gap-2">
          <TriangleAlert :size="18" class="flex-shrink-0 mt-1" />
          <span>
            Viewshed needs a <strong>WebGPU-capable browser</strong> — Chrome/Edge, Safari&nbsp;18+, or a
            recent Firefox. The rest of the app is unaffected.
          </span>
        </div>
      </div>
    </div>

    <template v-else>
      <div class="row mt-3">
        <div class="col-12">
          <div class="form-check form-switch">
            <input
              class="form-check-input"
              type="checkbox"
              role="switch"
              id="viewshed_enabled"
              :checked="store.viewshedEnabled"
              :disabled="!store.selectedNode"
              @change="store.toggleViewshed()"
            />
            <label class="form-check-label" for="viewshed_enabled">Show viewshed for selected node</label>
          </div>
          <div v-if="!store.selectedNode" class="form-text">Add or select a node to begin.</div>
          <div v-else-if="store.viewshedProgress" class="form-text d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Loading terrain… {{ store.viewshedProgress.loaded }}/{{ store.viewshedProgress.total }} tiles
          </div>
          <div v-else-if="store.viewshedState === 'computing'" class="form-text d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Computing…
          </div>
          <div v-else-if="store.viewshedState === 'error'" class="form-text text-warning">
            Couldn't compute the viewshed — see the console. Try a smaller radius.
          </div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="form-check form-switch">
            <input
              class="form-check-input"
              type="checkbox"
              role="switch"
              id="viewshed_live"
              :checked="store.viewshedLive"
              @change="store.toggleViewshedLive()"
            />
            <label class="form-check-label" for="viewshed_live">Live recompute while dragging</label>
          </div>
          <div class="form-text">
            On = recompute continuously as you drag the node (needs a fast GPU; runs at lower detail
            mid-drag). Off = recompute when you drop it or change a setting.
          </div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <label for="viewshed_radius" class="form-label">Radius: {{ store.viewshedRadiusKm }} km</label>
          <input
            type="range"
            class="form-range"
            id="viewshed_radius"
            min="1"
            max="30"
            step="1"
            :value="store.viewshedRadiusKm"
            @input="store.setViewshedRadiusKm(Number(($event.target as HTMLInputElement).value))"
          />
          <div class="form-text">How far out to test. Larger radius = coarser terrain at this range.</div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <label for="viewshed_target_height" class="form-label">
            Receiver height: {{ store.viewshedTargetHeight }} m
          </label>
          <input
            type="range"
            class="form-range"
            id="viewshed_target_height"
            min="0"
            max="50"
            step="1"
            :value="store.viewshedTargetHeight"
            @input="store.setViewshedTargetHeight(Number(($event.target as HTMLInputElement).value))"
          />
          <div class="form-text">
            Height above ground at the tested cells. The observer uses the node's antenna height.
          </div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <label for="viewshed_opacity" class="form-label">
            Opacity: {{ Math.round(store.viewshedOpacity * 100) }}%
          </label>
          <input
            type="range"
            class="form-range"
            id="viewshed_opacity"
            min="0.05"
            max="1"
            step="0.05"
            :value="store.viewshedOpacity"
            @input="store.setViewshedOpacity(Number(($event.target as HTMLInputElement).value))"
          />
          <div class="form-text">Higher = more opaque green tint.</div>
        </div>
      </div>
    </template>
  </form>
</template>

<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue'
import { useStore } from '../store.ts'
const store = useStore()
</script>
