<template>
  <form novalidate>
    <div class="row g-2">
      <div class="col-6">
        <label for="min_dbm" class="form-label">{{ t('display.minDbm') }}</label>
        <input
          v-model="display.min_dbm"
          type="number"
          class="form-control form-control-sm"
          id="min_dbm"
          required
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('display.minDbmInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="max_dbm" class="form-label">{{ t('display.maxDbm') }}</label>
        <input
          v-model="display.max_dbm"
          type="number"
          class="form-control form-control-sm"
          id="max_dbm"
          required
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('display.maxDbmInvalid') }}</div>
      </div>
    </div>
    <div class="row g-2 mt-2">
      <div class="col-6">
        <label for="color_scale" class="form-label">{{ t('display.colorScale') }}</label>
        <select v-model="display.color_scale" id="color_scale" class="form-select form-select-sm" required>
          <option v-for="opt in COLOR_SCALE_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <div class="invalid-feedback">{{ t('display.colorScaleInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="overlay_transparency" class="form-label d-flex justify-content-between">
          <span>{{ t('display.transparency') }}</span>
          <span class="text-body-secondary">{{ display.overlay_transparency }}%</span>
        </label>
        <input
          v-model.number="display.overlay_transparency"
          type="range"
          class="form-range"
          id="overlay_transparency"
          min="0"
          max="100"
          step="1"
        />
      </div>
    </div>
    <div class="mt-3 small">
      <div
        class="legend-bar"
        role="img"
        :aria-label="t('display.colorbarAlt')"
        :style="{ background: gradientCss(display.color_scale) }"
      ></div>
      <div class="d-flex justify-content-between text-muted mt-1">
        <span>{{ display.min_dbm }} dBm</span>
        <span>{{ display.max_dbm }} dBm</span>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
import { COLOR_SCALE_OPTIONS, gradientCss } from '../sim/colormap.ts';
const { t } = useI18n();
const display = useStore().splatParams.display;
</script>
