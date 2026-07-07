<template>
  <form novalidate>
    <div class="row g-2">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="listener_height_agl" class="form-label mb-0">Listener Height AGL (m)</label>
          <InfoTip>
            Height above ground assumed for a listener elsewhere on the map when generating coverage — not any
            particular node's own antenna height (see the node's Transmitter panel for that).
          </InfoTip>
        </div>
        <input
          v-model.number="store.listenerHeightAgl"
          type="number"
          class="form-control form-control-sm"
          id="listener_height_agl"
          required
          min="0"
          step="0.1"
        />
        <div class="invalid-feedback">Height must be a positive number.</div>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts';
import InfoTip from './InfoTip.vue';
const store = useStore();
</script>
