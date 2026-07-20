import type { Bbox, PublicNodeCandidate, PublicNodeSource } from './types.ts';
import { zonesForBounds } from './meshmapperZones.ts';
import { i18n } from '../i18n/index.ts';

const repeatersUrl = (code: string) => `https://${code.toLowerCase()}.meshmapper.net/get_repeaters.php`;

// MeshMapper publishes repeaters per region at https://<code>.meshmapper.net/get_repeaters.php
// (CORS-open, small payloads). We resolve the view to a handful of region codes (zonesForBounds),
// fetch each, and normalise. MeshMapper carries no frequency, and disabled repeaters are kept. Its
// `hex_id` is the node's public key (identical to MeshCore's public_key), which drives cross-source
// dedupe in the orchestrator.
async function fetchRegion(code: string, signal?: AbortSignal): Promise<PublicNodeCandidate[]> {
  const res = await fetch(repeatersUrl(code), { mode: 'cors', signal });
  if (!res.ok) {
    throw new Error(`${code} ${res.status}`);
  }
  const json: unknown = await res.json();
  if (!Array.isArray(json)) {
    return [];
  }
  const out: PublicNodeCandidate[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      continue;
    }
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : i18n.global.t('store.unnamed');
    const key = typeof r.hex_id === 'string' && r.hex_id ? r.hex_id.toLowerCase() : null;
    out.push({ key, name, lat, lon, freq: null, sourceId: 'meshmapper' });
  }
  return out;
}

export const meshMapperSource: PublicNodeSource = {
  id: 'meshmapper',
  label: 'MeshMapper (regional)',
  defaultEnabled: true,
  async fetchInView(bbox: Bbox, signal?: AbortSignal) {
    const { codes, capped } = zonesForBounds(bbox);
    const results = await Promise.allSettled(codes.map((c) => fetchRegion(c, signal)));
    const candidates: PublicNodeCandidate[] = [];
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        candidates.push(...r.value);
      } else {
        failed++;
      }
    }
    const warnings: string[] = [];
    if (capped) {
      warnings.push(i18n.global.t('publicMapSync.meshMapperCapped', { count: codes.length }));
    }
    if (failed) {
      warnings.push(
        failed === 1
          ? i18n.global.t('publicMapSync.meshMapperFailedOne')
          : i18n.global.t('publicMapSync.meshMapperFailedMany', { count: failed }),
      );
    }
    return { candidates, warnings: warnings.length ? warnings : undefined };
  },
};
