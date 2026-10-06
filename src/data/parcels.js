/**
 * @module parcels
 * @description Property Intelligence A2.2 — the "Property Boundaries" map
 * layer: visible property-parcel outline rendering only. No click selection,
 * no detail panel, no owner data — those are explicitly out of scope here
 * (see A2.3+).
 *
 * Architecture mirrors `militaryInstallations.js` (the reference
 * implementation this phase was asked to follow): a module-level `state`
 * object, one `Cesium.CustomDataSource`, a `camera.moveEnd`-debounced
 * viewport fetch, an `AbortController` per request, and the SAME
 * `DataLayerManager` lifecycle contract (`init/enable/disable/update/
 * destroy/getStats`) every other layer already uses — nothing here invents
 * a parallel layer system.
 *
 * Provider discovery is entirely registry-driven through the existing A2.1
 * server contract: this module calls `/api/parcels/coverage` and
 * `/api/parcels/viewport?region=...` using whatever `region` the server
 * hands back. It never hardcodes `or-deschutes` or any other region id.
 *
 * Privacy (A2.2 scope): this module reads only `{parcelId, geometry}` per
 * parcel from the viewport response — the same shape A2.1 already serves
 * with owner data stripped server-side. It never calls `/detail` for a
 * rendered parcel and carries no owner-related code path at all.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { cachedGroundFloor, floorAltitudeM, resolveGroundFloorCellsBounded } from './groundFloor.js';
import { MAX_PARCEL_VIEWPORT_DEGREES } from './parcelProviderData.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

export const LAYER_ID = 'property-parcels';
const REQUEST_DEBOUNCE_MS = 500;
/**
 * Camera altitude (metres) below which the layer fetches/renders parcels.
 * The audit's suggested band was ~3000-5000 m; 3500 m is the conservative
 * end of that range — close enough to be useful at a "neighbourhood" zoom,
 * while erring toward FEWER/smaller viewport requests than a higher ceiling
 * would produce. Exported so the client-side gate and its tests share one
 * number, same reasoning as the shared server-side bbox cap.
 */
export const ZOOM_GATE_ALTITUDE_M = 3500;
const BOUNDARY_COLOR = '#22c7e8'; // the app's existing cyan accent (style.css --accent)
const BOUNDARY_OUTLINE_ALPHA = 0.75;
const BOUNDARY_FILL_ALPHA = 0.05; // nearly transparent — never meant to obscure imagery
const BOUNDARY_WIDTH = 1.5;
const ENTITY_ID_PREFIX = 'property-parcel';

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  region: null,
  sourceAgency: null,
  parcels: [],
  parcelIds: new Set(), // for the pick-ownership predicate only — A2.2 is non-clickable
  count: 0,
  saturated: false,
  status: 'idle', // 'idle' | 'unsupported' | 'zoom-in' | 'ready' | 'unavailable'
  error: null,
  lastUpdate: null,
  loading: false,
  abort: null,
  generation: 0,
  moveEndRemove: null,
  timer: null,
};

// -- pure helpers (unit-tested without Cesium/network) -----------------------------------------------

/**
 * One ring's [lon, lat] pairs -> a flat list of `{lon, lat}` — the shape the
 * (Cesium-dependent) renderer turns into `Cartesian3`s. Kept separate from
 * the Cesium call itself so the geometry-shape logic below is testable with
 * plain arrays.
 */
function ringToPoints(ring) {
  return Array.isArray(ring) ? ring.map(([lon, lat]) => ({ lon, lat })).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat)) : [];
}

/**
 * Normalize a GeoJSON `Polygon` or `MultiPolygon` geometry into a flat list
 * of renderable "parts" — each an outer ring plus its holes, as plain
 * `{lon, lat}` point arrays. A `Polygon` is always one part; a
 * `MultiPolygon` is one part per disjoint shape (Cesium's `PolygonGraphics`
 * has no native multi-polygon concept, so each part becomes its own
 * entity — see `parcelEntityId`). Degenerate rings (fewer than 3 points) are
 * dropped; an entirely degenerate/unsupported geometry yields `[]`, never a
 * thrown error.
 * @param {{type?: string, coordinates?: Array}|null|undefined} geometry
 * @returns {Array<{outer: Array<{lon:number, lat:number}>, holes: Array<Array<{lon:number, lat:number}>>}>}
 */
