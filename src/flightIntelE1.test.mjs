// Flight Intelligence E.1 cleanup, from real Cloud Run validation of the Phase E candidate:
//  1. a multi-hour silence with no ground point must not join two segments (19 h / 21.8 h "tracked duration"),
//  2. the violet path's terrain-floor lookup is a small bounded sample, never ~300 points,
//  3. no doomed /api/opensky-track request while OpenSky is disabled (cyan session trail and violet history untouched),
//  4. an aircraft-type-looking "operator code" (C680) is not labelled as an operator.
// Fixture data only; nothing touches a network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  LONG_GAP_SEC,
  MIN_TRANSIT_KMH,
  extractCurrentLeg,
  slimAdsbLolTrace,
  traceDistanceKm,
} from './data/adsbLolTrace.js';
import { HISTORY_TERRAIN_MAX, sampleHistoryForTerrain } from './data/flightHistory.js';
import { isOpenSkyDisabledReason, shouldBackfillFromOpenSky } from './data/openSkyBackfill.js';
import { buildFlightDetailsModel, operatorCodeForDisplay } from './flightPanel.js';
import { _backfillTrailForTest, _setOpenSkyAuthReasonForTest } from './data/flights.js';
import { greatCircleKm } from './data/routePlausible.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const g = (t, lat = 48.7, lon = 2.4) => [t, lat, lon, 'ground', 0, 0, 0];
const a = (t, lat, lon = 2.4, alt = 5000) => [t, lat, lon, alt, 300, 0, 0];
const HOUR = 3600;

// -- 1. gap handling ------------------------------------------------------------------------------------------------

test('the chosen thresholds are the documented ones', () => {
  assert.equal(LONG_GAP_SEC, 2 * HOUR);
  assert.equal(MIN_TRANSIT_KMH, 150);
});

test('a normal short airborne coverage gap stays one leg (real in-flight gaps were 73-85 min)', () => {
  const pts = [g(0), a(60, 48.8), a(120, 48.9), a(120 + 85 * 60, 49.4), a(120 + 85 * 60 + 60, 49.5)];
  const leg = extractCurrentLeg(pts);
  assert.equal(leg.start, 0, 'still starts at the departure ground point');
  assert.equal(leg.end, pts.length - 1);
  assert.equal(leg.atTraceStart, false);
});

test('a long airborne gap that the aircraft flew ACROSS (ocean-style) is not fragmented', () => {
  // 5 h hole, but the aircraft reappears ~3,500 km away: ~700 km/h implied, i.e. it was flying.
  const pts = [g(0, 40.6, -73.8), a(600, 41, -70, 35000), a(1200, 42, -65, 35000), a(1200 + 5 * HOUR, 51.0, -5.0, 35000), a(1200 + 5 * HOUR + 60, 51.1, -4.5, 35000)];
  assert.ok(greatCircleKm(42, -65, 51, -5) / 5 > MIN_TRANSIT_KMH * 3, 'fixture really is a fast crossing');
  const leg = extractCurrentLeg(pts);
  assert.equal(leg.start, 0);
  assert.equal(leg.end, pts.length - 1);
});

test('a >10 min gap after a KNOWN ground point still starts the leg at the first airborne point', () => {
  const pts = [g(0), g(60), a(30_000, 48.7), a(30_060, 48.8), a(30_120, 48.9)];
  const leg = extractCurrentLeg(pts);
  assert.equal(leg.start, 2);
  assert.equal(leg.onGroundNow, false);
  assert.equal(extractCurrentLeg([g(0), g(60), a(120, 48.7), a(180, 48.8)]).start, 1, 'a normal takeoff is unchanged');
});

test('a very large gap with NO ground point starts a new current leg', () => {
  // Yesterday's flying, then 14 h of silence with the aircraft in (almost) the same place, then today's flying.
  const pts = [
    a(0, 37.40), a(60, 37.41), a(120, 37.42), // last heard low, near where it later reappears
    a(120 + 14 * HOUR, 37.421, 2.4, 700), a(120 + 14 * HOUR + 60, 37.5), a(120 + 14 * HOUR + 120, 37.6),
  ];
  const leg = extractCurrentLeg(pts);
  assert.equal(leg.start, 3, 'the segment starts after the silence');
  assert.equal(leg.end, 5);
  assert.equal(leg.atTraceStart, false, 'it is not the beginning of the trace');
});

