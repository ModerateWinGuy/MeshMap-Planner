<template>
  <!-- Basemap picker + 3D terrain / relief-shading toggles. Buttons rather than a <select>: a native
       select dropdown over a WebGL canvas gets closed instantly by focus handling. This is the shared
       control body — BasemapControl wraps it as the floating on-map overlay, and Settings renders it
       inline in the sidebar. -->
  <BasemapPicker />
  <button
    type="button"
    class="btn btn-sm shadow w-100 mt-2"
    :class="store.terrainEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.terrainEnabled"
    title="Toggle 3D terrain (tilt the map to see relief)"
    @click="store.toggleTerrain()"
  >
    3D
  </button>
  <button
    type="button"
    class="btn btn-sm shadow w-100 mt-2"
    :class="store.hillshadeEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.hillshadeEnabled"
    title="Toggle terrain shading (relief / ambient-occlusion look). Works in flat and 3D view."
    @click="store.toggleHillshade()"
  >
    Shade
  </button>
  <button
    v-if="store.terrainEnabled"
    type="button"
    class="btn btn-sm shadow w-100 mt-2 d-flex align-items-center justify-content-center gap-1"
    :class="store.links3dEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.links3dEnabled"
    title="Toggle 3D line-of-sight links (lines flying through the air between antenna tops, clipping sections in yellow)"
    @click="store.toggleLinks3d()"
  >
    <Waypoints :size="16" />
    Links
  </button>
  <!-- Browser-computed line-of-sight viewshed for the selected node. Hidden where WebGPU is missing
       (the mode is inert there); disabled until a node is selected, mirroring the panel's switch. -->
  <button
    v-if="store.viewshedState !== 'unsupported'"
    type="button"
    class="btn btn-sm shadow w-100 mt-2 d-flex align-items-center justify-content-center gap-1"
    :class="store.viewshedEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.viewshedEnabled"
    :disabled="!store.selectedNode"
    :title="
      store.selectedNode
        ? 'Toggle the line-of-sight viewshed — green where the selected node has clear LOS'
        : 'Select a node to show its viewshed'
    "
    @click="store.toggleViewshed()"
  >
    <ScanEye :size="16" />
    Viewshed
  </button>
  <button
    type="button"
    class="btn btn-sm shadow w-100 mt-2 d-flex align-items-center justify-content-center gap-1"
    :class="store.nodesLocked ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.nodesLocked"
    :title="
      store.nodesLocked
        ? 'Nodes locked in place — click to allow dragging'
        : 'Lock nodes in place to prevent accidental dragging'
    "
    @click="store.toggleNodesLock()"
  >
    <component :is="store.nodesLocked ? Lock : LockOpen" :size="16" />
    {{ store.nodesLocked ? 'Nodes Locked' : 'Lock Nodes' }}
  </button>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts';
import { Lock, LockOpen, Waypoints, ScanEye } from '@lucide/vue';
import BasemapPicker from './BasemapPicker.vue';
const store = useStore();
</script>
