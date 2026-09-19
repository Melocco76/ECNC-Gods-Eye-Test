// FIRMS close-band terrain warm is view-bounded: with usable view bounds the
// rendered detections still warm their DEM anchors; with no bounds (sky/horizon
// view -> globally strongest fires) nothing is sent to /api/terrain/heights.
// Real layer, headless viewer stub, injected fetch — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import { unregisterSpriteCollection } from './spriteOrder.js';

const CLOSE_HEIGHT_M = 100_000; // < 750 km -> 'close' detections band
const AUSTIN = { lon: -97.7, lat: 30.2 };
const TOKYO = { lon: 139.7, lat: 35.7 };
const LAGOS = { lon: 3.4, lat: 6.5 };
// Bounded test uses its own cell: the floor cache is module-level and session-long.
const DENVER = { lon: -104.9, lat: 39.7 };

class MockEvent {
  constructor() { this.listeners = new Set(); }
  addEventListener(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

function canvasStub() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillStyle: null,
      fillRect() {},
    }),
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
  };
}

const rawFire = ({ lat, lon }, frp) => ({
  lat, lon, frp, confidence: 'h', brightness: 340, daynight: 'D',
  acqDate: '2026-08-03', acqTime: '0412', instrument: 'VIIRS', satellite: 'N20',
});

function createHarness(rawFires, { viewRect } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const terrainUrls = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/terrain/heights')) {
      terrainUrls.push(href);
      const points = decodeURIComponent(href.split('points=')[1]).split(';');
      return { ok: true, status: 200, json: async () => ({ results: points.map(() => ({ ellipsoid: 250 })) }) };
    }
    return { ok: true, status: 200, json: async () => ({ fires: rawFires, fetchedAt: Date.now() }) };
  };
  globalThis.window = globalThis.window || {};
  globalThis.document = { createElement: () => canvasStub() };
  // Deterministic projection: each distinct position gets its own screen slot.
  const originalProject = Cesium.SceneTransforms.worldToWindowCoordinates;
  const slots = new Map();
  Cesium.SceneTransforms.worldToWindowCoordinates = (_scene, position, result) => {
    if (!slots.has(position)) slots.set(position, slots.size);
    const slot = slots.get(position);
    const out = result || new Cesium.Cartesian2();
    out.x = 100 + (slot % 10) * 200;
    out.y = 100 + Math.floor(slot / 10) * 200;
    return out;
  };

  const primitives = [];
  const entryCalls = [];
  const camera = {
    moveEnd: new MockEvent(),
    positionWC: Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, CLOSE_HEIGHT_M),
    directionWC: new Cesium.Cartesian3(0, 0, -1),
    positionCartographic: { height: CLOSE_HEIGHT_M },
  };
  if (viewRect) camera.computeViewRectangle = () => viewRect;
  const viewer = {
    dataSources: { add: (value) => value, remove: () => {} },
    camera,
    scene: {
      canvas: { clientWidth: 2000, clientHeight: 2000 },
      preRender: new MockEvent(),
      primitives: { add: (v) => { primitives.push(v); return v; }, remove: () => {}, contains: () => false },
      frameState: { mode: Cesium.SceneMode.SCENE3D, mapProjection: new Cesium.GeographicProjection() },
      mapProjection: new Cesium.GeographicProjection(),
    },
  };
  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    overlayHost: {
      setEntries: (_id, entries) => entryCalls.push(entries),
      setVisible: () => {},
      clearSource: () => {},
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  return {
    layer,
    viewer,
    terrainUrls,
    billboardIds() {
      const bb = primitives[0];
      const ids = [];
      for (let i = 0; i < bb.length; i += 1) ids.push(bb.get(i).id);
      return ids;
    },
    latestEntries: () => entryCalls[entryCalls.length - 1] || [],
    cleanup() {
      layer.destroy(viewer);
      unregisterSpriteCollection('firms');
      Cesium.SceneTransforms.worldToWindowCoordinates = originalProject;
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
      if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('close band WITHOUT view bounds renders every fire but never warms terrain', async () => {
  const harness = createHarness([
    rawFire(AUSTIN, 100),
    rawFire(TOKYO, 900),
    rawFire(LAGOS, 500),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    await settle();

    // Global top-FRP set, FRP-ordered (pick ids follow the FRP index), all rendered.
    assert.equal(harness.billboardIds().length, 3, 'all detections still render');
    assert.equal(harness.terrainUrls.length, 0, 'no /api/terrain/heights request for the global set');
    assert.ok(harness.latestEntries().length > 0, 'labels are still published');
    assert.equal(harness.layer.getStrongestFire().frp, 900, 'strongest fire unchanged');
    assert.equal(harness.layer.getAnalystRecords().length, 3, 'analyst records unchanged');
  } finally {
    harness.cleanup();
  }
});

test('close band WITH view bounds still warms terrain, only for in-view fires', async () => {
  const viewRect = Cesium.Rectangle.fromDegrees(-105.6, 39.2, -104.2, 40.2);
  const harness = createHarness([
    rawFire(DENVER, 100),
    rawFire(TOKYO, 900),
    rawFire(LAGOS, 500),
  ], { viewRect });
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    await settle();

    assert.equal(harness.billboardIds().length, 1, 'bounded selection is unchanged: only the in-view fire');
    assert.ok(harness.terrainUrls.length >= 1, 'bounded close band warms the DEM anchors');
    const requested = harness.terrainUrls
      .flatMap((href) => decodeURIComponent(href.split('points=')[1]).split(';'))
      .map((pair) => pair.split(',').map(Number));
    for (const [lon, lat] of requested) {
      assert.ok(lon > -106 && lon < -103.5 && lat > 39 && lat < 41, `only in-view points requested (${lon},${lat})`);
    }
  } finally {
    harness.cleanup();
  }
});

