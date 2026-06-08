import { defineStore } from 'pinia';
import { useLocalStorage } from '@vueuse/core';
import { watch } from 'vue';
import { randanimalSync } from 'randanimal';
import L from 'leaflet';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import parseGeoraster from 'georaster';
import 'leaflet-easyprint';
import { type Site, type SplatParams, type Node } from './types.ts';
import { cloneObject } from './utils.ts';
import { redPinMarker, selectedPinMarker } from './layers.ts';

const DEFAULT_LAT = 51.102167;
const DEFAULT_LON = -114.098667;

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
      dragging: false,
      localSites: [] as Site[], // in-memory only (raster is not JSON-serializable)
      simulationState: 'idle',
      nodes: useLocalStorage<Node[]>('nodes', [seedNode()]),
      selectedNodeId: useLocalStorage<string | null>('selectedNodeId', null),
      // shared / global params (per-node radio lives on the nodes themselves)
      splatParams: useLocalStorage('splatParams', {
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
      })
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
          this.nodeMarkers[node.id] = marker;
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
    initMap() {
      this.map = L.map("map", {
        // center: [51.102167, -114.098667],
        zoom: 10,
        zoomControl: false,
      });
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
              const geoRaster = await parseGeoraster(arrayBuffer);
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
    }
  }
});

export { useStore }
