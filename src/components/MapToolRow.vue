<template>
  <!-- The one map toolbar for every regime: a vertical strip on desktop/tablet, a centred row on phone.
       .tool-label text only shows on wide screens (see style.css). -->
  <div class="map-tool-row">
    <div :class="vertical ? 'dropend' : 'dropdown'">
      <button
        type="button"
        class="tool-btn"
        data-bs-toggle="dropdown"
        aria-expanded="false"
        :aria-label="t('mapControls.basemap')"
        :title="t('mapControls.basemap')"
      >
        <Layers :size="17" />
        <span class="tool-label">{{ activeBasemapLabel }}</span>
      </button>
      <ul class="dropdown-menu" data-bs-theme="dark" :aria-label="t('mapControls.basemap')">
        <li v-for="b in store.availableBasemaps" :key="b.id">
          <button
            type="button"
            class="dropdown-item"
            :class="{ active: store.activeBasemap === b.id }"
            :aria-current="store.activeBasemap === b.id"
            @click="store.setBasemap(b.id)"
          >
            {{ t(b.labelKey) }}
          </button>
        </li>
      </ul>
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
      <span class="tool-glyph">3D</span>
      <span class="tool-label">{{ t('mapControls.terrain3d') }}</span>
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
      <span class="tool-label">{{ t('mapControls.shade') }}</span>
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
      <span class="tool-label">{{ t('mapControls.buildings') }}</span>
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
      <span class="tool-label">{{ t('mapControls.links') }}</span>
    </button>

    <button
      type="button"
      class="tool-btn"
      :class="{ active: store.nodesLocked }"
      :aria-pressed="store.nodesLocked"
      :aria-label="
        store.nodesLocked
          ? t(vertical ? 'mapControls.nodesLocked' : 'mapControls.nodesLockedAriaLabelTouch')
          : t('mapControls.lockNodes')
      "
      :title="
        store.nodesLocked
          ? t(vertical ? 'mapControls.nodesLockedTitleDesktop' : 'mapControls.nodesLockedTitleTouch')
          : t('mapControls.lockNodesTitle')
      "
      @click="store.toggleNodesLock()"
    >
      <component :is="store.nodesLocked ? Lock : LockOpen" :size="17" />
      <span class="tool-label">{{
        store.nodesLocked ? t('mapControls.nodesLocked') : t('mapControls.lockNodes')
      }}</span>
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
      <span class="tool-label">{{ t('mapControls.viewshed') }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { Layers, Sun, Waypoints, Lock, LockOpen, ScanEye, Building2 } from '@lucide/vue';
const { t } = useI18n();
const store = useStore();
const { vertical = false } = defineProps<{ vertical?: boolean }>();

const activeBasemapLabel = computed(() => {
  const b = store.availableBasemaps.find((b) => b.id === store.activeBasemap);
  return b ? t(b.labelKey) : t('mapControls.basemap');
});
</script>
