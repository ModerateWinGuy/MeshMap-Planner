<template>
  <span class="info-tip">
    <button ref="trigger" type="button" class="info-tip-btn" aria-label="More information">
      <Info :size="size" :stroke-width="2.25" aria-hidden="true" />
    </button>
    <span ref="source" class="d-none"><slot /></span>
  </span>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Info } from '@lucide/vue';
import { Popover } from 'bootstrap';

withDefaults(defineProps<{ size?: number }>(), { size: 15 });

const trigger = ref<HTMLButtonElement | null>(null);
const source = ref<HTMLElement | null>(null);
let popover: Popover | null = null;

onMounted(() => {
  if (!trigger.value || !source.value) return;
  // Snapshot the slot's rendered markup (callers pass rich help text — <strong>, coloured spans) and
  // hand it to a Bootstrap popover. container:'body' keeps the sidebar's overflow:hidden from clipping
  // it; that puts it outside the dark-theme scope, but the light popover stays readable. The snapshot
  // is taken once, so only pass static help text here — reactive values won't update.
  popover = new Popover(trigger.value, {
    html: true,
    content: source.value.innerHTML,
    trigger: 'hover focus',
    placement: 'left',
    container: 'body',
    customClass: 'info-tip-popover',
    fallbackPlacements: ['left', 'top', 'bottom'],
  });
});

onBeforeUnmount(() => {
  // Dispose so the body-appended popover element doesn't leak when the panel unmounts/HMR-reloads.
  popover?.dispose();
  popover = null;
});
</script>
