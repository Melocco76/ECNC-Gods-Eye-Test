/**
 * @module parcels
 * @description Property Intelligence A2.2/A2.3 — the "Property Boundaries"
 * map layer: visible property-parcel outline rendering (A2.2) plus
 * click/select/highlight (A2.3). Still no detail panel, no owner data, no
 * owner search, no `/identify` or `/detail` calls for an ordinary click on
 * already-rendered geometry — those remain out of scope for a later phase
 * (A3+).
 *
 * Architecture mirrors `militaryInstallations.js` (the reference
 * implementation this phase was asked to follow): a module-level `state`
 * object, one `Cesium.CustomDataSource`, a `camera.moveEnd`-debounced
 * viewport fetch, an `AbortController` per request, and the SAME
 * `DataLayerManager` lifecycle contract (`init/enable/disable/update/
 * destroy/getStats`) every other layer already uses — nothing here invents
 * a parallel layer system. Selection reuses the shared
 * `contextStore.js`/`pickRegistry.js` infrastructure the same way
 * `militaryInstallations.js` and `flights.js` already do; it is not a new,
 * property-specific selection channel.
 *
 * A2.2 found that the same `parcelId` can legitimately appear on more than
 * one returned record (not just as multiple parts of one record's own
 * MultiPolygon) — and a later A2.3 hardening pass found that which of those
 * records comes first is NOT stable across viewport refreshes either, so a
 * transient array/record index cannot be part of an entity's identity.
 * `renderParcels()` instead derives each part's id from its own geometry
 * (`geometryPartFingerprint` — a deterministic, order-independent hash of its
 * coordinates). Selection/highlight/persistence logic always keys off the
 * resulting entity id (`parcelEntityId(parcelId, geometryKey)` — the exact
 * render/entity identity), never off `parcelId` alone and never off position.
 *
 * Provider discovery is entirely registry-driven through the existing A2.1
 * server contract: this module calls `/api/parcels/coverage` and
 * `/api/parcels/viewport?region=...` using whatever `region` the server
 * hands back. It never hardcodes `or-deschutes` or any other region id.
 *
 * Privacy: this module reads only `{parcelId, geometry}` per parcel from the
 * viewport response — the same shape A2.1 already serves with owner data
 * stripped server-side. Clicking a rendered parcel selects it from that
 * already-fetched data only; it never calls `/identify` or `/detail` and
 * carries no owner-related code path at all.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
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
// Selected-parcel highlight: same accent, pushed to full emphasis in place —
// never a new/different color, and never a reason to rebuild other parcels.
const SELECTED_FILL_ALPHA = 0.22;
const SELECTED_OUTLINE_ALPHA = 1;
const SELECTED_WIDTH = 3;
const ENTITY_ID_PREFIX = 'property-parcel';

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  region: null,
  sourceAgency: null,
  parcels: [],
  parcelIds: new Set(), // for the pick-ownership predicate (other layers' empty-space checks)
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
  clickHandler: null,
  // The exact render/entity identity (`parcelEntityId(parcelId, geometryKey)`)
  // of the selected parcel — never parcelId alone, since duplicate parcelIds
  // across distinct records are a real, confirmed case (A2.2), and never a
  // transient array/record index, since the same geometry can legitimately
  // come back at a different position on a later viewport refresh (A2.3
  // hardening — see `geometryPartFingerprint`).
  selectedRenderEntityId: null,
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
 * Decimal places geometry coordinates are rounded to before fingerprinting —
 * generous enough (~1 cm at the equator) to never merge two genuinely
 * distinct parcel boundaries, while absorbing any incidental float-formatting
 * noise a provider might introduce between otherwise-identical responses.
 */
const GEOMETRY_FINGERPRINT_PRECISION = 7;

/** Deterministic, dependency-free 32-bit string hash (FNV-1a). No randomness, no UUIDs — the same input always yields the same output. */
function fnv1aHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function fingerprintRing(points) {
  return points.map((p) => `${p.lon.toFixed(GEOMETRY_FINGERPRINT_PRECISION)},${p.lat.toFixed(GEOMETRY_FINGERPRINT_PRECISION)}`).join(';');
}

/**
 * A deterministic, geometry-derived key for one rendered parcel part —
 * depends only on the part's own coordinates, never on its position in the
 * viewport response array or on any other record. Two parts with the exact
 * same outer ring + holes (down to `GEOMETRY_FINGERPRINT_PRECISION`) always
 * fingerprint identically, from any refresh, in any order; two parts with
 * different coordinates — including two different MultiPolygon parts of the
 * same record — always fingerprint differently.
 *
 * This is what makes selection persistence (`renderParcels`'s
 * previous-identity restore) survive a reordered viewport response: the
 * fix for "duplicate parcelId across two records in a different order can
 * retarget a persisted selection to the wrong geometry."
 * @param {{outer: Array<{lon:number, lat:number}>, holes: Array<Array<{lon:number, lat:number}>>}} part
 * @returns {string} An 8-character lowercase hex fingerprint (no colons).
 */
