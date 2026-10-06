// Property Intelligence A2.2: the "Property Boundaries" map layer.
// Pure geometry/decision helpers are tested directly (no Cesium, no network).
// Lifecycle/network behavior is tested against the real layer module with a
// fake Cesium-shaped viewer and a mocked fetch — the same pattern already
// proven in militaryInstallations.test.mjs for this exact DataLayerManager
// contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import {
  decideViewportFetch,
  normalizeParcelGeometryParts,
  parcelEntityId,
  parcelIdFromEntityId,
  ZOOM_GATE_ALTITUDE_M,
} from './parcels.js';
import propertyParcelsLayer, { LAYER_ID } from './parcels.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';
import { MAX_PARCEL_VIEWPORT_DEGREES } from './parcelProviderData.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// -- 7/8. Polygon / MultiPolygon normalization -----------------------------------------------------

test('a GeoJSON Polygon becomes exactly one renderable part, with holes attached', () => {
  const outer = [[-121.5, 44.0], [-121.4, 44.0], [-121.4, 44.1], [-121.5, 44.1], [-121.5, 44.0]];
  const hole = [[-121.48, 44.02], [-121.46, 44.02], [-121.46, 44.04], [-121.48, 44.04], [-121.48, 44.02]];
  const parts = normalizeParcelGeometryParts({ type: 'Polygon', coordinates: [outer, hole] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].outer.length, 5);
  assert.deepEqual(parts[0].outer[0], { lon: -121.5, lat: 44.0 });
  assert.equal(parts[0].holes.length, 1);
  assert.equal(parts[0].holes[0].length, 5);
});

test('a GeoJSON MultiPolygon becomes one renderable part per disjoint shape', () => {
  const partA = [[-121.5, 44.0], [-121.4, 44.0], [-121.4, 44.1], [-121.5, 44.1], [-121.5, 44.0]];
  const partB = [[-121.0, 44.0], [-120.9, 44.0], [-120.9, 44.1], [-121.0, 44.1], [-121.0, 44.0]];
  const parts = normalizeParcelGeometryParts({ type: 'MultiPolygon', coordinates: [[partA], [partB]] });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].outer[0], { lon: -121.5, lat: 44.0 });
  assert.deepEqual(parts[1].outer[0], { lon: -121.0, lat: 44.0 });
});

test('degenerate rings, unsupported geometry types, and missing geometry never throw — they yield no parts', () => {
  assert.deepEqual(normalizeParcelGeometryParts(null), []);
  assert.deepEqual(normalizeParcelGeometryParts(undefined), []);
  assert.deepEqual(normalizeParcelGeometryParts({ type: 'Point', coordinates: [1, 2] }), []);
  assert.deepEqual(normalizeParcelGeometryParts({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }), [], 'fewer than 3 points');
  assert.deepEqual(normalizeParcelGeometryParts({ type: 'Polygon', coordinates: null }), []);
  assert.deepEqual(normalizeParcelGeometryParts({ type: 'MultiPolygon', coordinates: 'not-an-array' }), []);
});

test('a hole with fewer than 3 points is dropped, but the outer ring still renders', () => {
  const outer = [[-121.5, 44.0], [-121.4, 44.0], [-121.4, 44.1], [-121.5, 44.1], [-121.5, 44.0]];
  const badHole = [[-121.48, 44.02], [-121.46, 44.02]];
  const parts = normalizeParcelGeometryParts({ type: 'Polygon', coordinates: [outer, badHole] });
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].holes, []);
});

// -- 9. parcel identity retained ------------------------------------------------------------------

test('entity ids are namespaced and collision-safe, and decode back to the exact parcel id', () => {
  assert.equal(parcelEntityId('1408000000200'), 'property-parcel:1408000000200:0');
  assert.equal(parcelEntityId('1408000000200', 2), 'property-parcel:1408000000200:2');
  assert.equal(parcelIdFromEntityId('property-parcel:1408000000200:0'), '1408000000200');
  assert.equal(parcelIdFromEntityId('property-parcel:181209AC00700:3'), '181209AC00700');
});

