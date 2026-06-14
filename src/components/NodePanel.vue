<template>
    <div>
        <template v-if="store.nodes.length">
            <div v-if="store.nodes.length > 1" class="d-flex justify-content-end gap-2 mb-2">
                <button
                    type="button"
                    @click="store.setAllNodesHidden(false)"
                    :disabled="!anyHidden"
                    class="btn btn-outline-secondary btn-sm py-0 px-1 d-flex align-items-center gap-1"
                    title="Show all nodes"
                ><Eye :size="14" /> Show all</button>
                <button
                    type="button"
                    @click="store.setAllNodesHidden(true)"
                    :disabled="!anyVisible"
                    class="btn btn-outline-secondary btn-sm py-0 px-1 d-flex align-items-center gap-1"
                    title="Hide all nodes"
                ><EyeOff :size="14" /> Hide all</button>
            </div>
            <ul  class="list-group">
                <li
                    v-for="node in store.nodes"
                    :key="node.id"
                    @click="store.selectNode(node.id)"
                    class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                    :class="{ active: node.id === store.selectedNode?.id }"
                    role="button"
                >
                    <span class="text-truncate" :class="{ 'text-muted fst-italic': node.hidden }">{{ node.transmitter.name }}</span>
                    <span class="d-flex align-items-center gap-2 flex-shrink-0">
                        <button
                            type="button"
                            @click.stop="store.toggleNodeVisibility(node.id)"
                            class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                            :aria-label="node.hidden ? 'Show node' : 'Hide node'"
                            :title="node.hidden ? 'Show on map' : 'Hide from map'"
                        ><EyeOff v-if="node.hidden" :size="16" /><Eye v-else :size="16" /></button>
                        <button
                            type="button"
                            @click.stop="store.deleteNode(node.id)"
                            class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                            aria-label="Delete node"
                            title="Delete node"
                        ><X :size="16" /></button>
                    </span>
                </li>
            </ul>
        </template>
        <p v-else class="text-muted medium centered mb-0">Add a node to begin.</p>
        <div class="d-flex gap-2 mb-2 mt-3">
            <button @click="store.addNode()" type="button" class="btn btn-success btn-sm w-100 d-flex align-items-center justify-content-center gap-1"><Plus :size="16" /> Add node</button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useStore } from '../store.ts';
import { Eye, EyeOff, Plus, X } from '@lucide/vue';

const store = useStore();

// Drive the enabled state of the bulk buttons: only offer "Show all" when something is hidden, and
// "Hide all" when something is visible.
const anyHidden = computed(() => store.nodes.some((n) => n.hidden));
const anyVisible = computed(() => store.nodes.some((n) => !n.hidden));
</script>
