// Which task-focused panel the sidebar shows; persisted to localStorage as the active UI mode.
import type { CoverageGrid } from './sim/coverageTypes.ts'; // type-only: erased at compile, no runtime cycle

export type UiMode = 'nodes' | 'radio' | 'coverage' | 'linkfinder' | 'viewshed' | 'settings';

export interface Site {
    params: SplatParams;
    taskId: string;
    raster: any;
    visible: boolean;
    // Coverage overlay for MapLibre: the palette-decoded RGBA canvas (markRaw'd, non-reactive)
    // and its four corner coordinates [lng,lat] (TL, TR, BR, BL). Built once at parse time.
    image?: HTMLCanvasElement;
    coords?: [[number, number], [number, number], [number, number], [number, number]];
}
export interface Node {
    id: string;
    transmitter: SplatParams['transmitter'];
    receiver: SplatParams['receiver'];
}
export interface SplatParams {
    transmitter: {
        name: string;
        tx_lat: number;
        tx_lon: number;
        tx_power: number;
        tx_freq: number;
        tx_height: number;
        tx_gain: number;
    };
    receiver: {
        rx_sensitivity: number;
        rx_height: number;
        rx_gain: number;
        rx_loss: number;
    };
    environment: {
        radio_climate: string;
        polarization: string;
        clutter_height: number;
        ground_dielectric: number;
        ground_conductivity: number;
        atmosphere_bending: number;
    };
    simulation: {
        situation_fraction: number;
        time_fraction: number;
        simulation_extent: number;
        filter_radio_horizon: boolean;
        // Browser-side sim fidelity preset (terrain-profile sampling detail vs speed). May be absent
        // on params persisted before it existed (mergeDefaults is shallow) — read with a default.
        quality: 'draft' | 'balanced' | 'high' | 'max';
    };
    display: {
        color_scale: string;
        min_dbm: number;
        max_dbm: number;
        overlay_transparency: number;
    };
    lora?: {
        preset: string;
    };
}
export interface LinkResult {
    a: string;
    b: string;
    distance_km: number | null;
    path_loss_db: number | null;
    rx_power_dbm: number | null;
    fresnel_pct: number | null;
    margin_db: number | null;
    viable: boolean;
    error: string | null;
}
export interface MatrixResult {
    nodes: string[];
    preset: string | null;
    sensitivity_dbm: number;
    links: LinkResult[];
}

// A SPLAT! profile curve: a list of [distance_km, value_m] samples along the path.
export type ProfileCurve = Array<[number, number]>;

// Curves SPLAT! emits for the terrain graph (`-p`). Just the ground elevation above sea level
// (metres) vs distance (km), TX->RX; the frontend derives the line of sight and Fresnel zone.
export interface ProfileCurves {
    terrain: ProfileCurve;      // ground profile, elevation AMSL (profile.gp)
}

// Result of POST /profile: the point-to-point link metrics plus the chart curves and the derived
// headline link-budget figures the bottom strip annotates.
export interface ProfileResult {
    distance_km: number | null;
    path_loss_db: number | null;
    free_space_db: number | null;
    rx_power_dbm: number | null;
    fresnel_pct: number | null;
    tx_eirp_dbm: number;
    rx_signal_dbm: number | null;
    margin_db: number | null;
    sensitivity_dbm: number;
    viable: boolean;
    profile: ProfileCurves;
}

// Geometry is `any` to avoid a dependency on @types/geojson; properties are typed per layer.
export interface FeatureCollection<P> {
    type: 'FeatureCollection';
    features: Array<{
        type: 'Feature';
        geometry: any;
        properties: P;
    }>;
}

export interface RelayZoneProps {
    island_id: number;
    peak_margin: number;
    area_km2: number;
    band: number;
    label: string;
}

export interface RelayPointProps {
    rank: number;
    island_id: number;
    min_margin: number;
    margin_a: number;
    margin_b: number;
}

export interface RelayResult {
    sensitivity_dbm: number;
    node_a: string;
    node_b: string;
    relay_rx_gain: number;
    zone: FeatureCollection<RelayZoneProps>;
    points: FeatureCollection<RelayPointProps>;
    // Per-cell min-margin field (dB) over the shared bbox, rendered as a smooth heatmap the way the
    // coverage overlay renders dBm — replaces the old blocky banded polygons. NaN marks a non-zone
    // cell; null on the empty result. dbm here carries margin, not received power, so colorizeGrid
    // (which is value-agnostic) drapes it identically. See [[client-side-splat-port]].
    marginGrid: CoverageGrid | null;
    empty: boolean;
    warning: string | null;
}