export function geometryPartFingerprint(part) {
  const outer = fingerprintRing(part?.outer || []);
  const holes = (part?.holes || []).map(fingerprintRing).join('|');
  return fnv1aHash(`${outer}#${holes}`);
}

/**
 * Collision-safe Cesium entity id for one rendered parcel part. Namespaced
 * (matches the `gev-trail:`/`installations:`-style convention elsewhere) so
 * a raw parcel id can never collide with another layer's entity id, and
 * parseable back to the parcel id by `parcelIdFromEntityId`.
 *
 * `geometryKey` is the part's deterministic identity — normally a
 * `geometryPartFingerprint(part)` result (optionally disambiguated by
 * `renderParcels` when two parts under the same parcelId are byte-identical
 * geometry). It is never a transient array/record index.
 * @param {string} parcelId @param {string} geometryKey
 * @returns {string}
 */
export function parcelEntityId(parcelId, geometryKey) {
  return `${ENTITY_ID_PREFIX}:${parcelId}:${geometryKey}`;
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
  // A rebuild discards every Cesium Entity, so any context record pointing
  // at one is now dangling. `removeEntityContextsForLayer` drops this
  // layer's records and — if the dropped one was selected — clears the
  // shared selection and dispatches 'gev:entity-selection-cleared' with
  // reason 'evicted' on our behalf (contextStore.js). `renderParcels` below
  // re-selects the matching render/entity identity afterward when it
  // reappears in the fresh render, so a plain viewport refresh that still
  // contains the same parcel is a transient evicted->selected pair, not a
  // real deselection.
  removeEntityContextsForLayer(LAYER_ID);
  state.selectedRenderEntityId = null;
}

function setStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('parcels-status');
}

/** In-place style mutation for one already-rendered parcel entity — never a `renderParcels()` rebuild just to change a selection. */
function applyParcelSelectionStyle(entity, selected) {
  if (!entity?.polygon) return;
  const boundaryColor = Cesium.Color.fromCssColorString(BOUNDARY_COLOR);
  entity.polygon.material = boundaryColor.withAlpha(selected ? SELECTED_FILL_ALPHA : BOUNDARY_FILL_ALPHA);
  entity.polygon.outlineColor = boundaryColor.withAlpha(selected ? SELECTED_OUTLINE_ALPHA : BOUNDARY_OUTLINE_ALPHA);
  entity.polygon.outlineWidth = selected ? SELECTED_WIDTH : BOUNDARY_WIDTH;
}

/**
 * Select one rendered parcel entity: highlight it in place, restore the
 * previously-selected entity's normal style, and publish it through the
 * shared context store. `entityId` is the exact render/entity identity
 * (`parcelEntityId`), never parcelId alone.
 */
function selectParcelEntity(entity, entityId) {
  if (!entity || state.selectedRenderEntityId === entityId) return;
  const previousId = state.selectedRenderEntityId;
  if (previousId) {
    const previousEntity = state.dataSource?.entities?.getById(previousId);
    applyParcelSelectionStyle(previousEntity, false);
  }
  state.selectedRenderEntityId = entityId;
  applyParcelSelectionStyle(entity, true);
  selectEntityContext(entity);
  governorRequestRender('parcels-select');
}

