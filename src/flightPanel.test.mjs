// Flight Intelligence Phase A: the expanded Flight details panel, the squawk parse, the
// additive tracked-aircraft description, the corrected source label, and the panel's
// selection/open/close behaviour. Fixture data only; nothing here touches a network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import {
  angleDiffDeg,
  bearingDeg,
  buildFlightDetailsModel,
  estimateMinutesRemaining,
  formatAltitude,
  formatBearing,
  formatDataAge,
  formatDuration,
  formatGeometricAltitude,
  formatSpeedKt,
  formatSquawk,
  formatVerticalRate,
  initFlightPanel,
  remainingToDestination,
} from './flightPanel.js';
import { greatCircleKm } from './data/routePlausible.js';
import flightsLayer, {
  _contextSubjectMetadataForTest,
  _setFlightFeedSourceForTest,
  _setTrackedFlightRefreshStateForTest,
  parseSquawk,
} from './data/flights.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('../style.css');
const html = read('../index.html');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BOS = { code: 'BOS', name: 'Boston', lat: 42.3643, lon: -71.0052 };
const CHS = { code: 'CHS', name: 'Charleston', lat: 32.8986, lon: -80.0405 };

/** A full description as `flightsLayer.getTrackedDetails()` returns it. */
const details = (over = {}) => ({
  icao24: 'a40ca4',
  callsign: 'DAL1491',
  airline: 'Delta Air Lines',
  registration: 'N360DN',
  typeName: 'Airbus A321 211SL',
  typeCode: 'A321',
  klass: 'airliner',
  originCountry: null,
  route: { origin: { ...CHS }, destination: { ...BOS } },
  latitude: 36.0,
  longitude: -78.0,
  altitudeM: 10_668,
  geoAltitudeM: 10_760,
  onGround: false,
  velocityMps: 230,
  track: 20,
  verticalRateMps: 6.5,
  squawk: '2023',
  lastContactEpochMs: 1_000_000 - 4000,
  stale: false,
  feed: { source: 'adsb.lol', coverage: '250nm regional fallback' },
  ...over,
});
const NOW = 1_000_000;
const rowsOf = (model) => Object.fromEntries(model.sections.flatMap((s) => s.rows.map((r) => [r.key, r.value])));
const sectionIds = (model) => model.sections.map((s) => s.id);

// -- squawk ---------------------------------------------------------------------------------------

test('squawk parse: only a 4-digit octal code survives; row[14] is read without changing the row contract', () => {
  assert.equal(parseSquawk('2023'), '2023');
  assert.equal(parseSquawk(' 7700 '), '7700');
  assert.equal(parseSquawk('0000'), '0000');
  for (const bad of [null, undefined, '', '12', '12345', '1289', 'ABCD', 0, {}]) assert.equal(parseSquawk(bad), null, String(bad));
  const source = read('./data/flights.js');
  assert.match(source, /const squawk = parseSquawk\(state\[14\]\)/, 'read from row[14]');
  assert.match(source, /category: cat,\s*squawk,/, 'kept in the per-aircraft metadata');
  assert.equal(/state\[1[5-9]\]/.test(source.match(/const squawk[\s\S]{0,200}/)[0]), false);
  // The server row shape and the fallback normalizer are untouched by this phase.
  assert.match(read('./data/adsbLolFallback.js'), /aircraft\?\.squawk \|\| null,/);
});

// -- formatting -----------------------------------------------------------------------------------

test('altitude, geometric altitude, speed, track, vertical rate, squawk, age', () => {
  assert.equal(formatAltitude(10_668), 'FL350 (35,000 ft)');
  assert.equal(formatAltitude(1_646), '5,400 ft');
  assert.equal(formatAltitude(null), null);
  assert.equal(formatGeometricAltitude(10_760), '35,302 ft (GPS)');
  assert.equal(formatSpeedKt(230), '447 kt');
  assert.equal(formatBearing(247), '247° WSW');
  assert.equal(formatBearing(360), '0° N');
  assert.equal(formatVerticalRate(6.5), '+1,280 fpm ▲');
  assert.equal(formatVerticalRate(-3.3), '−650 fpm ▼');
  assert.equal(formatVerticalRate(0.1), 'Level');
  assert.equal(formatVerticalRate(null), null);
  assert.equal(formatSquawk('7700'), '7700 · general emergency code');
  assert.equal(formatSquawk('7500'), '7500 · hijack code');
  assert.equal(formatSquawk('2023'), '2023');
  assert.equal(formatDataAge(4000), 'Updated 4s ago');
  assert.equal(formatDataAge(65_000), 'Updated 1m 05s ago');
  assert.equal(formatDataAge(-500), 'Updated 0s ago');
  assert.equal(formatDataAge(null), null);
  assert.equal(formatDuration(102), '1 h 42 min');
  assert.equal(formatDuration(35), '35 min');
});

