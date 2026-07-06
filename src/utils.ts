import type { Node } from './types.ts';

export function cloneObject(item: any) {
  return JSON.parse(JSON.stringify(item));
}

// One node carried in a share link: name + position + the node-level radio fields. Short keys keep
// the encoded URL compact; the values mirror SplatParams transmitter/receiver (see types.ts).
export interface SharedNode {
  name: string;
  lat: number;
  lon: number;
  txp: number; // tx_power (W)
  txf: number; // tx_freq (MHz)
  txh: number; // tx_height (m AGL)
  txg: number; // tx_gain (dBi)
  rxs: number; // rx_sensitivity (dBm)
  rxl: number; // rx_loss (dB)
}

// The payload encoded into a #s=… share link: a set of nodes ('nodes' — one selected node, a folder,
// or the whole site), or a node pair whose link profile the recipient is offered ('link'). `g` is an
// optional destination folder name (set when sharing a folder, so the recipient gets them grouped).
// `lp` is the sharer's LoRa preset, carried for context only — it never overrides the recipient's
// global radio settings.
export interface SharePayload {
  v: 1;
  t: 'nodes' | 'link';
  n: SharedNode[];
  g?: string;
  lp?: string;
}

export function nodeToShared(node: Node): SharedNode {
  const t = node.transmitter;
  const r = node.receiver;
  return {
    name: t.name,
    lat: t.tx_lat,
    lon: t.tx_lon,
    txp: t.tx_power,
    txf: t.tx_freq,
    txh: t.tx_height,
    txg: t.tx_gain,
    rxs: r.rx_sensitivity,
    rxl: r.rx_loss,
  };
}

// Encode a share payload as URL-safe base64 (base64url, no padding). Goes through TextEncoder so
// non-Latin1 node names (possible from a MeshCore import) survive — plain btoa(json) would throw on them.
export function encodeShare(payload: SharePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Decode a base64url share token back into a payload, returning null on anything malformed so a bad
// link can never throw into app startup.
export function decodeShare(token: string): SharePayload | null {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || obj.v !== 1 || (obj.t !== 'nodes' && obj.t !== 'link') || !Array.isArray(obj.n) || !obj.n.length) {
      return null;
    }
    if (obj.g != null && typeof obj.g !== 'string') {
      return null;
    }
    for (const n of obj.n) {
      if (!n || typeof n.name !== 'string' || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) {
        return null;
      }
    }
    if (obj.t === 'link' && obj.n.length < 2) {
      return null;
    }
    return obj as SharePayload;
  } catch {
    return null;
  }
}

// The full shareable URL: the app's own origin + base path, with the payload in the hash. The hash
// (not a query) keeps it a pure client-side concern — it never reaches GitHub Pages and needs no SPA
// routing. BASE_URL is Vite's configured base ('/MeshMap-Planner/'), so this works from any deploy.
export function buildShareUrl(payload: SharePayload): string {
  return `${location.origin}${import.meta.env.BASE_URL}#s=${encodeShare(payload)}`;
}

// Escape user-supplied text before interpolating it into popup HTML (node names, error strings).
// MapLibre popups render with setHTML, so unescaped names would be a stored-XSS vector.
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
