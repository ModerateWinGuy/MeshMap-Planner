<template>
  <!-- Floating on-map overlay (a Vue overlay, not a custom IControl, to stay in Vue idiom). The
       controls themselves live in BasemapButtons so the Settings panel can render the same body
       inline; this wrapper only adds the fixed positioning over the map canvas. -->
  <div class="map-controls">
    <BasemapButtons />
  </div>
</template>

<script setup lang="ts">
import BasemapButtons from './BasemapButtons.vue'
</script>

<style scoped>
.map-controls {
  position: fixed;
  top: 70px;
  left: 10px;
  z-index: 1000;
  width: 130px;
}
</style>