test('the same holds when the aircraft reappears elsewhere after hours (a hop with no ground state)', () => {
  // 3 h gap, ~300 km apart: 100 km/h implied - slower than anything flying, so it was parked and moved on.
  const pts = [a(0, 40.0), a(60, 40.1), a(60 + 3 * HOUR, 42.8), a(60 + 3 * HOUR + 60, 42.9)];
  assert.ok(greatCircleKm(40.1, 2.4, 42.8, 2.4) / 3 < MIN_TRANSIT_KMH);
  assert.equal(extractCurrentLeg(pts).start, 2);
});

test('the most recent silent gap wins when there are several', () => {
  const pts = [a(0, 30), a(60, 30.01), a(60 + 10 * HOUR, 30.02), a(120 + 10 * HOUR, 30.5), a(180 + 10 * HOUR, 30.6), a(180 + 20 * HOUR, 30.61), a(240 + 20 * HOUR, 31), a(300 + 20 * HOUR, 31.1)];
  assert.equal(extractCurrentLeg(pts).start, 5);
});

test('distance and duration describe the current segment only and never bridge the discarded gap', () => {
  const raw = {
    timestamp: 1_789_000_000,
    trace: [
      // yesterday: a long run north, 14 h of silence, then a short hop today near where it went quiet.
      [0, 30, 2.4, 20000, 400, 0, 0], [600, 32, 2.4, 20000, 400, 0, 0], [1200, 34, 2.4, 20000, 400, 0, 0], [1800, 34.5, 2.4, 3000, 200, 0, 0],
      [1800 + 14 * HOUR, 34.5, 2.41, 800, 200, 0, 0], [1800 + 14 * HOUR + 300, 34.55, 2.41, 2000, 220, 0, 0], [1800 + 14 * HOUR + 600, 34.6, 2.41, 5000, 250, 0, 0],
    ],
  };
  const slim = slimAdsbLolTrace(raw);
  assert.equal(slim.stats.legPoints, 3);
  assert.equal(slim.stats.startEpoch, 1_789_000_000 + 1800 + 14 * HOUR);
  assert.equal(slim.stats.durationSec, 600, 'ten minutes, not ~14 h');
  assert.ok(slim.stats.distanceKm < 20, `distance ${slim.stats.distanceKm} km covers only the hop, not yesterday's ~500 km run`);
  assert.equal(slim.stats.startsAtTraceBeginning, false);
  // The full trace WOULD have been absurd: prove the fix is what changed it.
  const whole = raw.trace.map((p) => [1_789_000_000 + p[0], p[1], p[2]]);
  assert.ok(traceDistanceKm(whole) > 500);
});

test('first and last point behaviour is unchanged: the leg ends at the last point, starts where it should, and stays in order', () => {
  const pts = [g(0), a(60, 48.8), a(120, 48.9), a(180, 49.0)];
  const leg = extractCurrentLeg(pts);
  assert.deepEqual([leg.start, leg.end, leg.atTraceStart, leg.onGroundNow], [0, 3, false, false]);
  const parked = [a(0, 10), a(60, 10.1), g(120, 10.2), g(180, 10.2)];
  const landed = extractCurrentLeg(parked);
  assert.equal(landed.onGroundNow, true);
  assert.equal(landed.end, 2, 'still ends at touchdown');
  assert.deepEqual(extractCurrentLeg([]), { start: 0, end: -1, atTraceStart: true, onGroundNow: false });
  const slim = slimAdsbLolTrace({ timestamp: 1_000_000, trace: [[0, 48.7, 2.4, 'ground', 0, 0, 0], [60, 48.8, 2.4, 5000, 300, 0, 0], [120, 48.9, 2.4, 5000, 300, 0, 0]] });
  assert.equal(slim.points[0][0], 1_000_000);
  assert.equal(slim.points.at(-1)[0], 1_000_120);
});

