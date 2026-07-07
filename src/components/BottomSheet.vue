<template>
  <div class="sheet-scrim" :class="{ open: modelValue }" @click="close" aria-hidden="true"></div>
  <div
    class="bottom-sheet text-bg-dark"
    :class="{ dragging }"
    :style="sheetStyle"
    :aria-hidden="!modelValue"
    role="dialog"
    :aria-label="title"
    data-bs-theme="dark"
  >
    <div
      class="sheet-handle"
      role="separator"
      aria-label="Drag to resize, or tap the title bar's chevron to close"
      @pointerdown="onPointerDown"
    ></div>
    <div class="sheet-title-row">
      <span class="sheet-title">{{ title }}</span>
      <button type="button" class="sheet-close-hint" @click="close">
        swipe down / tap map to close
        <ChevronDown :size="14" />
      </button>
    </div>
    <div class="sheet-body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="sheet-footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
// Drag/detent logic uses native Pointer Events (no gesture library in this project) — they unify
// mouse/touch/pen, and pointer capture keeps delivering move/up events to the handle even once the
// finger leaves its bounds. The sheet is a fixed-height box (tall enough for the tallest allowed
// detent) that's mostly translated below the viewport when closed/peeking; revealing more of it is
// just animating that translateY, which doubles as the open/close slide animation — no separate
// enter/leave transition needed.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ChevronDown } from '@lucide/vue'

type Detent = 'peek' | 'half' | 'full'
// Fraction of viewport height visible at each detent.
const DETENT_FRACTIONS: Record<Detent, number> = { peek: 0.3, half: 0.55, full: 0.92 }
const VELOCITY_CLOSE_THRESHOLD = 0.5 // px/ms, fast enough to jump a detent (or close) on release

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    detent: Detent
    detents?: Detent[]
  }>(),
  { detents: () => ['peek', 'half', 'full'] }
)
const emit = defineEmits<{ 'update:modelValue': [boolean]; 'update:detent': [Detent] }>()

const viewportH = ref(window.innerHeight)
function onResize() {
  viewportH.value = window.innerHeight
}
onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))

const heightsPx = computed(() => {
  const vh = viewportH.value
  return {
    peek: DETENT_FRACTIONS.peek * vh,
    half: DETENT_FRACTIONS.half * vh,
    full: DETENT_FRACTIONS.full * vh,
  }
})
// The box's own (fixed) height: tall enough for the tallest detent this sheet allows.
const containerHeightPx = computed(() => Math.max(...props.detents.map((d) => heightsPx.value[d])))
function translateForDetent(d: Detent) {
  return containerHeightPx.value - heightsPx.value[d]
}

const currentDetent = ref<Detent>(props.detent)
watch(() => props.detent, (d) => { currentDetent.value = d })
const settledTranslate = computed(() =>
  props.modelValue ? translateForDetent(currentDetent.value) : containerHeightPx.value
)

const dragging = ref(false)
const dragTranslate = ref<number | null>(null)
const translate = computed(() =>
  dragging.value && dragTranslate.value !== null ? dragTranslate.value : settledTranslate.value
)
const sheetStyle = computed(() => ({
  height: `${containerHeightPx.value}px`,
  transform: `translateY(${translate.value}px)`,
}))

let startClientY = 0
let startTranslate = 0
let lastClientY = 0
let lastT = 0
let velocity = 0

function onPointerDown(e: PointerEvent) {
  dragging.value = true
  startClientY = e.clientY
  lastClientY = e.clientY
  lastT = performance.now()
  velocity = 0
  startTranslate = settledTranslate.value
  dragTranslate.value = startTranslate
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  handle.addEventListener('pointermove', onPointerMove)
  handle.addEventListener('pointerup', onPointerUp)
  handle.addEventListener('pointercancel', onPointerUp)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) {
    return
  }
  const delta = e.clientY - startClientY
  dragTranslate.value = Math.min(containerHeightPx.value, Math.max(0, startTranslate + delta))
  const now = performance.now()
  const dt = now - lastT
  if (dt > 0) {
    velocity = (e.clientY - lastClientY) / dt
  }
  lastClientY = e.clientY
  lastT = now
}
function onPointerUp(e: PointerEvent) {
  if (!dragging.value) {
    return
  }
  dragging.value = false
  const handle = e.currentTarget as HTMLElement
  handle.removeEventListener('pointermove', onPointerMove)
  handle.removeEventListener('pointerup', onPointerUp)
  handle.removeEventListener('pointercancel', onPointerUp)
  const release = dragTranslate.value ?? settledTranslate.value
  dragTranslate.value = null
  snapTo(release, velocity)
}

function snapTo(release: number, vel: number) {
  const points = props.detents
    .map((id) => ({ id: id as Detent | 'closed', t: translateForDetent(id) }))
    .concat([{ id: 'closed', t: containerHeightPx.value }])
    .sort((a, b) => a.t - b.t)

  let chosen: (typeof points)[number]
  if (Math.abs(vel) > VELOCITY_CLOSE_THRESHOLD) {
    if (vel > 0) {
      chosen = points.find((p) => p.t > release + 1) ?? points[points.length - 1]
    } else {
      const candidates = points.filter((p) => p.t < release - 1)
      chosen = candidates.length ? candidates[candidates.length - 1] : points[0]
    }
  } else {
    chosen = points.reduce((best, p) => (Math.abs(p.t - release) < Math.abs(best.t - release) ? p : best), points[0])
  }

  if (chosen.id === 'closed') {
    emit('update:modelValue', false)
  } else {
    currentDetent.value = chosen.id
    emit('update:detent', chosen.id)
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>