function renderParcels(parcels) {
  governorRequestRender('parcels-render');
  const previousSelectedId = state.selectedRenderEntityId;
  clearRendered();
  const boundaryColor = Cesium.Color.fromCssColorString(BOUNDARY_COLOR);
  const fillColor = boundaryColor.withAlpha(BOUNDARY_FILL_ALPHA);
  const outlineColor = boundaryColor.withAlpha(BOUNDARY_OUTLINE_ALPHA);
  // Real Deschutes viewport data proved this necessary (field-tested): the
  // same parcelId can legitimately appear on more than one returned record,
  // not only as multiple parts of one record's own MultiPolygon geometry.
  // A record's position in the response is NOT stable across refreshes (a
  // later poll can return the same two parcelId-sharing records in swapped
  // order), so the per-part identity is derived from the part's own geometry
  // (`geometryPartFingerprint`), never from its index in this loop. Two
  // genuinely identical geometries under one parcelId (byte-for-byte, the
  // only case the fingerprint alone can't tell apart) fall back to a
  // content-driven dedupe counter below — never an array-position one.
  const usedGeometryKeys = new Set();
  for (const parcel of parcels) {
    const parts = normalizeParcelGeometryParts(parcel.geometry);
    parts.forEach((part) => {
      const fingerprint = geometryPartFingerprint(part);
      let geometryKey = fingerprint;
      let dedupe = 1;
      while (usedGeometryKeys.has(`${parcel.parcelId}:${geometryKey}`)) {
        geometryKey = `${fingerprint}-${dedupe}`;
        dedupe += 1;
      }
      usedGeometryKeys.add(`${parcel.parcelId}:${geometryKey}`);
      const heightM = surfaceHeightM(part.outer[0].lat, part.outer[0].lon);
      const outerPositions = part.outer.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, heightM));
      const holePositions = part.holes.map((hole) => hole.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, heightM)));
      const entityId = parcelEntityId(parcel.parcelId, geometryKey);
      const entity = state.dataSource.entities.add({
        id: entityId,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(outerPositions, holePositions.map((positions) => new Cesium.PolygonHierarchy(positions))),
          material: fillColor,
          outline: true,
          outlineColor,
          outlineWidth: BOUNDARY_WIDTH,
          height: heightM,
        },
      });
      // Retained for the pick-ownership predicate / debugging — click
      // handling itself resolves identity from the Cesium entity id string.
      entity.gevParcelId = parcel.parcelId;
      // Identity-only, owner-free metadata — see module docstring. Registered
      // for every rendered parcel (selected or not), same as
      // `militaryInstallations.js`, so any of them can be selected.
      registerEntityContext(entity, {
        id: entityId,
        layerId: LAYER_ID,
        layerName: 'Property Boundaries',
        source: state.sourceAgency || 'Property boundaries',
        label: `Parcel ${parcel.parcelId}`,
        latitude: part.outer[0].lat,
        longitude: part.outer[0].lon,
        properties: {
          parcelId: parcel.parcelId,
          geometryKey,
          region: state.region,
        },
      });
    });
  }
  // Restore selection across the rebuild ONLY when the exact same
  // render/entity identity reappears in this fresh render — never by
  // parcelId alone (see module docstring). If it does not reappear,
  // `clearRendered()` above already cleared and dispatched the eviction.
  if (previousSelectedId) {
    const restoredEntity = state.dataSource.entities.getById(previousSelectedId);
    if (restoredEntity) selectParcelEntity(restoredEntity, previousSelectedId);
  }
}

/**
 * Install this layer's own left-click handler, following the same
 * per-layer `ScreenSpaceEventHandler` convention as `militaryInstallations.js`
 * and `flights.js` (each layer owns its own handler and reads its own
 * picks; `pickRegistry.js` is how OTHER layers learn to leave a parcel
 * pick alone, not how this one finds its own entities).
 *
 * Selection comes entirely from the already-rendered viewport dataset: a
 * plain `scene.pick` plus an id-prefix check, never `/api/parcels/identify`.
 *
 * Empty-space clicks are deliberately a no-op here, matching
 * `militaryInstallations.js`'s existing convention for a plain,
 * non-tracking, contextStore-backed entity layer: selection persists until
 * replaced by another parcel selection, evicted by a viewport refresh that
 * no longer contains it, or the layer is disabled. (`flights.js`'s
 * empty-space deselection is specific to its aircraft-tracking lane —
 * tracked-entity/Cockpit semantics that do not apply here — not a
 * general-purpose convention for a layer like this one.)
 */
/** The actual pick-to-selection logic, factored out of the raw Cesium event wiring so it is directly exercisable by `_handleParcelPickForTest`. */
function handleParcelPick(picked) {
  if (!state.enabled || !state.dataSource) return;
  const pickedId = typeof picked?.id?.id === 'string' ? picked.id.id : null;
  if (!pickedId || parcelIdFromEntityId(pickedId) == null) return;
  const entity = state.dataSource.entities.getById(pickedId);
  if (entity) selectParcelEntity(entity, pickedId);
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    handleParcelPick(viewer.scene.pick(click.position));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

/**
 * Test-only: exercise the exact click-to-selection code path with a fake
 * Cesium pick result, without needing a real canvas/DOM click simulation —
 * same `_xForTest` convention as `flights.js`/`militaryInstallations.js`.
 * @param {{id?: {id?: string}}|null} picked A Cesium `scene.pick()`-shaped result.
 */
export function _handleParcelPickForTest(picked) {
  handleParcelPick(picked);
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
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    // Lets OTHER layers' own click handlers recognize a parcel pick as
    // "not empty space" (e.g. so clicking a parcel never wrongly clears a
    // tracked aircraft). This layer finds its OWN entities directly in its
    // own click handler (`installInteraction`) — this registration is for
    // everyone else.
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
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedRenderEntityId = null;
  },
  update() { return loadParcels(); },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    state.clickHandler?.destroy();
    state.clickHandler = null;
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
