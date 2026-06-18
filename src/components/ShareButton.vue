<template>
  <button
    type="button"
    @click.stop="onShare"
    :class="[baseClass, { 'text-success': copied && !text }]"
    :aria-label="label"
    :title="copied ? 'Link copied!' : title"
  >
    <Check v-if="copied" :size="size" />
    <Share2 v-else :size="size" />
    <span v-if="text">{{ copied ? 'Copied!' : text }}</span>
  </button>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { Share2, Check } from '@lucide/vue'
import { buildShareUrl, type SharePayload } from '../utils.ts'

// payload may be a value or a builder evaluated at click time (so it reads the current coords/nodes);
// a builder returning null cancels the copy. With `text`, the button renders a label (and a Bootstrap
// variant the caller passes via class); without it, it's an icon-only borderless button.
const props = withDefaults(
  defineProps<{
    payload: SharePayload | (() => SharePayload | null)
    title?: string
    label?: string
    size?: number
    text?: string
  }>(),
  {
    title: 'Copy share link',
    label: 'Copy share link',
    size: 16,
  }
)

const baseClass = computed(() =>
  props.text
    ? 'btn btn-sm d-inline-flex align-items-center gap-1'
    : 'btn btn-sm p-0 border-0 bg-transparent lh-1'
)

const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | null = null

async function onShare() {
  const payload = typeof props.payload === 'function' ? props.payload() : props.payload
  if (!payload) {
    return
  }
  await copyText(buildShareUrl(payload))
  copied.value = true
  if (resetTimer) {
    clearTimeout(resetTimer)
  }
  resetTimer = setTimeout(() => {
    copied.value = false
  }, 1500)
}

// navigator.clipboard needs a secure context (https / localhost — both hold for this app); fall back
// to a hidden textarea + execCommand, then a prompt, so a copy still works in odd contexts.
async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    prompt('Copy this share link:', text)
  }
}

onBeforeUnmount(() => {
  if (resetTimer) {
    clearTimeout(resetTimer)
  }
})
</script>