test('a lone point after the silence yields no history rather than a fabricated leg', () => {
  const raw = { timestamp: 1_000_000, trace: [[0, 30, 2.4, 5000, 300, 0, 0], [60, 30.01, 2.4, 5000, 300, 0, 0], [60 + 12 * HOUR, 30.02, 2.4, 700, 100, 0, 0]] };
  assert.equal(slimAdsbLolTrace(raw), null);
});

// -- 2. terrain sample size -----------------------------------------------------------------------------------------

function path(n, { lowEvery = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const f = i / (n - 1);
    const low = lowEvery && (i < 30 || i > n - 30) && i % lowEvery === 0;
    rows.push([1_000 + i * 20, 33 + f * 8, -84 + f * 10 + Math.sin(f * 9) * 0.5, i === 0 || i === n - 1 ? 'ground' : (low ? 900 : 34000), 400, 40, 0]);
  }
  return rows;
}

test('a 300-point history can never produce a 300-point terrain lookup', () => {
  const sample = sampleHistoryForTerrain(path(300, { lowEvery: 1 }));
  assert.ok(HISTORY_TERRAIN_MAX >= 40 && HISTORY_TERRAIN_MAX <= 75, 'within the agreed 40-75 band');
  assert.ok(sample.length <= HISTORY_TERRAIN_MAX, `${sample.length} <= ${HISTORY_TERRAIN_MAX}`);
  assert.ok(sample.length >= 40, 'still a representative sample');
});

test('the sample keeps the first and last points and covers the route end to end, in order', () => {
  const rows = path(300);
  const sample = sampleHistoryForTerrain(rows);
  assert.deepEqual(sample[0], { lat: rows[0][1], lon: rows[0][2] });
  assert.deepEqual(sample.at(-1), { lat: rows[299][1], lon: rows[299][2] });
  const lats = sample.map((p) => p.lat);
  assert.deepEqual([...lats].sort((x, y) => x - y), lats, 'monotone along a monotone route');
  const gaps = lats.slice(1).map((v, i) => v - lats[i]);
  assert.ok(Math.max(...gaps) < 8 / 25, 'no big unsampled stretch (no more than ~1/25 of the route)');
});

test('low and ground points, where a floor matters, are prioritised without exceeding the cap', () => {
  const rows = path(300, { lowEvery: 1 });
  const sample = sampleHistoryForTerrain(rows);
  const lowPositions = new Set(rows.filter((r) => r[3] === 'ground' || r[3] < 3000).map((r) => `${r[1]},${r[2]}`));
  const lowKept = sample.filter((p) => lowPositions.has(`${p.lat},${p.lon}`)).length;
  assert.ok(lowKept >= 15, `kept ${lowKept} low points`);
  assert.ok(sample.length <= HISTORY_TERRAIN_MAX);
});

test('short paths pass through whole, and empty or invalid input is safe', () => {
  assert.equal(sampleHistoryForTerrain(path(12)).length, 12);
  assert.deepEqual(sampleHistoryForTerrain([]), []);
  assert.deepEqual(sampleHistoryForTerrain(null), []);
  assert.equal(sampleHistoryForTerrain(path(300), 10).length <= 10, true, 'an explicit smaller cap is honoured');
});

