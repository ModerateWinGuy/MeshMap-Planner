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
                <label for="high_resolution" class="form-label">High-Resolution</label>
                <div class="form-check">
                    <input v-model="simulation.high_resolution" type="checkbox" class="form-check-input" id="high_resolution" />
                    <label class="form-check-label" for="high_resolution">Use 30 meter resolution terrain data (default: 90 meter).</label>
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
        <div class="row mt-3">
            <div class="col-12">
                <label for="terrain_source" class="form-label">Terrain Model</label>
                <select v-model="simulation.terrain_source" class="form-select form-select-sm" id="terrain_source">
                    <option value="srtm">SRTM — global bare earth (default)</option>
                    <option value="dem">LINZ DEM — bare earth (NZ LIDAR)</option>
                    <option value="dsm">LINZ DSM — surface, buildings &amp; trees (NZ LIDAR)</option>
                </select>
                <div class="form-text">
                    <strong>SRTM</strong> is the global bare-earth baseline (AWS Terrarium on the map). The
                    <strong>LINZ</strong> options only differ where high-resolution LIDAR coverage exists
                    (currently only New Zealand): <strong>DEM</strong> is bare earth, <strong>DSM</strong> bakes
                    buildings/canopy into the terrain — set Clutter Height to 0 when using it to avoid counting
                    obstructions twice. The map's 3D terrain and hillshade follow this choice too.
                </div>
            </div>
        </div>
    </form>
</template>

<script setup lang="ts">
import { useStore } from '../store.ts'
const simulation = useStore().splatParams.simulation
</script>
