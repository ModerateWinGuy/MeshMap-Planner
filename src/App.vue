<template>
  <div>
    <nav class="navbar navbar-dark bg-dark fixed-top">
      <div class="container-fluid position-relative">
        <a class="navbar-brand d-inline-flex align-items-center gap-2" href="#">
          <Radio :size="30" class="brand-icon" aria-label="MeshMap Planner Logo" />
          MeshMap Planner
        </a>
        <!-- Mode selector: an iOS-style segmented control (radio btn-check + label). Picking a mode
             swaps the sidebar's contents below. Absolutely centered so it stays mid-navbar
             regardless of the brand width; the checked segment becomes a solid white pill — the
             active highlight (see the .mode-toggle rules in style.css). -->
        <div class="btn-group mode-toggle position-absolute top-50 start-50 translate-middle" role="group" aria-label="Mode">
          <template v-for="m in MODES" :key="m.id">
            <input
              type="radio"
              class="btn-check"
              name="uiMode"
              :id="'mode-' + m.id"
              :value="m.id"
              v-model="store.activeMode"
              autocomplete="off"
            />
            <label class="btn d-inline-flex align-items-center gap-1" :for="'mode-' + m.id">
              <component :is="m.icon" :size="16" />
              {{ m.label }}
            </label>
          </template>
        </div>
      </div>
    </nav>

    <div class="content-row">
      <!-- Map column: the map fills it, with the point-to-point profile strip docked below when a
           profile exists. Wrapped (rather than a bare #map) so the strip can shrink the map via flex
           instead of overlapping it; MapLibre's ResizeObserver re-fits the canvas automatically. -->
      <div class="map-col">
        <div id="map" ref="map"></div>
        <MapLoadingBar />
        <MeasurePanel v-if="store.measureActive" />
        <ProfilePanel v-if="store.profileResult || store.profileState === 'running' || store.profileState === 'failed'" />
      </div>
      <!-- data-bs-theme="dark" puts every Bootstrap component in this dark sidebar onto its dark-mode
           palette (Bootstrap 5.3 color modes). Without it, descendants default to light-mode colours
           that vanish on the dark background: .form-text / .text-muted render near-black, and
           .list-group-item draws a white box (which hid the white close buttons on the coverage
           results and node list). -->
      <aside class="sidebar text-bg-dark" data-bs-theme="dark">
        <div class="mode-area">
          <!-- One panel group visible per mode. v-show (not v-if) keeps every panel mounted so
               component state survives mode switches and the map — initialised here in App, see the
               onMounted hook — is never torn down by a panel unmount. -->
          <div v-show="store.activeMode === 'nodes'">
            <NodePanel />
            <!-- The transmitter/receiver editors only make sense once a node exists; hiding them when
                 the list is empty leaves NodePanel's single "Add a node to begin." prompt, instead of
                 each panel repeating its own "no node selected" message. -->
            <template v-if="store.nodes.length">
              <hr />
              <Transmitter />
              <hr />
              <Receiver />
            </template>
          </div>

          <div v-show="store.activeMode === 'radio'">
            <Environment />
            <hr />
            <LoRaPreset />
            <hr />
            <Simulation />
          </div>

          <div v-show="store.activeMode === 'coverage'">
            <Display />
            <div class="mt-3 d-flex gap-2">
              <button :disabled="store.simulationState === 'running' || !store.selectedNode" @click="store.runSimulation" type="button" class="btn btn-success btn-sm w-100" id="runSimulation">
                <span :class="{ 'd-none': store.simulationState !== 'running' }" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                <span class="button-text">{{ buttonText() }}</span>
              </button>
            </div>
            <div v-if="store.simulationState === 'running'" class="mt-2">
              <small class="text-muted d-block mb-1">{{ store.progress?.message || 'Starting…' }}</small>
              <div class="progress" role="progressbar" aria-label="Simulation progress" style="height: 6px;">
                <div class="progress-bar progress-bar-striped progress-bar-animated" :style="{ width: progressWidth() }"></div>
              </div>
            </div>
          </div>

          <div v-show="store.activeMode === 'viewshed'">
            <Viewshed />
          </div>

          <div v-show="store.activeMode === 'linkfinder'">
            <LinkMatrix />
            <hr />
            <RelayFinder />
          </div>

          <div v-show="store.activeMode === 'settings'">
            <BasemapButtons />
            <hr />
            <Terrain />
          </div>
        </div>

        <!-- Computed-coverage results: pinned below the mode area so they stay visible (and
             toggleable) in every mode. -->
        <ul class="list-group mt-3 results-pinned">
          <li class="list-group-item d-flex justify-content-between align-items-center" v-for="(site, index) in store.$state.localSites" :key="site.taskId">
            <span :class="{ 'text-muted': site.visible === false }">{{ site.params.transmitter.name }}</span>
            <div class="d-flex align-items-center gap-2">
              <button type="button" @click="store.toggleSiteVisibility(index)" class="btn btn-sm p-0 border-0 bg-transparent lh-1" :aria-label="site.visible === false ? 'Show result' : 'Hide result'" :title="site.visible === false ? 'Show result' : 'Hide result'">
                <EyeOff v-if="site.visible === false" :size="18" />
                <Eye v-else :size="18" />
              </button>
              <button type="button" @click="store.removeSite(index)" class="btn btn-sm p-0 border-0 bg-transparent lh-1" aria-label="Remove result" title="Remove result">
                <X :size="18" />
              </button>
            </div>
          </li>
        </ul>
      </aside>
    </div>
    <BasemapControl />
  </div>
</template>

<script setup lang="ts">
import "maplibre-gl/dist/maplibre-gl.css"
// Bootstrap's CSS is imported in main.ts (before style.css) so our theme overrides win; only the JS
// bundle (popovers/dropdowns) is needed here.
import "bootstrap/dist/js/bootstrap.bundle.min.js"
import { onMounted, onUnmounted } from "vue"
import NodePanel from "./components/NodePanel.vue"
import LinkMatrix from "./components/LinkMatrix.vue"
import RelayFinder from "./components/RelayFinder.vue"
import Transmitter from "./components/Transmitter.vue"
import Receiver from "./components/Receiver.vue"
import Environment from "./components/Environment.vue"
import LoRaPreset from "./components/LoRaPreset.vue"
import Simulation from "./components/Simulation.vue"
import Display from "./components/Display.vue"
import Viewshed from "./components/Viewshed.vue"
import Terrain from "./components/Terrain.vue"
import BasemapControl from "./components/BasemapControl.vue"
import BasemapButtons from "./components/BasemapButtons.vue"
import ProfilePanel from "./components/ProfilePanel.vue"
import MapLoadingBar from "./components/MapLoadingBar.vue"
import MeasurePanel from "./components/MeasurePanel.vue"
import { Eye, EyeOff, X, Radio, RadioTower, Map as MapIcon, Link, WifiCog, SlidersVertical, ScanEye } from "@lucide/vue"
import type { Component } from "vue"

import { useStore } from './store.ts'
import type { UiMode } from './types.ts'
const store = useStore()

// Top-bar mode toggle. Order is the rough workflow: build nodes -> set radio params -> run coverage
// -> analyse links -> map settings.
const MODES = [
  { id: 'nodes', label: 'Nodes', icon: RadioTower },
  { id: 'coverage', label: 'Coverage', icon: MapIcon },
  { id: 'viewshed', label: 'Viewshed', icon: ScanEye },
  { id: 'linkfinder', label: 'Link Finder', icon: Link },
  { id: 'radio', label: 'Simulation Settings', icon: WifiCog },
  { id: 'settings', label: 'Settings', icon: SlidersVertical },
] as const satisfies ReadonlyArray<{ id: UiMode; label: string; icon: Component }>

// The map belongs to the app shell, not any one panel — init/destroy here so switching modes (which
// only toggles panel visibility via v-show) never tears the map down.
onMounted(() => {
  store.initMap()
})
onUnmounted(() => {
  // Tear the map down on unmount so a remount (Vite HMR) can't leave the old map's layers subscribed
  // to its handlers — that orphaned state is what throws "map is null" and drifts layers on the next
  // interaction.
  store.destroyMap()
})

const buttonText = () => {
  if ('running' === store.simulationState) {
    return 'Running'
  } else if ('failed' === store.simulationState) {
    return 'Failed'
  } else {
    return 'Run Simulation'
  }
}
// Bar width: proportional when the backend reports a fraction, else a full animated bar (the
// striped animation reads as "working" while we have no estimate, e.g. during a remote warp).
const progressWidth = () => {
  const f = store.progress?.fraction
  return typeof f === 'number' ? `${Math.round(Math.min(Math.max(f, 0), 1) * 100)}%` : '100%'
}
</script>

<style>
/* Node pin element handed to maplibregl.Marker (see src/layers.ts): a name caption stacked above
   the MapPin icon, both horizontally centred over the coordinate. */
.node-pin {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  line-height: 1;
  user-select: none;
}
/* Name caption above the pin. max-width is set inline per selection size in stylePinElement (twice
   the icon width) and the name is ellipsised so a long one can't sprawl across the map. The pill
   keeps it legible over any basemap; colour overrides the red/blue currentColor it would inherit. */
.node-pin-label {
  max-width: 150px;
  margin-bottom: 3px;
  padding: 1px 5px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 4px;
}
</style>
