<template>
  <nav class="bottom-tab-bar" aria-label="Mode">
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
      <span>{{ tab.label }}</span>
    </button>
    <button type="button" class="tab" @click="emit('toggleMore')">
      <MoreHorizontal :size="20" />
      <span>More</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { RadioTower, Map as MapIcon, Link, MoreHorizontal } from '@lucide/vue';
import type { UiMode } from '../types.ts';

// Subset of App.vue's MODES — only the modes that get their own bottom tab. The remaining modes
// (Simulation Settings, Settings, Import, Viewshed) live behind "More" — see App.vue's overflow sheet.
const TABS = [
  { id: 'nodes' as UiMode, label: 'Nodes', icon: RadioTower },
  { id: 'coverage' as UiMode, label: 'Coverage', icon: MapIcon },
  { id: 'linkfinder' as UiMode, label: 'Links', icon: Link },
];

defineProps<{ openMode: UiMode | null }>();
const emit = defineEmits<{ tap: [mode: UiMode]; toggleMore: [] }>();
</script>
