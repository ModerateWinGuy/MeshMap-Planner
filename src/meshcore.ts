import type { Node } from './types.ts';

// MeshCore contact `type` codes, for the import preview's per-row label.
export const MESHCORE_TYPE_LABELS: Record<number, string> = {
  1: 'Companion',
  2: 'Repeater',
  3: 'Room server',
};

// The contact types we turn into nodes: repeaters and room servers (fixed infrastructure that
// advertises a location). Companions (type 1) are person-carried and usually report no fix.
const IMPORTABLE_TYPES = new Set([2, 3]);

export interface ContactCandidate {
  name: string;
  lat: number;
  lon: number;
  typeLabel: string;
  // True when a node with the same name + location already exists, or an identical contact appeared
  // earlier in this same file. The preview leaves these unchecked so re-imports don't pile up dupes.
  isDuplicate: boolean;
}

export interface ParsedContacts {
  candidates: ContactCandidate[];
  // Contacts of an importable type that carried no usable location (0,0 sentinel or unparseable).
  skippedNoLocation: number;
}

// Dedupe key at the same 6-dp precision the store rounds coords to (see addNode), so a re-import of
// an already-placed contact keys identically and is flagged.
function dedupeKey(name: string, lat: number, lon: number): string {
  return `${name}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
}

// Parse a MeshCore contacts export into importable candidates. `existingNodes` seeds the duplicate
// check. Throws a user-facing Error on anything that isn't a contacts export.
export function parseMeshcoreContacts(rawJson: unknown, existingNodes: Node[]): ParsedContacts {
  if (!rawJson || typeof rawJson !== 'object' || !Array.isArray((rawJson as { contacts?: unknown }).contacts)) {
    throw new Error('Not a MeshCore export: expected a top-level "contacts" array.');
  }
  const contacts = (rawJson as { contacts: unknown[] }).contacts;

  const seen = new Set(
    existingNodes.map((n) => dedupeKey(n.transmitter.name, n.transmitter.tx_lat, n.transmitter.tx_lon))
  );

  const candidates: ContactCandidate[] = [];
  let skippedNoLocation = 0;

  for (const raw of contacts) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const c = raw as Record<string, unknown>;
    const type = Number(c.type);
    if (!IMPORTABLE_TYPES.has(type)) {
      continue;
    }

    const lat = Number(c.latitude);
    const lon = Number(c.longitude);
    // 0,0 is MeshCore's "no fix" sentinel; guard NaN from missing/garbage fields too.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      skippedNoLocation++;
      continue;
    }

    const custom = typeof c.custom_name === 'string' ? c.custom_name.trim() : '';
    const base = typeof c.name === 'string' ? c.name.trim() : '';
    const name = custom || base || 'Unnamed';

    const lat6 = Number(lat.toFixed(6));
    const lon6 = Number(lon.toFixed(6));
    const key = dedupeKey(name, lat6, lon6);
    const isDuplicate = seen.has(key);
    seen.add(key); // a later identical row in this same file also counts as a duplicate

    candidates.push({
      name,
      lat: lat6,
      lon: lon6,
      typeLabel: MESHCORE_TYPE_LABELS[type] ?? `Type ${type}`,
      isDuplicate,
    });
  }

  return { candidates, skippedNoLocation };
}
