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
    :title="t('mapControls.toggle3dTerrainTitle')"
    @click="store.toggleTerrain()"
  >
    3D
  </button>
  <button
    type="button"
    class="btn btn-sm shadow w-100 mt-2"
    :class="store.hillshadeEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.hillshadeEnabled"
    :title="t('mapControls.toggleShadingTitle')"
    @click="store.toggleHillshade()"
  >
    {{ t('mapControls.shade') }}
  </button>
  <button
    type="button"
    class="btn btn-sm shadow w-100 mt-2 d-flex align-items-center justify-content-center gap-1"
    :class="store.buildingsEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.buildingsEnabled"
    :title="t('mapControls.toggleBuildingsTitle')"
    @click="store.toggleBuildings()"
  >
    <Building2 :size="16" />
    {{ t('mapControls.buildings') }}
  </button>
  <button
    v-if="store.terrainEnabled"
    type="button"
    class="btn btn-sm shadow w-100 mt-2 d-flex align-items-center justify-content-center gap-1"
    :class="store.links3dEnabled ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.links3dEnabled"
    :title="t('mapControls.toggleLinksTitle')"
    @click="store.toggleLinks3d()"
  >
    <Waypoints :size="16" />
    {{ t('mapControls.links') }}
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
    :title="store.selectedNode ? t('mapControls.viewshedOnTitle') : t('mapControls.viewshedOffTitle')"
    @click="store.toggleViewshed()"
  >
    <ScanEye :size="16" />
    {{ t('mapControls.viewshed') }}
  </button>
  <button
    type="button"
    class="btn btn-sm shadow w-100 mt-2 d-flex align-items-center justify-content-center gap-1"
    :class="store.nodesLocked ? 'btn-primary' : 'btn-light'"
    :aria-pressed="store.nodesLocked"
    :title="store.nodesLocked ? t('mapControls.nodesLockedTitleDesktop') : t('mapControls.lockNodesTitle')"
    @click="store.toggleNodesLock()"
  >
    <component :is="store.nodesLocked ? Lock : LockOpen" :size="16" />
    {{ store.nodesLocked ? t('mapControls.nodesLocked') : t('mapControls.lockNodes') }}
  </button>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { Lock, LockOpen, Waypoints, ScanEye, Building2 } from '@lucide/vue';
import BasemapPicker from './BasemapPicker.vue';
const { t } = useI18n();
const store = useStore();
</script>
