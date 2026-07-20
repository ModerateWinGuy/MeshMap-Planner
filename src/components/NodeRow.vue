<template>
  <li
    :key="node.id"
    @click="store.selectNode(node.id)"
    class="list-group-item list-group-item-action d-flex justify-content-between align-items-center node-row"
    :class="{
      active: node.id === store.selectedNode?.id,
      dragging: isDragSource,
      'drop-before': showDropLine,
    }"
    role="button"
    draggable="true"
    @dragstart="onDragStart"
    @dragend="endDrag"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <span class="d-flex align-items-center gap-1 text-truncate">
      <GripVertical :size="14" class="grip flex-shrink-0" />
      <span
        class="text-truncate"
        :class="{ 'text-muted fst-italic': effectiveHidden }"
        :title="t('nodeRow.centerMapTitle')"
        @dblclick.stop="centerMapOnNode"
        >{{ node.transmitter.name }}</span
      >
    </span>
    <span class="d-flex align-items-center gap-2 flex-shrink-0">
      <button
        type="button"
        @click.stop="store.toggleNodeVisibility(node.id)"
        class="btn btn-sm p-0 border-0 bg-transparent lh-1"
        :aria-label="node.hidden ? t('nodeRow.showNode') : t('nodeRow.hideNode')"
        :title="
          inHiddenFolder
            ? t('nodeRow.folderHiddenTitle')
            : node.hidden
              ? t('nodeRow.showOnMap')
              : t('nodeRow.hideFromMap')
        "
      >
        <EyeOff v-if="node.hidden" :size="16" /><Eye v-else :size="16" />
      </button>
      <button
        type="button"
        @click.stop="store.deleteNode(node.id)"
        class="btn btn-sm p-0 border-0 bg-transparent lh-1"
        :aria-label="t('nodeRow.deleteNode')"
        :title="t('nodeRow.deleteNode')"
      >
        <X :size="16" />
      </button>
    </span>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import type { Node } from '../types.ts';
import { Eye, EyeOff, GripVertical, X } from '@lucide/vue';
import { dragKind, dragId, startDrag, endDrag, isOver, dropTarget } from './nodeDnd.ts';

const props = defineProps<{ node: Node }>();
const { t } = useI18n();
const store = useStore();

// Effective visibility drives the dimming; the eye icon below reflects only the node's OWN flag
// (that's what its button toggles). A node can look dimmed yet show an open eye when its folder is
// what's hiding it — the tooltip explains that case.
const effectiveHidden = computed(() => store.nodeHidden(props.node));
const inHiddenFolder = computed(() => effectiveHidden.value && !props.node.hidden);

const isDragSource = computed(() => dragKind.value === 'node' && dragId.value === props.node.id);
// Show the insertion line above this row only while dragging a *different* node onto it.
const showDropLine = computed(() => isOver({ kind: 'before-node', id: props.node.id }));

function onDragStart(e: DragEvent) {
  startDrag('node', props.node.id);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', props.node.id); // Firefox won't start a drag without data
  }
}

function onDragOver(e: DragEvent) {
  // Only nodes drop onto a node row, and never onto itself.
  if (dragKind.value !== 'node' || dragId.value === props.node.id) {
    return;
  }
  e.preventDefault(); // allow the drop
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
  dropTarget.value = { kind: 'before-node', id: props.node.id };
}

function centerMapOnNode() {
  const tx = props.node.transmitter;
  if (store.map && !isNaN(tx.tx_lat) && !isNaN(tx.tx_lon)) {
    store.map.flyTo({ center: [tx.tx_lon, tx.tx_lat] }); // [lng, lat]; keeps current zoom
  }
}

function onDrop(e: DragEvent) {
  if (dragKind.value !== 'node' || !dragId.value || dragId.value === props.node.id) {
    return;
  }
  e.preventDefault();
  e.stopPropagation(); // don't also bubble to the folder/ungrouped container drop
  // Insert before this row and adopt its folder, so a drag both reorders and regroups.
  store.moveNodeToGroup(dragId.value, props.node.groupId ?? null, props.node.id);
  endDrag();
}
</script>

<style scoped>
.node-row {
  cursor: grab;
}
.node-row.dragging {
  opacity: 0.45;
}
.node-row .grip {
  opacity: 0.35;
}
/* Insertion indicator: a coloured line at the top edge where the dragged node will land. */
.node-row.drop-before {
  box-shadow: inset 0 2px 0 0 var(--bs-primary);
}
</style>
