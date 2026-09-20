// Regional AIS coverage: the fixed catalogue, validation, combined boxes, the
// point-in-coverage matcher, and the desired-vs-subscribed coalescing controller.
// Pure logic with fake timers - no sockets, no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIS_COVERAGE_DEBOUNCE_MS,
  AIS_COVERAGE_MIN_SEND_INTERVAL_MS,
  AIS_DEFAULT_REGIONS,
  AIS_REGION_CATALOGUE,
  AIS_REGION_LIMITS,
  boxesForRegions,
  createAisCoverageController,
  createCoverageMatcher,
  isKnownRegionId,
  normalizeRegionIds,
  parseDefaultRegionsEnv,
  pointInRegions,
  publicRegionCatalogue,
  sameRegionSet,
} from './aisRegions.js';

test('the catalogue holds exactly the four approved regions with the approved boxes', () => {
  assert.deepEqual(AIS_REGION_CATALOGUE.map((r) => r.id), ['gulf', 'east-coast', 'west-coast', 'great-lakes']);
  assert.deepEqual(AIS_REGION_CATALOGUE.map((r) => r.label),
    ['Gulf of Mexico', 'U.S. East Coast', 'U.S. West Coast', 'Great Lakes']);
  const byId = Object.fromEntries(AIS_REGION_CATALOGUE.map((r) => [r.id, r.boxes]));
  assert.deepEqual(byId.gulf, [[[24.5, -98.0], [30.9, -90.0]], [[24.0, -90.0], [30.9, -81.5]]]);
  assert.deepEqual(byId['east-coast'], [
    [[24.3, -82.0], [31.0, -79.0]], [[31.0, -81.5], [40.2, -72.0]], [[40.2, -74.5], [45.0, -66.0]],
  ]);
  assert.deepEqual(byId['west-coast'], [
    [[32.3, -122.0], [34.8, -117.0]], [[34.8, -125.0], [38.6, -121.0]], [[38.6, -126.0], [49.0, -122.0]],
  ]);
  assert.deepEqual(byId['great-lakes'], [
    [[46.3, -92.3], [49.1, -84.3]], [[41.5, -88.2], [46.6, -79.6]], [[41.3, -83.6], [44.3, -75.8]],
  ]);
});

test('the catalogue is deeply immutable', () => {
  assert.equal(Object.isFrozen(AIS_REGION_CATALOGUE), true);
  assert.equal(Object.isFrozen(AIS_REGION_CATALOGUE[0]), true);
  assert.equal(Object.isFrozen(AIS_REGION_CATALOGUE[0].boxes), true);
  assert.equal(Object.isFrozen(AIS_REGION_CATALOGUE[0].boxes[0][0]), true);
  assert.throws(() => { 'use strict'; AIS_REGION_CATALOGUE[0].boxes[0][0][0] = 0; }, TypeError);
  // Returned boxes are copies: mutating them never touches the catalogue.
  const boxes = boxesForRegions(['gulf']);
  boxes[0][0][0] = 99;
  assert.equal(AIS_REGION_CATALOGUE[0].boxes[0][0][0], 24.5);
});

test('first-rollout limits and default', () => {
  assert.deepEqual({ ...AIS_REGION_LIMITS }, { minRegions: 1, maxRegions: 2, maxBoxes: 12 });
  assert.deepEqual([...AIS_DEFAULT_REGIONS], ['gulf']);
  assert.equal(AIS_COVERAGE_DEBOUNCE_MS, 3000);
  assert.equal(AIS_COVERAGE_MIN_SEND_INTERVAL_MS, 5000);
});

test('public catalogue metadata is id, label and boxCount only', () => {
  const pub = publicRegionCatalogue();
  assert.deepEqual(pub, [
    { id: 'gulf', label: 'Gulf of Mexico', boxCount: 2 },
    { id: 'east-coast', label: 'U.S. East Coast', boxCount: 3 },
    { id: 'west-coast', label: 'U.S. West Coast', boxCount: 3 },
    { id: 'great-lakes', label: 'Great Lakes', boxCount: 3 },
  ]);
  assert.equal(JSON.stringify(pub).includes('-98'), false, 'no coordinates in public metadata');
});

test('validation accepts 1-2 known regions and normalises order and duplicates', () => {
  assert.deepEqual(normalizeRegionIds(['gulf']), { ok: true, regions: ['gulf'] });
  assert.deepEqual(normalizeRegionIds(['east-coast', 'gulf']), { ok: true, regions: ['gulf', 'east-coast'] });
  assert.deepEqual(normalizeRegionIds(['gulf', 'gulf', 'gulf']), { ok: true, regions: ['gulf'] });
});

