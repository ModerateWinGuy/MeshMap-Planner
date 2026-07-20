<template>
  <button
    type="button"
    @click.stop="share(payload)"
    :class="[baseClass, { 'text-success': copied && !text }]"
    :aria-label="displayLabel"
    :title="copied ? t('common.linkCopied') : displayTitle"
  >
    <Check v-if="copied" :size="size" />
    <Share2 v-else :size="size" />
    <span v-if="text">{{ copied ? t('common.copied') : text }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Share2, Check } from '@lucide/vue';
import { useShareLink } from '../shareLink.ts';
import type { SharePayload } from '../utils.ts';

const { t } = useI18n();

// payload may be a value or a builder evaluated at click time (so it reads the current coords/nodes);
// a builder returning null cancels the copy. With `text`, the button renders a label (and a Bootstrap
// variant the caller passes via class); without it, it's an icon-only borderless button.
const props = withDefaults(
  defineProps<{
    payload: SharePayload | (() => SharePayload | null);
    title?: string;
    label?: string;
    size?: number;
    text?: string;
  }>(),
  {
    size: 16,
  },
);

const { copied, share } = useShareLink();

const baseClass = computed(() =>
  props.text ? 'btn btn-sm d-inline-flex align-items-center gap-1' : 'btn btn-sm p-0 border-0 bg-transparent lh-1',
);
// Fall back to a translated default when the caller doesn't pass its own title/label, so the
// fallback stays reactive to locale switches (a static prop default would not).
const displayTitle = computed(() => props.title ?? t('common.copyShareLink'));
const displayLabel = computed(() => props.label ?? t('common.copyShareLink'));
</script>
