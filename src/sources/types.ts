// Source-agnostic contract for pulling publicly-published nodes into the map. A "source" is any
// public service that can list nodes for a geographic area (MeshCore's global API, MeshMapper's
// per-region endpoints, …). Adding one is a single file implementing PublicNodeSource plus one entry
// in the registry (see ./index.ts) — the orchestrator and the UI stay untouched.

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

// One node normalised across sources, ready for merge/dedupe.
export interface PublicNodeCandidate {
  // Stable public key (lowercased hex) used for cross-source and re-sync dedupe; null when the source
  // exposes no key (then the orchestrator falls back to a name+coords key).
  key: string | null;
  name: string;
  lat: number;
  lon: number;
  // Real operating frequency (MHz) when the source carries one, else null (the import uses the app
  // default). When a node comes from several sources, the freq-carrying candidate wins.
  freq: number | null;
  sourceId: string;
}

export interface PublicNodeSource {
  // Stable id; also the dedupe tie-break order (earlier in the registry wins ties).
  id: string;
  // Shown next to the source's checkbox in the sync UI.
  label: string;
  defaultEnabled?: boolean;
  // Fetch the candidates this source considers relevant to the view. It may over-return (e.g. a global
  // API ignores the bbox for fetching) — the orchestrator applies the exact bbox filter. `warnings`
  // surface soft limits such as a hit region cap.
  fetchInView(bbox: Bbox, signal?: AbortSignal): Promise<{ candidates: PublicNodeCandidate[]; warnings?: string[] }>;
}
