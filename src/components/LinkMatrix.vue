<template>
  <div>
    <div class="d-flex gap-2 mb-2 align-items-center">
      <button
        :disabled="store.matrixState === 'running' || store.nodes.length < 2 || !store.selectedNode"
        @click="store.runNodeLinks()"
        type="button"
        class="btn btn-success btn-sm flex-grow-1"
        title="Compute links from the selected node to every other node (fast). Shortcut: L"
      >
        <span
          v-if="store.matrixState === 'running'"
          class="spinner-border spinner-border-sm"
          role="status"
          aria-hidden="true"
        ></span>
        {{ buttonText }}
      </button>
      <button
        v-if="store.matrixState === 'running'"
        @click="store.cancelMatrix()"
        type="button"
        class="btn btn-outline-danger btn-sm text-nowrap"
        title="Stop the running link computation (keeps any links already computed)"
      >
        Cancel
      </button>
      <button
        v-else
        :disabled="store.nodes.length < 2"
        @click="computeAll"
        type="button"
        class="btn btn-outline-success btn-sm text-nowrap"
        title="Compute every node-to-node link (slower on large maps)"
      >
        Compute all
      </button>
    </div>

    <div class="form-check form-switch mb-2">
      <input
        class="form-check-input"
        type="checkbox"
        role="switch"
        id="links_selected_only"
        :checked="store.linksSelectedOnly"
        @change="store.toggleLinksSelectedOnly()"
      />
      <label class="form-check-label small" for="links_selected_only">Only show selected node's links</label>
      <InfoTip>
        Hide every link except those touching the selected node. Off: viable links always show, marginal/failed links
        only for the selected node.
      </InfoTip>
    </div>

    <div class="form-check form-switch mb-2">
      <input
        class="form-check-input"
        type="checkbox"
        role="switch"
        id="hide_invalid_links"
        :checked="store.hideInvalidLinks"
        @change="store.toggleHideInvalidLinks()"
      />
      <label class="form-check-label small" for="hide_invalid_links">Hide invalid links</label>
      <InfoTip> Hide links that don't meet the margin threshold, including those touching the selected node. </InfoTip>
    </div>

    <p v-if="store.nodes.length < 2" class="text-muted small mb-0">Add at least two nodes to compute links.</p>

    <template v-else>
      <p v-if="!store.selectedNode" class="text-muted small mb-0">Select a node to see its links.</p>

      <template v-else>
        <p class="small text-muted mb-2">
          Links from <strong>{{ store.selectedNode.transmitter.name }}</strong>
          <template v-if="store.matrixResult">
            · preset <strong>{{ store.matrixResult.preset }}</strong> · sensitivity
            <strong>{{ store.matrixResult.sensitivity_dbm }} dBm</strong>
          </template>
        </p>

        <!-- Per-node link list: selected node -> every other node. Always shown (even before
                     any run) so the "not yet calculated" prompt below is the entry point to computing. -->
        <div class="mb-2" style="max-height: 38vh; overflow-y: auto; overflow-x: hidden">
          <table
            class="table table-sm table-dark table-bordered text-center small mb-0 align-middle"
            style="table-layout: fixed; width: 100%"
          >
            <thead>
              <tr>
                <th class="text-start" style="width: 28%">To</th>
                <th title="Link margin (dB); green = viable">Margin</th>
                <th>Dist</th>
                <th>Loss</th>
                <th title="First Fresnel zone clearance">Fresnel</th>
                <th style="width: 32px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="other in inRangeNodes" :key="other.id">
                <th class="text-truncate text-start">{{ other.transmitter.name }}</th>
                <td :style="cellStyle(other.id)">{{ marginText(other.id) }}</td>
                <td>{{ fieldText(other.id, 'distance_km', ' km') }}</td>
                <td>{{ fieldText(other.id, 'path_loss_db', ' dB') }}</td>
                <td>{{ fieldText(other.id, 'fresnel_pct', '%') }}</td>
                <td>
                  <button
                    type="button"
                    class="btn btn-sm p-0 border-0 bg-transparent lh-1 text-info"
                    :disabled="store.profileState === 'running'"
                    title="Show line profile"
                    @click="store.runProfile(store.selectedNodeId, other.id)"
                  >
                    <Spline :size="16" />
                  </button>
                </td>
              </tr>
              <tr v-if="outOfRangeNodes.length">
                <td colspan="6" class="p-0">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary w-100 my-1"
                    @click="showOutOfRange = !showOutOfRange"
                  >
                    {{ showOutOfRange ? 'Hide' : 'Show' }} {{ outOfRangeNodes.length }} node{{
                      outOfRangeNodes.length === 1 ? '' : 's'
                    }}
                    out of range
                  </button>
                </td>
              </tr>
              <tr v-if="uncalculatedNodes.length">
                <td colspan="6" class="p-0">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-warning w-100 my-1"
                    :disabled="store.matrixState === 'running'"
                    @click="store.runNodeLinks()"
                  >
                    <span
                      v-if="store.matrixState === 'running'"
                      class="spinner-border spinner-border-sm"
                      role="status"
                      aria-hidden="true"
                    ></span>
                    {{ uncalculatedNodes.length }} node{{ uncalculatedNodes.length === 1 ? '' : 's' }}
                    not yet calculated - compute this node's links
                  </button>
                </td>
              </tr>
              <template v-if="showOutOfRange">
                <tr v-for="other in outOfRangeNodes" :key="other.id">
                  <th class="text-truncate text-start">{{ other.transmitter.name }}</th>
                  <td>{{ marginText(other.id) }}</td>
                  <td>{{ fieldText(other.id, 'distance_km', ' km') }}</td>
                  <td>{{ fieldText(other.id, 'path_loss_db', ' dB') }}</td>
                  <td>{{ fieldText(other.id, 'fresnel_pct', '%') }}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-sm p-0 border-0 bg-transparent lh-1 text-info"
                      :disabled="store.profileState === 'running'"
                      title="Show line profile"
                      @click="store.runProfile(store.selectedNodeId, other.id)"
                    >
                      <Spline :size="16" />
                    </button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <!-- Check LOS: draw the terrain/LOS profile to one chosen node. Independent of the
                     matrix, so it works before (or instead of) computing every pair. -->
        <label class="form-label small mb-1">Check line-of-sight to:</label>
        <div class="d-flex gap-2">
          <select v-model="store.losTargetId" class="form-select form-select-sm">
            <option :value="null" disabled>Select node…</option>
            <option v-for="other in otherNodes" :key="other.id" :value="other.id">
              {{ other.transmitter.name }}
            </option>
          </select>
          <button
            type="button"
            class="btn btn-primary btn-sm text-nowrap"
            :disabled="!store.losTargetId || store.profileState === 'running'"
            @click="store.runProfile(store.selectedNodeId, store.losTargetId)"
          >
            <span
              v-if="store.profileState === 'running'"
              class="spinner-border spinner-border-sm"
              role="status"
              aria-hidden="true"
            ></span>
            Show profile
          </button>
        </div>
      </template>
    </template>

    <p v-if="store.matrixState === 'failed'" class="text-danger small mb-0 mt-2">
      Matrix computation failed. See console.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Spline } from '@lucide/vue';
