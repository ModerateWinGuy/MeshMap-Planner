<template>
  <div class="d-flex gap-2 mb-2 mt-3">
    <button
      @click="store.addNode()"
      type="button"
      class="btn btn-success btn-sm w-100 d-flex align-items-center justify-content-center gap-1"
    >
      <Plus :size="16" /> Add node
    </button>
    <button
      @click="store.addGroup()"
      type="button"
      class="btn btn-outline-secondary btn-sm w-100 d-flex align-items-center justify-content-center gap-1"
    >
      <FolderPlus :size="16" /> Add folder
    </button>
  </div>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts';
import { FolderPlus, Plus } from '@lucide/vue';

const store = useStore();
</script>