test('a parcel id containing a colon still decodes correctly (last colon is the part-index separator)', () => {
  assert.equal(parcelIdFromEntityId(parcelEntityId('weird:id:with:colons', 1)), 'weird:id:with:colons');
});

test('an id from a different namespace is never mistaken for one of ours', () => {
  assert.equal(parcelIdFromEntityId('gev-trail:fl-head-1'), null);
  assert.equal(parcelIdFromEntityId('acd964'), null);
  assert.equal(parcelIdFromEntityId(''), null);
  assert.equal(parcelIdFromEntityId(null), null);
});

// -- 3/4/6. zoom gate, coverage gate, oversized-bbox refusal ----------------------------------------

const BBOX_OK = { south: 44.0, west: -121.74, north: 44.03, east: -121.70 }; // ~0.04° span

test('zoom gate prevents a viewport fetch above the documented altitude threshold', () => {
  assert.ok(ZOOM_GATE_ALTITUDE_M >= 3000 && ZOOM_GATE_ALTITUDE_M <= 5000, 'within the audited 3000-5000 m band');
  const decision = decideViewportFetch({ altitudeM: ZOOM_GATE_ALTITUDE_M + 1, bbox: BBOX_OK, region: 'or-deschutes' });
  assert.deepEqual(decision, { fetch: false, status: 'zoom-in' });
});

test('a supported region, close enough, with a small bbox triggers the viewport request', () => {
  const decision = decideViewportFetch({ altitudeM: ZOOM_GATE_ALTITUDE_M - 1, bbox: BBOX_OK, region: 'or-deschutes' });
  assert.deepEqual(decision, { fetch: true, status: 'ok' });
});

test('an unsupported location (no region) never fetches, regardless of altitude', () => {
  assert.deepEqual(decideViewportFetch({ altitudeM: 100, bbox: BBOX_OK, region: null }), { fetch: false, status: 'unsupported' });
});

test('the client refuses an oversized bbox (matching the shared server-side cap) before ever asking', () => {
  const oversized = { south: 44.0, west: -122.0, north: 44.2, east: -121.5 }; // 0.2°/0.5° span, well past the cap
  assert.ok(oversized.north - oversized.south > MAX_PARCEL_VIEWPORT_DEGREES);
  const decision = decideViewportFetch({ altitudeM: 1000, bbox: oversized, region: 'or-deschutes' });
  assert.deepEqual(decision, { fetch: false, status: 'zoom-in' });
});

test('a missing/malformed bbox never fetches', () => {
  assert.deepEqual(decideViewportFetch({ altitudeM: 1000, bbox: null, region: 'or-deschutes' }).fetch, false);
  assert.deepEqual(decideViewportFetch({ altitudeM: 1000, bbox: { south: NaN, west: 0, north: 1, east: 1 }, region: 'or-deschutes' }).fetch, false);
});

// -- lifecycle / network: fake viewer + mocked fetch, mirroring militaryInstallations.test.mjs --------

function fakeViewer({ heightM = 1000 } = {}) {
  const dataSources = [];
  const moveEndListeners = new Set();
  return {
    __moveEndListeners: moveEndListeners,
    __dataSources: dataSources,
    camera: {
      positionCartographic: { height: heightM },
      moveEnd: {
        addEventListener(listener) { moveEndListeners.add(listener); return () => moveEndListeners.delete(listener); },
      },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(44.0), west: Cesium.Math.toRadians(-121.74),
          north: Cesium.Math.toRadians(44.03), east: Cesium.Math.toRadians(-121.70),
        };
      },
    },
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) { const i = dataSources.indexOf(dataSource); if (i >= 0) dataSources.splice(i, 1); return i >= 0; },
    },
  };
}