import { useStore } from '../store.ts';
import { type LinkResult, type Node } from '../types.ts';
import InfoTip from './InfoTip.vue';

const store = useStore();

// Out-of-range rows (no computed link, e.g. skipped beyond the radio horizon) are folded away by
// default so a populated map doesn't bury the viable links under a wall of blank rows.
const showOutOfRange = ref(false);
watch(
  () => store.selectedNodeId,
  () => {
    showOutOfRange.value = false;
  },
);

const buttonText = computed(() => {
  if (store.matrixState === 'running') return 'Computing…';
  if (store.matrixState === 'failed') return 'Retry';
  return "Calculate node's links";
});

// Full-matrix work grows ~O(N²); past this many nodes "Compute all" warrants a heads-up (the per-node
// "L" path stays one click away). Tuned to where a full run starts taking real time / terrain bandwidth.
const CONFIRM_NODE_COUNT = 75;
function computeAll() {
  const n = store.nodes.length;
  if (
    n >= CONFIRM_NODE_COUNT &&
    !window.confirm(
      `Computing every link between ${n} nodes can take a while and download a lot of terrain. ` +
        `For a single node, use “Calculate node's links” (or press L) instead.\n\nCompute the full matrix anyway?`,
    )
  ) {
    return;
  }
  store.runMatrix();
}

// Every node except the currently selected one — the rows/options of the "from selected node" view.
// Hidden nodes are dropped so the table matches the map (their links aren't drawn). When "hide invalid
// links" is on, also drop rows whose link to the selected node isn't viable. A pair with no computed
// link yet still shows (nothing to hide).
const otherNodes = computed<Node[]>(() =>
  store.nodes.filter((n) => {
    if (n.id === store.selectedNodeId) return false;
    if (store.nodeHidden(n)) return false;
    if (!store.hideInvalidLinks) return true;
    const link = linkFor(n.id);
    return !link || link.viable;
  }),
);

// Whether the selected node has actually had every pair attempted (full matrix, or it was the
// per-node run's source) — only then does a missing link mean genuinely out of range. Otherwise
// it just hasn't been calculated yet, and folding it under "out of range" would be misleading.
const selectedNodeComputed = computed(() => {
  const sel = store.selectedNodeId;
  return !!sel && !!store.matrixResult?.computedSourceIds.includes(sel);
});

// Split into rows with a computed link, blank rows that are genuinely out of range, and blank rows
// that simply haven't been calculated yet (e.g. just-selected a node that's never had its own run,
// while an older matrix/other node's run is still showing).
const inRangeNodes = computed<Node[]>(() => otherNodes.value.filter((n) => !!linkFor(n.id)));
const outOfRangeNodes = computed<Node[]>(() =>
  selectedNodeComputed.value ? otherNodes.value.filter((n) => !linkFor(n.id)) : [],
);
const uncalculatedNodes = computed<Node[]>(() =>
  selectedNodeComputed.value ? [] : otherNodes.value.filter((n) => !linkFor(n.id)),
);

function linkFor(other: string): LinkResult | undefined {
  const sel = store.selectedNodeId;
  if (!sel) return undefined;
  return store.matrixResult?.links.find((l) => (l.a === sel && l.b === other) || (l.a === other && l.b === sel));
}

function marginText(other: string): string {
  const link = linkFor(other);
  if (!link) return '';
  if (link.error) return '!';
  return link.margin_db === null ? '?' : `${link.margin_db}`;
}

function fieldText(other: string, key: 'distance_km' | 'path_loss_db' | 'fresnel_pct', unit: string): string {
  const link = linkFor(other);
  const value = link?.[key];
  return value === null || value === undefined ? '—' : `${value}${unit}`;
}

function cellStyle(other: string): Record<string, string> {
  const link = linkFor(other);
  if (!link || link.margin_db === null) return {};
  // Margin 0..30 dB maps to a red->green ramp.
  const t = Math.max(0, Math.min(1, link.margin_db / 30));
  const r = Math.round(200 * (1 - t));
  const g = Math.round(40 + 140 * t);
  return { background: `rgb(${r}, ${g}, 50)`, color: '#fff' };
}
</script>