// -- calculations reuse the shared great-circle helper ----------------------------------------------

test('distance and bearing come from the shared helper; bearing is a true initial bearing', () => {
  const r = remainingToDestination({ lat: 36.0, lon: -78.0, destination: BOS });
  assert.ok(Math.abs(r.km - greatCircleKm(36.0, -78.0, BOS.lat, BOS.lon)) < 1e-9, 'the same function, not a copy');
  assert.ok(Math.abs(r.nm - r.km / 1.852) < 1e-9);
  assert.ok(r.bearing > 36 && r.bearing < 40, `Raleigh area → Boston is about NE (${r.bearing.toFixed(1)}°)`);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 10) - 90) < 1e-6, 'due east');
  assert.ok(Math.abs(bearingDeg(0, 0, 10, 0) - 0) < 1e-6 || Math.abs(bearingDeg(0, 0, 10, 0) - 360) < 1e-6, 'due north');
  assert.ok(Math.abs(bearingDeg(0, 0, 0, -10) - 270) < 1e-6, 'due west');
  assert.equal(remainingToDestination({ lat: 1, lon: 1, destination: { lat: null, lon: 2 } }), null);
  assert.equal(angleDiffDeg(350, 10), 20);
  assert.equal(angleDiffDeg(10, 350), 20);
});

test('time remaining is an estimate and is omitted when it would mislead', () => {
  const ok = { distanceKm: 900, speedMps: 230, trackDeg: 20, bearing: 25, onGround: false };
  const minutes = estimateMinutesRemaining(ok);
  assert.ok(Math.abs(minutes - (900_000 / 230 / 60)) < 1e-9);
  assert.equal(estimateMinutesRemaining({ ...ok, onGround: true }), null, 'on the ground');
  assert.equal(estimateMinutesRemaining({ ...ok, speedMps: 20 }), null, 'unusable speed');
  assert.equal(estimateMinutesRemaining({ ...ok, speedMps: null }), null);
  assert.equal(estimateMinutesRemaining({ ...ok, distanceKm: 5 }), null, 'basically there');
  assert.equal(estimateMinutesRemaining({ ...ok, trackDeg: 200 }), null, 'flying away from the destination');
  assert.equal(estimateMinutesRemaining({ ...ok, trackDeg: null }), null);
  assert.equal(estimateMinutesRemaining({ ...ok, distanceKm: 40_000, speedMps: 60 }), null, 'absurdly long');
});

// -- model ----------------------------------------------------------------------------------------------

