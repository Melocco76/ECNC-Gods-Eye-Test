// Weather-radar overlay lifecycle: attach per map stack, migration, fallback,
// opacity, polling/visibility, frame swap, races, and credit lifecycle.
// Fakes only — no Cesium viewer, no network, no real timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  RADAR_BACKOFF_MS,
  RADAR_DEFAULT_OPACITY,
  RADAR_REFRESH_MS,
  RADAR_SWAP_OVERLAP_MS,
  RADAR_TILE_ERROR_LIMIT,
  createRadarOverlayLayer,
} from './radarOverlay.js';
import { RadarFrameError, parseRainViewerIndex } from './radarFrames.js';

const T0 = Date.UTC(2026, 8, 19, 14, 20, 0);

function makeFrame(name, timeMs = T0) {
  return parseRainViewerIndex({
    host: 'https://tilecache.rainviewer.com',
    radar: { past: [{ time: timeMs / 1000, path: `/v2/radar/${name}` }] },
  });
}

function makeCollection({ throwOnAdd = false } = {}) {
  const collection = {
    layers: [],
    destroyed: [],
    add(layer) {
      if (throwOnAdd) throw new Error('imagery layers unsupported here');
      collection.layers.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      collection.layers = collection.layers.filter((entry) => entry !== layer);
      if (destroy) collection.destroyed.push(layer);
      return true;
    },
  };
  return collection;
}

