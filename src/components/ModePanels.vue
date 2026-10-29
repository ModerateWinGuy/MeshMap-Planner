<template>
  <!-- One panel group visible per mode. v-show (not v-if) keeps every panel mounted so component
       state survives mode switches and the map — initialised in App.vue's onMounted hook — is never
       torn down by a panel unmount. Mounted once by App.vue, inside whichever container the current
       layout regime calls for (the sidebar on desktop/tablet, the bottom sheet on phone). -->
  <div v-show="store.activeMode === 'nodes'" class="mode-pane">
    <NodePanel :hide-footer="nodeFooter === 'external'" />
    <!-- The transmitter/receiver editors only make sense once a node exists; hiding them when the
         list is empty leaves NodePanel's single "Add a node to begin." prompt, instead of each panel
         repeating its own "no node selected" message. -->
    <template v-if="store.nodes.length">
      <hr />
      <h2 class="h6 d-flex align-items-center gap-2">
        <SlidersHorizontal :size="16" /> {{ t('modePanels.sections.node') }}
      </h2>
      <Transmitter />
    </template>
  </div>

  <div v-show="store.activeMode === 'radio'" class="mode-pane">
    <h2 class="h6 d-flex align-items-center gap-2"><Trees :size="16" /> {{ t('modePanels.sections.environment') }}</h2>
    <Environment />
    <hr />
    <h2 class="h6 d-flex align-items-center gap-2"><Radio :size="16" /> {{ t('modePanels.sections.loraPreset') }}</h2>
    <LoRaPreset />
    <hr />
    <h2 class="h6 d-flex align-items-center gap-2"><Cpu :size="16" /> {{ t('modePanels.sections.simulation') }}</h2>
    <Simulation />
  </div>

  <div v-show="store.activeMode === 'coverage'" class="mode-pane">
    <h2 class="h6 d-flex align-items-center gap-2"><Palette :size="16" /> {{ t('modePanels.sections.display') }}</h2>
    <Display />
    <hr />
    <h2 class="h6 d-flex align-items-center gap-2"><Ear :size="16" /> {{ t('modePanels.sections.listener') }}</h2>
    <Listener />
    <div class="mt-3 d-flex gap-2">
      <button
        :disabled="store.simulationState === 'running' || !store.selectedNode"
        @click="store.runSimulation()"
        type="button"
        class="btn btn-primary btn-sm w-100"
        id="runSimulation"
      >
        <span
          :class="{ 'd-none': store.simulationState !== 'running' }"
          class="spinner-border spinner-border-sm"
          role="status"
          aria-hidden="true"
        ></span>
        <span class="button-text">{{ buttonText }}</span>
      </button>
    </div>
    <!-- Detailed coverage progress now rides the global SimLoadingBar (bottom of the map), so it
         stays visible from any tab / the C shortcut; the button spinner above is the in-panel cue. -->
  </div>

  <div v-show="store.activeMode === 'viewshed'" class="mode-pane">
    <Viewshed />
  </div>

  <div v-show="store.activeMode === 'linkfinder'" class="mode-pane">
    <h2 class="h6 d-flex align-items-center gap-2"><Network :size="16" /> {{ t('modePanels.sections.linkMatrix') }}</h2>
    <LinkMatrix />
    <hr />
    <h2 class="h6 d-flex align-items-center gap-2">
      <MapPinPlus :size="16" /> {{ t('modePanels.sections.relayFinder') }}
    </h2>
    <RelayFinder />
  </div>

  <div v-show="store.activeMode === 'import'" class="mode-pane">
    <!-- These importers are MeshCore-specific: a MeshCore contacts export, or live nodes from the
         MeshCore public maps. Spelled out here so users don't expect other mesh networks. -->
    <p class="small text-secondary mb-3" v-html="t('modePanels.importIntro')"></p>
    <ContactImport />
    <hr />
    <PublicMapSync />
  </div>

  <div v-show="store.activeMode === 'settings'" class="mode-pane">
    <Terrain />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import NodePanel from './NodePanel.vue';
import LinkMatrix from './LinkMatrix.vue';
import RelayFinder from './RelayFinder.vue';
import Transmitter from './Transmitter.vue';
import Environment from './Environment.vue';
import LoRaPreset from './LoRaPreset.vue';
import Simulation from './Simulation.vue';
import Display from './Display.vue';
import Listener from './Listener.vue';
import Viewshed from './Viewshed.vue';
import Terrain from './Terrain.vue';
import ContactImport from './ContactImport.vue';
import PublicMapSync from './PublicMapSync.vue';
import { useStore } from '../store.ts';
import { SlidersHorizontal, Trees, Radio, Cpu, Palette, Ear, Network, MapPinPlus } from '@lucide/vue';

const { t } = useI18n();
const store = useStore();

const { nodeFooter = 'inline' } = defineProps<{ nodeFooter?: 'inline' | 'external' }>();

const buttonText = computed(() => {
  if ('running' === store.simulationState) {
    return t('modePanels.running');
  } else if ('failed' === store.simulationState) {
    return t('modePanels.failed');
  } else {
    return t('modePanels.runSimulation');
  }
});
</script>
