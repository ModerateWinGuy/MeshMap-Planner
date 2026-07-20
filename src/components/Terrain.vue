<template>
  <form novalidate class="panel-min-width">
    <div class="row">
      <div class="col-12">
        <div class="form-text" v-html="t('terrain.toggle3dInfo')"></div>
      </div>
    </div>

    <div class="row mt-3">
      <div class="col-12">
        <DemProviders />
      </div>
    </div>

    <div class="row mt-3">
      <div class="col-12">
        <div class="form-check form-switch">
          <input
            class="form-check-input"
            type="checkbox"
            role="switch"
            id="nz_basemap_enabled"
            :checked="store.nzBasemapEnabled"
            @change="store.toggleNzBasemap()"
          />
          <label class="form-check-label" for="nz_basemap_enabled">{{ t('terrain.nzBasemap') }}</label>
          <InfoTip>
            <span v-html="t('terrain.nzBasemapInfo')"></span>
          </InfoTip>
        </div>
      </div>
    </div>

    <div class="row mt-3" v-if="store.hillshadeEnabled">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="hillshade_intensity" class="form-label mb-0">
            {{ t('terrain.shadingIntensity', { pct: Math.round(store.hillshadeExaggeration * 100) }) }}
          </label>
          <InfoTip>{{ t('terrain.shadingIntensityInfo') }}</InfoTip>
        </div>
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
      </div>
    </div>

    <div class="row mt-3" v-if="store.terrainEnabled">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="terrain_exaggeration" class="form-label mb-0">
            {{ t('terrain.verticalExaggeration', { x: store.terrainExaggeration.toFixed(1) }) }}
          </label>
          <InfoTip>{{ t('terrain.verticalExaggerationInfo') }}</InfoTip>
        </div>
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
          <label class="form-check-label" for="links3d_enabled">{{ t('terrain.show3dLinks') }}</label>
          <InfoTip>
            {{ t('terrain.show3dLinksInfo') }}
          </InfoTip>
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
          <label class="form-check-label" for="link_curtain_enabled">{{ t('terrain.showDropCurtain') }}</label>
          <InfoTip>
            {{ t('terrain.showDropCurtainInfo') }}
          </InfoTip>
        </div>
      </div>
    </div>

    <div class="row mt-3" v-if="store.terrainEnabled && store.links3dEnabled && store.linkCurtainEnabled">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="link_curtain_opacity" class="form-label mb-0">
            {{ t('terrain.dropCurtainOpacity', { pct: Math.round(store.linkCurtainOpacity * 100) }) }}
          </label>
          <InfoTip>{{ t('terrain.dropCurtainOpacityInfo') }}</InfoTip>
        </div>
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
      </div>
    </div>

    <div class="row mt-3">
      <div class="col-12"><hr class="border-secondary" /></div>
    </div>

    <div class="row mt-3">
      <div class="col-12">
        <div class="form-check form-switch">
          <input
            class="form-check-input"
            type="checkbox"
            role="switch"
            id="drag_only_selected"
            :checked="store.dragOnlySelected"
            @change="store.toggleDragOnlySelected()"
          />
          <label class="form-check-label" for="drag_only_selected">{{ t('terrain.dragOnlySelected') }}</label>
          <InfoTip>
            {{ t('terrain.dragOnlySelectedInfo') }}
          </InfoTip>
        </div>
      </div>
    </div>

    <div class="row mt-3">
      <div class="col-12">
        <div class="form-check form-switch">
          <input
            class="form-check-input"
            type="checkbox"
            role="switch"
            id="profile_flat_signal_line"
            :checked="store.profileFlatSignalLine"
            @change="store.toggleProfileFlatSignalLine()"
          />
          <label class="form-check-label" for="profile_flat_signal_line">{{ t('terrain.flatSignalLine') }}</label>
          <InfoTip>
            {{ t('terrain.flatSignalLineInfo') }}
          </InfoTip>
        </div>
      </div>
    </div>

    <div class="row mt-3">
      <div class="col-12">
        <button type="button" class="btn btn-outline-light btn-sm" @click="store.resetView()">
          {{ t('terrain.resetView') }}
        </button>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import InfoTip from './InfoTip.vue';
import DemProviders from './DemProviders.vue';
const { t } = useI18n();
const store = useStore();
</script>