function makeEvent() {
  const listeners = new Set();
  return {
    addEventListener(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    raise(payload) { for (const fn of [...listeners]) fn(payload); },
    get size() { return listeners.size; },
  };
}

function makeHarness({
  activeId = 'esri-imagery',
  tileset = 'ok', // 'ok' | 'missing' | 'throws'
  withController = true,
  frames = [makeFrame('frame1')],
  clock = { now: T0 + 8 * 60_000 },
} = {}) {
  const viewerLayers = makeCollection();
  const tilesetLayers = makeCollection({ throwOnAdd: tileset === 'throws' });
  const viewer = { imageryLayers: viewerLayers, creditDisplay: {} };
  const googleTileset = tileset === 'missing' ? {} : { imageryLayers: tilesetLayers };

  const eventTarget = new EventTarget();
  const controllerState = { activeId, gen: 1, switching: false, setStackCalls: [], failSwitch: false, available: true };
  const dispatchStack = (status = 'ready') => eventTarget.dispatchEvent(
    Object.assign(new Event('gev:map-stack-changed'), { detail: { activeId: controllerState.activeId, status } }),
  );
  const controller = {
    googleTileset,
    getActiveId: () => controllerState.activeId,
    getSwitchGeneration: () => controllerState.gen,
    getState: () => ({ status: controllerState.switching ? 'switching' : 'ready', activeId: controllerState.activeId }),
    isStackAvailable: () => controllerState.available,
    async setStack(id) {
      controllerState.setStackCalls.push(id);
      controllerState.gen += 1;
      if (!controllerState.failSwitch) controllerState.activeId = id;
      dispatchStack('ready');
      return controller.getState();
    },
  };
  // A user (not radar) changing stacks: same effect on the controller, no call recorded.
  const userSwitch = (id) => {
    controllerState.gen += 1;
    controllerState.activeId = id;
    dispatchStack('ready');
  };

  // The REAL MapStackController timing: it emits 'switching', commits the new stack,
  // emits 'ready' while its own getState() STILL reports "switching" (the flag is
  // cleared in a `finally` that runs after the emit), and only then settles.
  const realSwitch = (id) => {
    controllerState.switching = true;
    dispatchStack('switching');
    controllerState.gen += 1;
    controllerState.activeId = id;
    const statusDuringReady = [];
    const spy = () => statusDuringReady.push(controller.getState().status);
    eventTarget.addEventListener('gev:map-stack-changed', spy);
    dispatchStack('ready');
    eventTarget.removeEventListener('gev:map-stack-changed', spy);
    controllerState.switching = false;
    return statusDuringReady;
  };

  const doc = {
    hidden: false,
    listeners: new Set(),
    addEventListener(name, fn) { if (name === 'visibilitychange') doc.listeners.add(fn); },
    removeEventListener(name, fn) { if (name === 'visibilitychange') doc.listeners.delete(fn); },
    setHidden(hidden) { doc.hidden = hidden; for (const fn of [...doc.listeners]) fn(); },
  };

  let timerId = 0;
  const timers = [];
  const setTimer = (fn, ms) => { timerId += 1; timers.push({ id: timerId, fn, ms, active: true }); return timerId; };
  const clearTimer = (id) => { const timer = timers.find((t) => t.id === id); if (timer) timer.active = false; };
  const activeTimers = () => timers.filter((t) => t.active);
  const fire = (predicate = () => true) => {
    const timer = activeTimers().find(predicate);
    assert.ok(timer, 'expected an active timer');
    timer.active = false;
    timer.fn();
    return timer;
  };

  const credits = { registered: 0, unregistered: 0, live: false };
  const creditsApi = {
    register() { credits.registered += 1; credits.live = true; },
    unregister() { if (credits.live) credits.unregistered += 1; credits.live = false; },
  };

  const renders = [];
  const created = [];
  const fetchState = { queue: [...frames], calls: 0, mode: 'ok', deferred: null, last: frames[frames.length - 1] };
  const fetchFrame = async () => {
    fetchState.calls += 1;
    if (fetchState.deferred) return fetchState.deferred.promise;
    if (fetchState.mode === 'fail') throw new RadarFrameError('network', 'index unreachable');
    if (fetchState.queue.length) fetchState.last = fetchState.queue.shift();
    return fetchState.last;
  };

  const layer = createRadarOverlayLayer({
    fetchFrame,
    now: () => clock.now,
    setTimer,
    clearTimer,
    getDocument: () => doc,
    getEventTarget: () => eventTarget,
    requestRender: (reason) => renders.push(reason),
    credits: creditsApi,
    createImageryLayer: (frame, alpha) => {
      const errorEvent = makeEvent();
      const made = { alpha, framePath: frame.path, imageryProvider: { errorEvent } };
      created.push(made);
      return made;
    },
    ...(withController ? { mapStackController: controller } : {}),
  });

  return {
    layer, viewer, viewerLayers, tilesetLayers, controller, controllerState, userSwitch, realSwitch, dispatchStack,
    doc, eventTarget, timers, activeTimers, fire, credits, renders, created, fetchState, clock,
  };
}

const enable = async (h) => { h.layer.init(h.viewer); return h.layer.enable(h.viewer); };
const pollTimer = (h) => h.activeTimers().find((t) => t.ms >= 60_000 || t.ms === RADAR_REFRESH_MS);

test('globe stack: the layer is added to viewer.imageryLayers at the default opacity', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  assert.equal(await enable(h), true);
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.tilesetLayers.layers.length, 0);
  assert.equal(h.viewerLayers.layers[0].alpha, RADAR_DEFAULT_OPACITY);
  assert.equal(h.viewerLayers.layers[0].framePath, '/v2/radar/frame1');
  assert.equal(h.layer.getStats().attachedTo, 'viewer');
  assert.equal(h.layer.getStatusText(), 'RADAR · 14:20Z · 8 min ago');
  assert.ok(h.renders.includes('radar-attach'));
});

test('Google 3D: the layer goes to the tileset imageryLayers, never the globe', async () => {
  const h = makeHarness({ activeId: 'photoreal' });
  await enable(h);
  assert.equal(h.tilesetLayers.layers.length, 1);
  assert.equal(h.viewerLayers.layers.length, 0);
  assert.equal(h.layer.getStats().attachedTo, 'tileset');
  assert.deepEqual(h.controllerState.setStackCalls, [], 'no stack switch when the tileset can drape');
});

