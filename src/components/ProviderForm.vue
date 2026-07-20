<template>
  <form novalidate class="d-flex flex-column gap-2 py-1">
    <input
      v-model="localName"
      type="text"
      required
      class="form-control form-control-sm"
      :placeholder="t('providerForm.providerName')"
      :aria-label="t('providerForm.providerName')"
    />
    <div>
      <input
        v-model="localUrlTemplate"
        type="text"
        required
        class="form-control form-control-sm"
        :class="{ 'is-invalid': localUrlTemplate.length > 0 && !urlTemplateValid }"
        placeholder="https://example.com/dem/{z}/{x}/{y}.png?key=..."
        :aria-label="t('providerForm.urlTemplate')"
      />
      <div class="invalid-feedback" v-if="localUrlTemplate.length > 0 && !urlTemplateValid">
        {{ t('providerForm.placeholdersRequired') }}
      </div>
      <div class="form-text">{{ t('providerForm.placeholdersHelp') }}</div>
    </div>
    <select v-model="localEncoding" class="form-select form-select-sm" :aria-label="t('providerForm.tileEncoding')">
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
        {{ testing ? t('providerForm.testing') : t('providerForm.test') }}
      </button>
      <span v-if="testResult" :class="testResult.ok ? 'text-success' : 'text-danger'" class="small">{{
        testResult.message
      }}</span>
    </div>
    <div class="d-flex gap-2">
      <button type="button" :disabled="!canSubmit" @click="$emit('submit')" class="btn btn-success btn-sm flex-grow-1">
        {{ submitLabel }}
      </button>
      <button type="button" @click="$emit('cancel')" class="btn btn-outline-secondary btn-sm">
        {{ t('common.cancel') }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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

const { t } = useI18n();
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
