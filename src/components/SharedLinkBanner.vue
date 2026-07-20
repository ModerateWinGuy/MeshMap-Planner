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
        {{ share.t === 'link' ? t('sharedLinkBanner.addAndShowLink') : t('sharedLinkBanner.addToMap') }}
      </button>
      <button type="button" class="btn btn-sm btn-outline-light" @click="store.dismissIncomingShare()">
        {{ t('common.dismiss') }}
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Share2 } from '@lucide/vue';
import { useStore } from '../store.ts';

const { t } = useI18n();
const store = useStore();
const share = computed(() => store.incomingShare);

const message = computed(() => {
  const s = share.value;
  if (!s) {
    return '';
  }
  if (s.t === 'link' && s.n.length >= 2) {
    return t('sharedLinkBanner.linkMessage', { a: s.n[0].name, b: s.n[1].name });
  }
  const count = s.n.length;
  if (s.g) {
    return count === 1
      ? t('sharedLinkBanner.folderMessageOne', { folder: s.g })
      : t('sharedLinkBanner.folderMessageMany', { folder: s.g, count });
  }
  if (count === 1) {
    return t('sharedLinkBanner.nodeMessageOne', { name: s.n[0].name });
  }
  return t('sharedLinkBanner.nodesMessage', { count });
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