test('enable/disable cleans up completely: layer, credit, timers, listeners', async () => {
  const h = makeHarness({ activeId: 'photoreal' });
  await enable(h);
  assert.equal(h.credits.live, true);
  assert.ok(h.activeTimers().length >= 1, 'poll scheduled');
  assert.equal(h.doc.listeners.size, 1);

  h.layer.disable();
  assert.equal(h.tilesetLayers.layers.length, 0);
  assert.equal(h.tilesetLayers.destroyed.length, 1, 'removed with destroy');
  assert.equal(h.credits.live, false);
  assert.equal(h.credits.unregistered, 1);
  assert.equal(h.activeTimers().length, 0, 'no polling after disable');
  assert.equal(h.doc.listeners.size, 0, 'visibility listener released');
  assert.equal(h.layer.getStatusText(), '');
  assert.ok(h.renders.includes('radar-disable'));

  // Stack events after disable are ignored (listener removed).
  const before = h.created.length;
  h.userSwitch('esri-imagery');
  assert.equal(h.created.length, before);
  assert.equal(h.viewerLayers.layers.length, 0);

  // destroy() is a full, idempotent cleanup.
  h.layer.destroy();
  h.layer.destroy();
  assert.equal(h.layer.getStats().attachedTo, null);
});

test('opacity updates the live layer, clamps, rejects junk, and survives a swap', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  const shown = h.viewerLayers.layers[0];
  const rendersBefore = h.renders.length;

  assert.equal(h.layer.setParams({ opacity: 0.3 }), true);
  assert.equal(shown.alpha, 0.3);
  assert.ok(h.renders.length > rendersBefore);
  assert.ok(h.renders.includes('radar-opacity'));
  assert.equal(h.layer.setParams({ opacity: 5 }), true);
  assert.equal(shown.alpha, 1, 'clamped to max');
  assert.equal(h.layer.setParams({ opacity: 0 }), true);
  assert.equal(shown.alpha, 0.1, 'clamped to min');
  assert.equal(h.layer.setParams({ opacity: 'abc' }), false);
  assert.equal(h.layer.setParams({}), true, 'unrelated params are ignored');
  assert.equal(shown.alpha, 0.1);
  assert.deepEqual(h.layer.getParams(), { opacity: 0.1 });

  h.layer.setParams({ opacity: 0.4 });
  assert.equal(h.layer.getRowControls().slider.value, 40);
  assert.equal(h.layer.getRowControls().slider.valueText, '40%');
  assert.equal(h.layer.getRowControls().reserveSlot, true, 'space reserved for the future play/pause');
  assert.match(h.layer.getRowControls().note.text, /RainViewer/);

  // A new frame keeps the chosen opacity.
  h.fetchState.queue.push(makeFrame('frame2'));
  h.fire((t) => t.ms === RADAR_REFRESH_MS);
  await Promise.resolve(); await Promise.resolve();
  h.fire((t) => t.ms === RADAR_SWAP_OVERLAP_MS);
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.viewerLayers.layers[0].framePath, '/v2/radar/frame2');
  assert.equal(h.viewerLayers.layers[0].alpha, 0.4);
});

test('map-stack migration moves the layer between collections, keeping frame and opacity', async () => {
  const h = makeHarness({ activeId: 'photoreal' });
  await enable(h);
  h.layer.setParams({ opacity: 0.5 });
  const firstFrame = h.layer.getStats().framePath;

  h.userSwitch('esri-imagery');
  assert.equal(h.tilesetLayers.layers.length, 0, 'detached from the tileset');
  assert.equal(h.tilesetLayers.destroyed.length, 1);
  assert.equal(h.viewerLayers.layers.length, 1, 'attached to the globe');
  assert.equal(h.viewerLayers.layers[0].alpha, 0.5);
  assert.equal(h.viewerLayers.layers[0].framePath, firstFrame);
  assert.equal(h.layer.getStats().attachedTo, 'viewer');
  assert.equal(h.credits.live, true);

  h.userSwitch('photoreal');
  assert.equal(h.viewerLayers.layers.length, 0);
  assert.equal(h.tilesetLayers.layers.length, 1);
  assert.equal(h.tilesetLayers.layers[0].alpha, 0.5);

  // Globe → globe: nothing to move, no churn.
  h.userSwitch('osm');
  const created = h.created.length;
  h.userSwitch('bing-aerial');
  assert.equal(h.created.length, created, 'a globe-to-globe switch does not rebuild the layer');
  assert.equal(h.viewerLayers.layers.length, 1);

  // Intermediate 'switching' events never attach.
  h.controllerState.switching = true;
  h.dispatchStack('switching');
  assert.equal(h.viewerLayers.layers.length, 1);
});

