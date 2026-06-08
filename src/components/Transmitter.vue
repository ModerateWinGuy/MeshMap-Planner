
<template>
    <form v-if="transmitter" novalidate>
        <div class="row g-2">
            <div class="col-12">
                <label for="name" class="form-label">Site name</label>
                <input v-model="transmitter.name" class="form-control form-control-sm" id="name" required data-bs-toggle="tooltip" title="Site Name" />
            </div>
        </div>
        <div class="row g-2">
            <div class="col-6">
                <label for="tx_lat" class="form-label">Latitude (degrees)</label>
                <input v-model="transmitter.tx_lat" type="number" class="form-control form-control-sm" id="tx_lat" required min="-90" max="90" step="0.000001" data-bs-toggle="tooltip" title="Transmitter latitude in degrees (-90 to 90)." />
                <div class="invalid-feedback">Please enter a valid latitude (-90 to 90).</div>
            </div>
            <div class="col-6">
                <label for="tx_lon" class="form-label">Longitude (degrees)</label>
                <input v-model="transmitter.tx_lon" type="number" class="form-control form-control-sm" id="tx_lon" required min="-180" max="180" step="0.000001" data-bs-toggle="tooltip" title="Transmitter longitude in degrees (-180 to 180)." />
                <div class="invalid-feedback">Please enter a valid longitude (-180 to 180).</div>
            </div>
        </div>
        <div class="row g-2 mt-2">
            <div class="col-6">
                <label for="tx_power" class="form-label">Power (W)</label>
                <input v-model.number="transmitter.tx_power" type="number" class="form-control form-control-sm" id="tx_power" required min="0" step="0.1" data-bs-toggle="tooltip" title="Transmitter power in watts (>0)." />
                <div class="invalid-feedback">Power must be a positive number.</div>
            </div>
            <div class="col-6">
                <label for="tx_power_dbm" class="form-label">Power (dBm)</label>
                <input v-model="txPowerDbm" @input="onDbmInput" @focus="dbmFocused = true" @blur="onDbmBlur" type="number" class="form-control form-control-sm" id="tx_power_dbm" step="0.1" data-bs-toggle="tooltip" title="Transmitter power in dBm. Converts to/from watts automatically (30 dBm = 1 W)." />
            </div>
        </div>
        <div class="row g-2 mt-2">
            <div class="col-6">
                <label for="frequency" class="form-label">Frequency (MHz)</label>
                <input v-model="transmitter.tx_freq" type="number" class="form-control form-control-sm" id="tx_freq" required min="20" max="20000" step="0.1" data-bs-toggle="tooltip" title="Transmitter frequency in MHz (20 to 20,000)." />
                <div class="invalid-feedback">Frequency must be a positive number.</div>
            </div>
            <div class="col-6">
                <label for="tx_height" class="form-label">Height AGL (m)</label>
                <input v-model="transmitter.tx_height" type="number" class="form-control form-control-sm" id="tx_height" required min="1.0" step="0.1" data-bs-toggle="tooltip" title="Transmitter height above ground in meters (>= 1.0)." />
                <div class="invalid-feedback">Height must be a positive number.</div>
            </div>
        </div>
        <div class="row g-2 mt-2">
            <div class="col-6">
                <label for="tx_gain" class="form-label">Antenna Gain (dB)</label>
                <input v-model="transmitter.tx_gain" type="number" class="form-control form-control-sm" id="tx_gain" required min="0" step="0.1" />
                <div class="invalid-feedback">Gain must be a positive number.</div>
            </div>
        </div>
        <div class="mt-3 d-flex gap-2">
            <button @click="setWithMap" type="button" id="setWithMap" class="btn btn-primary btn-sm" data-bs-toggle="popover" data-bs-trigger="manual" data-bs-placement="left" title="Set Coordinates" data-bs-content="" content="Click on the map to set the transmitter location.">
                Set with Map
            </button>
            <button @click="centerMapOnTransmitter" type="button" class="btn btn-secondary btn-sm">Center map on transmitter</button>
        </div>
    </form>
    <p v-else class="text-muted small mb-0">No node selected. Add a node to edit its parameters.</p>
</template>

<script setup lang="ts">
    import * as bootstrap from 'bootstrap';
    import { useStore } from '../store.ts'
    import { computed, onMounted, ref, watch } from 'vue';
    const store = useStore();
    const transmitter = computed(() => store.selectedNode?.transmitter);

    // Power can be entered in watts or dBm; the two stay in sync (30 dBm = 1 W).
    // The dBm field holds its own text while focused so that round-trip rounding
    // (dBm -> watts -> dBm) doesn't rewrite what the user is typing mid-keystroke.
    const txPowerDbm = ref<string>('');
    const dbmFocused = ref(false);

    const wattsToDbm = (watts: number) => Math.round((10 * Math.log10(watts) + 30) * 100) / 100;

    // Reflect watts -> dBm, but never while the user is actively editing the dBm field.
    watch(
        () => transmitter.value?.tx_power,
        (power) => {
            if (dbmFocused.value) {
                return;
            }
            txPowerDbm.value =
                typeof power === 'number' && !isNaN(power) && power > 0 ? String(wattsToDbm(power)) : '';
        },
        { immediate: true },
    );

    // Reflect dBm -> watts on every keystroke without touching the dBm text itself.
    const onDbmInput = () => {
        const tx = transmitter.value;
        if (!tx) {
            return;
        }
        const dbm = parseFloat(txPowerDbm.value);
        if (isNaN(dbm)) {
            return;
        }
        tx.tx_power = Math.round(Math.pow(10, (dbm - 30) / 10) * 1000) / 1000;
    };

    const onDbmBlur = () => {
        dbmFocused.value = false;
        // Snap the field to the canonical value derived from the stored watts.
        const power = transmitter.value?.tx_power;
        txPowerDbm.value =
            typeof power === 'number' && !isNaN(power) && power > 0 ? String(wattsToDbm(power)) : '';
    };

    const centerMapOnTransmitter = () => {
        const tx = transmitter.value;
        if (tx && !isNaN(tx.tx_lat) && !isNaN(tx.tx_lon)) {
            store.map!.setView([tx.tx_lat, tx.tx_lon], store.map!.getZoom()); // Center map on the coordinates
        } else {
            alert("Please enter valid Latitude and Longitude values.");
        }
    };
    let popover = new bootstrap.Popover(document.createElement("input"), {
        trigger: "manual",
    });

    const setWithMap = () => {
        const node = store.selectedNode;
        if (!node) {
            return;
        }
        popover.show();
        store.map!.once("click", function (e: any) {
            const { lat, lng } = e.latlng; // Get clicked location coordinates
            store.updateNodeCoords(node.id, lat, lng); // Update the store (marker follows via watch)
            popover.hide(); // Hide the popover
        });
    };
    onMounted(() => {
        popover = new bootstrap.Popover(document.getElementById("setWithMap") as Element, {
            trigger: "manual",
        });
        store.initMap(); // Initialize the map
    });

</script>
