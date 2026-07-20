<template>
  <form novalidate class="panel-min-width">
    <div class="row">
      <div class="col-12">
        <div class="form-text" v-html="t('viewshed.description')"></div>
      </div>
    </div>

    <!-- The compute pass needs WebGPU or, failing that, WebGL2; on a browser with neither the mode is inert. -->
    <div v-if="store.viewshedState === 'unsupported'" class="row mt-3">
      <div class="col-12">
        <div class="alert alert-warning py-2 px-3 mb-0 d-flex align-items-start gap-2">
          <TriangleAlert :size="18" class="flex-shrink-0 mt-1" />
          <span v-html="t('viewshed.unsupported')"></span>
        </div>
      </div>
    </div>

    <template v-else>
      <div class="row mt-3">
        <div class="col-12">
          <div class="form-check form-switch">
            <input
              class="form-check-input"
              type="checkbox"
              role="switch"
              id="viewshed_enabled"
              :checked="store.viewshedEnabled"
              :disabled="!store.selectedNode"
              @change="store.toggleViewshed()"
            />
            <label class="form-check-label" for="viewshed_enabled">{{ t('viewshed.showForSelectedNode') }}</label>
          </div>
          <div v-if="!store.selectedNode" class="form-text">{{ t('viewshed.addOrSelectNode') }}</div>
          <div v-else-if="store.viewshedProgress" class="form-text d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            {{
              t('viewshed.loadingTerrain', {
                loaded: store.viewshedProgress.loaded,
                total: store.viewshedProgress.total,
              })
            }}
          </div>
          <div v-else-if="store.viewshedState === 'computing'" class="form-text d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            {{ t('linkMatrix.computing') }}
          </div>
          <div v-else-if="store.viewshedState === 'error'" class="form-text text-warning">
            {{ t('viewshed.computeError') }}
          </div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="form-check form-switch">
            <input
              class="form-check-input"
              type="checkbox"
              role="switch"
              id="viewshed_live"
              :checked="store.viewshedLive"
              @change="store.toggleViewshedLive()"
            />
            <label class="form-check-label" for="viewshed_live">{{ t('viewshed.liveRecompute') }}</label>
            <InfoTip>
              {{ t('viewshed.liveRecomputeInfo') }}
            </InfoTip>
          </div>
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="d-flex align-items-center mb-2">
            <label for="viewshed_radius" class="form-label mb-0">{{
              t('viewshed.radius', { km: store.viewshedRadiusKm })
            }}</label>
            <InfoTip>{{ t('viewshed.radiusInfo') }}</InfoTip>
          </div>
          <input
            type="range"
            class="form-range"
            id="viewshed_radius"
            min="1"
            max="30"
            step="1"
            :value="store.viewshedRadiusKm"
            @input="store.setViewshedRadiusKm(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="d-flex align-items-center mb-2">
            <label for="viewshed_target_height" class="form-label mb-0">
              {{ t('viewshed.receiverHeight', { m: store.viewshedTargetHeight }) }}
            </label>
            <InfoTip> {{ t('viewshed.receiverHeightInfo') }} </InfoTip>
          </div>
          <input
            type="range"
            class="form-range"
            id="viewshed_target_height"
            min="0"
            max="50"
            step="1"
            :value="store.viewshedTargetHeight"
            @input="store.setViewshedTargetHeight(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>

      <div class="row mt-3" v-if="store.viewshedEnabled">
        <div class="col-12">
          <div class="d-flex align-items-center mb-2">
            <label for="viewshed_opacity" class="form-label mb-0">
              {{ t('viewshed.opacity', { pct: Math.round(store.viewshedOpacity * 100) }) }}
            </label>
            <InfoTip>{{ t('viewshed.opacityInfo') }}</InfoTip>
          </div>
          <input
            type="range"
            class="form-range"
            id="viewshed_opacity"
            min="0.05"
            max="1"
            step="0.05"
            :value="store.viewshedOpacity"
            @input="store.setViewshedOpacity(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>
    </template>
  </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { TriangleAlert } from '@lucide/vue';
import { useStore } from '../store.ts';
import InfoTip from './InfoTip.vue';
const { t } = useI18n();
const store = useStore();
</script>
