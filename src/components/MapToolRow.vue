<template>
  <div class="map-tool-row">
    <div class="dropdown">
      <button
        type="button"
        class="tool-btn"
        data-bs-toggle="dropdown"
        aria-expanded="false"
        aria-label="Basemap"
        title="Basemap"
      >
        <Layers :size="17" />
      </button>
      <div class="dropdown-menu p-2" data-bs-theme="dark" style="width: 160px">
        <BasemapPicker />
      </div>
    </div>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.terrainEnabled }"
      :aria-pressed="store.terrainEnabled"
      aria-label="Toggle 3D terrain"
      title="Toggle 3D terrain (tilt the map to see relief)"
      @click="store.toggleTerrain()"
    >
      3D
    </button>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.hillshadeEnabled }"
      :aria-pressed="store.hillshadeEnabled"
      aria-label="Toggle terrain shading"
      title="Toggle terrain shading (relief / ambient-occlusion look). Works in flat and 3D view."
      @click="store.toggleHillshade()"
    >
      <Sun :size="17" />
    </button>

    <button
      v-if="store.terrainEnabled"
      type="button"
      class="tool-btn"
      :class="{ active: store.links3dEnabled }"
      :aria-pressed="store.links3dEnabled"
      aria-label="Toggle 3D line-of-sight links"
      title="Toggle 3D line-of-sight links (lines flying through the air between antenna tops, clipping sections in yellow)"
      @click="store.toggleLinks3d()"
    >
      <Waypoints :size="17" />
    </button>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.nodesLocked }"
      :aria-pressed="store.nodesLocked"
      :aria-label="store.nodesLocked ? 'Nodes locked — tap to allow dragging' : 'Lock nodes in place'"
      :title="store.nodesLocked
        ? 'Nodes locked in place — tap to allow dragging'
        : 'Lock nodes in place to prevent accidental dragging'"
      @click="store.toggleNodesLock()"
    >
      <component :is="store.nodesLocked ? Lock : LockOpen" :size="17" />
    </button>

    <button
      v-if="store.viewshedState !== 'unsupported'"
      type="button"
      class="tool-btn"
      :class="{ active: store.viewshedEnabled }"
      :aria-pressed="store.viewshedEnabled"
      :disabled="!store.selectedNode"
      :aria-label="store.selectedNode ? 'Toggle viewshed' : 'Select a node to show its viewshed'"
      :title="store.selectedNode
        ? 'Toggle the line-of-sight viewshed — green where the selected node has clear LOS'
        : 'Select a node to show its viewshed'"
      @click="store.toggleViewshed()"
    >
      <ScanEye :size="17" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts'
import { Layers, Sun, Waypoints, Lock, LockOpen, ScanEye } from '@lucide/vue'
import BasemapPicker from './BasemapPicker.vue'
const store = useStore()
</script>
