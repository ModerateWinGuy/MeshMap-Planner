<template>
    <div>
        <template v-if="store.nodes.length">
            <ul  class="list-group">
                <li
                    v-for="node in store.nodes"
                    :key="node.id"
                    @click="store.selectNode(node.id)"
                    class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                    :class="{ active: node.id === store.selectedNode?.id }"
                    role="button"
                >
                    <span class="text-truncate">{{ node.transmitter.name }}</span>
                    <button
                        type="button"
                        @click.stop="store.deleteNode(node.id)"
                        class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                        aria-label="Delete node"
                        title="Delete node"
                    ><X :size="16" /></button>
                </li>
            </ul>
        </template>
        <p v-else class="text-muted medium centered mb-0">No nodes yet. Click "Add node" to create one.</p>
        <div class="d-flex gap-2 mb-2 mt-3">
            <button @click="store.addNode()" type="button" class="btn btn-success btn-sm w-100 d-flex align-items-center justify-content-center gap-1"><Plus :size="16" /> Add node</button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts';
import { Plus, X } from '@lucide/vue';

const store = useStore();
</script>
