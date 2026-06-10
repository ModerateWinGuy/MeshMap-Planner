# DEM providers

Pluggable terrain sources for the SPLAT! service. Each provider turns a **1-degree terrain cell**
into a SPLAT! `.sdf` tile (or declines, so the next provider is tried). SPLAT! finds tiles purely
by filename in its working directory, so every provider's only job is to emit the canonical SDF
name — `app/services/terrain_tiles.py` computes those names.

## The chain

`Splat` holds an ordered list of providers. For each required tile it walks the list and the
**first** provider to return bytes wins. The order *is* the precedence and comes entirely from the
`DEM_PROVIDERS` environment variable:

```
DEM_PROVIDERS=local,linz,srtm
```

`app/main.py` resolves that string to instances with `build_providers(...)` and hands them to
`Splat`. `main.py` and `splat.py` never name a concrete provider class.

## Built-in providers

| name    | source                              | coverage      | notes |
|---------|-------------------------------------|---------------|-------|
| `local` | hand-prepared `.sdf` in `LOCAL_SDF_DIR` | wherever you drop files | manual override; read-only |
| `linz`  | LINZ 1 m LIDAR via `nz-elevation` S3 (live) | New Zealand   | DEM/DSM per request; degrades to next on any failure |
| `srtm`  | AWS `elevation-tiles-prod` SRTM (live)      | global        | bare-earth default; normally last |

Per-provider config is read from each provider's own `from_env`:
`LOCAL_SDF_DIR`; `LINZ_BBOX` / `LINZ_CATALOG_URL` / `LINZ_RESAMPLE` / `LINZ_FILL_VOIDS`;
`SRTM_BUCKET_NAME` / `SRTM_BUCKET_PREFIX`; plus shared `SPLAT_PATH`, `SPLAT_CACHE_DIR`.

## Adding a new source

1. Create `app/services/dem_providers/<name>.py`:

   ```python
   from typing import Mapping, Optional
   from app.services.dem_providers.base import DEMProvider, TerrainTile
   from app.services.dem_providers import register_provider

   @register_provider
   class MyProvider(DEMProvider):
       name = "myprovider"

       @classmethod
       def from_env(cls, env: Mapping[str, str]) -> "MyProvider":
           return cls(...)  # read MYPROVIDER_* from env

       def try_get_sdf(self, tile: TerrainTile) -> Optional[bytes]:
           # return SDF bytes for this cell, or None to defer to the next provider.
           ...
   ```

2. Import it so the decorator runs — add it to the `from . import ...` line at the bottom of
   `__init__.py`.
3. Add its `name` to `DEM_PROVIDERS` wherever you want it in the precedence order.

That's it — **no changes to `splat.py`, `_provision_sdf_tiles`, `main.py`, or any other provider.**

### Contract notes

- Return `None` for "not my coverage / can't serve" — cheaply, ideally without network I/O, and
  **without raising**. Raise only on genuine errors you want surfaced. A provider that is not the
  last in the chain should generally degrade to `None` on failure so the chain can fall through.
- Own your caching, keyed so it can't collide with other sources on the shared SDF name (prefix
  keys with `name` and, where relevant, `terrain_source`).
- The SDF format caps at ~1 arc-second (~30 m); finer source data is downsampled.
