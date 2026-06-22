<template>
    <div>
        <div class="d-flex align-items-center mb-2">
            <span class="fw-medium">Terrain providers</span>
            <InfoTip>
                Higher-detail elevation layered over the Mapterhorn baseline wherever a provider has
                data — the baseline still fills the rest of the world, so enabling one only adds detail,
                never removes coverage. Feeds the 3D terrain, hillshade, and the line-of-sight / coverage
                sims. Where two providers overlap, the one lower in this list wins. <strong>LINZ</strong>
                rows are pre-configured and NZ-only (elevation &copy; LINZ, CC&#8209;BY&nbsp;4.0). Add your
                own region's DEM/DSM tile service below — it needs to serve Mapbox or Terrarium-encoded
                terrain-RGB PNG tiles, the same scheme LINZ uses.
            </InfoTip>
        </div>

        <ul class="list-group mb-2">
            <li
                v-for="provider in store.allDemProviders"
                :key="provider.id"
                class="list-group-item d-flex align-items-center gap-1 px-2 py-1"
            >
                <template v-if="editingId === provider.id">
                    <ProviderForm
                        class="flex-grow-1"
                        :name="formName"
                        :url-template="formUrlTemplate"
                        :encoding="formEncoding"
                        submit-label="Save"
                        @update:name="formName = $event"
                        @update:url-template="formUrlTemplate = $event"
                        @update:encoding="formEncoding = $event"
                        @submit="commitEdit"
                        @cancel="cancelEdit"
                    />
                </template>
                <template v-else>
                    <span class="flex-grow-1 text-truncate" :class="{ 'text-muted': !provider.enabled }">{{ provider.name }}</span>
                    <span class="d-flex align-items-center gap-2 flex-shrink-0 ms-1">
                        <button
                            type="button"
                            @click="store.toggleProviderEnabled(provider.id)"
                            class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                            :aria-label="provider.enabled ? 'Disable provider' : 'Enable provider'"
                            :title="provider.enabled ? 'Disable this provider' : 'Enable this provider'"
                        ><EyeOff v-if="!provider.enabled" :size="16" /><Eye v-else :size="16" /></button>
                        <template v-if="!provider.builtin">
                            <button
                                type="button"
                                @click="startEdit(provider)"
                                class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                                aria-label="Edit provider"
                                title="Edit provider"
                            ><Pencil :size="15" /></button>
                            <button
                                type="button"
                                @click="store.removeCustomDemProvider(provider.id)"
                                class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                                aria-label="Delete provider"
                                title="Delete provider"
                            ><Trash2 :size="15" /></button>
                        </template>
                    </span>
                </template>
            </li>
        </ul>

        <button
            v-if="!addingNew"
            type="button"
            @click="startAdd"
            class="btn btn-success btn-sm w-100 d-flex align-items-center justify-content-center gap-1"
        ><Plus :size="16" /> Add provider</button>
        <ProviderForm
            v-else
            :name="formName"
            :url-template="formUrlTemplate"
            :encoding="formEncoding"
            submit-label="Add"
            @update:name="formName = $event"
            @update:url-template="formUrlTemplate = $event"
            @update:encoding="formEncoding = $event"
            @submit="commitAdd"
            @cancel="cancelAdd"
        />
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useStore } from '../store.ts'
import type { DemProvider } from '../terrain/demTiles.ts'
import InfoTip from './InfoTip.vue'
import ProviderForm from './ProviderForm.vue'
import { Eye, EyeOff, Pencil, Plus, Trash2 } from '@lucide/vue'

const store = useStore()

const editingId = ref<string | null>(null)
const addingNew = ref(false)
const formName = ref('')
const formUrlTemplate = ref('')
const formEncoding = ref<'mapbox' | 'terrarium'>('mapbox')

function resetForm() {
    formName.value = ''
    formUrlTemplate.value = ''
    formEncoding.value = 'mapbox'
}
function startAdd() {
    resetForm()
    editingId.value = null
    addingNew.value = true
}
function cancelAdd() {
    addingNew.value = false
}
function commitAdd() {
    store.addCustomDemProvider(formName.value.trim(), formUrlTemplate.value.trim(), formEncoding.value)
    addingNew.value = false
}
function startEdit(provider: DemProvider) {
    addingNew.value = false
    editingId.value = provider.id
    formName.value = provider.name
    formUrlTemplate.value = provider.urlTemplate
    formEncoding.value = provider.encoding
}
function cancelEdit() {
    editingId.value = null
}
function commitEdit() {
    if (!editingId.value) {
        return
    }
    store.updateCustomDemProvider(editingId.value, {
        name: formName.value.trim(),
        urlTemplate: formUrlTemplate.value.trim(),
        encoding: formEncoding.value,
    })
    editingId.value = null
}
</script>
