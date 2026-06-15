<template>
    <form novalidate>
        <div class="row g-2">
            <div class="col-12">
                <div class="d-flex align-items-center mb-2">
                    <label for="lora_preset" class="form-label mb-0">Modem Preset</label>
                    <InfoTip>
                        Shared by all nodes; sets the receiver sensitivity used to judge link viability.
                    </InfoTip>
                </div>
                <select v-model="store.splatParams.lora.preset" class="form-select form-select-sm" id="lora_preset">
                    <option v-for="preset in LORA_PRESETS" :key="preset" :value="preset">{{ preset }}</option>
                </select>
            </div>
        </div>
    </form>
</template>

<script setup lang="ts">
import { useStore, LORA_PRESETS } from '../store.ts'
import InfoTip from './InfoTip.vue'
const store = useStore()
</script>
