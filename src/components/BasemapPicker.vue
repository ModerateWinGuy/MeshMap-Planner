<template>
  <div class="btn-group-vertical shadow w-100" role="group" :aria-label="t('mapControls.basemap')">
    <button
      v-for="b in store.availableBasemaps"
      :key="b.id"
      type="button"
      class="btn btn-sm text-start"
      :class="store.activeBasemap === b.id ? 'btn-primary' : 'btn-light'"
      @click="store.setBasemap(b.id)"
    >
      {{ t(b.labelKey) }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
const { t } = useI18n();
const store = useStore();
</script>
