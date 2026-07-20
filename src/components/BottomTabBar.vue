<template>
  <nav class="bottom-tab-bar" :aria-label="t('bottomTabBar.mode')">
    <button
      v-for="tab in TABS"
      :key="tab.id"
      type="button"
      class="tab"
      :class="{ active: openMode === tab.id }"
      :aria-pressed="openMode === tab.id"
      @click="emit('tap', tab.id)"
    >
      <component :is="tab.icon" :size="20" />
      <span>{{ t(tab.labelKey) }}</span>
    </button>
    <button type="button" class="tab" @click="emit('toggleMore')">
      <MoreHorizontal :size="20" />
      <span>{{ t('bottomTabBar.more') }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RadioTower, Map as MapIcon, Link, MoreHorizontal } from '@lucide/vue';
import type { UiMode } from '../types.ts';

const { t } = useI18n();

// Subset of App.vue's MODES — only the modes that get their own bottom tab. The remaining modes
// (Simulation Settings, Settings, Import, Viewshed) live behind "More" — see App.vue's overflow sheet.
const TABS = [
  { id: 'nodes' as UiMode, labelKey: 'app.modes.nodes', icon: RadioTower },
  { id: 'coverage' as UiMode, labelKey: 'app.modes.coverage', icon: MapIcon },
  { id: 'linkfinder' as UiMode, labelKey: 'app.modes.linkfinder', icon: Link },
];

defineProps<{ openMode: UiMode | null }>();
const emit = defineEmits<{ tap: [mode: UiMode]; toggleMore: [] }>();
</script>
