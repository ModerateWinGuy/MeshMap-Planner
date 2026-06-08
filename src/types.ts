export interface Site {
    params: SplatParams;
    taskId: string;
    raster: any;
    visible: boolean;
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
        high_resolution: boolean;
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