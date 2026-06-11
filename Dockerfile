# ---- Frontend build stage: produces the static SPA at /build/app/ui ----
# Vite 7 requires Node >= 20.19 / 22.12; node:22 satisfies it. Built here so the image is
# self-contained — deploy targets (e.g. TrueNAS) never need Node or to run `pnpm build`.
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
# Pin pnpm 9 to match the lockfile (lockfileVersion 9.0). pnpm 10+ stopped reading the
# `pnpm.overrides` field from package.json, which breaks `--frozen-lockfile` here with
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (the lockfile carries the proj4-fully-loaded override).
RUN npm install -g pnpm@9
# Install deps first (their own cache layer — only re-runs when the lockfile changes).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- SPLAT build stage: compiles the SPLAT! binaries ----
# Isolated so the C/C++ toolchain and GDAL/-dev headers (~600+ MB) never reach the runtime
# image. Only the compiled binaries are copied forward, which is the bulk of the size saving.
FROM python:3.11-slim AS splat-build
# zlib1g-dev is needed by the `fontdata` util (#include <zlib.h>); the single-stage build only
# got it transitively via libgdal-dev. The matching runtime lib (zlib1g) is already in the base.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libbz2-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/splat
COPY splat/ /app/splat/
# Normalize line endings: a Windows (CRLF) checkout leaves a trailing \r on the shebang line,
# which makes Linux fail these scripts with "not found" (exit 127). Then configure + build
# SPLAT and SPLAT-HD (-march=native is fine: builder and runtime share the same build host).
RUN sed -i 's/\r$//' build configure install \
    && chmod +x build configure install \
    && sed -i.bak 's/-march=\$cpu/-march=native/g' build \
    && printf "8\n4\n" | ./configure \
    && ./install splat
# SPLAT utils (srtm2sdf, citydecoder, ...). Mirror the original layout: copy the converters to
# /app and fold the whole utils dir into /app/splat, then ensure every binary is executable.
WORKDIR /app/splat/utils
RUN sed -i 's/\r$//' build \
    && chmod +x build \
    && ./build all \
    && cp srtm2sdf srtm2sdf-hd /app/ \
    && cp -a ./ /app/splat \
    && chmod +x /app/splat/splat /app/splat/splat-hd /app/splat/srtm2sdf \
       /app/splat/citydecoder /app/splat/bearing /app/splat/fontdata /app/splat/usgs2sdf

# ---- Backend runtime stage ----
FROM python:3.11-slim

ENV HOME="/root"
ENV TERM=xterm

# Runtime system deps only — GDAL runtime for rasterio, bzip2 runtime for SPLAT. No compilers
# or -dev headers (those live in the splat-build stage). gdal-bin can be dropped if rasterio's
# bundled GDAL proves sufficient, but it is kept here as a low-risk safety margin.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libbz2-1.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (wheels — no build toolchain required).
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Application source, the in-image-built SPA, and the compiled SPLAT binaries.
COPY . .
COPY --from=frontend /build/app/ui /app/app/ui
COPY --from=splat-build /app/splat /app/splat
COPY --from=splat-build /app/srtm2sdf /app/srtm2sdf
COPY --from=splat-build /app/srtm2sdf-hd /app/srtm2sdf-hd

# Mount points for the runtime bind mounts (see docker-compose). local_sdf is supplied at runtime
# via a read-only bind mount, so it is intentionally NOT baked into the image (and is excluded in
# .dockerignore) — baking it would only be shadowed by that mount and bloat the image.
RUN mkdir -p /app/local_sdf /app/.splat_tiles

EXPOSE 8080