test('the violet paint asks terrain about the SAMPLE only, draws every point, and does not depend on the lookup succeeding', () => {
  const flights = code('./data/flights.js');
  const paint = flights.slice(flights.indexOf('async function _paintHistoryPath'), flights.indexOf('function _clearHistoryPath'));
  assert.match(paint, /resolveGroundFloorCellsBounded\(sampleHistoryForTerrain\(points, HISTORY_TERRAIN_MAX\)\)/);
  assert.equal(/resolveGroundFloorCellsBounded\(parsed\)/.test(paint), false, 'the full path is no longer sent for terrain');
  assert.match(paint, /for \(const \{ lat, lon, altFt \} of parsed\)[\s\S]*positions\.push\(/, 'every point still becomes a vertex');
  assert.match(paint, /cachedGroundFloor\(lat, lon\)/, 'unsampled cells simply read the (possibly cold) cache');
  assert.match(paint, /_historyTrail\.setPositions\(positions\)/);
});

// -- 3. OpenSky backfill gate ---------------------------------------------------------------------------------------

test('the gate: disabled reasons suppress the backfill, everything else keeps it', () => {
  for (const reason of ['opensky_disabled_regional_fallback', 'opensky_disabled_no_fallback', 'OPENSKY_DISABLED_REGIONAL_FALLBACK']) {
    assert.equal(isOpenSkyDisabledReason(reason), true, reason);
    assert.equal(shouldBackfillFromOpenSky(reason), false, reason);
  }
  for (const reason of ['', null, undefined, 'oauth_invalid_or_missing', 'forced_anonymous', 'opensky_rate_limited_regional_fallback']) {
    assert.equal(shouldBackfillFromOpenSky(reason), true, String(reason));
  }
});

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = (url, init) => { urls.push(String(url)); return impl(url, init); };
  return Promise.resolve(fn(urls)).finally(() => { globalThis.fetch = real; });
}

test('OpenSky disabled: selecting a civil aircraft makes NO /api/opensky-track request', async () => {
  _setOpenSkyAuthReasonForTest('opensky_disabled_regional_fallback');
  try {
    await withFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }), async (urls) => {
      await _backfillTrailForTest('a40ca4');
      assert.deepEqual(urls, []);
    });
  } finally {
    _setOpenSkyAuthReasonForTest('');
  }
});

test('OpenSky genuinely enabled: the existing backfill request is still made', async () => {
  for (const reason of ['', 'oauth_ok']) {
    _setOpenSkyAuthReasonForTest(reason);
    await withFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }), async (urls) => {
      await _backfillTrailForTest('a40ca4');
      assert.deepEqual(urls, ['/api/opensky-track?icao24=a40ca4']);
    });
  }
  _setOpenSkyAuthReasonForTest('');
});