test('real controller timing: Google 3D → Esri/OSM migrates even though getState() still says switching', async () => {
  for (const globeId of ['esri-imagery', 'osm']) {
    const h = makeHarness({ activeId: 'photoreal' });
    await enable(h);
    h.layer.setParams({ opacity: 0.4 });
    const frame = h.layer.getStats().framePath;
    assert.equal(h.tilesetLayers.layers.length, 1, 'starts attached to the tileset');
    const registeredBefore = h.credits.registered;
    const tilesetLayer = h.tilesetLayers.layers[0];

    const statusDuringReady = h.realSwitch(globeId);
    assert.deepEqual(statusDuringReady, ['switching'],
      'the ready event fires while the controller still reports "switching" (the real timing)');

    assert.equal(h.tilesetLayers.layers.length, 0, `${globeId}: detached from the hidden tileset`);
    assert.ok(h.tilesetLayers.destroyed.includes(tilesetLayer), 'the tileset layer was destroyed');
    assert.equal(h.viewerLayers.layers.length, 1, `${globeId}: attached to the globe exactly once`);
    assert.equal(h.viewerLayers.layers[0].alpha, 0.4, 'opacity preserved');
    assert.equal(h.viewerLayers.layers[0].framePath, frame, 'same frame');
    assert.equal(h.layer.getStats().attachedTo, 'viewer');
    assert.equal(h.credits.live, true, 'credit still shown');
    assert.equal(h.credits.registered - registeredBefore, 1, 'credit re-registered once for the new surface');
    assert.deepEqual(h.controllerState.setStackCalls, [], 'no fallback switch triggered');

    // A repeated settled event (some paths emit more than one) must not duplicate the layer.
    h.dispatchStack('ready');
    assert.equal(h.viewerLayers.layers.length, 1, 'no duplicate radar layer');
    assert.equal(h.tilesetLayers.layers.length, 0);
    h.layer.disable();
  }
});

test('real controller timing: Esri/OSM → Google 3D migrates back to the tileset exactly once', async () => {
  for (const globeId of ['esri-imagery', 'osm']) {
    const h = makeHarness({ activeId: globeId });
    await enable(h);
    h.layer.setParams({ opacity: 0.4 });
    const frame = h.layer.getStats().framePath;
    assert.equal(h.viewerLayers.layers.length, 1, 'starts attached to the globe');
    const viewerLayer = h.viewerLayers.layers[0];
    const registeredBefore = h.credits.registered;

    const statusDuringReady = h.realSwitch('photoreal');
    assert.deepEqual(statusDuringReady, ['switching']);

    assert.equal(h.viewerLayers.layers.length, 0, `${globeId} → Google 3D: viewer layer removed`);
    assert.ok(h.viewerLayers.destroyed.includes(viewerLayer));
    assert.equal(h.tilesetLayers.layers.length, 1, 'tileset layer added exactly once');
    assert.equal(h.tilesetLayers.layers[0].alpha, 0.4, 'opacity preserved');
    assert.equal(h.tilesetLayers.layers[0].framePath, frame, 'same frame');
    assert.equal(h.layer.getStats().attachedTo, 'tileset');
    assert.equal(h.credits.live, true);
    assert.equal(h.credits.registered - registeredBefore, 1);
    assert.deepEqual(h.controllerState.setStackCalls, [], 'no fallback triggered');

    h.dispatchStack('ready');
    assert.equal(h.tilesetLayers.layers.length, 1, 'no duplicate radar layer');
    assert.equal(h.viewerLayers.layers.length, 0);
    h.layer.disable();
  }
});

