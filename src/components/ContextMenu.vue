<template>
  <!-- absolute within .map-col; positioned at the click point, clamped on mount to stay on-screen. -->
  <ul
    v-if="menu"
    ref="menuRef"
    class="dropdown-menu show context-menu shadow"
    data-bs-theme="dark"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
  >
    <template v-if="menu.nodeId">
      <li><button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="deleteNode">
        <Trash2 :size="14" /> Delete node
      </button></li>
      <li><button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareNode">
        <Check v-if="copied" :size="14" /><Share2 v-else :size="14" /> {{ copied ? 'Copied!' : 'Share node' }}
      </button></li>
    </template>
    <template v-else>
      <li><button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="addNodeHere">
        <Plus :size="14" /> Add node here
      </button></li>
      <li><button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="copyCoordinates">
        <Check v-if="copiedCoords" :size="14" /><Copy v-else :size="14" /> {{ copiedCoords ? 'Copied!' : 'Copy coordinates' }}
      </button></li>
    </template>
  </ul>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Trash2, Share2, Plus, Copy, Check } from '@lucide/vue'
import { useStore } from '../store.ts'
import { useShareLink, copyText } from '../shareLink.ts'
import { nodeToShared, type SharePayload } from '../utils.ts'
import { trackEvent } from '../analytics.ts'

const CONFIRM_CLOSE_MS = 800

const store = useStore()
const { copied, share } = useShareLink()
const copiedCoords = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

const menu = computed(() => store.contextMenu)

// Clamp after render (once the menu's real size is known) so it never hangs off the map edge.
watch(menu, async (m) => {
  if (!m) {
    return
  }
  pos.value = { x: m.x, y: m.y }
  await nextTick()
  const el = menuRef.value
  const container = el?.offsetParent as HTMLElement | null
  if (!el || !container) {
    return
  }
  pos.value = {
    x: Math.max(0, Math.min(m.x, container.clientWidth - el.offsetWidth)),
    y: Math.max(0, Math.min(m.y, container.clientHeight - el.offsetHeight)),
  }
}, { immediate: true })

function deleteNode() {
  if (menu.value?.nodeId) {
    store.deleteNode(menu.value.nodeId)
  }
  store.closeContextMenu()
}

async function shareNode() {
  const node = store.nodes.find((n) => n.id === menu.value?.nodeId)
  if (node) {
    trackEvent('share-node')
    const payload: SharePayload = { v: 1, t: 'nodes', n: [nodeToShared(node)] }
    await share(payload)
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_CLOSE_MS)) // let the "Copied!" flash register
  }
  store.closeContextMenu()
}

function addNodeHere() {
  if (menu.value) {
    store.addNode({ lat: menu.value.lat, lng: menu.value.lng })
  }
  store.closeContextMenu()
}

async function copyCoordinates() {
  if (menu.value) {
    await copyText(`${menu.value.lat.toFixed(6)}, ${menu.value.lng.toFixed(6)}`)
    copiedCoords.value = true
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_CLOSE_MS))
    copiedCoords.value = false
  }
  store.closeContextMenu()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    store.closeContextMenu()
  }
}

function onOutsideClick(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    store.closeContextMenu()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('mousedown', onOutsideClick)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousedown', onOutsideClick)
})
</script>

<style scoped>
.context-menu {
  position: absolute;
  /* Above the phone bottom-sheet/scrim (z-index 1190/1200, see style.css) so a map long-press menu
     isn't trapped beneath an open sheet. */
  z-index: 1250;
  min-width: 180px;
}
</style>