test('the gate is recorded from the live poll, reset with the layer, and guards ONLY the backfill', () => {
  const flights = code('./data/flights.js');
  assert.match(flights, /_lastSource = responseSource \|\| 'OpenSky Network';[\s\S]{0,140}_openSkyAuthReason = authReason;/);
  assert.match(flights, /_openSkyAuthReason = '';/);
  const backfill = flights.slice(flights.indexOf('async function _backfillTrail'), flights.indexOf('function _paintHistory') > 0 ? flights.indexOf('async function _paintHistoryPath') : undefined);
  assert.match(backfill, /if \(!shouldBackfillFromOpenSky\(_openSkyAuthReason\)\) return;\s*let path = null;/);
  assert.equal((flights.match(/shouldBackfillFromOpenSky\(/g) || []).length, 1, 'one call site');
  assert.match(flights, /fetch\('\/api\/opensky-track\?icao24=' \+ encodeURIComponent\(icao24\)/, 'OpenSky support is kept, not removed');
});

test('the cyan session trail still accumulates and the violet history stays a separate path', () => {
  const flights = code('./data/flights.js');
  const start = flights.slice(flights.indexOf('function _startTrail'), flights.indexOf('async function _backfillTrail'));
  assert.match(start, /_trail = createTrail\(_viewer, \{ color: TRAIL_COLOR, width: 2\.5 \}\)/, 'the session trail is still created at selection');
  assert.match(start, /_trailPositions\.push\(Cesium\.Cartesian3\.clone\(fix\.position\)\)/, 'seeded from live fixes');
  assert.match(start, /_backfillTrail\(icao24, _trailBackfillToken, oldestFixEpochSec\)/, 'the backfill is still attempted (and gated inside)');
  assert.match(flights, /_trailPositions\.push\(/);
  assert.match(flights, /function _appendTrailFix/);
  assert.match(flights, /const TRAIL_COLOR = '#00d4ff';/);
  assert.match(flights, /const HISTORY_TRAIL_COLOR = '#c39bff';/);
  assert.equal((flights.match(/createTrail\(/g) || []).length, 2, 'session trail and history trail remain two separate entities');
  const gate = flights.slice(flights.indexOf('async function _backfillTrail'), flights.indexOf('let path = null;'));
  assert.equal(/_trailPositions|_historyTrail|_history\./.test(gate), false, 'the gate touches neither trail nor history');
});

// -- 4. operator code display ---------------------------------------------------------------------------------------

test('an airline operator code such as AAL is displayed', () => {
  assert.equal(operatorCodeForDisplay('AAL'), 'AAL');
  assert.equal(operatorCodeForDisplay(' dal '), 'dal');
  assert.equal(operatorCodeForDisplay('EDV', 'CRJ9'), 'EDV');
  assert.equal(operatorCodeForDisplay('B6'), 'B6', 'a two-character IATA-style designator is not mistaken for a type');
});

test('an aircraft-type-looking value such as C680 is omitted', () => {
  for (const [value, type] of [['C680', 'C680'], ['C680', null], ['EC45', 'C06T'], ['CL35', 'CL35'], ['B738', null], ['A320', null], ['PA28', null]]) {
    assert.equal(operatorCodeForDisplay(value, type), null, `${value}`);
  }
  assert.equal(operatorCodeForDisplay('GLF', 'GLF'), null, 'a value that just repeats the aircraft\'s own type is not an operator');
});

test('a missing or blank value is omitted', () => {
  for (const value of [null, undefined, '', '   ']) assert.equal(operatorCodeForDisplay(value), null);
});

const rowsOf = (model) => Object.fromEntries(model.sections.flatMap((s) => s.rows.map((r) => [r.key, r])));
const base = { icao24: 'a5b680', callsign: 'N4674', registration: 'N4674', typeCode: 'C680', latitude: 36, longitude: -78, altitudeM: 5000, onGround: false, velocityMps: 150, track: 20, stale: false, feed: { source: 'adsb.lol', coverage: 'x' } };

test('the panel shows a real operator code, omits a type-looking one with no blank row, and keeps the raw field', () => {
  const airline = rowsOf(buildFlightDetailsModel({ ...base, typeCode: 'B738', operatorFlagCode: 'AAL' }, { nowMs: 0 }));
  assert.equal(airline.operatorCode.value, 'AAL');
  assert.equal(airline.operatorCode.label, 'Operator code');
  const details = { ...base, operatorFlagCode: 'C680', registeredOwner: 'Sanibel Aviation LLC' };
  const ga = rowsOf(buildFlightDetailsModel(details, { nowMs: 0 }));
  assert.equal('operatorCode' in ga, false);
  assert.equal(ga.registeredOwner.value, 'Sanibel Aviation LLC', 'other Phase B rows are unaffected');
  assert.equal(details.operatorFlagCode, 'C680', 'the raw normalised field is kept, only the presentation changed');
  const none = rowsOf(buildFlightDetailsModel({ ...base, operatorFlagCode: null }, { nowMs: 0 }));
  assert.equal('operatorCode' in none, false);
});

// -- 5. things that must not change ---------------------------------------------------------------------------------

test('AIS, the live poll, the 18-element row and providers are untouched by E.1', () => {
  for (const file of ['./data/openSkyBackfill.js', './data/flightHistory.js', './data/adsbLolTrace.js', './flightPanel.js']) {
    const imports = [...code(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.equal(imports.some((i) => /ais|vessel/i.test(i)), false, `${file} imports no AIS module`);
  }
  assert.equal(/process\.env|fetch\(|Authorization/.test(code('./data/openSkyBackfill.js')), false, 'the gate is pure');
  assert.equal(/opensky/i.test(code('./data/flightHistory.js')), false, 'the history path still never mentions OpenSky');
  assert.equal(/opensky/i.test(code('./data/adsbLolTrace.js')), false);
});
