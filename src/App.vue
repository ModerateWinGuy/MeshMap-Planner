<template>
  <div :data-regime="regime">
    <!-- Phone app bar replaces the desktop/tablet navbar — no room for the mode-toggle segmented
         control, so mode switching moves to BottomTabBar at the bottom of the screen instead. -->
    <header v-if="regime === 'phone'" class="phone-appbar">
      <span class="d-inline-flex align-items-center gap-2">
        <Radio :size="20" class="brand-icon" :aria-label="t('app.logoAlt')" />
        <span class="phone-appbar-title">MeshMap Planner</span>
      </span>
      <div class="d-flex align-items-center gap-2">
        <div class="dropdown">
          <button
            type="button"
            class="btn btn-sm btn-outline-light dropdown-toggle d-inline-flex align-items-center gap-1"
            data-bs-toggle="dropdown"
            aria-expanded="false"
            :disabled="!store.nodes.length"
            :title="shareCopied ? t('common.linkCopied') : t('app.shareNodesTitle')"
          >
            <component :is="shareCopied ? Check : Share2" :size="14" />
            {{ shareCopied ? t('common.copied') : t('app.share') }}
          </button>
          <ul class="dropdown-menu dropdown-menu-end" data-bs-theme="dark">
            <li>
              <button
                type="button"
                class="dropdown-item d-flex align-items-center gap-2"
                :disabled="!store.selectedNode"
                @click="shareSelectedNode"
              >
                <RadioTower :size="15" />
                <span class="text-truncate"
                  >{{ t('app.selectedNode')
                  }}<template v-if="store.selectedNode">: {{ store.selectedNode.transmitter.name }}</template></span
                >
              </button>
            </li>
            <li><hr class="dropdown-divider" /></li>
            <li>
              <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareSite">
                <MapIcon :size="15" /> {{ t('app.wholeSite', { count: store.nodes.length }) }}
              </button>
            </li>
          </ul>
        </div>

        <LanguagePicker />
      </div>
    </header>

    <nav v-else class="navbar navbar-dark bg-dark fixed-top">
      <div class="container-fluid position-relative">
        <a class="navbar-brand d-inline-flex align-items-center gap-2" href="#">
          <Radio :size="30" class="brand-icon" :aria-label="t('app.logoAlt')" />
          MeshMap Planner
        </a>
        <!-- Mode selector: an iOS-style segmented control (radio btn-check + label). Picking a mode
             swaps the sidebar's contents below. Absolutely centered so it stays mid-navbar
             regardless of the brand width; the checked segment becomes a solid white pill — the
             active highlight (see the .mode-toggle rules in style.css). -->
        <div
          class="btn-group mode-toggle position-absolute top-50 start-50 translate-middle"
          role="group"
          :aria-label="t('bottomTabBar.mode')"
        >
          <template v-for="m in MODES" :key="m.id">
            <input
              type="radio"
              class="btn-check"
              name="uiMode"
              :id="'mode-' + m.id"
              :value="m.id"
              v-model="store.activeMode"
              autocomplete="off"
            />
            <label class="btn d-inline-flex align-items-center gap-1" :for="'mode-' + m.id">
              <component :is="m.icon" :size="16" />
              {{ t(m.labelKey) }}
            </label>
          </template>
        </div>

        <!-- Right-aligned group (navbar container's space-between): feedback link, then the share menu. -->
        <div class="d-flex align-items-center gap-2">
          <a
            class="btn btn-sm btn-outline-light p-0 border-0 bg-transparent lh-1"
            href="https://github.com/ModerateWinGuy/MeshMap-Planner/issues"
            target="_blank"
            rel="noopener"
            :title="t('app.reportIssue')"
            :aria-label="t('app.reportIssue')"
          >
            <Bug :size="18" />
          </a>

          <!-- Share menu: the selected node (primary), or the whole site. Folders share from their own
               header in the node list. -->
          <div class="dropdown">
            <button
              type="button"
              class="btn btn-sm btn-outline-light dropdown-toggle d-inline-flex align-items-center gap-1"
              data-bs-toggle="dropdown"
              aria-expanded="false"
              :disabled="!store.nodes.length"
              :title="shareCopied ? t('common.linkCopied') : t('app.shareNodesTitle')"
            >
              <component :is="shareCopied ? Check : Share2" :size="16" />
              {{ shareCopied ? t('common.copied') : t('app.share') }}
            </button>
            <ul class="dropdown-menu dropdown-menu-end" data-bs-theme="dark">
              <li>
                <button
                  type="button"
                  class="dropdown-item d-flex align-items-center gap-2"
                  :disabled="!store.selectedNode"
                  @click="shareSelectedNode"
                >
                  <RadioTower :size="15" />
                  <span class="text-truncate"
                    >{{ t('app.selectedNode')
                    }}<template v-if="store.selectedNode">: {{ store.selectedNode.transmitter.name }}</template></span
                  >
                </button>
              </li>
              <li><hr class="dropdown-divider" /></li>
              <li>
                <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareSite">
                  <MapIcon :size="15" /> {{ t('app.wholeSite', { count: store.nodes.length }) }}
                </button>
              </li>
            </ul>
          </div>

          <LanguagePicker />
        </div>
      </div>
    </nav>

    <!-- A node/link shared via #s=… link: confirm before adding it to the user's saved map. -->
    <SharedLinkBanner />

    <div class="content-row">
      <!-- Map column: the map fills it, with the point-to-point profile strip docked below when a
           profile exists. Wrapped (rather than a bare #map) so the strip can shrink the map via flex
           instead of overlapping it; MapLibre's ResizeObserver re-fits the canvas automatically. -->
      <div class="map-col">
        <div id="map" ref="map"></div>
        <MapLoadingBar />
        <SimLoadingBar />
        <MeasurePanel v-if="store.measureActive" />
        <LocationSearchPanel v-if="store.locationSearchActive && regime !== 'phone'" />
        <ContextMenu v-if="store.contextMenu" />
        <ProfilePanel v-if="profileActive && regime !== 'phone'" />
        <div
          v-if="store.coverageHover"
          class="coverage-hover-tip"
          :style="{ left: store.coverageHover.x + 'px', top: store.coverageHover.y + 'px' }"
        >
          {{ store.coverageHover.dbm }} dBm
        </div>
      </div>
      <!-- data-bs-theme="dark" puts every Bootstrap component in this dark sidebar onto its dark-mode
           palette (Bootstrap 5.3 color modes). Without it, descendants default to light-mode colours
           that vanish on the dark background: .form-text / .text-muted render near-black, and
           .list-group-item draws a white box (which hid the white close buttons on the coverage
           results and node list). -->
      <!-- Tablet collapse handle: a sibling of .sidebar (not a child), so it stays visible/clickable
           against the boundary even once the sidebar it controls has collapsed to 0 width — see the
           overflow:hidden note on .sidebar-collapse-handle in style.css. -->
      <button
        v-if="regime === 'tablet'"
        type="button"
        class="sidebar-collapse-handle"
        :class="{ collapsed: store.sidebarCollapsed }"
        @click="store.toggleSidebarCollapsed()"
        :aria-label="store.sidebarCollapsed ? t('app.expandPanel') : t('app.collapsePanel')"
        :title="store.sidebarCollapsed ? t('app.expandPanel') : t('app.collapsePanel')"
      >
        <component :is="store.sidebarCollapsed ? ChevronLeft : ChevronRight" :size="16" />
      </button>
      <aside
        v-if="regime !== 'phone'"
        class="sidebar text-bg-dark"
        :class="{ collapsed: regime === 'tablet' && store.sidebarCollapsed }"
        data-bs-theme="dark"
      >
        <div class="mode-area">
          <ModePanels />
        </div>

        <!-- Computed-coverage results: pinned below the mode area so they stay visible (and
             toggleable) in every mode. -->
        <ul class="list-group mt-3 results-pinned">
          <li class="list-group-item" v-for="(site, index) in store.$state.localSites" :key="site.taskId">
            <div class="d-flex justify-content-between align-items-center">
              <div class="text-truncate">
                <div :class="{ 'text-muted': site.visible === false }">
                  {{ site.params.transmitter.name }}
                </div>
                <div class="small text-muted">{{ siteSubtitle(site) }}</div>
              </div>
              <div class="d-flex align-items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  @click="toggleSiteExpanded(site.taskId)"
                  class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                  :aria-label="
                    expandedSites.has(site.taskId) ? t('app.hideDisplaySettings') : t('app.editDisplaySettings')
                  "
                  :title="expandedSites.has(site.taskId) ? t('app.hideDisplaySettings') : t('app.editDisplaySettings')"
                >
                  <ChevronDown v-if="expandedSites.has(site.taskId)" :size="18" />
                  <ChevronRight v-else :size="18" />
                </button>
                <button
                  type="button"
                  @click="store.toggleSiteVisibility(index)"
                  class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                  :aria-label="site.visible === false ? t('app.showResult') : t('app.hideResult')"
                  :title="site.visible === false ? t('app.showResult') : t('app.hideResult')"
                >
                  <EyeOff v-if="site.visible === false" :size="18" />
                  <Eye v-else :size="18" />
                </button>
                <button
                  type="button"
                  @click="store.removeSite(index)"
                  class="btn btn-sm p-0 border-0 bg-transparent lh-1"
                  :aria-label="t('app.removeResult')"
                  :title="t('app.removeResult')"
                >
                  <X :size="18" />
                </button>
              </div>
            </div>
            <!-- Per-layer live recolor: same fields as Display.vue's "next run" panel, but scoped to
                 this site's own params.display and re-baked from its retained grid on change. -->
            <div v-if="expandedSites.has(site.taskId)" class="mt-2 pt-2 border-top">
              <div class="row g-2">
                <div class="col-6">
                  <label class="form-label small mb-1">{{ t('app.minDbm') }}</label>
                  <input
                    v-model.number="site.params.display.min_dbm"
                    @change="store.recolorSite(index)"
                    type="number"
                    step="0.1"
                    class="form-control form-control-sm"
                  />
                </div>
                <div class="col-6">
                  <label class="form-label small mb-1">{{ t('app.maxDbm') }}</label>
                  <input
                    v-model.number="site.params.display.max_dbm"
                    @change="store.recolorSite(index)"
                    type="number"
                    step="0.1"
                    class="form-control form-control-sm"
                  />
                </div>
              </div>
              <label class="form-label small mb-1 mt-2">{{ t('display.colorScale') }}</label>
              <select
                v-model="site.params.display.color_scale"
                @change="store.recolorSite(index)"
                class="form-select form-select-sm"
              >
                <option v-for="opt in COLOR_SCALE_OPTIONS" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
              <div class="mt-2 small">
                <div class="legend-bar" :style="{ background: gradientCss(site.params.display.color_scale) }"></div>
                <div class="d-flex justify-content-between text-muted">
                  <span>{{ site.params.display.min_dbm }} dBm</span>
                  <span>{{ site.params.display.max_dbm }} dBm</span>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </aside>
    </div>
    <BasemapControl v-if="regime !== 'phone'" />
    <template v-if="regime === 'phone'">
      <MapToolRow />
      <BottomTabBar
        :open-mode="sheetOpen ? store.activeMode : null"
        @tap="onTabTap"
        @toggle-more="moreSheetOpen = !moreSheetOpen"
      />
      <BottomSheet v-model="sheetOpen" v-model:detent="sheetDetent" :title="activeModeLabel">
        <ModePanels node-footer="external" />
        <template v-if="store.activeMode === 'nodes'" #footer>
          <NodePanelFooter />
        </template>
      </BottomSheet>
      <!-- Overflow for the 3 modes that don't get their own bottom tab. A 3-item list doesn't need
           half/full detents, so it's pinned to peek. -->
      <BottomSheet v-model="moreSheetOpen" detent="peek" :detents="['peek']" :title="t('bottomTabBar.more')">
        <ul class="list-group">
          <li
            v-for="m in overflowModes"
            :key="m.id"
            class="list-group-item d-flex align-items-center gap-2"
            role="button"
            @click="openOverflow(m.id)"
          >
            <component :is="m.icon" :size="18" />
            {{ t(m.labelKey) }}
          </li>
        </ul>
      </BottomSheet>
      <!-- The native MapLibre search button (bottom-left) toggles store.locationSearchActive same as
           on desktop; on phone the results render in a sheet instead of the absolute-positioned panel
           (which the fixed bottom tab bar would otherwise cover). -->
      <BottomSheet
        :model-value="store.locationSearchActive"
        @update:model-value="
          (open: boolean) => {
            if (!open) store.closeLocationSearch();
          }
        "
        detent="peek"
        :detents="['peek']"
        :title="t('app.searchLocation')"
      >
        <LocationSearchPanel embedded />
      </BottomSheet>
      <!-- Point-to-point link profile: docked below the map on desktop/tablet, a sheet here so it
           doesn't get stuck under the top tool row or fight the bottom tab bar for screen space. -->
      <BottomSheet
        :model-value="profileActive"
        @update:model-value="
          (open: boolean) => {
            if (!open) store.clearProfile();
          }
        "
        detent="half"
        :title="t('app.linkProfile')"
      >
        <ProfilePanel embedded />
      </BottomSheet>
    </template>
  </div>
</template>

<script setup lang="ts">
import 'maplibre-gl/dist/maplibre-gl.css';
// Bootstrap's CSS is imported in main.ts (before style.css) so our theme overrides win; only the JS
// bundle (popovers/dropdowns) is needed here.
import 'bootstrap/dist/js/bootstrap.bundle.min.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ModePanels from './components/ModePanels.vue';
import BasemapControl from './components/BasemapControl.vue';
import LanguagePicker from './components/LanguagePicker.vue';
import BottomTabBar from './components/BottomTabBar.vue';
import BottomSheet from './components/BottomSheet.vue';
import NodePanelFooter from './components/NodePanelFooter.vue';
import MapToolRow from './components/MapToolRow.vue';
import SharedLinkBanner from './components/SharedLinkBanner.vue';
import ProfilePanel from './components/ProfilePanel.vue';
import MapLoadingBar from './components/MapLoadingBar.vue';
import SimLoadingBar from './components/SimLoadingBar.vue';
import MeasurePanel from './components/MeasurePanel.vue';
import LocationSearchPanel from './components/LocationSearchPanel.vue';
import ContextMenu from './components/ContextMenu.vue';
import {
  Eye,
  EyeOff,
  X,
  Radio,
  RadioTower,
  Map as MapIcon,
  Link,
  WifiCog,
  SlidersVertical,
  ScanEye,
  Share2,
  Check,
  FolderInput,
  Bug,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from '@lucide/vue';
import type { Component } from 'vue';

import { useStore } from './store.ts';
import { installKeyboardShortcuts } from './keyboard.ts';
import { useShareLink } from './shareLink.ts';
import { nodeToShared } from './utils.ts';
import { trackEvent } from './analytics.ts';
import { gradientCss, COLOR_SCALE_OPTIONS } from './sim/colormap.ts';
import type { UiMode, Site } from './types.ts';
const { t } = useI18n();
const store = useStore();

// Phone (<768px) and tablet (768-1023px) get a different layout shell; desktop (>=1024px) renders
// today's markup untouched. matchMedia (not a resize listener) only fires on the 2 regime
// transitions, never on every drag-resize pixel; CSS media queries still own the actual chrome sizing.
const PHONE_MAX = 767;
const TABLET_MAX = 1023;
function useRegime() {
  const phoneMq = window.matchMedia(`(max-width: ${PHONE_MAX}px)`);
  const tabletMq = window.matchMedia(`(min-width: ${PHONE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`);
  const regime = ref<'phone' | 'tablet' | 'desktop'>(
    phoneMq.matches ? 'phone' : tabletMq.matches ? 'tablet' : 'desktop',
  );
  const update = () => {
    regime.value = phoneMq.matches ? 'phone' : tabletMq.matches ? 'tablet' : 'desktop';
  };
  onMounted(() => {
    phoneMq.addEventListener('change', update);
    tabletMq.addEventListener('change', update);
  });
  onUnmounted(() => {
    phoneMq.removeEventListener('change', update);
    tabletMq.removeEventListener('change', update);
  });
  return regime;
}
const regime = useRegime();

// Share-menu actions. `shareCopied` flips the toggle to a brief "Copied!" after any item copies.
const { copied: shareCopied, share: shareLink } = useShareLink();
function shareSelectedNode() {
  const n = store.selectedNode;
  if (n) {
    trackEvent('share-node');
    shareLink({ v: 1, t: 'nodes', n: [nodeToShared(n)] });
  }
}
function shareSite() {
  if (store.nodes.length) {
    trackEvent('share-site');
    shareLink({ v: 1, t: 'nodes', n: store.nodes.map(nodeToShared) });
  }
}

// Top-bar mode toggle. Order is the rough workflow: build nodes -> set radio params -> run coverage
// -> analyse links -> map settings.
const MODES = [
  { id: 'nodes', labelKey: 'app.modes.nodes', icon: RadioTower },
  { id: 'coverage', labelKey: 'app.modes.coverage', icon: MapIcon },
  { id: 'linkfinder', labelKey: 'app.modes.linkfinder', icon: Link },
  { id: 'viewshed', labelKey: 'app.modes.viewshed', icon: ScanEye },
  { id: 'radio', labelKey: 'app.modes.radio', icon: WifiCog },
  { id: 'settings', labelKey: 'app.modes.settings', icon: SlidersVertical },
  { id: 'import', labelKey: 'app.modes.import', icon: FolderInput },
] as const satisfies ReadonlyArray<{ id: UiMode; labelKey: string; icon: Component }>;

const activeModeLabel = computed(() => t(MODES.find((m) => m.id === store.activeMode)?.labelKey ?? ''));

// Whether a point-to-point link profile exists to show — shared by the desktop/tablet docked strip
// and the phone sheet below, so the two stay in sync without duplicating the condition.
const profileActive = computed(
  () => !!store.profileResult || store.profileState === 'running' || store.profileState === 'failed',
);

// Coverage results list: which rows have their inline display-settings editor expanded. View-only
// state (not persisted, not on the Site itself), keyed by taskId.
const expandedSites = ref(new Set<string>());
function toggleSiteExpanded(taskId: string) {
  if (expandedSites.value.has(taskId)) {
    expandedSites.value.delete(taskId);
  } else {
    expandedSites.value.add(taskId);
  }
}
// Disambiguates repeat coverage runs on the same node in the results list.
function siteSubtitle(site: Site): string {
  const time = new Date(site.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const { tx_power, tx_height } = site.params.transmitter;
  return `${time} · ${tx_power}W · ${tx_height}m AGL`;
}

// Phone bottom sheet. Not persisted (see the responsive-redesign plan's state-ownership table) —
// reload should always land on the map-home rest state, sheet closed. `store.activeMode` (already
// persisted) stays the single source of truth for *which* mode is showing across all three regimes;
// these two only track whether the sheet for that mode is currently raised.
const sheetOpen = ref(false);
const sheetDetent = ref<'peek' | 'half' | 'full'>('half');
function onTabTap(mode: UiMode) {
  if (sheetOpen.value && store.activeMode === mode) {
    sheetOpen.value = false; // re-tapping the lit tab closes its sheet
    return;
  }
  store.activeMode = mode;
  sheetOpen.value = true;
  sheetDetent.value = 'half';
}

// "More" overflow: the 3 modes that don't have their own bottom tab. Reuses BottomSheet for visual/
// behavioral consistency (same scrim, same drag-to-dismiss) rather than a second sheet pattern.
const moreSheetOpen = ref(false);
const overflowModes = MODES.filter((m) => m.id === 'radio' || m.id === 'settings' || m.id === 'import');
function openOverflow(mode: UiMode) {
  store.activeMode = mode;
  moreSheetOpen.value = false;
  sheetOpen.value = true;
  sheetDetent.value = 'half';
}

// The map belongs to the app shell, not any one panel — init/destroy here so switching modes (which
// only toggles panel visibility via v-show) never tears the map down.
let removeKeyboardShortcuts: (() => void) | null = null;
onMounted(() => {
  store.initMap();
  removeKeyboardShortcuts = installKeyboardShortcuts(store);
});
onUnmounted(() => {
  // Tear the map down on unmount so a remount (Vite HMR) can't leave the old map's layers subscribed
  // to its handlers — that orphaned state is what throws "map is null" and drifts layers on the next
  // interaction.
  store.destroyMap();
  removeKeyboardShortcuts?.();
  removeKeyboardShortcuts = null;
});
</script>

<style>
/* Node pin element handed to maplibregl.Marker (see src/layers.ts): a name caption stacked above
   the MapPin icon, both horizontally centred over the coordinate. */
.node-pin {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  line-height: 1;
  user-select: none;
}
/* Name caption above the pin. max-width is set inline per selection size in stylePinElement (twice
   the icon width) and the name is ellipsised so a long one can't sprawl across the map. The pill
   keeps it legible over any basemap; colour overrides the red/blue currentColor it would inherit. */
.node-pin-label {
  max-width: 150px;
  margin-bottom: 3px;
  padding: 1px 5px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 4px;
}
/* Signal-strength readout that follows the cursor over a coverage overlay (see store.coverageHover).
   Absolute within .map-col, using MapLibre's container-relative e.point coords directly. */
.coverage-hover-tip {
  position: absolute;
  transform: translate(10px, -100%);
  pointer-events: none;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  z-index: 5;
}
</style>