test('real controller timing: a full Google 3D → Esri → Google 3D round trip ends with one layer on the tileset', async () => {
  const h = makeHarness({ activeId: 'photoreal' });
  await enable(h);
  h.realSwitch('esri-imagery');
  assert.equal(h.viewerLayers.layers.length, 1, 'on the globe after the first switch');
  assert.equal(h.tilesetLayers.layers.length, 0);
  h.realSwitch('osm');
  assert.equal(h.viewerLayers.layers.length, 1, 'globe → globe keeps a single layer');
  h.realSwitch('photoreal');
  assert.equal(h.tilesetLayers.layers.length, 1);
  assert.equal(h.viewerLayers.layers.length, 0);
  assert.equal(h.credits.live, true);
  assert.deepEqual(h.controllerState.setStackCalls, []);
});

test('the mid-switch guard still protects paths with no settled event (fetch landing during a real switch)', async () => {
  const h = makeHarness({ activeId: 'photoreal' });
  let resolve;
  h.fetchState.deferred = { promise: new Promise((r) => { resolve = r; }) };
  h.layer.init(h.viewer);
  const pending = h.layer.enable(h.viewer);
  h.controllerState.switching = true;
  h.dispatchStack('switching');
  resolve(makeFrame('during-real-switch'));
  await pending;
  assert.equal(h.tilesetLayers.layers.length, 0, 'not attached to a stack that is going away');
  assert.equal(h.viewerLayers.layers.length, 0);

  // The switch completes with the real timing: the ready event attaches to the winner.
  h.controllerState.gen += 1;
  h.controllerState.activeId = 'esri-imagery';
  h.dispatchStack('ready'); // controller state still "switching" here
  h.controllerState.switching = false;
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.tilesetLayers.layers.length, 0);
});

test('fallback: no tileset.imageryLayers → switch to Esri, say why, restore on disable', async () => {
  const h = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  await enable(h);
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery']);
  assert.equal(h.controllerState.activeId, 'esri-imagery');
  assert.equal(h.viewerLayers.layers.length, 1, 'radar is shown on the globe');
  assert.equal(h.layer.getStatusText(), 'RADAR · GLOBE FALLBACK');
  assert.equal(h.layer.getStats().fallback, true);

  h.layer.disable();
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery', 'photoreal'], 'previous stack restored');
  assert.equal(h.viewerLayers.layers.length, 0);
});

test('fallback: adding to the tileset throws → same graceful switch', async () => {
  const h = makeHarness({ activeId: 'photoreal', tileset: 'throws' });
  await enable(h);
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery']);
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.tilesetLayers.layers.length, 0);
  assert.equal(h.layer.getStatusText(), 'RADAR · GLOBE FALLBACK');
});

test('fallback never fights the user: a manual stack change forfeits the restore', async () => {
  const h = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  await enable(h);
  assert.equal(h.controllerState.activeId, 'esri-imagery');

  h.userSwitch('osm'); // the user picks another globe stack
  h.layer.disable();
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery'], 'no restore over the user choice');
  assert.equal(h.controllerState.activeId, 'osm');
});

test('fallback restore is also gated on the switch generation at disable time', async () => {
  // A stack change that never produced an event (e.g. a silent switch) must
  // still forfeit the restore — the generation check is the backstop.
  const h = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  await enable(h);
  h.controllerState.gen += 1;
  h.controllerState.activeId = 'osm';
  h.layer.disable();
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery']);
});

test('fallback: user returning to Google 3D hides radar without a second switch', async () => {
  const h = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  await enable(h);
  h.userSwitch('photoreal');
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery'], 'radar does not switch them away again');
  assert.equal(h.viewerLayers.layers.length, 0);
  assert.equal(h.tilesetLayers.layers.length, 0);
  assert.equal(h.layer.getStatusText(), 'RADAR · GLOBE MODE REQUIRED');
  assert.equal(h.controllerState.activeId, 'photoreal');
  h.layer.disable();
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery'], 'and does not "restore" either');

  // Turning radar on again re-runs the capability check from scratch.
  await enable(h);
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery', 'esri-imagery']);
});

