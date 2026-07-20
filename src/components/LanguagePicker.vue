<template>
  <div class="dropdown">
    <button
      type="button"
      class="btn btn-sm btn-outline-light dropdown-toggle d-inline-flex align-items-center gap-1 px-2"
      data-bs-toggle="dropdown"
      aria-expanded="false"
      :title="t('terrain.language')"
      :aria-label="t('terrain.language')"
    >
      <span>{{ currentFlag }}</span>
    </button>
    <ul class="dropdown-menu dropdown-menu-end" data-bs-theme="dark">
      <li v-for="l in SUPPORTED_LOCALES" :key="l.code">
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: store.locale === l.code }"
          @click="store.setLocale(l.code)"
        >
          <span>{{ l.flag }}</span> {{ l.name }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { SUPPORTED_LOCALES } from '../i18n/detectLocale.ts';

const { t } = useI18n();
const store = useStore();

// Falls back to a globe if store.locale somehow holds a code outside SUPPORTED_LOCALES (e.g. a
// stale localStorage value from a since-removed locale).
const currentFlag = computed(() => SUPPORTED_LOCALES.find((l) => l.code === store.locale)?.flag ?? '🌐');
</script>