test('validation rejects unknown, empty, oversized and malformed input', () => {
  assert.match(normalizeRegionIds(['atlantis']).error, /unknown region/);
  assert.match(normalizeRegionIds(['gulf', 'constructor']).error, /unknown region/, 'inherited keys are not regions');
  assert.match(normalizeRegionIds([]).error, /at least 1/);
  assert.match(normalizeRegionIds(['gulf', 'east-coast', 'west-coast']).error, /at most 2/);
  assert.match(normalizeRegionIds(['gulf', 'east-coast', 'west-coast', 'great-lakes']).error, /at most 2/);
  for (const bad of [undefined, null, 'gulf', {}, 7, [1], [null], [{ id: 'gulf' }]]) {
    assert.equal(normalizeRegionIds(bad).ok, false, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(isKnownRegionId('gulf'), true);
  assert.equal(isKnownRegionId('__proto__'), false);
});

test('combined boxes concatenate in canonical order and never exceed 12', () => {
  assert.equal(boxesForRegions(['gulf']).length, 2);
  assert.equal(boxesForRegions(['gulf', 'east-coast']).length, 5);
  assert.deepEqual(boxesForRegions(['gulf', 'east-coast']).slice(0, 2), boxesForRegions(['gulf']));
  // Even the full catalogue (11) stays under the hard ceiling, and every allowed pair is well under it.
  assert.equal(boxesForRegions(AIS_REGION_CATALOGUE.map((r) => r.id)).length, 11);
  assert.ok(11 <= AIS_REGION_LIMITS.maxBoxes);
  for (const a of AIS_REGION_CATALOGUE) {
    for (const b of AIS_REGION_CATALOGUE) {
      assert.ok(boxesForRegions([a.id, b.id]).length <= AIS_REGION_LIMITS.maxBoxes);
    }
  }
  assert.deepEqual(boxesForRegions(['nope']), []);
});

test('the coverage matcher accepts points inside enabled boxes only', () => {
  const inGulf = createCoverageMatcher(['gulf']);
  assert.equal(inGulf(29.3, -94.8), true, 'Galveston');
  assert.equal(inGulf(25.0, -85.0), true, 'open Gulf, second box');
  assert.equal(inGulf(40.7, -74.0), false, 'New York');
  assert.equal(inGulf(Number.NaN, -94), false);
  assert.equal(inGulf(29, Number.NaN), false);
  assert.equal(createCoverageMatcher([]), null);
  assert.equal(pointInRegions(['east-coast'], 40.7, -74.0), true);
  assert.equal(pointInRegions(['east-coast'], 29.3, -94.8), false);
  assert.equal(pointInRegions(['great-lakes'], 41.5, -81.7), true, 'Cleveland');
  assert.equal(pointInRegions(['west-coast'], 37.8, -122.4), true, 'San Francisco');
});

test('default-region env parsing falls back safely and says why', () => {
  assert.deepEqual(parseDefaultRegionsEnv(undefined), { regions: ['gulf'], warning: null });
  assert.deepEqual(parseDefaultRegionsEnv(' east-coast , gulf '), { regions: ['gulf', 'east-coast'], warning: null });
  const bad = parseDefaultRegionsEnv('gulf,east-coast,west-coast');
  assert.deepEqual(bad.regions, ['gulf']);
  assert.match(bad.warning, /Ignoring AISSTREAM_DEFAULT_REGIONS/);
  assert.deepEqual(parseDefaultRegionsEnv('atlantis').regions, ['gulf']);
});

// -- coalescing controller ----------------------------------------------------

function makeController(overrides = {}) {
  let now = 1_000_000;
  const timers = [];
  const applied = [];
  const changes = [];
  let controller;
  const applyToSocket = () => {
    applied.push({ at: now, desired: controller.getDesired() });
    if (overrides.socketAvailable !== false) controller.markSubscribed();
    return { sent: overrides.socketAvailable !== false };
  };
  controller = createAisCoverageController({
    initial: ['gulf'],
    applyToSocket,
    onSubscribedChange: (next, prev) => changes.push({ next, prev }),
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = { fn, due: now + ms, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => { if (handle) handle.cancelled = true; },
  });
  return {
    controller, applied, changes, timers,
    /** Advance the fake clock, firing due timers in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => !t.cancelled && t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = Math.max(now, next.due);
        next.cancelled = true;
        next.fn();
      }
      now = end;
    },
    get now() { return now; },
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
}

test('initial state: desired is the default, nothing subscribed yet, applying until first send', () => {
  const h = makeController();
  assert.deepEqual(h.controller.snapshot(), {
    desired: ['gulf'], subscribed: [], applying: true, lastSubscribedAt: null, pending: false,
  });
  h.controller.markSubscribed(); // the first connect
  assert.equal(h.controller.snapshot().applying, false);
  assert.deepEqual(h.controller.getSubscribed(), ['gulf']);
  assert.equal(h.controller.snapshot().lastSubscribedAt, h.now);
});

test('an identical desired set is a no-op and schedules nothing', () => {
  const h = makeController();
  h.controller.markSubscribed();
  const result = h.controller.setDesired(['gulf']);
  assert.deepEqual(result, { ok: true, changed: false, desired: ['gulf'] });
  assert.equal(h.pendingTimers(), 0);
  h.advance(60_000);
  assert.equal(h.applied.length, 0);
});

test('a change is sent once after the 3s trailing debounce', () => {
  const h = makeController();
  h.controller.markSubscribed();
  h.advance(60_000); // well past the min-interval
  h.controller.setDesired(['east-coast']);
  assert.equal(h.controller.isApplying(), true);
  h.advance(2_999);
  assert.equal(h.applied.length, 0, 'not before 3s');
  h.advance(1);
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.controller.getSubscribed(), ['east-coast']);
  assert.equal(h.controller.isApplying(), false);
});

test('rapid changes collapse into ONE send of the newest set', () => {
  const h = makeController();
  h.controller.markSubscribed();
  h.advance(60_000);
  h.controller.setDesired(['east-coast']);
  h.advance(1_000);
  h.controller.setDesired(['west-coast']);
  h.advance(1_000);
  h.controller.setDesired(['gulf', 'great-lakes']);
  h.advance(1_000);
  h.controller.setDesired(['great-lakes']);
  assert.equal(h.applied.length, 0, 'the debounce keeps restarting');
  h.advance(3_000);
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.applied[0].desired, ['great-lakes']);
  assert.deepEqual(h.controller.getSubscribed(), ['great-lakes']);
});

test('actual sends are at least 5s apart even when the debounce would allow sooner', () => {
  const h = makeController();
  h.controller.markSubscribed(); // send #0 at t0 (a connect counts as a send)
  const t0 = h.now;
  h.controller.setDesired(['east-coast']);
  h.advance(3_000);
  assert.equal(h.applied.length, 0, 'debounce elapsed but the 5s spacing has not');
  h.advance(2_000);
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].at - t0, 5_000);

  const t1 = h.applied[0].at;
  h.controller.setDesired(['west-coast']);
  h.advance(4_999);
  assert.equal(h.applied.length, 1);
  h.advance(1);
  assert.equal(h.applied.length, 2);
  assert.ok(h.applied[1].at - t1 >= 5_000);
});

test('flipping back to the subscribed set cancels the pending send', () => {
  const h = makeController();
  h.controller.markSubscribed();
  h.advance(60_000);
  h.controller.setDesired(['east-coast']);
  assert.equal(h.pendingTimers(), 1);
  h.controller.setDesired(['gulf']);
  assert.equal(h.pendingTimers(), 0);
  assert.equal(h.controller.isApplying(), false);
  h.advance(60_000);
  assert.equal(h.applied.length, 0);
});

test('with no usable socket desired is retained, nothing is subscribed, and there is no retry storm', () => {
  const h = makeController({ socketAvailable: false });
  h.controller.markSubscribed(); // pretend the initial connect happened
  h.advance(60_000);
  h.controller.setDesired(['east-coast']);
  h.advance(3_000);
  assert.equal(h.applied.length, 1, 'one attempt');
  assert.deepEqual(h.controller.getDesired(), ['east-coast']);
  assert.deepEqual(h.controller.getSubscribed(), ['gulf'], 'the upstream still believes the old set');
  assert.equal(h.controller.isApplying(), true);
  assert.equal(h.pendingTimers(), 0, 'no timer loop while there is no socket');
  h.advance(600_000);
  assert.equal(h.applied.length, 1);
  // The next socket's open sends the CURRENT desired set and marks it subscribed.
  h.controller.markSubscribed();
  assert.deepEqual(h.controller.getSubscribed(), ['east-coast']);
  assert.equal(h.controller.isApplying(), false);
});

test('a change to subscribed coverage is reported to the cache purge hook exactly once', () => {
  const h = makeController();
  h.controller.markSubscribed();
  assert.deepEqual(h.changes.at(-1), { next: ['gulf'], prev: [] });
  h.controller.markSubscribed(); // re-sending the same coverage is not a change
  assert.equal(h.changes.length, 1);
  h.advance(60_000);
  h.controller.setDesired(['east-coast']);
  h.advance(3_000);
  assert.deepEqual(h.changes.at(-1), { next: ['east-coast'], prev: ['gulf'] });
  assert.equal(h.changes.length, 2);
});

test('invalid requests never change the desired set', () => {
  const h = makeController();
  assert.equal(h.controller.setDesired(['atlantis']).ok, false);
  assert.equal(h.controller.setDesired([]).ok, false);
  assert.equal(h.controller.setDesired(['gulf', 'east-coast', 'west-coast']).ok, false);
  assert.deepEqual(h.controller.getDesired(), ['gulf']);
  assert.equal(sameRegionSet(['gulf'], ['gulf']), true);
  assert.equal(sameRegionSet(['gulf'], ['gulf', 'east-coast']), false);
});