test('fallback switch that does not take is reported, not faked', async () => {
  const h = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  h.controllerState.failSwitch = true;
  await enable(h);
  assert.equal(h.controllerState.activeId, 'photoreal');
  assert.equal(h.layer.getStatusText(), 'RADAR · UNAVAILABLE');
  assert.equal(h.viewerLayers.layers.length, 0);
  h.layer.disable(); // no throw
  assert.deepEqual(h.controllerState.setStackCalls, ['esri-imagery'], 'nothing to restore');

  const unavailable = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  unavailable.controllerState.available = false;
  await enable(unavailable);
  assert.deepEqual(unavailable.controllerState.setStackCalls, [], 'globe stack unavailable → no attempt');
  assert.equal(unavailable.layer.getStatusText(), 'RADAR · GLOBE MODE REQUIRED');
});

test('no map-stack controller at all: derive the surface from the scene', async () => {
  const h = makeHarness({ activeId: 'esri-imagery', withController: false });
  h.viewer.scene = { globe: { show: true } };
  await enable(h);
  assert.equal(h.viewerLayers.layers.length, 1);
});

test('race: disable while the enable fetch is pending attaches nothing and schedules nothing', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  let resolve;
  h.fetchState.deferred = { promise: new Promise((r) => { resolve = r; }) };
  h.layer.init(h.viewer);
  const pending = h.layer.enable(h.viewer);
  h.layer.disable();
  resolve(makeFrame('late'));
  assert.equal(await pending, true);
  assert.equal(h.viewerLayers.layers.length, 0);
  assert.equal(h.tilesetLayers.layers.length, 0);
  assert.equal(h.activeTimers().length, 0);
  assert.equal(h.credits.registered, 0);
  assert.equal(h.layer.getStats().attachedTo, null);
});

test('race: re-enable while the first fetch is pending — the stale result is dropped', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  const resolvers = [];
  h.fetchState.deferred = null;
  const originalCalls = () => h.fetchState.calls;
  // First enable hangs; second enable uses a normal fetch.
  const hang = new Promise((r) => resolvers.push(r));
  h.fetchState.deferred = { promise: hang };
  h.layer.init(h.viewer);
  const first = h.layer.enable(h.viewer);
  h.layer.disable();
  h.fetchState.deferred = null;
  await h.layer.enable(h.viewer);
  assert.equal(h.viewerLayers.layers.length, 1);
  resolvers[0](makeFrame('stale-first'));
  await first;
  assert.equal(h.viewerLayers.layers.length, 1, 'the abandoned enable did not add a second layer');
  assert.equal(h.viewerLayers.layers[0].framePath, '/v2/radar/frame1');
  assert.ok(originalCalls() >= 2);
});

test('race: the stack is mid-switch when the fetch lands — attach waits for the ready event', async () => {
  const h = makeHarness({ activeId: 'photoreal' });
  let resolve;
  h.fetchState.deferred = { promise: new Promise((r) => { resolve = r; }) };
  h.layer.init(h.viewer);
  const pending = h.layer.enable(h.viewer);
  h.controllerState.switching = true;
  resolve(makeFrame('during-switch'));
  await pending;
  assert.equal(h.tilesetLayers.layers.length, 0);
  assert.equal(h.viewerLayers.layers.length, 0, 'not attached to a stack that is going away');

  h.controllerState.switching = false;
  h.controllerState.activeId = 'esri-imagery';
  h.controllerState.gen += 1;
  h.dispatchStack('ready');
  assert.equal(h.viewerLayers.layers.length, 1, 'attached to the stack that actually won');
  assert.equal(h.tilesetLayers.layers.length, 0);
});

test('polling: 5 minute cadence, paused while hidden, resumed when visible', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  assert.equal(h.fetchState.calls, 1);
  assert.equal(h.activeTimers().length, 1);
  assert.equal(h.activeTimers()[0].ms, RADAR_REFRESH_MS);

  h.doc.setHidden(true);
  assert.equal(h.activeTimers().length, 0, 'poll timer cleared while hidden');
  assert.equal(h.fetchState.calls, 1);

  h.clock.now += RADAR_REFRESH_MS + 1_000; // overdue by the time the tab returns
  h.doc.setHidden(false);
  assert.equal(h.activeTimers().length, 1, 'poll resumed');
  assert.equal(h.activeTimers()[0].ms, 0, 'overdue → refresh right away');
  h.fire();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.fetchState.calls, 2);

  // Not yet due when the tab returns: waits out the remainder instead of refetching.
  h.doc.setHidden(true);
  h.clock.now += 60_000;
  h.doc.setHidden(false);
  const resumed = h.activeTimers()[0];
  assert.ok(resumed.ms > 0 && resumed.ms <= RADAR_REFRESH_MS, `remaining delay, got ${resumed.ms}`);
});