test('a full aircraft fills every Phase A section with the right values', () => {
  const model = buildFlightDetailsModel(details(), { nowMs: NOW });
  assert.equal(model.title, 'DAL1491');
  assert.equal(model.icao24, 'a40ca4');
  assert.deepEqual(sectionIds(model), ['flight', 'aircraft', 'live', 'route', 'source']);
  const r = rowsOf(model);
  assert.equal(r.callsign, 'DAL1491');
  assert.equal(r.operator, 'Delta Air Lines');
  assert.equal(r.route, 'CHS → BOS');
  assert.equal(r.origin, 'CHS · Charleston', 'airport code + city');
  assert.equal(r.destination, 'BOS · Boston');
  assert.equal(r.registration, 'N360DN');
  assert.equal(r.type, 'Airbus A321 211SL');
  assert.equal(r.typeCode, 'A321');
  assert.equal(r.class, 'Airliner');
  assert.equal(r.icao24, 'A40CA4');
  assert.equal(r.status, 'Live');
  assert.equal(r.ground, 'Airborne');
  assert.equal(r.altitude, 'FL350 (35,000 ft)');
  assert.equal(r.geoAltitude, '35,302 ft (GPS)');
  assert.equal(r.speed, '447 kt');
  assert.equal(r.track, '20° NNE');
  assert.equal(r.vertical, '+1,280 fpm ▲');
  assert.equal(r.squawk, '2023');
  assert.equal(r.position, '36.0000° N · 78.0000° W');
  assert.equal(r.age, 'Updated 4s ago');
  assert.equal(r.bearing, '38° NE');
  assert.match(r.distance, /nm \(\d[\d,]* km\) straight line$/);
  assert.match(r.eta, /^≈ \d+ h \d\d min$|^≈ \d+ min$/);
  assert.equal(r.feed, 'adsb.lol · 250nm regional fallback');
  assert.equal(r.identity, 'adsbdb');
  const tags = Object.fromEntries(model.sections.find((s) => s.id === 'route').rows.map((row) => [row.key, row.tag]));
  assert.deepEqual(tags, { bearing: 'CALCULATED', distance: 'ESTIMATED', eta: 'ESTIMATED' }, 'never presented as provider data');
  assert.match(r.calcNote, /not provider data/);
});

test('missing fields are omitted, never rendered as filler', () => {
  const sparse = buildFlightDetailsModel({ icao24: 'abc123', feed: { source: 'adsb.lol' } }, { nowMs: NOW });
  assert.equal(sparse.title, 'ABC123');
  const r = rowsOf(sparse);
  assert.deepEqual(Object.keys(r).sort(), ['feed', 'icao24', 'status'].sort());
  assert.deepEqual(sectionIds(sparse), ['aircraft', 'live', 'source']);
  for (const section of sparse.sections) for (const row of section.rows) {
    assert.ok(row.value && row.value !== '—' && !/undefined|null|NaN/.test(row.value), `${row.key} has a real value`);
  }
  assert.equal(r.identity, undefined, 'no adsbdb line without any enriched field');
  assert.equal(buildFlightDetailsModel(null), null);
  assert.equal(buildFlightDetailsModel({ icao24: '  ' }), null);
});

test('title falls back callsign → registration → ICAO24', () => {
  assert.equal(buildFlightDetailsModel(details({ callsign: '  ' }), { nowMs: NOW }).title, 'N360DN');
  assert.equal(buildFlightDetailsModel(details({ callsign: null, registration: null }), { nowMs: NOW }).title, 'A40CA4');
});

test('on the ground: no altitude, vertical rate or time remaining, but the ground state and speed show', () => {
  const r = rowsOf(buildFlightDetailsModel(details({ onGround: true, velocityMps: 8 }), { nowMs: NOW }));
  assert.equal(r.ground, 'On ground');
  assert.equal(r.altitude, undefined);
  assert.equal(r.geoAltitude, undefined);
  assert.equal(r.vertical, undefined);
  assert.equal(r.eta, undefined);
  assert.equal(r.speed, '16 kt');
});

test('unknown speed (the layer defaults it to 0) is not shown as 0 kt or a 0° track while airborne', () => {
  const r = rowsOf(buildFlightDetailsModel(details({ velocityMps: 0, track: 0 }), { nowMs: NOW }));
  assert.equal(r.speed, undefined);
  assert.equal(r.track, undefined);
  assert.equal(r.eta, undefined);
});

test('stale aircraft say so, and the route only appears when the layer judged it plausible', () => {
  assert.equal(rowsOf(buildFlightDetailsModel(details({ stale: true }), { nowMs: NOW })).status, 'Stale · showing last known position');
  const noRoute = rowsOf(buildFlightDetailsModel(details({ route: null }), { nowMs: NOW }));
  for (const key of ['route', 'origin', 'destination', 'bearing', 'distance', 'eta', 'calcNote']) assert.equal(noRoute[key], undefined, key);
  const noCoords = rowsOf(buildFlightDetailsModel(details({ route: { origin: { code: 'CHS' }, destination: { code: 'BOS' } } }), { nowMs: NOW }));
  assert.equal(noCoords.route, 'CHS → BOS');
  assert.equal(noCoords.bearing, undefined, 'no coordinates → nothing calculated');
});

