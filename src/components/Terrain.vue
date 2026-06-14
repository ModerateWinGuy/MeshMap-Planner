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

    <div class="row mt-3" v-if="store.terrainEnabled">
      <div class="col-12">
        <div class="form-check form-switch">
          <input
            class="form-check-input"
            type="checkbox"
            role="switch"
            id="links3d_enabled"
            :checked="store.links3dEnabled"
            @change="store.toggleLinks3d()"
          />
          <label class="form-check-label" for="links3d_enabled">Show 3D line-of-sight links</label>
        </div>
        <div class="form-text">
          Draw links as 3D lines flying through the air between antenna tops, with terrain-clipping
          sections in yellow. When off, links stay as flat lines draped on the ground.
        </div>
      </div>
    </div>

    <div class="row mt-3" v-if="store.terrainEnabled && store.links3dEnabled">
      <div class="col-12">
        <div class="form-check form-switch">
          <input
            class="form-check-input"
            type="checkbox"
            role="switch"
            id="link_curtain_enabled"
            :checked="store.linkCurtainEnabled"
            @change="store.toggleLinkCurtain()"
          />
          <label class="form-check-label" for="link_curtain_enabled">Show link drop-curtain</label>
        </div>
        <div class="form-text">
          A translucent wall dropped from each link to the ground, showing its track and where it clips
          terrain.
        </div>
      </div>
    </div>

    <div class="row mt-3" v-if="store.terrainEnabled && store.links3dEnabled && store.linkCurtainEnabled">
      <div class="col-12">
        <label for="link_curtain_opacity" class="form-label">
          Drop-curtain opacity: {{ Math.round(store.linkCurtainOpacity * 100) }}%
        </label>
        <input
          type="range"
          class="form-range"
          id="link_curtain_opacity"
          min="0.05"
          max="1"
          step="0.05"
          :value="store.linkCurtainOpacity"
          @input="store.setLinkCurtainOpacity(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="form-text">Higher = more opaque.</div>
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
