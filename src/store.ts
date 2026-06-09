import { defineStore } from 'pinia';
import { useLocalStorage } from '@vueuse/core';
import { watch, markRaw } from 'vue';
import { randanimalSync } from 'randanimal';
import L from 'leaflet';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import parseGeoraster from 'georaster';
import 'leaflet-easyprint';
import { type Site, type SplatParams, type Node, type MatrixResult, type RelayResult } from './types.ts';
import { cloneObject } from './utils.ts';
import { redPinMarker, selectedPinMarker } from './layers.ts';

const DEFAULT_LAT = 51.102167;
const DEFAULT_LON = -114.098667;

// Meshtastic LoRa modem presets (must match app/services/link_budget.py PRESET_TABLE).
export const LORA_PRESETS = [
  'ShortTurbo', 'ShortFast', 'ShortSlow', 'MediumFast',
  'MediumSlow', 'LongFast', 'LongModerate', 'LongSlow'
];

// Colour a link by its margin: green (strong) -> red (marginal/none). Grey when unknown.
function linkColor(margin: number | null): string {
  if (margin === null || margin === undefined) {
    return '#888888';
  }
  const t = Math.max(0, Math.min(1, margin / 30)); // saturate at +30 dB margin
  const r = Math.round(220 * (1 - t));
  const g = Math.round(40 + 150 * t);
  return `rgb(${r}, ${g}, 50)`;
}

// Colour a relay-zone island by its margin band: 0 (marginal) -> orange,
// 1 (moderate) -> yellow, 2+ (strong) -> green.
function relayBandColor(band: number): string {
  if (band >= 2) {
    return '#2e9e3f'; // strong
  }
  if (band === 1) {
    return '#d9c021'; // moderate
  }
  return '#e08326'; // marginal
}

function defaultTransmitter(): SplatParams['transmitter'] {
  return {
    name: randanimalSync(),
    tx_lat: DEFAULT_LAT,
    tx_lon: DEFAULT_LON,
    tx_power: 0.1,
    tx_freq: 907.0,
    tx_height: 2.0,
    tx_gain: 2.0
  };
}

function defaultReceiver(): SplatParams['receiver'] {
  return {
    rx_sensitivity: -130.0,
    rx_height: 1.0,
    rx_gain: 2.0,
    rx_loss: 2.0
  };
}

function seedNode(): Node {
  return {
    id: crypto.randomUUID(),
    transmitter: defaultTransmitter(),
    receiver: defaultReceiver()
  };
}

