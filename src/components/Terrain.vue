<template>
  <form novalidate style="min-width: 260px;">
    <div class="row">
      <div class="col-12">
        <div class="form-text">
          Toggle <strong>3D terrain</strong> with the <strong>3D</strong> button on the map
          (top-left, under the basemap buttons). It drapes the map over an elevation mesh (AWS
          Terrarium / SRTM); tilt with right-drag (or the compass control) to read hill elevation.
          The <strong>Shade</strong> button beside it adds relief shading that reads hills on flat
          basemaps — works in both top-down and 3D view.
        </div>
      </div>
    </div>

    <div class="row mt-3" v-if="store.hillshadeEnabled">
      <div class="col-12">
        <label for="hillshade_intensity" class="form-label">
          Shading intensity: {{ Math.round(store.hillshadeExaggeration * 100) }}%
        </label>
        <input
          type="range"
          class="form-range"
          id="hillshade_intensity"
          min="0"
          max="1"
          step="0.05"
          :value="store.hillshadeExaggeration"
          @input="store.setHillshadeExaggeration(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="form-text">Multidirectional relief shading from the DEM. Higher = stronger.</div>
      </div>
    </div>

    <div class="row mt-3" v-if="store.terrainEnabled">
      <div class="col-12">
        <label for="terrain_exaggeration" class="form-label">
          Vertical exaggeration: {{ store.terrainExaggeration.toFixed(1) }}×
        </label>
        <input
          type="range"
          class="form-range"
          id="terrain_exaggeration"
          min="0.5"
          max="3"
          step="0.1"
          :value="store.terrainExaggeration"
          @input="store.setTerrainExaggeration(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="form-text">Higher values make subtle terrain easier to read.</div>
      </div>
    </div>

    <div class="row mt-3">
      <div class="col-12">
        <button type="button" class="btn btn-outline-light btn-sm" @click="store.resetView()">
          Reset view (top-down)
        </button>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts'
const store = useStore()
</script>