test('class shows only when it adds information (the bare default guess is not presented as fact)', () => {
  assert.equal(rowsOf(buildFlightDetailsModel(details({ typeCode: null, klass: 'airliner' }), { nowMs: NOW })).class, undefined);
  assert.equal(rowsOf(buildFlightDetailsModel(details({ typeCode: null, klass: 'helicopter' }), { nowMs: NOW })).class, 'Helicopter');
  assert.equal(rowsOf(buildFlightDetailsModel(details({ typeCode: 'A321' }), { nowMs: NOW })).class, 'Airliner');
});

test('an emergency squawk is annotated; no scope creep into later-phase fields', () => {
  assert.equal(rowsOf(buildFlightDetailsModel(details({ squawk: '7700' }), { nowMs: NOW })).squawk, '7700 · general emergency code');
  const labels = buildFlightDetailsModel(details(), { nowMs: NOW }).sections.flatMap((s) => s.rows.map((row) => row.label.toLowerCase()));
  for (const later of ['photo', 'owner', 'year', 'seat', 'capacity', 'gate', 'terminal', 'baggage', 'delay', 'departure', 'arrival', 'schedule']) {
    assert.equal(labels.some((label) => label.includes(later)), false, `Phase A must not show "${later}"`);
  }
});

// -- layer integration: additive description, source label ---------------------------------------------

const ICAO = 'a40ca4';
const POSITION = Cesium.Cartesian3.fromDegrees(-78.0, 36.0, 10_668);
function seed({ tracked = true, icao24 = ICAO, meta = {} } = {}) {
  _setTrackedFlightRefreshStateForTest({
    icao24,
    entity: null,
    billboard: { position: POSITION, color: Cesium.Color.WHITE, show: true },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked,
    meta: {
      callsign: 'DAL1491',
      registration: 'N360DN',
      typeCode: 'A321',
      typeName: 'Airbus A321 211SL',
      airline: 'Delta Air Lines',
      altitude: 10_668,
      geoAltitudeM: 10_760,
      renderAltitudeM: 10_760,
      velocity: 230,
      true_track: 20,
      verticalRate: 6.5,
      squawk: '2023',
      lastContactEpochMs: 1_000_000,
      klass: 'airliner',
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 36.0,
      rawLon: -78.0,
      route: { origin: { ...CHS }, destination: { ...BOS } },
      ...meta,
    },
  });
}

test('getTrackedDetails carries the additive Phase A fields and the feed', () => {
  seed();
  _setFlightFeedSourceForTest({ source: 'adsb.lol', coverage: '250nm regional fallback' });
  const d = flightsLayer.getTrackedDetails();
  assert.equal(d.icao24, ICAO);
  assert.equal(d.geoAltitudeM, 10_760);
  assert.equal(d.verticalRateMps, 6.5);
  assert.equal(d.squawk, '2023');
  assert.equal(d.registration, 'N360DN');
  assert.equal(d.typeCode, 'A321');
  assert.equal(d.klass, 'airliner');
  assert.equal(d.lastContactEpochMs, 1_000_000);
  assert.equal(d.route.origin.name, 'Charleston');
  assert.equal(d.route.destination.name, 'Boston');
  assert.deepEqual(d.feed, { source: 'adsb.lol', coverage: '250nm regional fallback' });
  assert.equal('position' in d, false, 'no Cesium object leaks into the panel');
  assert.equal(flightsLayer.getTrackedInfo().squawk, '2023', 'the existing descriptor only gained fields');
});

test('getTrackedDetails is null when nothing is tracked, and changes with the selected aircraft', () => {
  seed({ tracked: false });
  assert.equal(flightsLayer.getTrackedDetails(), null);
  seed({ icao24: 'ae1fa4', meta: { callsign: 'SWA696', registration: 'N123AB', squawk: '1200' } });
  const other = flightsLayer.getTrackedDetails();
  assert.equal(other.icao24, 'ae1fa4');
  assert.equal(other.callsign, 'SWA696');
  assert.equal(other.squawk, '1200');
  seed();
  assert.equal(flightsLayer.getTrackedDetails().callsign, 'DAL1491');
});