test('a poll tick that fires while hidden does not fetch', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  const timer = h.activeTimers()[0];
  h.doc.hidden = true; // hidden without the event having run yet
  timer.active = false;
  timer.fn();
  await Promise.resolve();
  assert.equal(h.fetchState.calls, 1);
  assert.equal(h.activeTimers().length, 0);
});

test('frame refresh: same path does nothing; a new path swaps cleanly after the overlap', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  const first = h.viewerLayers.layers[0];

  // Same frame again.
  h.fetchState.queue.push(makeFrame('frame1'));
  h.fire((t) => t.ms === RADAR_REFRESH_MS);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.fetchState.calls, 2);
  assert.equal(h.created.length, 1, 'no new layer for an unchanged frame');
  assert.equal(h.viewerLayers.layers[0], first);

  // New frame: preload beside the old one, then retire the old.
  const rendersBefore = h.renders.length;
  h.fetchState.queue.push(makeFrame('frame2', T0 + 600_000));
  h.fire((t) => t.ms === RADAR_REFRESH_MS);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.created.length, 2);
  assert.equal(h.viewerLayers.layers.length, 2, 'old stays up while the new frame loads');
  const incoming = h.viewerLayers.layers[1];
  assert.equal(incoming.framePath, '/v2/radar/frame2');
  assert.ok(incoming.alpha < 0.01, 'the incoming frame preloads invisibly');
  assert.ok(h.renders.length > rendersBefore, 'a render is requested for the change');

  h.fire((t) => t.ms === RADAR_SWAP_OVERLAP_MS);
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.viewerLayers.layers[0], incoming);
  assert.equal(incoming.alpha, RADAR_DEFAULT_OPACITY);
  assert.equal(h.viewerLayers.destroyed.includes(first), true);
  assert.equal(h.layer.getStats().framePath, '/v2/radar/frame2');
});

test('a second new frame mid-swap finishes the first swap instead of stacking layers', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  h.fetchState.queue.push(makeFrame('frame2', T0 + 600_000));
  h.fire((t) => t.ms === RADAR_REFRESH_MS);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.viewerLayers.layers.length, 2);

  h.fetchState.queue.push(makeFrame('frame3', T0 + 1_200_000));
  h.fire((t) => t.ms === RADAR_REFRESH_MS);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.viewerLayers.layers.length, 2, 'never more than the outgoing + incoming layer');
  h.fire((t) => t.ms === RADAR_SWAP_OVERLAP_MS);
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.viewerLayers.layers[0].framePath, '/v2/radar/frame3');
});

test('a refresh failure keeps the loaded radar visible and backs off', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  h.fetchState.mode = 'fail';

  for (let i = 0; i < RADAR_BACKOFF_MS.length + 1; i += 1) {
    const timer = h.activeTimers()[0];
    assert.ok(timer, 'a retry is always scheduled');
    const expected = i === 0 ? RADAR_REFRESH_MS : RADAR_BACKOFF_MS[Math.min(i - 1, RADAR_BACKOFF_MS.length - 1)];
    assert.equal(timer.ms, expected, `attempt ${i}`);
    h.fire();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.viewerLayers.layers.length, 1, 'radar stays on screen');
    assert.match(h.layer.getStatusText(), /^RADAR · 14:20Z/, 'still describes the frame that is shown');
  }
  assert.equal(h.activeTimers()[0].ms, RADAR_BACKOFF_MS[RADAR_BACKOFF_MS.length - 1], 'delay caps');

  h.fetchState.mode = 'ok';
  h.fire();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.activeTimers()[0].ms, RADAR_REFRESH_MS, 'success resets to the normal cadence');
});