export function normalizeParcelGeometryParts(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  const toPolygonParts = (coordinates) => {
    if (!Array.isArray(coordinates)) return [];
    const [outerRing, ...holeRings] = coordinates;
    const outer = ringToPoints(outerRing);
    if (outer.length < 3) return [];
    const holes = holeRings.map(ringToPoints).filter((hole) => hole.length >= 3);
    return [{ outer, holes }];
  };
  if (geometry.type === 'Polygon') return toPolygonParts(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates)) return [];
    const parts = [];
    for (const polygonCoordinates of geometry.coordinates) parts.push(...toPolygonParts(polygonCoordinates));
    return parts;
  }
  return [];
}

/**
 * Collision-safe Cesium entity id for one rendered parcel part. Namespaced
 * (matches the `gev-trail:`/`installations:`-style convention elsewhere) so
 * a raw parcel id can never collide with another layer's entity id, and
 * parseable back to the parcel id for a future A2.3 click handler.
 * @param {string} parcelId @param {number} partIndex
 * @returns {string}
 */
export function parcelEntityId(parcelId, partIndex = 0) {
  return `${ENTITY_ID_PREFIX}:${parcelId}:${partIndex}`;
}

/** @param {string} entityId @returns {string|null} the parcel id encoded by `parcelEntityId`, or null if not one of ours. */
export function parcelIdFromEntityId(entityId) {
  if (typeof entityId !== 'string' || !entityId.startsWith(`${ENTITY_ID_PREFIX}:`)) return null;
  const rest = entityId.slice(ENTITY_ID_PREFIX.length + 1);
  const lastColon = rest.lastIndexOf(':');
  return lastColon > 0 ? rest.slice(0, lastColon) : null;
}

/**
 * Decide, from already-extracted camera/coverage facts, whether a viewport
 * fetch should happen right now — pure, so the zoom-gate/coverage-gate rules
 * are directly testable without Cesium or a server.
 * @param {{altitudeM: number|null, bbox: {south,west,north,east}|null, region: string|null}} input
 * @returns {{fetch: boolean, status: 'zoom-in'|'unsupported'|'ok'}}
 */
export function decideViewportFetch({ altitudeM, bbox, region }) {
  if (!region) return { fetch: false, status: 'unsupported' };
  if (!Number.isFinite(altitudeM) || altitudeM > ZOOM_GATE_ALTITUDE_M) return { fetch: false, status: 'zoom-in' };
  if (!bbox || !Number.isFinite(bbox.south) || !Number.isFinite(bbox.west) || !Number.isFinite(bbox.north) || !Number.isFinite(bbox.east)) {
    return { fetch: false, status: 'zoom-in' };
  }
  // Client-side refusal BEFORE asking — mirrors (and imports) the server's own
  // cap so an oversized viewport never round-trips into a predictable 400.
  if (bbox.north - bbox.south > MAX_PARCEL_VIEWPORT_DEGREES || bbox.east - bbox.west > MAX_PARCEL_VIEWPORT_DEGREES) {
    return { fetch: false, status: 'zoom-in' };
  }
  return { fetch: true, status: 'ok' };
}

// -- Cesium-dependent plumbing -------------------------------------------------------------------------

function viewportBbox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (!Number.isFinite(south + north + west + east) || east <= west || north <= south) return null;
  return { south, west, north, east };
}

/** Same ground-floor-height convention as `militaryInstallations.js`'s `installationSurfaceHeightM`. */
function surfaceHeightM(lat, lon) {
  return floorAltitudeM(null, cachedGroundFloor(lat, lon)) ?? 0;
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
}

function setStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('parcels-status');
}