/** A fast, safe fallback for any call this test doesn't care about (e.g. terrain-floor warm). */
const quietFallback = async () => ({ ok: false, status: 404, json: async () => ({}) });

function withMockedFetch(router, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    for (const [matcher, respond] of router) {
      if (matcher.test(u)) return respond(u, init);
    }
    return quietFallback();
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test('regression: two SEPARATE records sharing one parcelId (real Deschutes data does this) render as distinct entities, never colliding', async () => {
  // Found via real-server live verification: "An entity with id
  // property-parcel:...:0 already exists in this collection." — the same
  // parcelId appeared on two different viewport records, not just as two
  // parts of one record's own MultiPolygon.
  const viewer = fakeViewer({ heightM: 1000 });
  const samePolygon = { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.0]]] };
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/viewport/, okJson({
      parcels: [
        { parcelId: '181208AACANAL', geometry: samePolygon },
        { parcelId: '181208AACANAL', geometry: samePolygon }, // same id, a second record
      ],
      count: 2, saturated: false,
    })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await assert.doesNotReject(propertyParcelsLayer.update());
    const ids = viewer.__dataSources[0].entities.values.map((e) => e.id);
    assert.deepEqual(ids, ['property-parcel:181208AACANAL:0', 'property-parcel:181208AACANAL:1']);
    assert.equal(propertyParcelsLayer.getStats().status, 'ready', 'no collision error surfaced as a failure');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('1/4. a supported, close-enough view calls /coverage then /viewport, and renders the returned parcels', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  const calls = [];
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, async (u) => { calls.push(u); return okJson({ region: 'or-deschutes', providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office" })(); }],
    [/\/api\/parcels\/viewport/, async (u) => {
      calls.push(u);
      return okJson({
        region: 'or-deschutes', providerId: 'oregon-deschutes-county', count: 1, saturated: false,
        parcels: [{ parcelId: '1408000000200', geometry: { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.03], [-121.74, 44.0]]] } }],
      })();
    }],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    const stats = propertyParcelsLayer.getStats();
    assert.equal(stats.status, 'ready');
    assert.equal(stats.count, 1);
    assert.equal(stats.source, "Deschutes County Assessor's Office", 'attribution comes from the coverage response, not hardcoded');
    assert.equal(viewer.__dataSources[0].entities.values.length, 1);
    assert.equal(viewer.__dataSources[0].entities.values[0].id, 'property-parcel:1408000000200:0');
    assert.ok(calls.some((u) => u.includes('/api/parcels/coverage')));
    assert.ok(calls.some((u) => u.includes('/api/parcels/viewport')));
    propertyParcelsLayer.destroy(viewer);
  });
});

