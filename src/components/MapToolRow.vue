<template>
  <div class="map-tool-row">
    <div class="dropdown">
      <button
        type="button"
        class="tool-btn"
        data-bs-toggle="dropdown"
        aria-expanded="false"
        :aria-label="t('mapControls.basemap')"
        :title="t('mapControls.basemap')"
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
      :aria-label="t('mapControls.toggle3dAriaLabel')"
      :title="t('mapControls.toggle3dTerrainTitle')"
      @click="store.toggleTerrain()"
    >
      3D
    </button>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.hillshadeEnabled }"
      :aria-pressed="store.hillshadeEnabled"
      :aria-label="t('mapControls.toggleShadingAriaLabel')"
      :title="t('mapControls.toggleShadingTitle')"
      @click="store.toggleHillshade()"
    >
      <Sun :size="17" />
    </button>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.buildingsEnabled }"
      :aria-pressed="store.buildingsEnabled"
      :aria-label="t('mapControls.toggleBuildingsAriaLabel')"
      :title="t('mapControls.toggleBuildingsTitle')"
      @click="store.toggleBuildings()"
    >
      <Building2 :size="17" />
    </button>

    <button
      v-if="store.terrainEnabled"
      type="button"
      class="tool-btn"
      :class="{ active: store.links3dEnabled }"
      :aria-pressed="store.links3dEnabled"
      :aria-label="t('mapControls.toggleLinksAriaLabel')"
      :title="t('mapControls.toggleLinksTitle')"
      @click="store.toggleLinks3d()"
    >
      <Waypoints :size="17" />
    </button>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.nodesLocked }"
      :aria-pressed="store.nodesLocked"
      :aria-label="store.nodesLocked ? t('mapControls.nodesLockedAriaLabelTouch') : t('mapControls.lockNodes')"
      :title="store.nodesLocked ? t('mapControls.nodesLockedTitleTouch') : t('mapControls.lockNodesTitle')"
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
      :aria-label="store.selectedNode ? t('mapControls.toggleViewshedAriaLabel') : t('mapControls.viewshedOffTitle')"
      :title="store.selectedNode ? t('mapControls.viewshedOnTitle') : t('mapControls.viewshedOffTitle')"
      @click="store.toggleViewshed()"
    >
      <ScanEye :size="17" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { Layers, Sun, Waypoints, Lock, LockOpen, ScanEye, Building2 } from '@lucide/vue';
import BasemapPicker from './BasemapPicker.vue';
const { t } = useI18n();
const store = useStore();
</script>