function renderParcels(parcels) {
  governorRequestRender('parcels-render');
  clearRendered();
  const boundaryColor = Cesium.Color.fromCssColorString(BOUNDARY_COLOR);
  const fillColor = boundaryColor.withAlpha(BOUNDARY_FILL_ALPHA);
  const outlineColor = boundaryColor.withAlpha(BOUNDARY_OUTLINE_ALPHA);
  // Real Deschutes viewport data proved this necessary (field-tested): the
  // same parcelId can legitimately appear on more than one returned record,
  // not only as multiple parts of one record's own MultiPolygon geometry — a
  // per-record `partIndex` alone is not always collision-free. A running
  // per-parcelId counter across the WHOLE render pass is.
  const nextPartIndex = new Map();
  for (const parcel of parcels) {
    const parts = normalizeParcelGeometryParts(parcel.geometry);
    parts.forEach((part) => {
      const partIndex = nextPartIndex.get(parcel.parcelId) ?? 0;
      nextPartIndex.set(parcel.parcelId, partIndex + 1);
      const heightM = surfaceHeightM(part.outer[0].lat, part.outer[0].lon);
      const outerPositions = part.outer.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, heightM));
      const holePositions = part.holes.map((hole) => hole.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, heightM)));
      const entity = state.dataSource.entities.add({
        id: parcelEntityId(parcel.parcelId, partIndex),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(outerPositions, holePositions.map((positions) => new Cesium.PolygonHierarchy(positions))),
          material: fillColor,
          outline: true,
          outlineColor,
          outlineWidth: BOUNDARY_WIDTH,
          height: heightM,
        },
      });
      // Retained for future A2.3 (click selection) — never read for anything
      // click-related in A2.2 itself, which installs no pick handler.
      entity.gevParcelId = parcel.parcelId;
    });
  }
}

function scheduleLoad() {
  if (!state.enabled) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { void loadParcels(); }, REQUEST_DEBOUNCE_MS);
}

