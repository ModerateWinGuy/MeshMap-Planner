<template>
  <form novalidate>
        <div class="row g-2">
            <div class="col-6">
                <label for="situation_fraction" class="form-label">Situation Fraction (%)</label>
                <input v-model="simulation.situation_fraction" type="number" class="form-control form-control-sm" id="situation_fraction" required min="1" max="100" step="0.1" />
                <div class="invalid-feedback">Percentage must be between 1 and 100 (default: 50).</div>
            </div>
            <div class="col-6">
                <label for="time_fraction" class="form-label">Time Fraction (%)</label>
                <input v-model="simulation.time_fraction" type="number" class="form-control form-control-sm" id="time_fraction" required min="1" max="100" step="0.1" />
                <div class="invalid-feedback">Percentage must be between 1 and 100 (default: 90).</div>
            </div>
        </div>
        <div class="row g-2 mt-2">
            <div class="col-6">
                <label for="simulation_extent" class="form-label">Max Range (km)</label>
                <input v-model="simulation.simulation_extent" type="number" class="form-control form-control-sm" id="simulation_extent" required min="1" max="100" step="1" />
                <div class="invalid-feedback">Radius must be a positive number (default: 30 km).</div>
            </div>
        </div>
        <div class="row mt-3">
            <div class="col-12">
                <label for="sim_quality" class="form-label">Simulation Quality</label>
                <select v-model="simulation.quality" class="form-select form-select-sm" id="sim_quality">
                    <option value="draft">Draft — fastest, coarse terrain sampling</option>
                    <option value="balanced">Balanced (default)</option>
                    <option value="high">High — fine cells, follows the map's terrain resolution</option>
                    <option value="max">Max — ~8 m cells (native terrain resolution; slow over large ranges)</option>
                </select>
                <div class="form-text">
                    Trades accuracy for speed in the browser-side simulations: Draft samples the terrain
                    profile coarsely for snappy results; High samples at the displayed terrain's full
                    resolution. Applies to the link matrix, profile, coverage and relay.
                </div>
            </div>
        </div>
        <div class="row mt-3">
            <div class="col-12">
                <div class="form-check form-switch">
                    <input v-model="simulation.filter_radio_horizon" type="checkbox" role="switch" class="form-check-input" id="filter_radio_horizon" />
                    <label class="form-check-label" for="filter_radio_horizon">Filter line-of-sight horizon</label>
                </div>
                <div class="form-text">
                    When computing the link matrix, skip pairs beyond the radio horizon — the
                    line-of-sight distance set by the curve of the Earth and each node's height above
                    sea level (higher nodes reach further). Turn off for non-line-of-sight bands.
                </div>
            </div>
        </div>
    </form>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts'
const store = useStore()
const simulation = store.splatParams.simulation
</script>
