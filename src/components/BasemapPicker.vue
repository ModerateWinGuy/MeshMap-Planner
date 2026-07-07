<template>
  <div class="btn-group-vertical shadow w-100" role="group" aria-label="Basemap">
    <button
      v-for="b in store.availableBasemaps"
      :key="b.id"
      type="button"
      class="btn btn-sm text-start"
      :class="store.activeBasemap === b.id ? 'btn-primary' : 'btn-light'"
      @click="store.setBasemap(b.id)"
    >
      {{ b.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts';
const store = useStore();
</script>
