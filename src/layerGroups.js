/**
 * @module layerGroups
 * @description Presentation-only grouping of the data layers for the Layers
 * drawer. Nothing here changes what a layer is or how it behaves: layer ids,
 * registration order, persistence tokens and handlers are untouched. A layer
 * that is not listed falls back to the first group so a newly registered layer
 * is never hidden.
 */

/** Drawer groups in display order. */
export const LAYER_GROUPS = Object.freeze([
  Object.freeze({
    id: 'live',
    label: 'Live',
    layers: Object.freeze(['flights', 'military', 'ais-live-vessels', 'traffic', 'cctv', 'bikeshare', 'radio']),
  }),
  Object.freeze({
    id: 'weather',
    label: 'Weather & hazards',
    layers: Object.freeze(['weather-radar', 'local-firms', 'earthquakes']),
  }),
  Object.freeze({
    id: 'infrastructure',
    label: 'Infrastructure',
    layers: Object.freeze(['telegeography-submarine-cables', 'local-datacenters', 'local-dams', 'military-installations']),
  }),
  Object.freeze({
    id: 'space',
    label: 'Space',
    layers: Object.freeze(['satellites', 'rocket-launches']),
  }),
]);

const GROUP_BY_LAYER = new Map();
const ORDER_BY_LAYER = new Map();
for (const group of LAYER_GROUPS) {
  group.layers.forEach((layerId, index) => {
    GROUP_BY_LAYER.set(layerId, group.id);
    ORDER_BY_LAYER.set(layerId, index);
  });
}
const GROUP_ORDER = new Map(LAYER_GROUPS.map((group, index) => [group.id, index]));

/** Group id for a layer; unknown layers fall back to the first group. */
export function groupIdForLayer(layerId) {
  return GROUP_BY_LAYER.get(layerId) ?? LAYER_GROUPS[0].id;
}

/**
 * Stable ordering by group, then by the position inside the group; layers the
 * table does not know keep their registration order after the known ones of
 * their (fallback) group.
 * @template {{id: string}} T
 * @param {readonly T[]} layers
 * @returns {T[]}
 */
export function orderLayersForDrawer(layers) {
  return layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => {
      const ga = GROUP_ORDER.get(groupIdForLayer(a.layer.id));
      const gb = GROUP_ORDER.get(groupIdForLayer(b.layer.id));
      if (ga !== gb) return ga - gb;
      const oa = ORDER_BY_LAYER.get(a.layer.id) ?? 1000;
      const ob = ORDER_BY_LAYER.get(b.layer.id) ?? 1000;
      if (oa !== ob) return oa - ob;
      return a.index - b.index;
    })
    .map((entry) => entry.layer);
}
