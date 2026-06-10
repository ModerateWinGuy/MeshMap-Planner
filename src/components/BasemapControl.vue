<template>
  <!-- On-map view controls (a Vue overlay, not a custom IControl, to stay in Vue idiom): basemap
       picker + 3D terrain toggle. Buttons rather than a <select>: a native select dropdown over a
       WebGL canvas gets closed instantly by focus handling. -->
  <div class="map-controls">
    <div class="btn-group-vertical shadow" role="group" aria-label="Basemap">
      <button
        v-for="b in BASEMAPS"
        :key="b.id"
        type="button"
        class="btn btn-sm text-start"
        :class="store.activeBasemap === b.id ? 'btn-primary' : 'btn-light'"
        @click="store.setBasemap(b.id)"
      >
        {{ b.label }}
      </button>
    </div>
    <button
      type="button"
      class="btn btn-sm shadow w-100 mt-2"
      :class="store.terrainEnabled ? 'btn-primary' : 'btn-light'"
      :aria-pressed="store.terrainEnabled"
      title="Toggle 3D terrain (tilt the map to see relief)"
      @click="store.toggleTerrain()"
    >
      {{ store.terrainEnabled ? '3D: on' : '3D: off' }}
    </button>
    <button
      type="button"
      class="btn btn-sm shadow w-100 mt-2"
      :class="store.hillshadeEnabled ? 'btn-primary' : 'btn-light'"
      :aria-pressed="store.hillshadeEnabled"
      title="Toggle terrain shading (relief / ambient-occlusion look). Works in flat and 3D view."
      @click="store.toggleHillshade()"
    >
      {{ store.hillshadeEnabled ? 'Shade: on' : 'Shade: off' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useStore, BASEMAPS } from '../store.ts'
const store = useStore()
</script>

<style scoped>
.map-controls {
  position: fixed;
  top: 70px;
  left: 10px;
  z-index: 1000;
  width: 130px;
}
</style>
