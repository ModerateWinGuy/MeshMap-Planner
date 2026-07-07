<template>
  <form novalidate class="panel-min-width">
    <div class="row">
      <div class="col-12">
        <div class="form-text">
          A fast, in-browser <strong>line-of-sight checker</strong>: everything the selected node can see is tinted
          <span class="text-success fw-semibold">green</span>. It reads whatever surface the map's 3D terrain is
          currently showing (bare-earth DEM, surface DSM, or the simulation grid), so switch terrain source in
          <strong>Settings</strong> to compare. This is a quick approximation - the <strong>Coverage</strong> (SPLAT)
          run remains the authoritative radio model.
        </div>
      </div>
    </div>

    <!-- The compute pass needs WebGPU or, failing that, WebGL2; on a browser with neither the mode is inert. -->
    <div v-if="store.viewshedState === 'unsupported'" class="row mt-3">
      <div class="col-12">
        <div class="alert alert-warning py-2 px-3 mb-0 d-flex align-items-start gap-2">
          <TriangleAlert :size="18" class="flex-shrink-0 mt-1" />
          <span>
            Viewshed needs a browser with <strong>WebGPU or WebGL2</strong> support. The rest of the app is unaffected.
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
            Loading terrain… {{ store.viewshedProgress.loaded }}/{{ store.viewshedProgress.total }}
            tiles
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
            <InfoTip>
              On = recompute continuously as you drag the node (needs a fast GPU; runs at lower detail mid-drag). Off =
              recompute when you drop it or change a setting.
            </InfoTip>
          </div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="d-flex align-items-center mb-2">
            <label for="viewshed_radius" class="form-label mb-0">Radius: {{ store.viewshedRadiusKm }} km</label>
            <InfoTip>How far out to test. Larger radius = coarser terrain at this range.</InfoTip>
          </div>
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
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="d-flex align-items-center mb-2">
            <label for="viewshed_target_height" class="form-label mb-0">
              Receiver height: {{ store.viewshedTargetHeight }} m
            </label>
            <InfoTip> Height above ground at the tested cells. The observer uses the node's antenna height. </InfoTip>
          </div>
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
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="d-flex align-items-center mb-2">
            <label for="viewshed_opacity" class="form-label mb-0">
              Opacity: {{ Math.round(store.viewshedOpacity * 100) }}%
            </label>
            <InfoTip>Higher = more opaque green tint.</InfoTip>
          </div>
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
        </div>
      </div>
    </template>
  </form>
</template>

<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue';
import { useStore } from '../store.ts';
import InfoTip from './InfoTip.vue';
const store = useStore();
</script>
