import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  // Served from a GitHub Pages project subpath (https://<user>.github.io/MeshMap-Planner/),
  // so assets must resolve relative to that prefix, not the domain root. Change to '/' for a
  // user/org site or a custom domain.
  base: '/MeshMap-Planner/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
