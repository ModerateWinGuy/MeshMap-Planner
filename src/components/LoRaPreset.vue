<template>
    <form novalidate>
        <div class="row g-2">
            <div class="col-12">
                <label for="lora_preset" class="form-label">Modem Preset</label>
                <select v-model="store.splatParams.lora.preset" class="form-select form-select-sm" id="lora_preset">
                    <option v-for="preset in LORA_PRESETS" :key="preset" :value="preset">{{ preset }}</option>
                </select>
                <div class="form-text text-muted">
                    Shared by all nodes; sets the receiver sensitivity used to judge link viability.
                </div>
            </div>
        </div>
    </form>
</template>

<script setup lang="ts">
import { useStore, LORA_PRESETS } from '../store.ts'
const store = useStore()
</script>
