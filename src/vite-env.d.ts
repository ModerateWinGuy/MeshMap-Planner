/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Free, non-expiring LINZ Basemaps Developer API key (email basemaps@linz.govt.nz). Enables the
  // high-detail NZ LINZ terrain overlay (see terrain/demTiles.ts). Public by design; empty just makes
  // the overlay fall back to the Mapterhorn baseline. Set in a local .env file (not committed).
  readonly VITE_LINZ_API_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
