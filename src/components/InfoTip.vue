<template>
  <span class="info-tip">
    <button ref="trigger" type="button" class="info-tip-btn" :aria-label="t('common.moreInformation')">
      <Info :size="size" :stroke-width="2.25" aria-hidden="true" />
    </button>
    <span ref="source" class="d-none"><slot /></span>
  </span>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Info } from '@lucide/vue';
import { Popover } from 'bootstrap';
import { useStore } from '../store.ts';

withDefaults(defineProps<{ size?: number }>(), { size: 15 });

const { t } = useI18n();
const store = useStore();
const trigger = ref<HTMLButtonElement | null>(null);
const source = ref<HTMLElement | null>(null);
let popover: Popover | null = null;

function createPopover() {
  if (!trigger.value || !source.value) return;
  // Snapshot the slot's rendered markup (callers pass rich help text — <strong>, coloured spans) and
  // hand it to a Bootstrap popover. container:'body' keeps the sidebar's overflow:hidden from clipping
  // it; that puts it outside the dark-theme scope, but the light popover stays readable. The snapshot
  // is taken once per locale (see the watch below), so only pass static help text here — other
  // reactive values still won't update.
  popover = new Popover(trigger.value, {
    html: true,
    content: source.value.innerHTML,
    trigger: 'hover focus',
    placement: 'left',
    container: 'body',
    customClass: 'info-tip-popover',
    fallbackPlacements: ['left', 'top', 'bottom'],
  });
}

onMounted(createPopover);

// Every settings panel using InfoTip is v-show-toggled (mounted once, kept alive for the app's
// life), so the slot's translated text only re-renders on a locale switch if we rebuild the
// popover — otherwise it'd silently keep showing its mount-time-language text forever.
watch(
  () => store.locale,
  async () => {
    popover?.dispose();
    popover = null;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the slot's text re-render first
    createPopover();
  },
);

onBeforeUnmount(() => {
  // Dispose so the body-appended popover element doesn't leak when the panel unmounts/HMR-reloads.
  popover?.dispose();
  popover = null;
});
</script>