const useStore = defineStore('store', {
  state() {
    return {
      map: undefined as undefined | L.Map,
      nodeMarkers: {} as Record<string, L.Marker>,
      linkLayers: {} as Record<string, L.Polyline>,
      dragging: false,
      localSites: [] as Site[], // in-memory only (raster is not JSON-serializable)
      simulationState: 'idle',
      matrixState: 'idle',
      matrixResult: null as MatrixResult | null, // in-memory only
      relayState: 'idle',
      relayResult: null as RelayResult | null, // in-memory only
      relayA: null as string | null, // selected endpoint node ids
      relayB: null as string | null,
      relayLayers: [] as any[], // zone polygon layers (in-memory)
      relayPointMarkers: [] as any[], // suggested-point markers (in-memory)
      nodes: useLocalStorage<Node[]>('nodes', [seedNode()]),
      selectedNodeId: useLocalStorage<string | null>('selectedNodeId', null),
      // shared / global params (per-node radio lives on the nodes themselves)
      splatParams: useLocalStorage('splatParams', {
        lora: {
          preset: 'LongFast'
        },
        environment: {
          radio_climate: 'continental_temperate',
          polarization: 'vertical',
          clutter_height: 1.0,
          ground_dielectric: 15.0,
          ground_conductivity: 0.005,
          atmosphere_bending: 301.0
        },
        simulation: {
          situation_fraction: 95.0,
          time_fraction: 95.0,
          simulation_extent: 30.0,
          high_resolution: false
        },
        display: {
          color_scale: 'plasma',
          min_dbm: -130.0,
          max_dbm: -80.0,
          overlay_transparency: 50
        }
      }, { mergeDefaults: true }) // merge so previously-stored params gain new keys (e.g. lora)
    }
  },
  getters: {
    selectedNode(state): Node | undefined {
      return state.nodes.find((n) => n.id === state.selectedNodeId) ?? state.nodes[0];
    }
  },
  actions: {
    addNode() {
      const base = this.selectedNode;
      const center = this.map ? this.map.getCenter() : { lat: DEFAULT_LAT, lng: DEFAULT_LON };
      const node: Node = {
        id: crypto.randomUUID(),
        transmitter: {
          ...(base ? cloneObject(base.transmitter) : defaultTransmitter()),
          name: randanimalSync(),
          tx_lat: Number(center.lat.toFixed(6)),
          tx_lon: Number(center.lng.toFixed(6))
        },
        receiver: base ? cloneObject(base.receiver) : defaultReceiver()
      };
      this.nodes.push(node);
      this.selectedNodeId = node.id;
      this.renderNodeMarkers();
    },
    selectNode(id: string) {
      this.selectedNodeId = id;
      this.renderNodeMarkers();
    },
    deleteNode(id: string) {
      const idx = this.nodes.findIndex((n) => n.id === id);
      if (idx === -1) {
        return;
      }
      this.nodes.splice(idx, 1);
      if (this.selectedNodeId === id) {
        this.selectedNodeId = this.nodes[0]?.id ?? null;
      }
      this.renderNodeMarkers();
    },
    updateNodeCoords(id: string, lat: number, lon: number) {
      const node = this.nodes.find((n) => n.id === id);
      if (!node) {
        return;
      }
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      node.transmitter.tx_lat = lat;
      node.transmitter.tx_lon = lon;
    },
    renderNodeMarkers() {
      if (!this.map) {
        return;
      }
      // Remove markers for nodes that no longer exist
      for (const id of Object.keys(this.nodeMarkers)) {
        if (!this.nodes.find((n) => n.id === id)) {
          this.map.removeLayer(this.nodeMarkers[id]);
          delete this.nodeMarkers[id];
        }
      }
      const selectedId = this.selectedNode?.id;
      for (const node of this.nodes) {
        const icon = node.id === selectedId ? selectedPinMarker : redPinMarker;
        const latlng: [number, number] = [node.transmitter.tx_lat, node.transmitter.tx_lon];
        let marker = this.nodeMarkers[node.id];
        if (!marker) {
          marker = L.marker(latlng, { icon, draggable: true });
          marker.on('dragstart', () => {
            this.dragging = true;
          });
          marker.on('dragend', (e: L.DragEndEvent) => {
            const { lat, lng } = (e.target as L.Marker).getLatLng();
            this.updateNodeCoords(node.id, lat, lng);
            this.dragging = false;
          });
          marker.on('click', () => this.selectNode(node.id));
          marker.addTo(this.map as L.Map);
          // markRaw so the marker isn't wrapped in a reactive Proxy in state — Leaflet relies
          // on raw `===` identity for its event bookkeeping (see initMap).
          this.nodeMarkers[node.id] = markRaw(marker);
        } else {
          marker.setIcon(icon);
          marker.setLatLng(latlng);
        }
        marker.bindPopup(node.transmitter.name);
      }
    },
    toggleSiteVisibility(index: number) {
      const site = this.localSites[index];
      if (!site) {
        return;
      }
      site.visible = site.visible === false;
      this.redrawSites();
    },
    removeSite(index: number) {
      if (!this.map) {
        return
      }
      this.localSites.splice(index, 1)
      this.map.eachLayer((layer: L.Layer) => {
        if (layer instanceof GeoRasterLayer) {
          this.map!.removeLayer(layer);
        }
      });
      this.redrawSites()
    },
    redrawSites() {
      if (!this.map) {
        return;
      }

      // Remove existing GeoRasterLayers
      this.map.eachLayer((layer: L.Layer) => {
        if (layer instanceof GeoRasterLayer) {
          this.map!.removeLayer(layer);
        }
      });

      // Add GeoRasterLayers back to the map (skip results hidden via the eye toggle)
      this.localSites.forEach((site: Site) => {
        if (site.visible === false) {
          return;
        }
        const rasterLayer = new GeoRasterLayer({
          georaster: {...site}.raster,
          opacity: 0.7,
          // noDataValue is a valid runtime option but missing from the lib's types (4.1.2)
          noDataValue: 255,
          resolution: 256,
          // georaster-layer-for-leaflet 4.1.2 keeps its tile `cache` on the prototype
          // (shared across all instances) keyed only by tile coords, so a removed layer's
          // tiles get served to a new layer over the same bounds. Disable it so each
          // result renders its own raster.
          caching: false,
          // The library only sets these GridLayer flags for URL-sourced rasters; for our
          // in-memory rasters it leaves the defaults (updateWhenIdle:true,
          // updateWhenZooming:false), which makes the overlay rely on a CSS transform during
          // zoom and only refresh when the map goes idle. A single wheel-notch zoom desyncs
          // that transform and leaves the overlay offset until a later zoom forces a full
          // reset. Re-rendering during zoom and on every move keeps it aligned with the map.
          updateWhenIdle: false,
          updateWhenZooming: true,
        } as any);
        rasterLayer.addTo(this.map as L.Map);
        rasterLayer.bringToFront();
      });
    },
    destroyMap() {
      // Leaflet only unsubscribes a layer's map events via a once('remove') handler that
      // fires from map.removeLayer. If a map is abandoned without map.remove(), every layer
      // it holds (base tiles, overlays, markers) stays subscribed to that map's 'zoomanim';
      // on the next zoom GridLayer._updateLevels dereferences the now-null _map and throws
      // "map is null", which aborts the zoom and leaves layers drifted. map.remove() tears
      // every layer down cleanly. Pair this with the onUnmounted hook so a component remount
      // (Vite HMR, navigation) can't leave orphaned handlers behind.
      if (!this.map) {
        return;
      }
      this.map.remove();
      this.map = undefined;
      this.nodeMarkers = {};
      this.linkLayers = {};
    },
    initMap() {
      // Guard against re-initialising onto a live map: initMap runs from Transmitter's
      // onMounted, which fires again on a remount. Without tearing down first, the old map's
      // layers leak their 'zoomanim' handlers (see destroyMap).
      this.destroyMap();
      // markRaw is essential: this.map lives in Pinia state, so without it Vue wraps the map
      // in a reactive Proxy and deeply proxies its internals — including the _events registry.
      // Leaflet stores each listener's context there and later matches it with raw `===` in
      // off()/_listens(). A proxied stored context never equals the raw layer passed to
      // removeLayer, so the layer's 'zoomanim' handler is never unsubscribed; on the next zoom
      // it runs with a null _map and throws "map is null", aborting the zoom and drifting every
      // layer. Keeping the map raw makes all of Leaflet's identity checks work.
      this.map = markRaw(L.map("map", {
        // center: [51.102167, -114.098667],
        zoom: 10,
        zoomControl: false,
      }));

      const start = this.selectedNode;
      const position: [number, number] = [
        start ? start.transmitter.tx_lat : DEFAULT_LAT,
        start ? start.transmitter.tx_lon : DEFAULT_LON
      ];
      this.map.setView(position, 10);

      L.control.zoom({ position: "bottomleft" }).addTo(this.map as L.Map);

      const cartoLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap contributors © CARTO',
      });

      const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
      })

      const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri — Source: Esri, USGS, NOAA',
      });

      const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data: © OpenStreetMap contributors, SRTM | OpenTopoMap',
      });

      streetLayer.addTo(this.map as L.Map);

      // Base Layers
      const baseLayers = {
        "OSM": streetLayer,
        "Carto Light": cartoLight,
        "Satellite": satelliteLayer,
        "Topo Map": topoLayer
      };

      // EasyPrint control
      (L as any).easyPrint({
        title: "Save",
        position: "bottomleft",
        sizeModes: ["A4Portrait", "A4Landscape"],
        filename: "sites",
        exportOnly: true
      }).addTo(this.map as L.Map);

      L.control.layers(baseLayers, {}, {
        position: "bottomleft",
      }).addTo(this.map as L.Map);

      this.map.on("baselayerchange", () => {
        this.redrawSites(); // Re-apply the GeoRasterLayer on top
      });

      if (!this.selectedNodeId && this.nodes[0]) {
        this.selectedNodeId = this.nodes[0].id;
      }
      this.renderNodeMarkers();
      this.redrawSites();

      // Keep markers in sync with manual lat/lon edits and renames.
      // Guard against re-rendering mid-drag (dragend handles that).
      watch(
        () =>
          this.nodes
            .map((n) => `${n.id}:${n.transmitter.tx_lat}:${n.transmitter.tx_lon}:${n.transmitter.name}`)
            .join('|'),
        () => {
          if (!this.dragging) {
            this.renderNodeMarkers();
            this.redrawLinks();
          }
        }
      );
    },
    async runSimulation() {
      console.log('Simulation running...')
      try {
        const node = this.selectedNode;
        if (!node) {
          console.warn('No node selected; cannot run simulation.');
          return;
        }
        // Collect input values
        const payload = {
          // Transmitter parameters (per-node)
          lat: node.transmitter.tx_lat,
          lon: node.transmitter.tx_lon,
          tx_height: node.transmitter.tx_height,
          tx_power: 10 * Math.log10(node.transmitter.tx_power) + 30,
          tx_gain: node.transmitter.tx_gain,
          frequency_mhz: node.transmitter.tx_freq,

          // Receiver parameters (per-node)
          rx_height: node.receiver.rx_height,
          rx_gain: node.receiver.rx_gain,
          signal_threshold: node.receiver.rx_sensitivity,
          system_loss: node.receiver.rx_loss,

          // Environment parameters (shared)
          clutter_height: this.splatParams.environment.clutter_height,
          ground_dielectric: this.splatParams.environment.ground_dielectric,
          ground_conductivity: this.splatParams.environment.ground_conductivity,
          atmosphere_bending: this.splatParams.environment.atmosphere_bending,
          radio_climate: this.splatParams.environment.radio_climate,
          polarization: this.splatParams.environment.polarization,

          // Simulation parameters (shared)
          radius: this.splatParams.simulation.simulation_extent * 1000,
          situation_fraction: this.splatParams.simulation.situation_fraction,
          time_fraction: this.splatParams.simulation.time_fraction,
          high_resolution: this.splatParams.simulation.high_resolution,

          // Display parameters (shared)
          colormap: this.splatParams.display.color_scale,
          min_dbm: this.splatParams.display.min_dbm,
          max_dbm: this.splatParams.display.max_dbm,
        };

        console.log("Payload:", payload);
        this.simulationState = 'running';

        // Send the request to the backend's /predict endpoint
        const predictResponse = await fetch("/predict", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!predictResponse.ok) {
          this.simulationState = 'failed';
          const errorDetails = await predictResponse.text();
          throw new Error(`Failed to start prediction: ${errorDetails}`);
        }

        const predictData = await predictResponse.json();
        const taskId = predictData.task_id;

        console.log(`Prediction started with task ID: ${taskId}`);

        // Poll for task status and result
        const pollInterval = 1000; // 1 seconds
        const pollStatus = async () => {
          const statusResponse = await fetch(
            `/status/${taskId}`,
          );
          if (!statusResponse.ok) {
            throw new Error("Failed to fetch task status.");
          }

          const statusData = await statusResponse.json();
          console.log("Task status:", statusData);

          if (statusData.status === "completed") {
            this.simulationState = 'completed';
            console.log("Simulation completed! Adding result to the map...");

            // Fetch the GeoTIFF data
            const resultResponse = await fetch(
              `/result/${taskId}`,
            );
            if (!resultResponse.ok) {
              throw new Error("Failed to fetch simulation result.");
            }
            else
            {
              const arrayBuffer = await resultResponse.arrayBuffer();
              // markRaw: the parsed georaster is a large in-memory object handed straight to
              // Leaflet (GeoRasterLayer); keep it raw so it isn't deeply proxied in state.
              const geoRaster = markRaw(await parseGeoraster(arrayBuffer));
              const params: SplatParams = cloneObject({
                transmitter: node.transmitter,
                receiver: node.receiver,
                environment: this.splatParams.environment,
                simulation: this.splatParams.simulation,
                display: this.splatParams.display
              });
              this.localSites.push({
                params,
                taskId,
                raster: geoRaster,
                visible: true
              });
              this.redrawSites();
            }
          }
          else if (statusData.status === "failed") {
            this.simulationState = 'failed';
          } else {
            setTimeout(pollStatus, pollInterval); // Retry after interval
          }
        };

        pollStatus(); // Start polling
      } catch (error) {
        console.error("Error:", error);
      }
    },
    redrawLinks() {
      if (!this.map) {
        return;
      }
      // Remove existing link polylines
      for (const key of Object.keys(this.linkLayers)) {
        this.map.removeLayer(this.linkLayers[key]);
        delete this.linkLayers[key];
      }
      if (!this.matrixResult) {
        return;
      }
      const byId: Record<string, Node> = {};
      for (const n of this.nodes) {
        byId[n.id] = n;
      }
      for (const link of this.matrixResult.links) {
        const a = byId[link.a];
        const b = byId[link.b];
        if (!a || !b) {
          continue; // node was deleted since the matrix ran
        }
        const poly = L.polyline(
          [
            [a.transmitter.tx_lat, a.transmitter.tx_lon],
            [b.transmitter.tx_lat, b.transmitter.tx_lon]
          ],
          {
            color: linkColor(link.margin_db),
            weight: link.viable ? 3 : 1.5,
            opacity: link.viable ? 0.9 : 0.5,
            dashArray: link.viable ? undefined : '6 6'
          }
        );
        const details = link.error
          ? `Error: ${link.error}`
          : `Margin: ${link.margin_db ?? '—'} dB<br>` +
            `Path loss: ${link.path_loss_db ?? '—'} dB<br>` +
            `Fresnel zone: ${link.fresnel_pct ?? '—'} % clear<br>` +
            `Distance: ${link.distance_km ?? '—'} km`;
        poly.bindPopup(`<strong>${a.transmitter.name} ↔ ${b.transmitter.name}</strong><br>${details}`);
        poly.addTo(this.map as L.Map);
        // markRaw: keep the polyline a raw Leaflet object in state (see initMap).
        this.linkLayers[`${link.a}|${link.b}`] = markRaw(poly);
      }
    },
    async runMatrix() {
      if (this.nodes.length < 2) {
        console.warn('Need at least 2 nodes to compute a link matrix.');
        return;
      }
      try {
        this.matrixState = 'running';
        const preset = this.splatParams.lora?.preset ?? 'LongFast';
        const payload = {
          nodes: this.nodes.map((n) => ({
            id: n.id,
            name: n.transmitter.name,
            lat: n.transmitter.tx_lat,
            lon: n.transmitter.tx_lon,
            height: n.transmitter.tx_height,
            tx_power: 10 * Math.log10(n.transmitter.tx_power) + 30, // watts -> dBm
            tx_gain: n.transmitter.tx_gain,
            rx_gain: n.receiver.rx_gain,
            frequency_mhz: n.transmitter.tx_freq,
            system_loss: n.receiver.rx_loss
          })),
          lora_preset: preset,
          // shared environment / simulation params
          clutter_height: this.splatParams.environment.clutter_height,
          ground_dielectric: this.splatParams.environment.ground_dielectric,
          ground_conductivity: this.splatParams.environment.ground_conductivity,
          atmosphere_bending: this.splatParams.environment.atmosphere_bending,
          radio_climate: this.splatParams.environment.radio_climate,
          polarization: this.splatParams.environment.polarization,
          situation_fraction: this.splatParams.simulation.situation_fraction,
          time_fraction: this.splatParams.simulation.time_fraction,
          high_resolution: this.splatParams.simulation.high_resolution
        };

        const matrixResponse = await fetch('/matrix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!matrixResponse.ok) {
          this.matrixState = 'failed';
          throw new Error(`Failed to start matrix: ${await matrixResponse.text()}`);
        }
        const { task_id: taskId } = await matrixResponse.json();
        console.log(`Link matrix started with task ID: ${taskId}`);

        const pollInterval = 1000;
        const pollStatus = async () => {
          const statusResponse = await fetch(`/status/${taskId}`);
          if (!statusResponse.ok) {
            throw new Error('Failed to fetch matrix status.');
          }
          const statusData = await statusResponse.json();
          if (statusData.status === 'completed') {
            const resultResponse = await fetch(`/matrix/result/${taskId}`);
            if (!resultResponse.ok) {
              throw new Error('Failed to fetch matrix result.');
            }
            this.matrixResult = await resultResponse.json();
            this.matrixState = 'completed';
            this.redrawLinks();
          } else if (statusData.status === 'failed') {
            this.matrixState = 'failed';
          } else {
            setTimeout(pollStatus, pollInterval);
          }
        };
        pollStatus();
      } catch (error) {
        console.error('Matrix error:', error);
        this.matrixState = 'failed';
      }
    },
    async runRelay(aId: string, bId: string) {
      const a = this.nodes.find((n) => n.id === aId);
      const b = this.nodes.find((n) => n.id === bId);
      if (!a || !b || a.id === b.id) {
        console.warn('Relay finder needs two distinct nodes.');
        return;
      }
      try {
        this.relayState = 'running';
        const preset = this.splatParams.lora?.preset ?? 'LongFast';
        const toNode = (n: Node) => ({
          id: n.id,
          name: n.transmitter.name,
          lat: n.transmitter.tx_lat,
          lon: n.transmitter.tx_lon,
          height: n.transmitter.tx_height,
          tx_power: 10 * Math.log10(n.transmitter.tx_power) + 30, // watts -> dBm
          tx_gain: n.transmitter.tx_gain,
          rx_gain: n.receiver.rx_gain,
          frequency_mhz: n.transmitter.tx_freq,
          system_loss: n.receiver.rx_loss
        });
        const payload = {
          node_a: toNode(a),
          node_b: toNode(b),
          lora_preset: preset,
          relay_rx_gain: a.receiver.rx_gain,
          search_radius_m: this.splatParams.simulation.simulation_extent * 1000,
          top_n: 5,
          // shared environment / simulation params
          clutter_height: this.splatParams.environment.clutter_height,
          ground_dielectric: this.splatParams.environment.ground_dielectric,
          ground_conductivity: this.splatParams.environment.ground_conductivity,
          atmosphere_bending: this.splatParams.environment.atmosphere_bending,
          radio_climate: this.splatParams.environment.radio_climate,
          polarization: this.splatParams.environment.polarization,
          situation_fraction: this.splatParams.simulation.situation_fraction,
          time_fraction: this.splatParams.simulation.time_fraction,
          high_resolution: this.splatParams.simulation.high_resolution
        };

        const relayResponse = await fetch('/relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!relayResponse.ok) {
          this.relayState = 'failed';
          throw new Error(`Failed to start relay: ${await relayResponse.text()}`);
        }
        const { task_id: taskId } = await relayResponse.json();
        console.log(`Relay finder started with task ID: ${taskId}`);

        const pollInterval = 1000;
        const pollStatus = async () => {
          const statusResponse = await fetch(`/status/${taskId}`);
          if (!statusResponse.ok) {
            throw new Error('Failed to fetch relay status.');
          }
          const statusData = await statusResponse.json();
          if (statusData.status === 'completed') {
            const resultResponse = await fetch(`/relay/result/${taskId}`);
            if (!resultResponse.ok) {
              throw new Error('Failed to fetch relay result.');
            }
            this.relayResult = await resultResponse.json();
            this.relayState = 'completed';
            this.redrawRelay();
          } else if (statusData.status === 'failed') {
            this.relayState = 'failed';
          } else {
            setTimeout(pollStatus, pollInterval);
          }
        };
        pollStatus();
      } catch (error) {
        console.error('Relay error:', error);
        this.relayState = 'failed';
      }
    },
    redrawRelay() {
      if (!this.map) {
        return;
      }
      // Tear down any existing relay overlay (zone polygons + suggested points).
      for (const layer of this.relayLayers) {
        this.map.removeLayer(layer);
      }
      this.relayLayers = [];
      for (const marker of this.relayPointMarkers) {
        this.map.removeLayer(marker);
      }
      this.relayPointMarkers = [];

      const result = this.relayResult;
      if (!result || result.empty) {
        return;
      }

      // Candidate zone: one polygon per island, coloured by its margin band.
      const zoneLayer = L.geoJSON(result.zone as any, {
        style: (feature) => {
          const band = feature?.properties?.band ?? 0;
          const color = relayBandColor(band);
          return { color, weight: 1, fillColor: color, fillOpacity: 0.35 };
        },
        onEachFeature: (feature, layer) => {
          const p = feature.properties;
          layer.bindPopup(
            `<strong>Relay zone</strong><br>` +
            `Band: ${p.label}<br>` +
            `Peak margin: ${p.peak_margin} dB<br>` +
            `Area: ${p.area_km2} km²`
          );
        }
      });
      zoneLayer.addTo(this.map as L.Map);
      this.relayLayers.push(zoneLayer);

      // Suggested points: clickable circle markers with a "Promote to node" action.
      for (const feature of result.points.features) {
        const [lon, lat] = feature.geometry.coordinates as [number, number];
        const p = feature.properties;
        const marker = L.circleMarker([lat, lon], {
          radius: 7,
          color: '#1d3557',
          weight: 2,
          fillColor: linkColor(p.min_margin),
          fillOpacity: 0.95
        });
        const html =
          `<strong>Relay candidate #${p.rank}</strong><br>` +
          `Min margin: ${p.min_margin} dB<br>` +
          `Margin to A: ${p.margin_a} dB · to B: ${p.margin_b} dB<br>` +
          `<button type="button" class="btn btn-sm btn-success mt-2 relay-promote-btn">Promote to node</button>`;
        marker.bindPopup(html);
        marker.on('popupopen', (e: L.PopupEvent) => {
          const el = (e.popup as L.Popup).getElement();
          const btn = el?.querySelector('.relay-promote-btn');
          if (btn) {
            btn.addEventListener(
              'click',
              () => {
                this.promoteRelayPoint(lat, lon);
                this.map?.closePopup();
              },
              { once: true }
            );
          }
        });
        marker.addTo(this.map as L.Map);
        this.relayPointMarkers.push(marker);
      }
    },
    clearRelay() {
      if (this.map) {
        for (const layer of this.relayLayers) {
          this.map.removeLayer(layer);
        }
        for (const marker of this.relayPointMarkers) {
          this.map.removeLayer(marker);
        }
      }
      this.relayLayers = [];
      this.relayPointMarkers = [];
      this.relayResult = null;
      this.relayState = 'idle';
    },
    promoteRelayPoint(lat: number, lon: number, name?: string) {
      const base = this.selectedNode;
      const node: Node = {
        id: crypto.randomUUID(),
        transmitter: {
          ...(base ? cloneObject(base.transmitter) : defaultTransmitter()),
          name: name ?? randanimalSync(),
          tx_lat: Number(lat.toFixed(6)),
          tx_lon: Number(lon.toFixed(6))
        },
        receiver: base ? cloneObject(base.receiver) : defaultReceiver()
      };
      this.nodes.push(node);
      this.selectedNodeId = node.id;
      this.renderNodeMarkers();
    }
  }
});

export { useStore }
