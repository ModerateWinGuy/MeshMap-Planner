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

    <div class="row mt-3" v-if="store.splatParams.simulation.terrain_source !== 'srtm'">
      <div class="col-12">
        <div class="form-text mb-2">
          LINZ LIDAR terrain is fetched live and can be slow on first view. Pre-download the on-screen
          area so the 3D terrain fills in now — it stays cached for next time.
        </div>
        <button
          v-if="!dl || !dl.running"
          type="button"
          class="btn btn-outline-light btn-sm"
          @click="store.downloadVisibleTerrain()"
        >
          Download terrain for this view
        </button>
        <div v-else class="d-flex align-items-center gap-2">
          <div class="progress flex-grow-1" style="height: 8px;">
            <div class="progress-bar" role="progressbar" :style="{ width: pct + '%' }"></div>
          </div>
          <button type="button" class="btn btn-outline-light btn-sm" @click="store.cancelTerrainDownload()">
            Cancel
          </button>
        </div>
        <div v-if="dl && dl.running" class="form-text">Downloading terrain… {{ dl.done }} / {{ dl.total }} tiles</div>
        <div v-else-if="dl && dl.tooLarge" class="form-text text-warning">
          This view is too large ({{ dl.total }} tiles). Zoom in and try again.
        </div>
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
import { computed } from 'vue'
import { useStore } from '../store.ts'
const store = useStore()
const dl = computed(() => store.terrainDownload)
const pct = computed(() => (dl.value && dl.value.total ? Math.round((dl.value.done / dl.value.total) * 100) : 0))
</script>