test('missing detail metadata stays null (nothing invented by the layer)', () => {
  seed({ meta: { geoAltitudeM: undefined, verticalRate: null, squawk: null, lastContactEpochMs: undefined, registration: null } });
  const d = flightsLayer.getTrackedDetails();
  assert.equal(d.geoAltitudeM, null);
  assert.equal(d.verticalRateMps, null);
  assert.equal(d.squawk, null);
  assert.equal(d.lastContactEpochMs, null);
  assert.equal(d.registration, null);
});

test('the Context/voice source follows the live feed: adsb.lol in production fallback mode, never a fixed OpenSky string', () => {
  seed();
  _setFlightFeedSourceForTest({ source: 'adsb.lol', coverage: '250nm regional fallback' });
  assert.equal(_contextSubjectMetadataForTest(ICAO).source, 'adsb.lol');
  _setFlightFeedSourceForTest({ source: 'OpenSky Network', coverage: 'worldwide upstream snapshot' });
  assert.equal(_contextSubjectMetadataForTest(ICAO).source, 'OpenSky Network', 'OpenSky is still named when it really is the source');
  const flights = read('./data/flights.js');
  const fn = flights.slice(flights.indexOf('function _contextSubjectMetadata('), flights.indexOf('function _isExplicitTrackingOrigin'));
  assert.equal(/source:\s*'OpenSky Network'/.test(fn), false, 'no hard-coded source in the descriptor');
  assert.match(fn, /source: _lastSource,/);
  // The provider name comes from the response header the proxy sets in fallback mode.
  assert.match(flights, /_lastSource = responseSource \|\| 'OpenSky Network';/);
  assert.match(flights, /response\.headers\.get\('x-flight-source'\)/);
});

// -- controller: fake DOM ------------------------------------------------------------------------------------

function makeNode(tag = 'div') {
  const node = {
    tag, children: [], className: '', hidden: false, textContent: '', scrollTop: 0, attributes: {}, listeners: {}, parent: null,
    classList: { contains: (name) => String(node.className).split(/\s+/).includes(name) },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    replaceChildren() { node.children = []; },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute: (name) => (name in node.attributes ? node.attributes[name] : null),
    addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
    removeEventListener(name, fn) { node.listeners[name] = (node.listeners[name] || []).filter((f) => f !== fn); },
    dispatch(name, event = {}) { for (const fn of [...(node.listeners[name] || [])]) fn({ stopPropagation() {}, ...event }); },
    click() { node.dispatch('click'); },
    focus() { node.focused = true; },
    querySelector: () => null,
  };
  return node;
}
const collect = (node, predicate, out = []) => { for (const c of node.children) { if (predicate(c)) out.push(c); collect(c, predicate, out); } return out; };
const textOf = (node) => [node.textContent, ...node.children.map(textOf)].join(' ').replace(/\s+/g, ' ').trim();

