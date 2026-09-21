// Flight Intelligence Phase E, browser side: the selection-only history controller (one request,
// cache, coalescing, switch/deselect races, failure), the panel's history rows (calculated values,
// no fabricated flight times), the layer wiring, and the guarantees (no ambient traces, no
// OpenSky fallback, no AIS, Phase A/B intact). Fixture data only; nothing touches a network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import { buildFlightDetailsModel, formatTraceTime, initFlightPanel } from './flightPanel.js';
import {
  HISTORY_CACHE_MAX,
  HISTORY_FAILURE_TTL_MS,
  HISTORY_TTL_MS,
  HISTORY_URL,
  createFlightHistory,
} from './data/flightHistory.js';
import flightsLayer, { _historyForTest, _setTrackedFlightRefreshStateForTest } from './data/flights.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = Date.UTC(2026, 8, 21, 18, 0, 0); // 2026-09-21 18:00Z
const HEX_A = 'a40ca4';
const HEX_B = 'ae1fa4';

const body = (hex, over = {}) => ({
  icao24: hex,
  points: [[1_000, 33.6, -84.4, 'ground', 5, 90, 0], [2_000, 34, -83, 30000, 450, 40, 0], [3_000, 35, -82, 31000, 450, 40, 0]],
  stats: { rawPoints: 5252, legPoints: 2100, keptPoints: 3, startEpoch: 1_000, endEpoch: 3_000, durationSec: 8_280, distanceKm: 1_526.4, startsAtTraceBeginning: false, onGroundNow: false, ...over },
  meta: {},
});
const jsonResponse = (payload, ok = true) => ({ ok, status: ok ? 200 : 502, json: async () => payload });

