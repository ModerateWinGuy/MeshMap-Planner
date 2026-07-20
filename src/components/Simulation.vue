<template>
  <form novalidate>
    <div class="row g-2">
      <div class="col-6">
        <label for="situation_fraction" class="form-label">{{ t('simulation.situationFraction') }}</label>
        <input
          v-model="simulation.situation_fraction"
          type="number"
          class="form-control form-control-sm"
          id="situation_fraction"
          required
          min="1"
          max="100"
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('simulation.situationFractionInvalid') }}</div>
      </div>
      <div class="col-6">
        <label for="time_fraction" class="form-label">{{ t('simulation.timeFraction') }}</label>
        <input
          v-model="simulation.time_fraction"
          type="number"
          class="form-control form-control-sm"
          id="time_fraction"
          required
          min="1"
          max="100"
          step="0.1"
        />
        <div class="invalid-feedback">{{ t('simulation.timeFractionInvalid') }}</div>
      </div>
    </div>
    <div class="row g-2 mt-2">
      <div class="col-6">
        <label for="simulation_extent" class="form-label">{{ t('simulation.maxRange') }}</label>
        <input
          v-model="simulation.simulation_extent"
          type="number"
          class="form-control form-control-sm"
          id="simulation_extent"
          required
          min="1"
          max="100"
          step="1"
        />
        <div class="invalid-feedback">{{ t('simulation.maxRangeInvalid') }}</div>
      </div>
    </div>
    <div class="row mt-3">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="sim_quality" class="form-label mb-0">{{ t('simulation.quality') }}</label>
          <InfoTip>
            {{ t('simulation.qualityInfo') }}
          </InfoTip>
        </div>
        <select v-model="simulation.quality" class="form-select form-select-sm" id="sim_quality">
          <option value="draft">{{ t('simulation.qualityDraft') }}</option>
          <option value="balanced">{{ t('simulation.qualityBalanced') }}</option>
          <option value="high">{{ t('simulation.qualityHigh') }}</option>
          <option value="max">{{ t('simulation.qualityMax') }}</option>
        </select>
      </div>
    </div>
    <div class="row mt-3">
      <div class="col-12">
        <div class="d-flex align-items-center mb-2">
          <label for="overlay_resolution" class="form-label mb-0">{{ t('simulation.overlayResolution') }}</label>
          <InfoTip>
            {{ t('simulation.overlayResolutionInfo') }}
          </InfoTip>
        </div>
        <select v-model="simulation.overlay_max_texture" class="form-select form-select-sm" id="overlay_resolution">
          <option :value="4096">{{ t('simulation.overlayStandard') }}</option>
          <option :value="8192">{{ t('simulation.overlayHigh') }}</option>
        </select>
        <div class="form-text">
          {{ t('simulation.coverageCellsPrefix') }}
          <strong>≈{{ Math.round(store.coverageCellMeters) }} m</strong> {{ t('simulation.wide') }}
        </div>
      </div>
    </div>
    <div class="row mt-3">
      <div class="col-12">
        <div class="form-check form-switch">
          <input
            v-model="simulation.filter_radio_horizon"
            type="checkbox"
            role="switch"
            class="form-check-input"
            id="filter_radio_horizon"
          />
          <label class="form-check-label" for="filter_radio_horizon">{{ t('simulation.filterHorizon') }}</label>
          <InfoTip>
            {{ t('simulation.filterHorizonInfo') }}
          </InfoTip>
        </div>
      </div>
    </div>
    <div class="row mt-3">
      <div class="col-12">
        <div class="d-flex align-items-center mb-1">
          <label for="max_link_distance" class="form-label mb-0">{{ t('simulation.maxLinkDistance') }}</label>
          <InfoTip>
            {{ t('simulation.maxLinkDistanceInfo') }}
          </InfoTip>
        </div>
        <input
          v-model.number="simulation.max_link_distance_km"
          type="number"
          min="0"
          step="5"
          class="form-control form-control-sm"
          id="max_link_distance"
        />
        <div class="form-text">{{ t('simulation.noLimit') }}</div>
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
const simulation = store.splatParams.simulation;
// mergeDefaults is shallow, so params persisted before this key existed lack it: backfill the
// default so the Overlay Resolution select preselects correctly (the store also reads it defensively).
if (simulation.overlay_max_texture == null) simulation.overlay_max_texture = 4096;
if (simulation.max_link_distance_km == null) simulation.max_link_distance_km = 0;
</script>
