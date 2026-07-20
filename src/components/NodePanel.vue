<template>
  <div>
    <template v-if="store.nodes.length || store.groups.length">
      <div v-if="store.nodes.length > 1" class="d-flex justify-content-end gap-2 mb-2">
        <button
          type="button"
          @click="store.setAllNodesHidden(false)"
          :disabled="!anyHidden"
          class="btn btn-outline-secondary btn-sm py-0 px-1 d-flex align-items-center gap-1"
          :title="t('nodePanel.showAllNodes')"
        >
          <Eye :size="14" /> {{ t('nodePanel.showAll') }}
        </button>
        <button
          type="button"
          @click="store.setAllNodesHidden(true)"
          :disabled="!anyVisible"
          class="btn btn-outline-secondary btn-sm py-0 px-1 d-flex align-items-center gap-1"
          :title="t('nodePanel.hideAllNodes')"
        >
          <EyeOff :size="14" /> {{ t('nodePanel.hideAll') }}
        </button>
      </div>

      <!-- Folders. Order = store.groups order; each is a drop target for nodes (drop into) and,
                 while dragging a folder, for reordering (insert before). -->
      <div
        v-for="group in store.groups"
        :key="group.id"
        class="node-folder mb-2"
        :class="{ 'drop-before-group': isOver({ kind: 'before-group', id: group.id }) }"
      >
        <div
          class="folder-header d-flex align-items-center gap-1 px-2 py-1 rounded"
          :class="{
            'drop-into': isOver({ kind: 'into-group', id: group.id }),
            dragging: isGroupDragSource(group.id),
          }"
          :draggable="editingGroupId !== group.id"
          @click="store.toggleGroupCollapsed(group.id)"
          @dragstart="onGroupDragStart($event, group.id)"
          @dragend="endDrag"
          @dragover="onFolderDragOver($event, group.id)"
          @drop="onFolderDrop($event, group.id)"
        >
          <component :is="group.collapsed ? ChevronRight : ChevronDown" :size="16" class="flex-shrink-0" />
          <Folder :size="15" class="flex-shrink-0 text-secondary" />
          <input
            v-if="editingGroupId === group.id"
            :id="'grp-input-' + group.id"
            v-model="editName"
            type="text"
            class="form-control form-control-sm py-0 flex-grow-1"
            @click.stop
            @keyup.enter="commitRename"
            @keyup.esc="cancelRename"
            @blur="commitRename"
          />
          <template v-else>
            <span class="flex-grow-1 text-truncate fw-medium" @dblclick.stop="startRename(group)">{{
              group.name
            }}</span>
            <span class="badge bg-secondary-subtle text-secondary-emphasis rounded-pill flex-shrink-0">{{
              nodesInGroup(group.id).length
            }}</span>
          </template>
          <span class="d-flex align-items-center gap-2 flex-shrink-0 ms-1">
            <button
              type="button"
              @click.stop="store.toggleGroupVisibility(group.id)"
              class="btn btn-sm p-0 border-0 bg-transparent lh-1"
              :aria-label="group.hidden ? t('nodePanel.showFolder') : t('nodePanel.hideFolder')"
              :title="group.hidden ? t('nodePanel.showFolderNodes') : t('nodePanel.hideFolderNodes')"
            >
              <EyeOff v-if="group.hidden" :size="16" /><Eye v-else :size="16" />
            </button>
            <ShareButton
              v-if="nodesInGroup(group.id).length"
              :payload="() => folderSharePayload(group)"
              :title="t('nodePanel.shareFolderTitle')"
              :label="t('nodePanel.shareFolderLabel', { name: group.name })"
              :size="15"
            />
            <input
              type="color"
              class="folder-color-swatch"
              :value="group.color ?? DEFAULT_PIN_COLOR"
              @click.stop
              @input="store.setGroupColor(group.id, ($event.target as HTMLInputElement).value)"
              :aria-label="t('nodePanel.setFolderColor')"
              :title="t('nodePanel.colorFolderNodes')"
            />
            <button
              type="button"
              @click.stop="startRename(group)"
              class="btn btn-sm p-0 border-0 bg-transparent lh-1"
              :aria-label="t('nodePanel.renameFolder')"
              :title="t('nodePanel.renameFolder')"
            >
              <Pencil :size="15" />
            </button>
            <button
              type="button"
              @click.stop="store.deleteGroup(group.id)"
              class="btn btn-sm p-0 border-0 bg-transparent lh-1"
              :aria-label="t('nodePanel.deleteFolder')"
              :title="t('nodePanel.deleteFolderTitle')"
            >
              <Trash2 :size="15" />
            </button>
          </span>
        </div>
        <ul
          v-show="!group.collapsed"
          class="list-group folder-body mt-1"
          :class="{ 'drop-into': isOver({ kind: 'into-group', id: group.id }) }"
          @dragover="onFolderDragOver($event, group.id)"
          @drop="onFolderDrop($event, group.id)"
        >
          <NodeRow v-for="node in nodesInGroup(group.id)" :key="node.id" :node="node" />
          <li v-if="!nodesInGroup(group.id).length" class="list-group-item text-muted small fst-italic empty-folder">
            {{ t('nodePanel.dragNodesHere') }}
          </li>
        </ul>
      </div>

      <!-- Drop a dragged folder past the last one to send it to the bottom. -->
      <div
        v-if="dragKind === 'group'"
        class="groups-end-zone rounded mb-2"
        :class="{ 'drop-into': isOver({ kind: 'groups-end' }) }"
        @dragover="onGroupsEndDragOver"
        @drop="onGroupsEndDrop"
      >
        {{ t('nodePanel.moveToBottom') }}
      </div>

      <!-- Ungrouped (top-level) nodes. With no folders this is just the flat list; once folders
                 exist it gets a header so a node can be dragged back out here to ungroup it. -->
      <div v-if="hasGroups" class="ungrouped-header text-muted small text-uppercase fw-semibold px-1 mb-1 mt-2">
        {{ t('nodePanel.ungrouped') }}
      </div>
      <ul
        class="list-group ungrouped"
        :class="{
          'drop-zone-active': hasGroups && dragKind === 'node',
          'drop-into': isOver({ kind: 'ungrouped' }),
        }"
        @dragover="onUngroupedDragOver"
        @drop="onUngroupedDrop"
      >
        <NodeRow v-for="node in ungroupedNodes" :key="node.id" :node="node" />
      </ul>
    </template>
    <p v-else class="text-muted medium centered mb-0">{{ t('nodePanel.addNodeToBegin') }}</p>

    <!-- Hidden when a parent renders NodePanelFooter itself (e.g. pinned to a phone bottom-sheet's
             sticky footer instead of scrolling with the rest of this panel). -->
    <div v-if="!hideFooter" class="d-flex gap-2 mb-2 mt-3">
      <button
        @click="store.addNode()"
        type="button"
        class="btn btn-success btn-sm w-100 d-flex align-items-center justify-content-center gap-1"
      >
        <Plus :size="16" /> {{ t('nodePanel.addNode') }}
      </button>
      <button
        @click="addFolder"
        type="button"
        class="btn btn-outline-secondary btn-sm w-100 d-flex align-items-center justify-content-center gap-1"
      >
        <FolderPlus :size="16" /> {{ t('nodePanel.addFolder') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { DEFAULT_PIN_COLOR } from '../layers.ts';
import type { NodeGroup } from '../types.ts';
import { nodeToShared, type SharePayload } from '../utils.ts';
import NodeRow from './NodeRow.vue';
import ShareButton from './ShareButton.vue';
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, FolderPlus, Pencil, Plus, Trash2 } from '@lucide/vue';
import { dragKind, dragId, startDrag, endDrag, isOver, dropTarget } from './nodeDnd.ts';

const { t } = useI18n();
const store = useStore();

defineProps<{ hideFooter?: boolean }>();

// Share link for one folder: its nodes, tagged with the folder name so the recipient gets them
// grouped under a folder of the same name. Null (button hidden) when the folder is empty.
function folderSharePayload(group: NodeGroup): SharePayload | null {
  const nodes = nodesInGroup(group.id);
  if (!nodes.length) {
    return null;
  }
  return { v: 1, t: 'nodes', g: group.name, n: nodes.map(nodeToShared) };
}

// Drive the bulk buttons off *effective* visibility (a node hidden by its folder counts as hidden).
const anyHidden = computed(() => store.nodes.some((n) => store.nodeHidden(n)));
const anyVisible = computed(() => store.nodes.some((n) => !store.nodeHidden(n)));

const hasGroups = computed(() => store.groups.length > 0);
const groupIds = computed(() => new Set(store.groups.map((g) => g.id)));

// Members of a folder, in `nodes`-array order. Nodes whose groupId points at a deleted folder are
// treated as ungrouped, not lost.
function nodesInGroup(id: string) {
  return store.nodes.filter((n) => n.groupId === id);
}
const ungroupedNodes = computed(() => store.nodes.filter((n) => !n.groupId || !groupIds.value.has(n.groupId)));

const editingGroupId = ref<string | null>(null);
const editName = ref('');

function startRename(group: NodeGroup) {
  editingGroupId.value = group.id;
  editName.value = group.name;
  nextTick(() => {
    const el = document.getElementById('grp-input-' + group.id) as HTMLInputElement | null;
    el?.focus();
    el?.select();
  });
}
function commitRename() {
  if (!editingGroupId.value) {
    return; // already committed/cancelled (blur can fire after enter)
  }
  const name = editName.value.trim();
  if (name) {
    store.renameGroup(editingGroupId.value, name);
  }
  editingGroupId.value = null;
}
function cancelRename() {
  editingGroupId.value = null;
}
function addFolder() {
  const id = store.addGroup();
  startRename({ id, name: t('nodePanel.newFolderName') } as NodeGroup); // drop straight into renaming the new folder
}

function isGroupDragSource(id: string) {
  return dragKind.value === 'group' && dragId.value === id;
}

function onGroupDragStart(e: DragEvent, id: string) {
  startDrag('group', id);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
}

// A folder header accepts a node (drop into the folder) or another folder (insert before it).
function onFolderDragOver(e: DragEvent, id: string) {
  if (dragKind.value === 'node') {
    e.preventDefault();
    dropTarget.value = { kind: 'into-group', id };
  } else if (dragKind.value === 'group' && dragId.value !== id) {
    e.preventDefault();
    dropTarget.value = { kind: 'before-group', id };
  } else {
    return;
  }
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}
function onFolderDrop(e: DragEvent, id: string) {
  e.preventDefault();
  if (dragKind.value === 'node' && dragId.value) {
    store.moveNodeToGroup(dragId.value, id, null); // append into this folder
  } else if (dragKind.value === 'group' && dragId.value) {
    store.moveGroup(dragId.value, id); // insert this folder before the dropped-on one
  }
  endDrag();
}

function onGroupsEndDragOver(e: DragEvent) {
  if (dragKind.value !== 'group') {
    return;
  }
  e.preventDefault();
  dropTarget.value = { kind: 'groups-end' };
}
function onGroupsEndDrop(e: DragEvent) {
  if (dragKind.value !== 'group' || !dragId.value) {
    return;
  }
  e.preventDefault();
  store.moveGroup(dragId.value, null); // null = append to the end
  endDrag();
}

// The ungrouped container: dropping a node here (in the empty space below the rows) sends it to the
// top level. Drops landing on a specific NodeRow are handled by that row (it stops propagation).
function onUngroupedDragOver(e: DragEvent) {
  if (dragKind.value !== 'node') {
    return;
  }
  e.preventDefault();
  dropTarget.value = { kind: 'ungrouped' };
}
function onUngroupedDrop(e: DragEvent) {
  if (dragKind.value !== 'node' || !dragId.value) {
    return;
  }
  e.preventDefault();
  store.moveNodeToGroup(dragId.value, null, null);
  endDrag();
}
</script>

<style scoped>
.folder-header {
  cursor: pointer;
  background: var(--bs-tertiary-bg);
  border: 1px solid var(--bs-border-color);
}
.folder-header.dragging {
  opacity: 0.45;
}
/* A node hovering over a folder, or a node about to be dropped into the ungrouped zone. */
.drop-into {
  outline: 2px dashed var(--bs-primary);
  outline-offset: -2px;
}
/* Insertion line above a folder when reordering folders. */
.node-folder.drop-before-group {
  box-shadow: inset 0 2px 0 0 var(--bs-primary);
}
.empty-folder {
  cursor: default;
}
/* Strip the native colour input's chrome down to a small round swatch matching the icon buttons. */
.folder-color-swatch {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--bs-border-color);
  border-radius: 50%;
  background: none;
  cursor: pointer;
}
.folder-color-swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}
.folder-color-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}
.folder-color-swatch::-moz-color-swatch {
  border: none;
  border-radius: 50%;
}
/* While dragging a node, give the ungrouped list a visible target even when it's empty, so a node
   can be dragged out of a folder. */
.ungrouped.drop-zone-active {
  min-height: 2.25rem;
  border: 1px dashed var(--bs-border-color);
  border-radius: var(--bs-border-radius);
}
.groups-end-zone {
  padding: 0.4rem 0.5rem;
  font-size: 0.8rem;
  color: var(--bs-secondary-color);
  text-align: center;
  border: 1px dashed var(--bs-border-color);
}
</style>
