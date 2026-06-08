<template>
    <div>
        <div class="d-flex gap-2 mb-2">
            <button @click="store.addNode()" type="button" class="btn btn-success btn-sm">+ Add node</button>
            <button @click="exportNodes" type="button" class="btn btn-outline-light btn-sm">Export</button>
            <button @click="triggerImport" type="button" class="btn btn-outline-light btn-sm">Import</button>
            <input ref="fileInput" @change="importNodes" type="file" accept="application/json" class="d-none" />
        </div>
        <ul v-if="store.nodes.length" class="list-group">
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
                    class="btn-close btn-close-white"
                    aria-label="Delete node"
                ></button>
            </li>
        </ul>
        <p v-else class="text-muted small mb-0">No nodes yet. Click "Add node" to create one.</p>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useStore } from '../store.ts';
import { type Node } from '../types.ts';

const store = useStore();
const fileInput = ref<HTMLInputElement | null>(null);

function exportNodes() {
    const json = JSON.stringify(store.nodes, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nodes.json';
    a.click();
    URL.revokeObjectURL(url);
}

function triggerImport() {
    fileInput.value?.click();
}

function isValidNode(n: any): boolean {
    return n && typeof n === 'object' && n.transmitter && n.receiver
        && typeof n.transmitter.tx_lat === 'number' && typeof n.transmitter.tx_lon === 'number';
}

function importNodes(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const parsed = JSON.parse(reader.result as string);
            if (!Array.isArray(parsed) || !parsed.every(isValidNode)) {
                throw new Error('File does not contain a valid node list.');
            }
            const nodes: Node[] = parsed.map((n) => ({
                id: crypto.randomUUID(),
                transmitter: n.transmitter,
                receiver: n.receiver
            }));
            store.nodes = nodes;
            store.selectedNodeId = nodes[0]?.id ?? null;
            store.renderNodeMarkers();
        } catch (err) {
            alert(`Import failed: ${err instanceof Error ? err.message : 'invalid file'}`);
        } finally {
            input.value = ''; // allow re-importing the same file
        }
    };
    reader.readAsText(file);
}
</script>