function harness({ initial = null, body: docBody = null } = {}) {
  let current = initial;
  const calls = { details: 0, drawerClose: 0 };
  const ids = {};
  const make = (id, tag) => { const n = makeNode(tag); n.id = id; ids[id] = n; return n; };
  const button = make('flight-details-btn', 'button');
  button.hidden = true;
  const panel = make('flight-details-panel', 'aside');
  panel.hidden = true;
  const closeBtn = makeNode('button');
  panel.querySelector = (selector) => (selector.includes('data-flight-details-close') ? closeBtn : null);
  make('flight-details-body', 'div');
  make('flight-details-title', 'strong');
  const drawer = make('layer-drawer', 'aside');
  const drawerClose = make('layer-drawer-close', 'button');
  drawerClose.addEventListener('click', () => { calls.drawerClose += 1; drawer.className = ''; });
  const doc = { getElementById: (id) => ids[id] || null, createElement: (tag) => makeNode(tag), body: docBody };
  const win = new EventTarget();
  const intervals = new Set();
  win.setInterval = (fn) => { const handle = { fn, unref() {} }; intervals.add(handle); return handle; };
  win.clearInterval = (handle) => intervals.delete(handle);
  win.setTimeout = (fn, ms) => setTimeout(fn, ms);
  win.clearTimeout = (h) => clearTimeout(h);
  const addListener = win.addEventListener.bind(win);
  win.addEventListener = (name, fn) => addListener(name, fn);
  const panelApi = initFlightPanel({
    getDetails: () => { calls.details += 1; return current; },
    doc, win, now: () => NOW,
  });
  const select = (id, layerId = 'flights') => win.dispatchEvent(new CustomEvent('gev:awareness-subject-selected', { detail: { layerId, id } }));
  const clear = (id, layerId = 'flights') => win.dispatchEvent(new CustomEvent('gev:awareness-subject-cleared', { detail: { layerId, id } }));
  return {
    api: panelApi, button, panel, closeBtn, ids, calls, drawer, intervals, select, clear,
    setDetails: (d) => { current = d; },
    tick: () => { for (const handle of [...intervals]) handle.fn(); },
    body: ids['flight-details-body'], title: ids['flight-details-title'],
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test('nothing to wire without the markup', () => {
  assert.equal(initFlightPanel({ getDetails: () => null, doc: { getElementById: () => null }, win: new EventTarget() }), null);
});

test('the button exists only while a civil aircraft is selected; opening shows the panel and paints it', () => {
  const h = harness({ initial: details() });
  assert.equal(h.button.hidden, true);
  assert.equal(h.panel.hidden, true);
  h.select('a40ca4');
  assert.equal(h.button.hidden, false, 'Details is offered');
  assert.equal(h.panel.hidden, true, 'but nothing opens by itself');
  h.button.click();
  assert.equal(h.panel.hidden, false);
  assert.equal(h.button.hidden, true, 'the button steps aside while the panel is open');
  assert.equal(h.title.textContent, 'DAL1491');
  const body = textOf(h.body);
  for (const expected of ['Flight', 'Aircraft', 'Live', 'Route', 'Source', 'N360DN', 'FL350', '2023', 'CHS · Charleston', 'adsb.lol']) {
    assert.ok(body.includes(expected), `body shows ${expected}`);
  }
  assert.equal(h.intervals.size, 1, 'a single low-frequency refresh timer while open');
});

test('opening and closing never touch tracking: the panel only reads', () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  const reads = h.calls.details;
  h.button.click();
  h.closeBtn.click();
  h.button.click();
  h.closeBtn.click();
  assert.equal(h.api.selectedId(), 'a40ca4', 'still selected after close/reopen');
  assert.equal(h.button.hidden, false, 'Details can be reopened');
  assert.ok(h.calls.details > reads);
  const src = code('./flightPanel.js');
  assert.equal(/_trackFlight|_clearTracking|trackedEntity|untrack|refocusTrackedById|selectById|clearSelection|dispatchEvent/.test(src), false, 'no selection/tracking calls exist in the panel');
  assert.equal(h.intervals.size, 0, 'the refresh timer stops on close');
});

test('a live value refresh patches rows in place without rebuilding or resetting scroll', () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  const first = collect(h.body, (n) => n.className === 'flight-details-value');
  h.body.scrollTop = 120;
  h.setDetails(details({ altitudeM: 9_144, velocityMps: 200 }));
  h.tick();
  const second = collect(h.body, (n) => n.className === 'flight-details-value');
  assert.equal(second.length, first.length);
  assert.ok(second.every((node, i) => node === first[i]), 'same DOM nodes: no rebuild');
  assert.ok(textOf(h.body).includes('FL300'), 'value updated');
  assert.ok(textOf(h.body).includes('389 kt'));
  assert.equal(h.body.scrollTop, 120);
});

test('changing the selected aircraft updates an open panel to the new aircraft', async () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  // the layer emits "cleared" for the old plane and "selected" for the new one in the same call
  h.clear('a40ca4');
  h.setDetails(details({ icao24: 'ae1fa4', callsign: 'SWA696', registration: 'N123AB', squawk: '1200', route: null, airline: null, typeName: 'Boeing 737-700', typeCode: 'B737' }));
  h.select('ae1fa4');
  await flush();
  assert.equal(h.panel.hidden, false, 'the panel stayed open through the switch');
  assert.equal(h.title.textContent, 'SWA696');
  const body = textOf(h.body);
  assert.ok(body.includes('N123AB') && body.includes('1200') && body.includes('Boeing 737-700'));
  assert.equal(body.includes('N360DN'), false, 'nothing from the previous aircraft remains');
  assert.equal(body.includes('Delta'), false);
  assert.equal(body.includes('BOS'), false, 'the old route is gone');
});

