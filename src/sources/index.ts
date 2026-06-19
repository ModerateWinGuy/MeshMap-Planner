import type { Node } from '../types.ts';
import { dedupeKey } from '../meshcore.ts';
import type { Bbox, PublicNodeCandidate, PublicNodeSource } from './types.ts';
import { meshCoreSource } from './meshcore.ts';
import { meshMapperSource } from './meshmapper.ts';

// The single registry of node sources. Order is the dedupe tie-break (earlier wins when neither
// candidate carries a frequency). Adding a source = append its PublicNodeSource here; nothing else
// in the orchestrator or UI changes.
export const PUBLIC_NODE_SOURCES: PublicNodeSource[] = [meshCoreSource, meshMapperSource];

// A node ready for store.importPublicMapNodes.
export interface ImportRow {
  name: string;
  lat: number;
  lon: number;
  freq: number | null;
  meshKey: string | null;
}

export interface SyncResult {
  rows: ImportRow[];
  duplicates: number; // candidates skipped because already on the map
  perSource: Record<string, number>; // in-view count per source, before cross-source dedupe
  warnings: string[];
}

const round6 = (n: number): number => Number(n.toFixed(6));

// A candidate's stable identity: its public key when present, otherwise the name+coords key the
// contacts import already dedupes on.
function identity(c: { key: string | null; name: string; lat: number; lon: number }): string {
  return c.key ?? dedupeKey(c.name, round6(c.lat), round6(c.lon));
}

function inBounds(lat: number, lon: number, b: Bbox): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

// Run the enabled sources, clip to the exact view, and dedupe — within the batch and against nodes
// already on the map — into rows the store can import. Fully source-agnostic: it never names a
// specific service, so new sources need no changes here.
export async function syncPublicNodes(
  enabledIds: string[],
  bbox: Bbox,
  existingNodes: Node[],
  signal?: AbortSignal
): Promise<SyncResult> {
  const sources = PUBLIC_NODE_SOURCES.filter((s) => enabledIds.includes(s.id));
  const order = new Map(PUBLIC_NODE_SOURCES.map((s, i) => [s.id, i] as const));
  const warnings: string[] = [];
  const perSource: Record<string, number> = {};

  const fetched = await Promise.allSettled(sources.map((s) => s.fetchInView(bbox, signal)));

  const candidates: PublicNodeCandidate[] = [];
  fetched.forEach((res, i) => {
    const src = sources[i];
    if (res.status === 'fulfilled') {
      const inView = res.value.candidates.filter((c) => inBounds(c.lat, c.lon, bbox));
      perSource[src.id] = inView.length;
      candidates.push(...inView);
      if (res.value.warnings) {
        warnings.push(...res.value.warnings);
      }
    } else {
      perSource[src.id] = 0;
      warnings.push(`${src.label} could not be reached.`);
    }
  });

  // Dedupe within this batch: one candidate per identity, preferring one that carries a freq, then the
  // source registered earliest.
  const best = new Map<string, PublicNodeCandidate>();
  for (const c of candidates) {
    const id = identity(c);
    const prev = best.get(id);
    if (!prev) {
      best.set(id, c);
      continue;
    }
    const cRank = order.get(c.sourceId) ?? Infinity;
    const prevRank = order.get(prev.sourceId) ?? Infinity;
    const better =
      (c.freq != null && prev.freq == null) ||
      ((c.freq == null) === (prev.freq == null) && cRank < prevRank);
    if (better) {
      best.set(id, c);
    }
  }

  // Everything already on the map, keyed by stored meshKey and by name+coords (so re-syncs and
  // pre-existing/imported nodes both dedupe).
  const existing = new Set<string>();
  for (const n of existingNodes) {
    if (n.meshKey) {
      existing.add(n.meshKey.toLowerCase());
    }
    existing.add(dedupeKey(n.transmitter.name, round6(n.transmitter.tx_lat), round6(n.transmitter.tx_lon)));
  }

  const rows: ImportRow[] = [];
  let duplicates = 0;
  for (const c of best.values()) {
    const keyHit = c.key != null && existing.has(c.key);
    const coordHit = existing.has(dedupeKey(c.name, round6(c.lat), round6(c.lon)));
    if (keyHit || coordHit) {
      duplicates++;
      continue;
    }
    rows.push({ name: c.name, lat: round6(c.lat), lon: round6(c.lon), freq: c.freq, meshKey: c.key });
  }

  return { rows, duplicates, perSource, warnings };
}