test('3. zoomed out: no /coverage and no /viewport call is ever made', async () => {
  const viewer = fakeViewer({ heightM: ZOOM_GATE_ALTITUDE_M + 500 });
  let called = false;
  await withMockedFetch([
    [/\/api\/parcels\//, async () => { called = true; return okJson({})(); }],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    assert.equal(called, false, 'no parcels endpoint was ever requested while zoomed out');
    assert.equal(propertyParcelsLayer.getStats().status, 'zoom-in');
    assert.equal(propertyParcelsLayer.getStatusText(), 'Zoom in to see property boundaries');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('2. an unsupported location (coverage returns no region) shows the unsupported state and fetches no viewport', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  let viewportCalled = false;
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: null })],
    [/\/api\/parcels\/viewport/, async () => { viewportCalled = true; return okJson({})(); }],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    assert.equal(viewportCalled, false);
    assert.equal(propertyParcelsLayer.getStats().status, 'unsupported');
    assert.equal(propertyParcelsLayer.getStatusText(), 'Property data unavailable here');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('10. saturated=true surfaces the concise limited-view status', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/viewport/, okJson({ parcels: [], count: 0, saturated: true })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    assert.equal(propertyParcelsLayer.getStats().saturated, true);
    assert.equal(propertyParcelsLayer.getStatusText(), 'Property view limited — zoom in for more detail');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('error path: an upstream failure shows the generic unavailable message, never a raw server error', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/viewport/, async () => ({ ok: false, status: 502, json: async () => ({ error: 'upstream ArcGIS stack trace leaked here' }) })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    assert.equal(propertyParcelsLayer.getStats().status, 'unavailable');
    assert.equal(propertyParcelsLayer.getStatusText(), 'Property data temporarily unavailable', 'the raw server error never reaches the displayed text');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('11. a superseded (stale-generation) response never overwrites newer state', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  let resolveSlowViewport;
  const slowViewport = new Promise((resolve) => { resolveSlowViewport = resolve; });
  let viewportCallsStarted = 0;
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/viewport/, async () => {
      viewportCallsStarted += 1;
      if (viewportCallsStarted === 1) {
        await slowViewport;
        return okJson({ parcels: [{ parcelId: 'STALE', geometry: { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.0]]] } }], count: 1, saturated: false })();
      }
      return okJson({ parcels: [{ parcelId: 'FRESH', geometry: { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.0]]] } }], count: 1, saturated: false })();
    }],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    const first = propertyParcelsLayer.update(); // starts the slow (first) request
    // Poll (bounded) rather than guess a microtask-tick count: wait until the
    // first request has genuinely reached its viewport fetch before starting
    // the second — a fixed `await Promise.resolve()` count is timing-fragile
    // and was observed to hang this test nondeterministically.
    for (let i = 0; i < 1000 && viewportCallsStarted < 1; i += 1) await Promise.resolve();
    assert.equal(viewportCallsStarted, 1, 'the first request reached its viewport fetch and is now parked awaiting slowViewport');
    await propertyParcelsLayer.update(); // supersedes it — resolves fully before returning
    resolveSlowViewport(); // only now let the stale (first) response finish, late
    await first;
    const ids = viewer.__dataSources[0].entities.values.map((e) => e.id);
    assert.deepEqual(ids, ['property-parcel:FRESH:0'], 'the late stale response never overwrote the fresh render');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('12. disabling the layer aborts the outstanding request and stops future fetches', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  let aborted = false;
  let viewportStarted = false;
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, async (u, init) => {
      viewportStarted = true;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    const pending = propertyParcelsLayer.update();
    assert.equal(viewportStarted, true);
    propertyParcelsLayer.disable();
    await pending;
    assert.equal(aborted, true);
    assert.equal(propertyParcelsLayer.getStats().loading, false);
    propertyParcelsLayer.destroy(viewer);
  });
});

test('13. destroy() removes the moveEnd listener, clears entities, and removes the data source', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: null })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    assert.equal(viewer.__moveEndListeners.size, 1);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    propertyParcelsLayer.destroy(viewer);
    assert.equal(viewer.__moveEndListeners.size, 0, 'moveEnd listener removed');
    assert.equal(viewer.__dataSources.length, 0, 'CustomDataSource removed from the viewer');
  });
});

test('disable() hides the layer without destroying its entities (matches the militaryInstallations convention)', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/viewport/, okJson({ parcels: [{ parcelId: 'A', geometry: { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.0]]] } }], count: 1, saturated: false })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    const dataSource = viewer.__dataSources[0];
    assert.equal(dataSource.show, true);
    assert.equal(dataSource.entities.values.length, 1);
    propertyParcelsLayer.disable();
    assert.equal(dataSource.show, false, 'hidden, not stripped of entities, matching the reference layer');
    propertyParcelsLayer.destroy(viewer);
  });
});

