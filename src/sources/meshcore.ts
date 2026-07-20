import type { Bbox, PublicNodeCandidate, PublicNodeSource } from './types.ts';
import { IMPORTABLE_TYPES } from '../meshcore.ts';
import { i18n } from '../i18n/index.ts';

const MESHCORE_URL = 'https://api.meshcore.nz/api/v1/map/nodes';

// MeshCore's public map API: one global, CORS-open endpoint (~15 MB) listing every published node. We
// fetch it whole and let the orchestrator clip to the view. We keep only repeaters and room servers
// (the same IMPORTABLE_TYPES the contacts import uses) and carry the real LoRa frequency.
async function fetchAll(signal?: AbortSignal): Promise<PublicNodeCandidate[]> {
  let res: Response;
  try {
    res = await fetch(MESHCORE_URL, { mode: 'cors', signal });
  } catch {
    throw new Error('Could not reach the MeshCore map (network error).');
  }
  if (!res.ok) {
    throw new Error(`MeshCore map returned ${res.status}.`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('MeshCore map returned an unreadable response.');
  }
  const nodes = (json as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error('Unexpected MeshCore map response (no "nodes" array).');
  }

  const out: PublicNodeCandidate[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const n = raw as Record<string, unknown>;
    if (!IMPORTABLE_TYPES.has(Number(n.type))) {
      continue;
    }
    const lat = Number(n.latitude);
    const lon = Number(n.longitude);
    // 0,0 is MeshCore's "no fix" sentinel; guard NaN from missing fields too.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      continue;
    }
    const name = typeof n.name === 'string' && n.name.trim() ? n.name.trim() : i18n.global.t('store.unnamed');
    const key = typeof n.public_key === 'string' && n.public_key ? n.public_key.toLowerCase() : null;
    const freqRaw = Number((n.params as { freq?: unknown } | undefined)?.freq);
    const freq = Number.isFinite(freqRaw) && freqRaw > 0 ? freqRaw : null;
    out.push({ key, name, lat, lon, freq, sourceId: 'meshcore' });
  }
  return out;
}

export const meshCoreSource: PublicNodeSource = {
  id: 'meshcore',
  label: 'MeshCore (global)',
  defaultEnabled: true,
  // The API is global, so the bbox isn't used for fetching — the orchestrator clips the result.
  async fetchInView(_bbox: Bbox, signal?: AbortSignal) {
    return { candidates: await fetchAll(signal) };
  },
};
