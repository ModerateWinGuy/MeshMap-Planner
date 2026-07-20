<template>
  <form novalidate>
    <div class="row g-2">
      <div class="col-6">
        <label for="radio_climate" class="form-label">{{ t('environment.radioClimate') }}</label>
        <select v-model="environment.radio_climate" id="radio_climate" class="form-select form-select-sm" required>
          <option value="equatorial">{{ t('environment.equatorial') }}</option>
          <option value="continental_subtropical">{{ t('environment.continentalSubtropical') }}</option>
          <option value="maritime_subtropical">{{ t('environment.maritimeSubtropical') }}</option>
          <option value="desert">{{ t('environment.desert') }}</option>
          <option value="continental_temperate">{{ t('environment.continentalTemperate') }}</option>
          <option value="maritime_temperate_land">{{ t('environment.maritimeTemperateLand') }}</option>
          <option value="maritime_temperate_sea">{{ t('environment.maritimeTemperateSea') }}</option>
        </select>
        <div class="invalid-feedback">{{ t('environment.radioClimateInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="polarization" class="form-label">{{ t('environment.polarization') }}</label>
        <select v-model="environment.polarization" id="polarization" class="form-select form-select-sm" required>
          <option value="horizontal">{{ t('environment.horizontal') }}</option>
          <option value="vertical">{{ t('environment.vertical') }}</option>
        </select>
        <div class="invalid-feedback">{{ t('environment.polarizationInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="clutter_height" class="form-label" v-html="t('environment.clutterHeight')"></label>
        <input
          v-model="environment.clutter_height"
          type="number"
          class="form-control form-control-sm"
          id="clutter_height"
          required
          min="0"
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('environment.clutterHeightInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="ground_dielectric" class="form-label">{{ t('environment.groundDielectric') }}</label>
        <input
          v-model="environment.ground_dielectric"
          type="number"
          class="form-control form-control-sm"
          id="ground_dielectric"
          required
          min="1"
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('environment.groundDielectricInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="ground_conductivity" class="form-label">{{ t('environment.groundConductivity') }}</label>
        <input
          v-model="environment.ground_conductivity"
          type="number"
          class="form-control form-control-sm"
          id="ground_conductivity"
          required
          min="0"
          step="0.001"
        />
        <div class="invalid-feedback">{{ t('environment.groundConductivityInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="atmosphere_bending" class="form-label">{{ t('environment.atmosphericBending') }}</label>
        <input
          v-model="environment.atmosphere_bending"
          type="number"
          class="form-control form-control-sm"
          id="atmosphere_bending"
          required
          min="0"
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('environment.atmosphericBendingInvalid') }}</div>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useStore } from '../store.ts';
const { t } = useI18n();
const environment = useStore().splatParams.environment;
</script>