test('a harmless pick-owner registration exists for A2.3, but A2.2 installs no click handler of its own', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/viewport/, okJson({ parcels: [{ parcelId: 'A1', geometry: { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.0]]] } }], count: 1, saturated: false })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    assert.equal(isOwnedByOtherLayer('some-other-layer', 'property-parcel:A1:0'), true, 'another layer\'s click handler must recognize this as claimed, not empty space');
    assert.equal(isOwnedByOtherLayer('some-other-layer', 'something-unrelated'), false);
    propertyParcelsLayer.disable();
    assert.equal(isOwnedByOtherLayer('some-other-layer', 'property-parcel:A1:0'), false, 'ownership is released on disable');
    propertyParcelsLayer.destroy(viewer);
  });
  const source = code('./parcels.js');
  assert.equal(/ScreenSpaceEventHandler|LEFT_CLICK/.test(source), false, 'A2.2 installs no click handler of its own');
});

// -- 14/15. privacy: no full-detail/owner calls, no hardcoded region ---------------------------------

test('14. the layer never calls /api/parcels/detail (full parcel detail) for a rendered parcel', async () => {
  const viewer = fakeViewer({ heightM: 1000 });
  let detailCalled = false;
  await withMockedFetch([
    [/\/api\/parcels\/coverage/, okJson({ region: 'or-deschutes', sourceAgency: 'X' })],
    [/\/api\/parcels\/detail/, async () => { detailCalled = true; return okJson({})(); }],
    [/\/api\/parcels\/viewport/, okJson({
      parcels: Array.from({ length: 5 }, (_, i) => ({ parcelId: `P${i}`, geometry: { type: 'Polygon', coordinates: [[[-121.74, 44.0], [-121.70, 44.0], [-121.70, 44.03], [-121.74, 44.0]]] } })),
      count: 5, saturated: false,
    })],
  ], async () => {
    propertyParcelsLayer.init(viewer);
    propertyParcelsLayer.enable();
    await propertyParcelsLayer.update();
    assert.equal(detailCalled, false);
    assert.equal(viewer.__dataSources[0].entities.values.length, 5);
    propertyParcelsLayer.destroy(viewer);
  });
});

test('14/source: no DATA-owner code path exists anywhere in this module', () => {
  // `registerPickOwner`/`unregisterPickOwner`/"pick-ownership" are the unrelated,
  // required Cesium pick-registry concept (Part 11) — not a person/data owner.
  const source = code('./parcels.js').replace(/registerPickOwner|unregisterPickOwner|pick-ownership/gi, '');
  assert.equal(/owner/i.test(source), false, 'A2.2 must carry no owner-DATA-related identifier once pick-ownership wording is excluded');
  assert.equal(/\/api\/parcels\/detail/.test(source), false, 'the generic layer never names the detail endpoint');
});

test('15. the generic layer module never hardcodes "or-deschutes" or any other region id', () => {
  const source = code('./parcels.js');
  assert.equal(/or-deschutes/i.test(source), false);
  assert.equal(/deschutes/i.test(source), false, 'no county name anywhere — region comes only from /coverage at runtime');
});

test('this layer is registered with the id the registration files expect', () => {
  assert.equal(LAYER_ID, 'property-parcels');
  assert.equal(propertyParcelsLayer.id, LAYER_ID);
  const layerGroups = read('../layerGroups.js');
  assert.match(layerGroups, /'property-parcels'/);
  const layerState = read('./layerState.js');
  assert.match(layerState, /id: 'property-parcels'/);
  const main = read('../main.js');
  assert.match(main, /dataManager\.register\(propertyParcelsLayer\)/);
});

test('governor contract: a discrete render/status mutation requests a render, matching every other layer in this codebase', () => {
  const source = code('./parcels.js');
  assert.match(source, /governorRequestRender\(/);
});

test('the viewport request always asks for the current camera rectangle, never a county-wide or unbounded box', () => {
  const source = code('./parcels.js');
  assert.equal(/south=0|west=0|north=90|east=180/.test(source), false);
  assert.match(source, /computeViewRectangle/);
});