test('a description for a different aircraft than the selected one is never shown', () => {
  const h = harness({ initial: details({ icao24: 'ffffff', callsign: 'OTHER1' }) });
  h.select('a40ca4');
  h.button.click();
  assert.equal(h.body.children.length, 0, 'mismatch → empty, not the wrong aircraft');
  assert.equal(h.title.textContent, '');
  h.setDetails(details());
  h.tick();
  assert.equal(h.title.textContent, 'DAL1491', 'shows as soon as the descriptions agree');
});

test('deselecting closes and clears the panel and hides the button', async () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  h.clear('a40ca4');
  await flush();
  assert.equal(h.panel.hidden, true);
  assert.equal(h.button.hidden, true);
  assert.equal(h.body.children.length, 0, 'no stale rows left behind');
  assert.equal(h.title.textContent, '');
  assert.equal(h.api.selectedId(), null);
  assert.equal(h.intervals.size, 0);
  // a later selection starts clean
  h.select('a40ca4');
  assert.equal(h.panel.hidden, true);
  assert.equal(h.button.hidden, false);
});

test('another layer taking the selection (military, vessel) removes the civil panel', async () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  h.select('ae0123', 'military');
  await flush();
  assert.equal(h.panel.hidden, true);
  assert.equal(h.button.hidden, true);
  h.clear('999', 'ais-live-vessels'); // an unrelated layer clearing must not disturb anything
  assert.equal(h.api.selectedId(), null);
});

test('an unrelated layer clearing does not close a civil panel', async () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  h.clear('sat-1', 'satellites');
  await flush();
  assert.equal(h.panel.hidden, false);
});

test('Escape inside the panel closes only the panel (the aircraft stays selected)', () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  let stopped = false;
  h.panel.dispatch('keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'the document-level deselect handler never sees it');
  assert.equal(h.panel.hidden, true);
  assert.equal(h.api.selectedId(), 'a40ca4');
  assert.equal(h.button.focused, true, 'focus returns to the button');
});

test('opening the panel closes the Layers drawer that shares the right edge', () => {
  const h = harness({ initial: details() });
  h.drawer.className = 'open';
  h.select('a40ca4');
  h.button.click();
  assert.equal(h.calls.drawerClose, 1);
  assert.equal(h.panel.hidden, false);
});

test('destroy releases every listener and timer', () => {
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  h.api.destroy();
  assert.equal(h.intervals.size, 0);
  h.select('ae1fa4');
  assert.equal(h.api.selectedId(), 'a40ca4', 'no longer listening');
});

// -- markup, CSS, wiring, isolation ------------------------------------------------------------------------

test('markup: a hidden button and a hidden labelled panel exist; the compact readout markup is untouched', () => {
  assert.match(html, /<button id="flight-details-btn"[^>]*aria-controls="flight-details-panel"[^>]*hidden>/);
  assert.match(html, /<aside id="flight-details-panel"[^>]*aria-label="Flight details" hidden>/);
  assert.match(html, /data-flight-details-close[^>]*aria-label="Close flight details"/);
  assert.match(html, /id="flight-details-body"[^>]*tabindex="0"/);
  assert.equal((html.match(/id="flight-details-panel"/g) || []).length, 1);
  assert.match(html, /id="cockpit-entry"/, 'cockpit entry still present');
  const trackedReadout = code('./data/trackedReadout.js');
  assert.equal(/flight-details|flightPanel/.test(trackedReadout), false, 'the quick-view card is not modified or coupled');
});

