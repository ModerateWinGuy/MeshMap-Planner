import type { CoverageGrid } from './sim/coverageTypes.ts'; // type-only: erased at compile, no runtime cycle

// Which task-focused panel the sidebar shows; persisted to localStorage as the active UI mode.
export type UiMode = 'nodes' | 'import' | 'radio' | 'coverage' | 'linkfinder' | 'viewshed' | 'settings';

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
    // When true the node is hidden from the map: no marker, and every link touching it drops out of
    // visibleLinks (2D + 3D). Lets a user focus on a subset without deleting the rest. Absent on
    // nodes persisted before this existed → treated as visible. The node's folder can also hide it
    // (NodeGroup.hidden) — effective visibility is the OR of the two, computed by the store's
    // nodeHidden getter.
    hidden?: boolean;
    // Id of the folder this node belongs to, or absent for an ungrouped (top-level) node. Folders are
    // single-level — a node is in at most one. Absent on nodes persisted before folders existed.
    groupId?: string;
    // Public key (lowercased hex) for nodes pulled from a public map source (MeshCore/MeshMapper).
    // Lets repeated/cross-source syncs dedupe exactly instead of by name+coords. Absent on hand-placed
    // and file-imported nodes.
    meshKey?: string;
}

// A user-created folder grouping nodes in the list. Single-level: folders never nest. Order in the
// store's `groups` array is the display order; membership is the back-reference Node.groupId.
export interface NodeGroup {
    id: string;
    name: string;
    // List UI only: when true the folder is collapsed so its members are hidden from the *list* (not
    // the map). Absent = expanded.
    collapsed?: boolean;
    // Folder-level map visibility. When true every member node is hidden from the map regardless of
    // its own `hidden` flag — which is left untouched, so showing the folder restores each node's
    // prior per-node state. See the store's nodeHidden getter for the combined rule.
    hidden?: boolean;
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
        // Max draped-overlay texture dimension (px). Caps how fine the coverage raster can get: a
        // larger cap buys smaller ground cells at the cost of memory/GPU. Clamped to the GPU's real
        // MAX_TEXTURE_SIZE at use time. May be absent on params persisted before it existed — read
        // with a default (mergeDefaults is shallow).
        overlay_max_texture: number;
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

// A profile curve: a list of [distance_km, value_m] samples along the path.
export type ProfileCurve = Array<[number, number]>;

// Just the ground elevation AMSL (metres) vs distance (km), TX->RX; the line of sight and Fresnel
// zone are derived from it.
export interface ProfileCurves {
    terrain: ProfileCurve;      // ground profile, elevation AMSL
}

// Point-to-point link metrics plus the chart curves and the derived headline link-budget figures
// the bottom strip annotates.
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
    // Per-cell min-margin field (dB) over the shared bbox, rendered as a smooth heatmap like the
    // coverage overlay. NaN marks a non-zone cell; null on the empty result. dbm here carries margin,
    // not received power, so colorizeGrid (which is value-agnostic) drapes it identically.
    // See [[client-side-splat-port]].
    marginGrid: CoverageGrid | null;
    empty: boolean;
    warning: string | null;
}