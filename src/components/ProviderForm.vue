<template>
  <form novalidate class="d-flex flex-column gap-2 py-1">
    <input
      v-model="localName"
      type="text"
      required
      class="form-control form-control-sm"
      placeholder="Provider name"
      aria-label="Provider name"
    />
    <div>
      <input
        v-model="localUrlTemplate"
        type="text"
        required
        class="form-control form-control-sm"
        :class="{ 'is-invalid': localUrlTemplate.length > 0 && !urlTemplateValid }"
        placeholder="https://example.com/dem/{z}/{x}/{y}.png?key=..."
        aria-label="Tile URL template"
      />
      <div class="invalid-feedback" v-if="localUrlTemplate.length > 0 && !urlTemplateValid">
        Must contain {z}, {x} and {y} placeholders.
      </div>
      <div class="form-text">Must include {z}/{x}/{y}; include any API key directly in the URL.</div>
    </div>
    <select v-model="localEncoding" class="form-select form-select-sm" aria-label="Tile encoding">
      <option value="mapbox">Mapbox / Mapzen terrain-RGB</option>
      <option value="terrarium">Terrarium</option>
    </select>
    <div class="d-flex align-items-center gap-2">
      <button
        type="button"
        :disabled="!urlTemplateValid || testing"
        @click="runTest"
        class="btn btn-outline-secondary btn-sm"
      >
        {{ testing ? 'Testing…' : 'Test' }}
      </button>
      <span v-if="testResult" :class="testResult.ok ? 'text-success' : 'text-danger'" class="small">{{
        testResult.message
      }}</span>
    </div>
    <div class="d-flex gap-2">
      <button type="button" :disabled="!canSubmit" @click="$emit('submit')" class="btn btn-success btn-sm flex-grow-1">
        {{ submitLabel }}
      </button>
      <button type="button" @click="$emit('cancel')" class="btn btn-outline-secondary btn-sm">Cancel</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useStore } from '../store.ts';
import type { ProviderTestResult } from '../terrain/demTiles.ts';

const props = defineProps<{
  name: string;
  urlTemplate: string;
  encoding: 'mapbox' | 'terrarium';
  submitLabel: string;
}>();
const emit = defineEmits<{
  'update:name': [string];
  'update:urlTemplate': [string];
  'update:encoding': ['mapbox' | 'terrarium'];
  submit: [];
  cancel: [];
}>();

const store = useStore();

const localName = computed({
  get: () => props.name,
  set: (v: string) => emit('update:name', v),
});
const localUrlTemplate = computed({
  get: () => props.urlTemplate,
  set: (v: string) => emit('update:urlTemplate', v),
});
const localEncoding = computed({
  get: () => props.encoding,
  set: (v: 'mapbox' | 'terrarium') => emit('update:encoding', v),
});

// Requires all three placeholders literally present — matches how every existing template in this
// codebase (AWS, LINZ, basemaps) is written, and is the simplest correct check for "did the user
// forget to template this".
const urlTemplateValid = computed(
  () =>
    localUrlTemplate.value.includes('{z}') &&
    localUrlTemplate.value.includes('{x}') &&
    localUrlTemplate.value.includes('{y}'),
);
const canSubmit = computed(() => localName.value.trim().length > 0 && urlTemplateValid.value);

const testing = ref(false);
const testResult = ref<ProviderTestResult | null>(null);

async function runTest() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await store.testDemProvider(localUrlTemplate.value, localEncoding.value);
  } finally {
    testing.value = false;
  }
}
</script>