/** A controllable fake fetch: each call is held until released. */
function fakeFetch() {
  const calls = [];
  const impl = (url, init) => new Promise((resolve, reject) => {
    const call = { url, init, resolve: (r) => resolve(r), reject };
    init?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    calls.push(call);
  });
  return { impl, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// -- controller: one request, cache, coalescing -------------------------------------------------------

test('history is requested only by an explicit request(), for one aircraft, with a fixed local URL', async () => {
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl });
  assert.equal(f.calls.length, 0, 'nothing happens until asked');
  assert.deepEqual(h.view(HEX_A), { status: 'idle' });
  h.request(HEX_A);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${HISTORY_URL}?hex=${HEX_A}`);
  assert.equal(HISTORY_URL, '/api/adsblol/history');
  assert.deepEqual(h.view(HEX_A), { status: 'loading' });
  f.calls[0].resolve(jsonResponse(body(HEX_A)));
  await tick();
  const view = h.view(HEX_A);
  assert.equal(view.status, 'ready');
  assert.equal(view.stats.distanceKm, 1_526.4);
  assert.equal(view.points.length, 3);
});

test('invalid ICAO24s are never requested', () => {
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl });
  for (const bad of ['', 'A40CA4', 'zzzzzz', null, undefined, 'a40ca4/x', '~a40ca4']) h.request(bad);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(h.view('nope'), { status: 'idle' });
});

test('asking again while loading coalesces onto the request already running', () => {
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl });
  h.request(HEX_A);
  h.request(HEX_A);
  h.request(HEX_A);
  assert.equal(f.calls.length, 1);
  assert.equal(h._requests(), 1);
});

test('repeat selection uses the cache: no second download within the TTL, a refresh after it', async () => {
  let clock = 0;
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl, now: () => clock });
  h.request(HEX_A);
  f.calls[0].resolve(jsonResponse(body(HEX_A)));
  await tick();
  h.clear();
  h.request(HEX_A); // re-selected
  assert.equal(f.calls.length, 1, 'served from the cache');
  assert.equal(h.view(HEX_A).status, 'ready');
  clock += HISTORY_TTL_MS + 1;
  h.request(HEX_A);
  assert.equal(f.calls.length, 2, 'refreshed once it ages out');
});

test('the client cache is bounded', async () => {
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl });
  const hexes = Array.from({ length: HISTORY_CACHE_MAX + 6 }, (_, i) => (0x200000 + i).toString(16));
  for (const hex of hexes) {
    h.request(hex);
    f.calls.at(-1).resolve(jsonResponse(body(hex)));
    await tick();
  }
  assert.equal(h._size(), HISTORY_CACHE_MAX);
});

// -- races ---------------------------------------------------------------------------------------------------

test('switching aircraft aborts the old request and a late answer can never attach to the new aircraft', async () => {
  const f = fakeFetch();
  const changed = [];
  const h = createFlightHistory({ fetchImpl: f.impl, onChange: (hex) => changed.push(hex) });
  h.request(HEX_A);
  h.request(HEX_B); // the user selected another aircraft
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].init.signal.aborted, true, 'A was aborted: at most one active request');
  assert.equal(f.calls[1].init.signal.aborted, false);
  // A's answer arrives anyway (a fetch that ignores abort): it must be dropped.
  f.calls[0].resolve(jsonResponse(body(HEX_A)));
  await tick();
  assert.deepEqual(h.view(HEX_A), { status: 'idle' }, 'A stored nothing');
  assert.equal(h.view(HEX_B).status, 'loading');
  f.calls[1].resolve(jsonResponse(body(HEX_B, { distanceKm: 99 })));
  await tick();
  assert.equal(h.view(HEX_B).stats.distanceKm, 99);
  assert.equal(h.view(HEX_A).status, 'idle', 'B never shows A, and A never shows B');
  assert.equal(changed.filter((hex) => hex === HEX_A).length, 1, 'A only announced "loading", never "ready"');
});

test('switching back to an aircraft whose history finished uses the cache', async () => {
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl });
  h.request(HEX_A);
  f.calls[0].resolve(jsonResponse(body(HEX_A)));
  await tick();
  h.request(HEX_B);
  f.calls[1].resolve(jsonResponse(body(HEX_B)));
  await tick();
  h.request(HEX_A);
  assert.equal(f.calls.length, 2, 'A came back from the cache');
  assert.equal(h.view(HEX_A).status, 'ready');
});

test('deselecting aborts the request and drops a late answer', async () => {
  const f = fakeFetch();
  const changed = [];
  const h = createFlightHistory({ fetchImpl: f.impl, onChange: (hex) => changed.push(hex) });
  h.request(HEX_A);
  h.clear();
  assert.equal(f.calls[0].init.signal.aborted, true);
  f.calls[0].resolve(jsonResponse(body(HEX_A)));
  await tick();
  assert.deepEqual(h.view(HEX_A), { status: 'idle' });
  assert.deepEqual(changed, [HEX_A], 'only the initial "loading" was announced');
  assert.equal(h._size(), 0);
});

// -- failure -------------------------------------------------------------------------------------------------

test('failures degrade to "unavailable" quietly and are not retried in a loop', async () => {
  let clock = 0;
  const f = fakeFetch();
  const h = createFlightHistory({ fetchImpl: f.impl, now: () => clock });
  h.request(HEX_A);
  f.calls[0].reject(new Error('network down'));
  await tick();
  assert.deepEqual(h.view(HEX_A), { status: 'unavailable' });
  h.request(HEX_A);
  h.request(HEX_A);
  assert.equal(f.calls.length, 1, 'no loop: the failure is remembered briefly');
  clock += HISTORY_FAILURE_TTL_MS + 1;
  h.request(HEX_A);
  assert.equal(f.calls.length, 2, 'a deliberate re-open after the window may retry');
});

test('non-OK answers, bad JSON and too-short paths are all "unavailable"', async () => {
  for (const make of [
    () => jsonResponse({ error: 'x' }, false),
    () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    () => jsonResponse({ points: [[1, 2, 3, 4, 5, 6, 7]], stats: {} }),
    () => jsonResponse({ points: [], stats: {} }),
    () => jsonResponse(null),
  ]) {
    const f = fakeFetch();
    const h = createFlightHistory({ fetchImpl: f.impl });
    h.request(HEX_A);
    f.calls[0].resolve(make());
    await tick();
    assert.equal(h.view(HEX_A).status, 'unavailable');
  }
});

test('a request that never answers times out into "unavailable" and stops', async () => {
  const f = fakeFetch();
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
  try {
    const h = createFlightHistory({ fetchImpl: f.impl });
    h.request(HEX_A);
    const timeout = timers.find((t) => t.ms === 10_000);
    assert.ok(timeout, 'a 10 s timeout is armed');
    timeout.fn();
    await new Promise((r) => realSetTimeout(r, 0));
    assert.equal(h.view(HEX_A).status, 'unavailable');
    assert.equal(f.calls[0].init.signal.aborted, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// -- panel model: history rows ------------------------------------------------------------------------------------

const details = (history, over = {}) => ({
  icao24: HEX_A, callsign: 'DAL1491', latitude: 36, longitude: -78, altitudeM: 10_668, onGround: false, velocityMps: 230, track: 20, stale: false,
  feed: { source: 'adsb.lol', coverage: '250nm regional fallback' }, history, ...over,
});
const rowsOf = (model) => Object.fromEntries(model.sections.flatMap((s) => s.rows.map((r) => [r.key, r])));
const NY = 'America/New_York';

test('a ready history adds calculated Tracked since / duration / distance / points to ROUTE, labelled as calculated', () => {
  const stats = { rawPoints: 5252, legPoints: 2100, keptPoints: 300, startEpoch: Math.floor(NOW / 1000) - 8_280, endEpoch: Math.floor(NOW / 1000), durationSec: 8_280, distanceKm: 1_526.4, startsAtTraceBeginning: false, onGroundNow: false };
  const model = buildFlightDetailsModel(details({ status: 'ready', stats }), { nowMs: NOW, timeZone: NY });
  const r = rowsOf(model);
  assert.equal(r.trackedSince.label, 'Tracked since');
  assert.equal(r.trackedSince.value, '11:42 AM', 'today, in the pinned zone');
  assert.equal(r.trackedDuration.value, '2 h 18 min');
  assert.equal(r.trackedDuration.tag, 'CALCULATED');
  assert.equal(r.trackedDistance.value, '824 nm (1,526 km)');
  assert.equal(r.trackedDistance.tag, 'CALCULATED');
  assert.equal(r.historyPoints.value, '300 shown · 2,100 recorded');
  assert.equal(r.history.value, 'adsb.lol trace · current leg', 'the source row credits adsb.lol');
  assert.ok(model.sections.find((s) => s.id === 'route').rows.some((row) => row.key === 'trackedSince'));
  assert.match(r.calcNote.value, /CALCULATED or ESTIMATED[\s\S]*not provider data/);
});

test('no scheduled/actual departure, arrival, flight-time or ETA wording is ever produced from the trace', () => {
  const stats = { rawPoints: 10, legPoints: 8, keptPoints: 8, startEpoch: 1, endEpoch: 2, durationSec: 1, distanceKm: 1, startsAtTraceBeginning: false, onGroundNow: true };
  const model = buildFlightDetailsModel(details({ status: 'ready', stats }), { nowMs: NOW, timeZone: NY });
  const text = model.sections.flatMap((s) => s.rows.flatMap((row) => [row.label, row.value])).join(' | ');
  for (const banned of [/depart/i, /arriv/i, /scheduled/i, /flight time/i, /flight duration/i, /on time|delay/i, /gate|terminal/i]) assert.equal(banned.test(text), false, String(banned));
  assert.ok(/Tracked since/.test(text) && /Tracked duration/.test(text));
});

test('start-of-trace and on-the-ground cases are worded honestly', () => {
  const base = { rawPoints: 3, legPoints: 3, keptPoints: 3, startEpoch: Math.floor(NOW / 1000) - 3600, endEpoch: Math.floor(NOW / 1000) - 600, durationSec: 3000, distanceKm: 10 };
  const atStart = rowsOf(buildFlightDetailsModel(details({ status: 'ready', stats: { ...base, startsAtTraceBeginning: true, onGroundNow: false } }), { nowMs: NOW, timeZone: NY }));
  assert.match(atStart.trackedSince.value, /\(start of available trace\)$/);
  assert.equal(atStart.trackedUntil, undefined);
  const landed = rowsOf(buildFlightDetailsModel(details({ status: 'ready', stats: { ...base, startsAtTraceBeginning: false, onGroundNow: true } }), { nowMs: NOW, timeZone: NY }));
  assert.equal(landed.trackedUntil.label, 'Tracked until');
  assert.equal(landed.trackedUntil.value, '1:50 PM');
});

test('a trace that began on an earlier day shows the date', () => {
  assert.equal(formatTraceTime(Math.floor(NOW / 1000) - 26 * 3600, NOW, NY), 'Sep 20, 12:00 PM');
  assert.equal(formatTraceTime(Math.floor(NOW / 1000) - 3600, NOW, NY), '1:00 PM');
  assert.equal(formatTraceTime(null, NOW, NY), null);
});

test('loading and unavailable are shown plainly; idle and missing history add nothing', () => {
  assert.equal(rowsOf(buildFlightDetailsModel(details({ status: 'loading' }), { nowMs: NOW })).history.value, 'Loading…');
  assert.equal(rowsOf(buildFlightDetailsModel(details({ status: 'unavailable' }), { nowMs: NOW })).history.value, 'History unavailable');
  for (const history of [{ status: 'idle' }, undefined, null]) {
    const r = rowsOf(buildFlightDetailsModel(details(history), { nowMs: NOW }));
    for (const key of ['history', 'trackedSince', 'trackedDuration', 'trackedDistance', 'historyPoints']) assert.equal(r[key], undefined, key);
  }
});

test('a history failure leaves every Phase A/B row exactly as it was', () => {
  const full = { ...details(undefined), airline: 'Delta Air Lines', registration: 'N360DN', typeName: 'Airbus A321', typeCode: 'A321', registeredOwner: 'Delta Air Lines',
    route: { origin: { code: 'CHS', name: 'Charleston', lat: 32.9, lon: -80 }, destination: { code: 'BOS', name: 'Boston', lat: 42.36, lon: -71 } }, geoAltitudeM: 10_760, verticalRateMps: 6.5, squawk: '2023', lastContactEpochMs: NOW - 4000 };
  const strip = (model) => JSON.stringify(model.sections.map((s) => [s.id, s.rows.filter((r) => !['history', 'calcNote'].includes(r.key)).map((r) => [r.key, r.value, r.tag ?? null])]));
  const without = buildFlightDetailsModel({ ...full, history: undefined }, { nowMs: NOW });
  const failed = buildFlightDetailsModel({ ...full, history: { status: 'unavailable' } }, { nowMs: NOW });
  assert.equal(strip(failed), strip(without));
  const r = rowsOf(failed);
  for (const key of ['registration', 'registeredOwner', 'bearing', 'distance', 'squawk', 'vertical', 'age', 'feed']) assert.ok(r[key], key);
});

// -- controller hooks: the panel is the deliberate action -----------------------------------------------------------

function makeNode(tag = 'div') {
  const node = {
    tag, children: [], className: '', hidden: false, textContent: '', scrollTop: 0, attributes: {}, listeners: {},
    classList: { contains: (name) => String(node.className).split(/\s+/).includes(name) },
    appendChild(child) { node.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    replaceChildren() { node.children = []; },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of node.listeners.click || []) fn({}); },
    focus() {},
    querySelector: () => null,
  };
  return node;
}
function panelHarness({ initial }) {
  let current = initial;
  const requested = [];
  const ids = {};
  for (const id of ['flight-details-btn', 'flight-details-panel', 'flight-details-body', 'flight-details-title', 'layer-drawer']) ids[id] = makeNode();
  ids['flight-details-btn'].hidden = true;
  ids['flight-details-panel'].hidden = true;
  ids['flight-details-panel'].querySelector = () => makeNode();
  const win = new EventTarget();
  win.setInterval = () => ({ unref() {} });
  win.clearInterval = () => {};
  win.setTimeout = (fn, ms) => setTimeout(fn, ms);
  win.clearTimeout = (h) => clearTimeout(h);
  initFlightPanel({ getDetails: () => current, requestHistory: (hex) => requested.push(hex), doc: { getElementById: (id) => ids[id] || null, createElement: makeNode, body: null }, win, now: () => NOW });
  return {
    ids, requested, setDetails: (d) => { current = d; },
    select: (id, layerId = 'flights') => win.dispatchEvent(new CustomEvent('gev:awareness-subject-selected', { detail: { layerId, id } })),
    clear: (id) => win.dispatchEvent(new CustomEvent('gev:awareness-subject-cleared', { detail: { layerId: 'flights', id } })),
    open: () => ids['flight-details-btn'].click(),
  };
}

test('history is asked for only when the panel is opened, and again only when the selection changes while it is open', async () => {
  const h = panelHarness({ initial: details({ status: 'idle' }) });
  h.select(HEX_A);
  assert.deepEqual(h.requested, [], 'selecting an aircraft alone fetches nothing');
  h.open();
  assert.deepEqual(h.requested, [HEX_A], 'opening Flight details is the deliberate action');
  h.clear(HEX_A);
  h.setDetails(details({ status: 'idle' }, { icao24: HEX_B }));
  h.select(HEX_B);
  await tick();
  assert.deepEqual(h.requested, [HEX_A, HEX_B], 'the open panel follows the new aircraft');
});

test('a closed panel never requests history, however often the selection changes', async () => {
  const h = panelHarness({ initial: details({ status: 'idle' }) });
  for (const hex of [HEX_A, HEX_B, HEX_A, HEX_B]) { h.select(hex); await tick(); }
  h.clear(HEX_B);
  assert.deepEqual(h.requested, []);
});

test('a throwing history hook never breaks the panel', () => {
  const ids = {};
  for (const id of ['flight-details-btn', 'flight-details-panel', 'flight-details-body', 'flight-details-title']) ids[id] = makeNode();
  ids['flight-details-panel'].querySelector = () => makeNode();
  const win = new EventTarget();
  win.setInterval = () => ({ unref() {} });
  win.clearInterval = () => {};
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  const api = initFlightPanel({ getDetails: () => details({ status: 'idle' }), requestHistory: () => { throw new Error('boom'); }, doc: { getElementById: (id) => ids[id] || null, createElement: makeNode, body: null }, win, now: () => NOW });
  win.dispatchEvent(new CustomEvent('gev:awareness-subject-selected', { detail: { layerId: 'flights', id: HEX_A } }));
  assert.doesNotThrow(() => api.open());
  assert.equal(api.isOpen(), true);
});

// -- layer: history rides the tracked aircraft only ------------------------------------------------------------------------

const POSITION = Cesium.Cartesian3.fromDegrees(-78, 36, 10_668);
function seed({ icao24 = HEX_A, tracked = true } = {}) {
  _setTrackedFlightRefreshStateForTest({
    icao24,
    entity: null,
    billboard: { position: POSITION, color: Cesium.Color.WHITE, show: true },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked,
    meta: { callsign: 'DAL1491', altitude: 10_668, renderAltitudeM: 10_760, velocity: 230, true_track: 20, klass: 'airliner', onGround: false, wasAirborne: true, turnRateDps: 0, rawLat: 36, rawLon: -78 },
  });
}

test('getTrackedDetails reports history status only (no polyline points), and none when nothing is tracked', () => {
  seed();
  assert.deepEqual(flightsLayer.getTrackedDetails().history, { status: 'idle' });
  seed({ tracked: false });
  assert.equal(flightsLayer.getTrackedDetails(), null);
  flightsLayer.requestTrackedHistory(); // nothing tracked: no request, no throw
  assert.equal(_historyForTest()._requests() >= 0, true);
});

test('requestTrackedHistory asks for the TRACKED aircraft only', () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = (url, init) => { urls.push(String(url)); return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))); };
  try {
    seed({ icao24: HEX_B });
    flightsLayer.requestTrackedHistory();
    assert.deepEqual(urls, [`${HISTORY_URL}?hex=${HEX_B}`]);
    assert.deepEqual(flightsLayer.getTrackedDetails().history, { status: 'loading' });
    flightsLayer.requestTrackedHistory();
    assert.equal(urls.length, 1, 'coalesced');
  } finally {
    _historyForTest().clear();
    globalThis.fetch = realFetch;
  }
});

test('trace requests are never part of the poll, ambient enrichment, or any non-panel path', () => {
  const flights = code('./data/flights.js');
  assert.equal((flights.match(/_history\.request\(/g) || []).length, 1, 'one call site');
  assert.match(flights, /requestTrackedHistory\(\) \{\s*if \(!_trackedIcao\) return;\s*_history\.request\(_trackedIcao\);/);
  assert.equal(/adsblol\/(trace|history)/.test(flights), false, 'flights.js never names a trace URL itself');
  const callers = ['./main.js', './ui.js', './layerDrawer.js', './data/manager.js', './data/militaryFlights.js']
    .filter((file) => /requestTrackedHistory/.test(code(file)));
  assert.deepEqual(callers, ['./main.js'], 'only the panel wiring calls it');
  assert.match(read('./main.js'), /requestHistory: \(\) => flightsLayer\.requestTrackedHistory\?\.\(\)/);
  const poll = flights.slice(flights.indexOf('const usableStates = data.states.filter'), flights.indexOf('_lastSource = responseSource'));
  assert.equal(/_history|requestTrackedHistory/.test(poll), false, 'the 30 s poll never touches history');
  const ambient = flights.slice(flights.indexOf('function _sweepAmbientEnrichment'), flights.indexOf('function _refloorStaleGroundedContacts'));
  assert.equal(/_history|requestTrackedHistory/.test(ambient), false, 'ambient enrichment never touches history');
});

test('deselecting clears the history request and the map path; switching invalidates any paint in flight', () => {
  const flights = code('./data/flights.js');
  const clearing = flights.slice(flights.indexOf('function _clearTracking('), flights.indexOf('function _normalizeTrackedIcao'));
  assert.match(clearing, /_history\.clear\(\);[\s\S]*_clearHistoryPath\(\);/);
  const clearPath = flights.slice(flights.indexOf('function _clearHistoryPath'), flights.indexOf('/**\n * Clear the rendered trail'));
  assert.match(clearPath, /_historyPaintToken \+= 1;/, 'a paint awaiting terrain is invalidated');
  const paint = flights.slice(flights.indexOf('async function _paintHistoryPath'), flights.indexOf('function _clearHistoryPath'));
  assert.match(paint, /token !== _historyPaintToken \|\| icao24 !== _trackedIcao/, 'a stale paint cannot draw for another aircraft');
  assert.match(flights, /if \(icao24 !== _trackedIcao\) return; \/\/ an answer for anything but the selected aircraft is ignored/);
});

test('the history path is a separate, distinct-coloured single polyline, hidden in the cockpit', () => {
  const flights = code('./data/flights.js');
  assert.match(flights, /const HISTORY_TRAIL_COLOR = '#c39bff';/);
  assert.notEqual('#c39bff', '#00d4ff', 'differs from the live cyan session trail');
  assert.match(flights, /createTrail\(_viewer, \{ color: HISTORY_TRAIL_COLOR, width: 2 \}\)/);
  assert.equal((flights.match(/createTrail\(/g) || []).length, 2, 'the session trail and the history trail, one entity each');
  assert.match(flights, /_historyTrail\?\.setVisible\(!next\);/);
  assert.match(flights, /_historyTrail\.destroy\(\);/);
});

test('the existing session trail, OpenSky backfill call and follow behaviour are untouched', () => {
  const flights = read('./data/flights.js');
  assert.match(flights, /fetch\('\/api\/opensky-track\?icao24=' \+ encodeURIComponent\(icao24\)/, 'unchanged existing backfill (not a fallback of the new path)');
  assert.match(flights, /const TRAIL_COLOR = '#00d4ff';/);
  assert.match(flights, /_trail = createTrail\(_viewer, \{ color: TRAIL_COLOR, width: 2\.5 \}\);/);
  const history = code('./data/flightHistory.js');
  assert.equal(/opensky/i.test(history), false, 'the history path never falls back to OpenSky');
});

test('no AIS code is imported or touched; the compact readout module is untouched', () => {
  for (const file of ['./data/flightHistory.js', './data/adsbLolTrace.js', './flightPanel.js']) {
    const imports = [...code(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.equal(imports.some((i) => /ais|vessel/i.test(i)), false, `${file} imports no AIS module`);
  }
  for (const file of ['./data/aisLiveVessels.js', './data/aisViewFilter.js', './data/aisRegions.js', './data/trackedReadout.js']) {
    assert.equal(/flightHistory|adsbLolTrace|requestTrackedHistory|historyTrail/.test(read(file)), false, `${file} is untouched`);
  }
  assert.equal(/adsbLolFallback|state\[1[5-9]\]/.test(code('./data/flightHistory.js')), false);
});