test('initial fetch failure: stays enabled but UNAVAILABLE, retries, then recovers', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  h.fetchState.mode = 'fail';
  assert.equal(await enable(h), true, 'enable resolves; the layer reports its own failure');
  assert.equal(h.viewerLayers.layers.length, 0);
  assert.equal(h.layer.getStatusText(), 'RADAR · UNAVAILABLE');
  const stats = h.layer.getStats();
  assert.equal(stats.status, 'unavailable');
  assert.ok(stats.error);
  assert.equal(h.activeTimers()[0].ms, RADAR_BACKOFF_MS[0]);
  assert.equal(h.credits.registered, 0, 'no attribution for radar that is not shown');

  h.fetchState.mode = 'ok';
  h.fire();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.layer.getStatusText(), 'RADAR · 14:20Z · 8 min ago');
  assert.equal(h.layer.getStats().status, undefined);
});

test('stale metadata is shown but labelled STALE', async () => {
  const h = makeHarness({ activeId: 'esri-imagery', clock: { now: T0 + 45 * 60_000 } });
  await enable(h);
  assert.equal(h.viewerLayers.layers.length, 1);
  assert.equal(h.layer.getStatusText(), 'RADAR · STALE · 14:20Z');
  assert.equal(h.layer.getStats().stale, true);
});

test('loading state is reported while the first fetch is in flight', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  let resolve;
  h.fetchState.deferred = { promise: new Promise((r) => { resolve = r; }) };
  h.layer.init(h.viewer);
  const pending = h.layer.enable(h.viewer);
  assert.equal(h.layer.getStatusText(), 'RADAR · LOADING');
  assert.equal(h.layer.getStats().loading, true);
  resolve(makeFrame('frame1'));
  await pending;
  assert.equal(h.layer.getStats().loading, false);
});

test('tile failures on the current frame surface as UNAVAILABLE and look for a newer frame', async () => {
  const h = makeHarness({ activeId: 'esri-imagery' });
  await enable(h);
  const events = h.created[0].imageryProvider.errorEvent;
  assert.equal(events.size, 1);
  const callsBefore = h.fetchState.calls;
  for (let i = 0; i < RADAR_TILE_ERROR_LIMIT; i += 1) events.raise({ error: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.layer.getStatusText(), 'RADAR · UNAVAILABLE');
  assert.ok(h.fetchState.calls > callsBefore, 'a fresh frame index is requested');

  // A newer frame clears it.
  h.fetchState.queue.push(makeFrame('frame2', T0 + 600_000));
  h.fire((t) => t.ms === RADAR_REFRESH_MS);
  await Promise.resolve(); await Promise.resolve();
  assert.match(h.layer.getStatusText(), /^RADAR · 14:30Z/);
});

test('credit lifecycle: registered while radar is attached, removed when it is not', async () => {
  const h = makeHarness({ activeId: 'photoreal', tileset: 'missing' });
  assert.equal(h.credits.live, false);
  await enable(h);
  assert.equal(h.credits.live, true, 'on while radar shows (fallback globe)');
  h.userSwitch('photoreal'); // radar hidden in Google 3D on this renderer
  assert.equal(h.credits.live, false, 'no credit while nothing is drawn');
  h.userSwitch('osm');
  assert.equal(h.credits.live, true, 'back when radar shows again');
  h.layer.disable();
  assert.equal(h.credits.live, false);
});

test('the default factory builds a real Cesium imagery layer over the API frame URL', async () => {
  const viewerLayers = makeCollection();
  const layer = createRadarOverlayLayer({
    fetchFrame: async () => makeFrame('real'),
    now: () => T0,
    setTimer: () => 1,
    clearTimer: () => {},
    getDocument: () => null,
    getEventTarget: () => null,
    requestRender: () => {},
    credits: { register() {}, unregister() {} },
  });
  const viewer = { imageryLayers: viewerLayers };
  layer.init(viewer);
  await layer.enable(viewer);
  const made = viewerLayers.layers[0];
  assert.ok(made instanceof Cesium.ImageryLayer);
  assert.equal(made.alpha, RADAR_DEFAULT_OPACITY);
  const provider = made.imageryProvider;
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.maximumLevel, 7);
  assert.equal(provider.minimumLevel, 0);
  layer.disable();
  assert.equal(viewerLayers.layers.length, 0);
});
