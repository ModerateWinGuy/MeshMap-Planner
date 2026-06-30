import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  // Served from a GitHub Pages project subpath (https://<user>.github.io/MeshMap-Planner/),
  // so assets must resolve relative to that prefix, not the domain root. Change to '/' for a
  // user/org site or a custom domain.
  base: '/MeshMap-Planner/',
  // Expose LINZ_-prefixed env vars (LINZ_API_KEY) to client code alongside Vite's default VITE_.
  envPrefix: ['VITE_'],
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Explicit (this is already Vite's default): the sim Web Worker (src/sim/worker.ts, imported via
  // `?worker` in simClient.ts) must bundle as a classic script, not an ES module, so it loads on every
  // browser with Worker support rather than only the ones with module-worker support.
  worker: {
    format: 'iife',
  },
})
