<template>
  <form novalidate>
    <div class="row g-2">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="listener_height_agl" class="form-label mb-0">{{ t('listener.heightAgl') }}</label>
          <InfoTip>
            {{ t('listener.heightAglInfo') }}
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
        <div class="invalid-feedback">{{ t('listener.heightAglInvalid') }}</div>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import InfoTip from './InfoTip.vue';
const { t } = useI18n();
const store = useStore();
</script>