test('wiring: initialised once from main.js against the layer accessor; joins the phone single-panel rule', () => {
  const main = read('./main.js');
  assert.match(main, /import \{ initFlightPanel \} from '\.\/flightPanel\.js';/);
  assert.match(main, /initFlightPanel\(\{ getDetails: \(\) => flightsLayer\.getTrackedDetails\?\.\(\) \|\| null \}\);/);
  assert.match(read('./layerDrawer.js'), /id: 'flight-details-panel', open: \(el\) => !el\.hidden/);
  assert.match(css, /body\.mobile-sheet-open :is\([^)]*#flight-details-panel, #flight-details-btn\)/, 'steps aside while the Layers sheet is open');
});

const block = css.slice(css.indexOf('/* ══ Flight details'), css.indexOf('/* ══ AIS viewer filter'));
const phone = block.slice(block.indexOf('@media (max-width: 767px)'), block.indexOf('/* The cockpit and the clean'));

test('mobile: a bottom sheet above the credit line, touch targets >= 44px, no horizontal overflow', () => {
  assert.ok(block.length > 500, 'css block found');
  assert.match(phone, /\.flight-details-panel \{\s*top: auto; left: 0; right: 0; bottom: 72px; width: 100%; max-height: min\(50vh, calc\(100dvh - 48px - 72px - 16px\)\);/);
  assert.match(phone, /\.flight-details-btn \{[^}]*min-height: 44px;/);
  assert.match(phone, /\.flight-details-row \{[^}]*min-height: 44px;/);
  assert.match(block, /\.flight-details-close \{[^}]*width: 44px; height: 44px;/);
  assert.match(block, /\.flight-details-body \{ overflow-y: auto; overflow-x: hidden;/, 'scrolls vertically, never sideways');
  assert.match(block, /\.flight-details-value \{[^}]*overflow-wrap: anywhere;/);
  assert.match(block, /\.flight-details-row \{[^}]*min-width: 0;/);
  assert.equal(/!important/.test(block), false, 'no !important that could fight the credit keep-out model');
  assert.equal(/#cesium-credits|#right-context-rail/.test(block), false, 'does not restyle the pinned credit/rail elements');
  const dockRules = block.match(/[^{}]*#command-dock[^{}]*\{[^}]*\}/g) || [];
  assert.equal(dockRules.length, 1, 'the dock is mentioned once');
  assert.match(dockRules[0], /visibility: hidden; pointer-events: none;/, 'and only to step it aside - never to move it');
  const bottoms = [...phone.matchAll(/bottom:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(bottoms, ['72px'], 'the only phone anchor is the literal 72px credit inset');
});

test('the calculated-values note is laid out as a paragraph row', () => {
  assert.match(block, /\.flight-details-row\.is-note \{ display: block; \}/);
  const h = harness({ initial: details() });
  h.select('a40ca4');
  h.button.click();
  const note = collect(h.body, (n) => String(n.className).includes('is-note'));
  assert.equal(note.length, 1);
});

test('phones: the voice dock steps aside while the sheet is open (class toggled by the panel, no bottom anchor added)', () => {
  assert.match(phone, /body\.flight-details-open #command-dock \{ visibility: hidden; pointer-events: none; \}/);
  const classes = [];
  const body = { classList: { add: (c) => classes.push(`+${c}`), remove: (c) => classes.push(`-${c}`) } };
  const h = harness({ initial: details(), body });
  h.select('a40ca4');
  h.button.click();
  h.closeBtn.click();
  assert.deepEqual(classes, ['+flight-details-open', '-flight-details-open']);
});

test('desktop: right edge under the header; hidden in cockpit and clean views', () => {
  assert.match(block, /\.flight-details-panel \{\s*position: fixed; top: 64px; right: 12px; z-index: 126;/);
  assert.match(block, /width: min\(340px, calc\(100vw - 24px\)\)/);
  assert.match(block, /body\.cockpit-mode :is\(#flight-details-btn, #flight-details-panel\)/);
  assert.match(block, /body\.ui-clean-view :is\(#flight-details-btn, #flight-details-panel\)/);
  assert.match(block, /forced-colors: active/);
});

test('isolation: Phase A touches no AIS code, no server code, no row contract, no new provider or fetch', () => {
  const panelSource = code('./flightPanel.js');
  const imports = [...panelSource.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./data/routePlausible.js']);
  assert.equal(/ais|vessel|AISStream/i.test(imports.join(' ')), false);
  assert.equal(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage/.test(panelSource), false, 'the panel fetches and stores nothing');
  for (const file of ['./data/aisLiveVessels.js', './data/aisViewFilter.js', './data/aisRegions.js']) {
    assert.equal(/flightPanel|getTrackedDetails/.test(read(file)), false, `${file} is untouched by flights`);
  }
  assert.equal(/photo|owner|manufactur|adsblol\/trace|schedule/i.test(panelSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, '')), false, 'no later-phase features');
});
