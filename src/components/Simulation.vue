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
                <div class="d-flex align-items-center mb-2">
                    <label for="sim_quality" class="form-label mb-0">Simulation Quality</label>
                    <InfoTip>
                        Sets the coverage overlay's target cell size and the link-profile sampling detail.
                        The target cell size only holds out to the range its texture budget allows; past
                        that, cells grow with range (see the readout below). Applies to the link matrix,
                        profile, coverage and relay.
                    </InfoTip>
                </div>
                <select v-model="simulation.quality" class="form-select form-select-sm" id="sim_quality">
                    <option value="draft">Draft — coarsest cells, fastest</option>
                    <option value="balanced">Balanced (default) — ~30 m cells</option>
                    <option value="high">High — ~16 m cells</option>
                    <option value="max">Max — 8 m cells (native terrain resolution)</option>
                </select>
            </div>
        </div>
        <div class="row mt-3">
            <div class="col-12">
                <div class="d-flex align-items-center mb-2">
                    <label for="overlay_resolution" class="form-label mb-0">Overlay Resolution</label>
                    <InfoTip>
                        Caps how large the draped coverage image can get, so it bounds the smallest cell at
                        long range. Standard hits 8 m cells out to ~16 km; High reaches 8 m across the full
                        range but uses much more memory and may not render on older Safari. Clamped to your
                        GPU's texture limit.
                    </InfoTip>
                </div>
                <select v-model="simulation.overlay_max_texture" class="form-select form-select-sm" id="overlay_resolution">
                    <option :value="4096">Standard — up to 4096 px (≈67 MB)</option>
                    <option :value="8192">High — up to 8192 px (≈268 MB)</option>
                </select>
                <div class="form-text">
                    Coverage cells at the current range: <strong>≈{{ Math.round(store.coverageCellMeters) }} m</strong> wide.
                </div>
            </div>
        </div>
        <div class="row mt-3">
            <div class="col-12">
                <div class="form-check form-switch">
                    <input v-model="simulation.filter_radio_horizon" type="checkbox" role="switch" class="form-check-input" id="filter_radio_horizon" />
                    <label class="form-check-label" for="filter_radio_horizon">Filter line-of-sight horizon</label>
                    <InfoTip>
                        When computing the link matrix, skip pairs beyond the radio horizon — the
                        line-of-sight distance set by the curve of the Earth and each node's height above
                        sea level (higher nodes reach further). Turn off for non-line-of-sight bands.
                    </InfoTip>
                </div>
            </div>
        </div>
    </form>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts'
import InfoTip from './InfoTip.vue'
const store = useStore()
const simulation = store.splatParams.simulation
// mergeDefaults is shallow, so params persisted before this key existed lack it: backfill the
// default so the Overlay Resolution select preselects correctly (the store also reads it defensively).
if (simulation.overlay_max_texture == null) simulation.overlay_max_texture = 4096
</script>
