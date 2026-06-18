import type { useStore } from './store.ts';

type Store = ReturnType<typeof useStore>;

// Whether the event target is a text-entry control, so shortcuts defer to it — including native
// Ctrl+Z text undo inside the lat/lon number fields.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) {
    return false;
  }
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Install the global keyboard shortcuts (A = add a node at the cursor, Ctrl/Cmd+Z = undo node move,
// H = hide/show selected node, C = calculate coverage). Returns a cleanup function that removes the
// listener; App.vue calls it on unmount so an HMR remount can't stack duplicate handlers.
export function installKeyboardShortcuts(store: Store): () => void {
  const onKeydown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+Z (no Shift) = undo. Inside a field, leave native text undo alone.
      if (!e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (isTypingTarget(e.target)) {
          return;
        }
        if (store.undoNodeMove()) {
          e.preventDefault();
        }
      }
      return; // other modifier combos never trigger the bare-key shortcuts
    }
    if (e.altKey || isTypingTarget(e.target)) {
      return;
    }
    if (e.key === 'a' || e.key === 'A') {
      store.addNodeAtCursor();
      e.preventDefault();
    } else if (e.key === 'h' || e.key === 'H') {
      store.toggleSelectedNodeVisibility();
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C') {
      // Mirror the Coverage panel's Run button: only when idle and a node is selected.
      if (store.simulationState !== 'running' && store.selectedNode) {
        store.runSimulation();
      }
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKeydown);
  return () => window.removeEventListener('keydown', onKeydown);
}
