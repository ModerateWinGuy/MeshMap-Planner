// String -> integer code mappings the ITM core expects for radio climate and polarization.

// Radio climate string -> ITM code (1..7).
export const CLIMATE_MAP: Record<string, number> = {
  equatorial: 1,
  continental_subtropical: 2,
  maritime_subtropical: 3,
  desert: 4,
  continental_temperate: 5,
  maritime_temperate_land: 6,
  maritime_temperate_sea: 7,
};

// Polarization string -> ITM code.
export const POLARIZATION_MAP: Record<string, number> = {
  horizontal: 0,
  vertical: 1,
};

// Fall back to continental temperate / vertical for an unknown label rather than throwing, so a
// stray value can't abort a whole link matrix.
export function climateCode(climate: string): number {
  return CLIMATE_MAP[climate] ?? CLIMATE_MAP.continental_temperate;
}

export function polarizationCode(polarization: string): number {
  return POLARIZATION_MAP[polarization] ?? POLARIZATION_MAP.vertical;
}
