<template>
    <form novalidate>
        <div class="row g-2">
            <div class="col-12">
                <div class="d-flex align-items-center mb-2">
                    <label for="lora_preset" class="form-label mb-0">Modem Preset</label>
                    <InfoTip>
                        Shared by all nodes; sets the receiver sensitivity used to judge link viability. Pick a
                        preset, or hand-edit the spreading factor / bandwidth below if your setup doesn't match one.
                    </InfoTip>
                </div>
                <select v-model="presetName" class="form-select form-select-sm" id="lora_preset">
                    <option value="">Custom</option>
                    <optgroup label="Meshtastic">
                        <option v-for="name in meshtasticNames" :key="name" :value="name">{{ name }}</option>
                    </optgroup>
                    <optgroup label="MeshCore">
                        <option v-for="name in meshcoreNames" :key="name" :value="name">{{ name }}</option>
                    </optgroup>
                </select>
            </div>
            <div class="col-6">
                <label for="lora_sf" class="form-label small mb-0">Spreading factor</label>
                <input
                    v-model.number="spreadingFactor"
                    type="number"
                    class="form-control form-control-sm"
                    id="lora_sf"
                    min="7"
                    max="12"
                    step="1"
                />
            </div>
            <div class="col-6">
                <label for="lora_bw" class="form-label small mb-0">Bandwidth (kHz)</label>
                <input
                    v-model.number="bandwidthKhz"
                    type="number"
                    class="form-control form-control-sm"
                    id="lora_bw"
                    min="1"
                    step="0.1"
                />
            </div>
            <div class="col-12">
                <button
                    type="button"
                    @click="store.applyLoraFrequencyToAllNodes()"
                    :disabled="!store.splatParams.lora?.frequencyMhz || !store.nodes.length"
                    class="btn btn-success btn-sm w-100 d-flex align-items-center justify-content-center gap-1"
                    title="Set every node's frequency to this preset's frequency. Only available for MeshCore presets, which set a region frequency; Meshtastic presets and Custom don't define one."
                ><Radio :size="14" /> Apply frequency to all nodes</button>
            </div>
        </div>
    </form>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStore } from '../store.ts'
import { MESHTASTIC_PRESETS, MESHCORE_PRESETS, presetNameFor } from '../sim/linkBudget.ts'
import InfoTip from './InfoTip.vue'
import { Radio } from '@lucide/vue'

const store = useStore()
const meshtasticNames = Object.keys(MESHTASTIC_PRESETS)
const meshcoreNames = Object.keys(MESHCORE_PRESETS)

// After a manual SF/BW edit, re-resolve which preset (if any) the new pair matches, so the dropdown
// and the link matrix's preset label stay in sync with hand-typed values.
function syncPresetLabel() {
    store.splatParams.lora.preset = presetNameFor(spreadingFactor.value, bandwidthKhz.value) ?? 'Custom';
}

const spreadingFactor = computed({
    get: () => store.splatParams.lora?.spreadingFactor ?? MESHTASTIC_PRESETS.LongFast.spreadingFactor,
    set: (value: number) => { store.splatParams.lora.spreadingFactor = value; syncPresetLabel(); }
})
const bandwidthKhz = computed({
    get: () => store.splatParams.lora?.bandwidthKhz ?? MESHTASTIC_PRESETS.LongFast.bandwidthKhz,
    set: (value: number) => { store.splatParams.lora.bandwidthKhz = value; syncPresetLabel(); }
})

const presetName = computed({
    get: () => {
        const saved = store.splatParams.lora?.preset;
        const savedPreset = saved ? (MESHTASTIC_PRESETS[saved] ?? MESHCORE_PRESETS[saved]) : undefined;
        if (savedPreset && savedPreset.spreadingFactor === spreadingFactor.value && savedPreset.bandwidthKhz === bandwidthKhz.value) {
            return saved!;
        }
        return presetNameFor(spreadingFactor.value, bandwidthKhz.value) ?? '';
    },
    set: (name: string) => {
        const preset = name ? (MESHTASTIC_PRESETS[name] ?? MESHCORE_PRESETS[name]) : undefined;
        if (!preset) {
            return;
        }
        store.splatParams.lora.preset = name;
        store.splatParams.lora.spreadingFactor = preset.spreadingFactor;
        store.splatParams.lora.bandwidthKhz = preset.bandwidthKhz;
        store.splatParams.lora.frequencyMhz = preset.frequencyMhz;
    }
})
</script>
