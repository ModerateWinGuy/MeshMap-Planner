<template>
  <div
    v-if="share"
    class="share-banner alert alert-info d-flex align-items-center justify-content-between gap-3 mb-0"
    data-bs-theme="dark"
    role="alert"
  >
    <span class="small d-flex align-items-center gap-2">
      <Share2 :size="18" class="flex-shrink-0" />
      <span>{{ message }}</span>
    </span>
    <span class="d-flex gap-2 flex-shrink-0">
      <button type="button" class="btn btn-sm btn-success" @click="store.applyIncomingShare()">
        {{ share.t === 'link' ? 'Add & show link' : 'Add to map' }}
      </button>
      <button type="button" class="btn btn-sm btn-outline-light" @click="store.dismissIncomingShare()">Dismiss</button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Share2 } from '@lucide/vue';
import { useStore } from '../store.ts';

const store = useStore();
const share = computed(() => store.incomingShare);

const message = computed(() => {
  const s = share.value;
  if (!s) {
    return '';
  }
  if (s.t === 'link' && s.n.length >= 2) {
    return `Someone shared a link between “${s.n[0].name}” and “${s.n[1].name}”. Add both nodes to your map?`;
  }
  const count = s.n.length;
  if (s.g) {
    return `Someone shared the folder “${s.g}” with ${count} node${count === 1 ? '' : 's'}. Add ${count === 1 ? 'it' : 'them'} to your map?`;
  }
  if (count === 1) {
    return `Someone shared the node “${s.n[0].name}”. Add it to your map?`;
  }
  return `Someone shared ${count} nodes. Add them to your map?`;
});
</script>

<style scoped>
/* Floats below the fixed navbar, centred over the map; high z-index so it clears the map controls. */
.share-banner {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1050;
  width: calc(100% - 2rem);
  max-width: 560px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
</style>