async function loadParcels() {
  if (!state.enabled || !state.viewer) return;
  const cameraHeight = state.viewer.camera?.positionCartographic?.height;
  const bbox = viewportBbox(state.viewer);
  const centerLat = bbox ? (bbox.south + bbox.north) / 2 : null;
  const centerLon = bbox ? (bbox.west + bbox.east) / 2 : null;

  // Zoomed out too far: refuse BEFORE any network call, not just before the
  // viewport fetch. Without this, panning around at a wide zoom would still
  // debounce-fire a /coverage request on every settle — harmless to the
  // server (cached, rate-limited) but exactly the "repeated requests while
  // zoomed out" this phase was asked to avoid. Any in-flight request from a
  // closer zoom is aborted and state is cleared, same as a real zoom-in
  // result below.
  if (!Number.isFinite(cameraHeight) || cameraHeight > ZOOM_GATE_ALTITUDE_M || !bbox) {
    state.abort?.abort();
    state.abort = null;
    state.generation += 1;
    state.loading = false;
    state.parcels = [];
    state.parcelIds = new Set();
    state.count = 0;
    state.saturated = false;
    state.region = null;
    state.sourceAgency = null;
    clearRendered();
    setStatus('zoom-in');
    return;
  }

  // Coverage is resolved fresh each load (cheap, cached server-side, and the
  // only way to stay registry-driven as the camera moves between regions —
  // this module never hardcodes which region is "the" region).
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  const myGeneration = ++state.generation;
  state.loading = true;
  governorRequestRender('parcels-loading');
  try {
    const coverageResponse = await fetch(`/api/parcels/coverage?${new URLSearchParams({ lat: centerLat.toFixed(5), lon: centerLon.toFixed(5) })}`, { signal: requestAbort.signal });
    const coveragePayload = await coverageResponse.json();
    if (!coverageResponse.ok) throw new Error(coveragePayload?.error || `Coverage lookup HTTP ${coverageResponse.status}`);
    const region = coveragePayload?.region || null;
    const sourceAgency = coveragePayload?.sourceAgency || null;
    // A superseded response (camera moved again, or the layer was disabled)
    // must never overwrite newer state — the generation counter is the guard.
    if (myGeneration !== state.generation || !state.enabled) return;
    state.region = region;
    state.sourceAgency = sourceAgency;

    const decision = decideViewportFetch({ altitudeM: cameraHeight, bbox, region });
    if (!decision.fetch) {
      state.parcels = [];
      state.parcelIds = new Set();
      state.count = 0;
      state.saturated = false;
      clearRendered();
      setStatus(decision.status);
      return;
    }

    const query = new URLSearchParams({
      region,
      south: bbox.south.toFixed(5), west: bbox.west.toFixed(5), north: bbox.north.toFixed(5), east: bbox.east.toFixed(5),
    });
    const response = await fetch(`/api/parcels/viewport?${query}`, { signal: requestAbort.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Parcel viewport HTTP ${response.status}`);
    if (myGeneration !== state.generation || !state.enabled) return; // superseded — do not render stale data over a newer view

    const parcels = Array.isArray(payload?.parcels) ? payload.parcels : [];
    await resolveGroundFloorCellsBounded(parcels
      .map((parcel) => normalizeParcelGeometryParts(parcel.geometry)[0]?.outer?.[0])
      .filter(Boolean)
      .map((p) => ({ lat: p.lat, lon: p.lon })));
    if (myGeneration !== state.generation || !state.enabled) return; // the bounded floor warm can itself take a moment

    state.parcels = parcels;
    state.parcelIds = new Set(parcels.map((parcel) => String(parcel.parcelId)));
    state.count = parcels.length;
    state.saturated = Boolean(payload.saturated);
    state.lastUpdate = Date.now();
    renderParcels(parcels);
    setStatus('ready');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (myGeneration !== state.generation || !state.enabled) return;
    state.parcels = [];
    state.parcelIds = new Set();
    state.count = 0;
    clearRendered();
    setStatus('unavailable', error?.message || 'Property data unavailable');
  } finally {
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
      governorRequestRender('parcels-loading-done');
    }
  }
}

const propertyParcelsLayer = {
  id: LAYER_ID,
  name: 'Property Boundaries',
  icon: '⬚',
  source: 'Property boundaries',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(LAYER_ID);
    viewer.dataSources.add(state.dataSource);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
  },
  enable() {
    state.enabled = true;
    // Harmless, forward-looking registration only (A2.3 will add real pick
    // handling): without this, another layer's own click handler can read an
    // unclaimed parcel polygon as "empty space" and, e.g., wrongly clear a
    // tracked aircraft. This layer itself installs no click listener.
    registerPickOwner(LAYER_ID, (id) => state.parcelIds.has(String(parcelIdFromEntityId(id) ?? id)));
    if (state.dataSource) state.dataSource.show = true;
    // DataLayerManager calls update() immediately after enable(); that owns the first load.
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(LAYER_ID);
    clearTimeout(state.timer);
    state.timer = null;
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    state.generation += 1; // orphan any in-flight response immediately
    if (state.dataSource) state.dataSource.show = false;
  },
  update() { return loadParcels(); },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.viewer = null;
  },
  getStats() {
    return {
      count: state.count,
      lastUpdate: state.lastUpdate,
      saturated: state.saturated,
      error: state.status === 'unavailable' ? state.error : null,
      status: state.status,
      loading: state.loading,
      loadingLabel: state.loading ? 'loading property boundaries' : '',
      source: state.sourceAgency || 'Property boundaries',
    };
  },
  /**
   * One-line override of the generic "ON · source · time ago" composition
   * for the states that need exact, concise wording (manager.js reads this
   * verbatim when non-empty — see `_buildMetaText`). Returning '' defers to
   * the generic composition, which already incorporates `getStats().source`
   * (the provider's sourceAgency) — that is this layer's attribution display
   * while active, per the Property Intelligence design intent.
   */
  getStatusText() {
    if (!state.enabled) return '';
    if (state.status === 'unsupported') return 'Property data unavailable here';
    if (state.status === 'zoom-in') return 'Zoom in to see property boundaries';
    if (state.status === 'unavailable') return 'Property data temporarily unavailable';
    if (state.status === 'ready' && state.saturated) return 'Property view limited — zoom in for more detail';
    return '';
  },
};

export default propertyParcelsLayer;
