// Transient drag-and-drop state for the node-list folder hierarchy, shared between NodePanel (folder
// headers, drop zones) and NodeRow (node rows). Module-level reactive refs rather than store state:
// this is ephemeral UI state for the current gesture, not something to persist or reload.
//
// HTML5 native DnD is used directly (no library): the flat `nodes` array + `groupId` model maps
// cleanly onto a handful of intent calls (store.moveNodeToGroup / store.moveGroup), so a sortable
// library would only fight the model. Each draggable element sets the drag source here on dragstart;
// each drop target sets `dropTarget` on dragover (for the insertion indicator) and resolves the move
// on drop.
import { ref } from 'vue';

// What's being dragged right now, or null when idle.
export type DragKind = 'node' | 'group';
export const dragKind = ref<DragKind | null>(null);
export const dragId = ref<string | null>(null);

// The drop target currently under the pointer, so exactly one insertion/into indicator shows:
//   before-node  — insert the dragged node before this node (adopting its folder)
//   into-group   — drop the dragged node into this folder (append)
//   before-group — insert the dragged folder before this folder
//   ungrouped    — append the dragged node to the top-level (ungrouped) list
//   groups-end   — append the dragged folder after the last folder
export type DropTarget =
  | { kind: 'before-node'; id: string }
  | { kind: 'into-group'; id: string }
  | { kind: 'before-group'; id: string }
  | { kind: 'ungrouped' }
  | { kind: 'groups-end' };

export const dropTarget = ref<DropTarget | null>(null);

export function startDrag(kind: DragKind, id: string) {
  dragKind.value = kind;
  dragId.value = id;
}

export function endDrag() {
  dragKind.value = null;
  dragId.value = null;
  dropTarget.value = null;
}

// True when the given target is the active one — drives the highlight/insertion-line CSS class.
export function isOver(target: DropTarget): boolean {
  const t = dropTarget.value;
  if (!t || t.kind !== target.kind) {
    return false;
  }
  return 'id' in t && 'id' in target ? t.id === target.id : true;
}
