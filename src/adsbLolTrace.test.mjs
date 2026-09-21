// Flight Intelligence Phase E, server side: the slim history built from the adsb.lol trace
// (ICAO24 validation, parsing, current-leg extraction, downsampling, calculated distance and
// duration, no fabricated flight times) and the history service (fixed URL, timeout, size cap,
// bounded cache, coalescing, graceful failure). Synthetic traces only; nothing hits the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  TRACE_CACHE_MAX,
  TRACE_FAILURE_CACHE_MS,
  TRACE_HISTORY_CACHE_MS,
  TRACE_MAX_POINTS,
  TRACE_NEGATIVE_CACHE_MS,
  TRACE_RESPONSE_CAP_BYTES,
  createAdsbLolHistoryService,
  downsampleTrace,
  extractCurrentLeg,
  isValidTraceHex,
  parseTrace,
  slimAdsbLolTrace,
  traceDistanceKm,
  traceUpstreamUrl,
} from './data/adsbLolTrace.js';
import { greatCircleKm } from './data/routePlausible.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const T0 = 1_789_870_521;

/** One readsb point: [dt, lat, lon, alt, gs, track, flags, baro_rate, extra, type, geomAlt, geomRate, ias, roll]. */
const pt = (dt, lat, lon, alt, gs = 200, track = 90, vr = 0) => [dt, lat, lon, alt, gs, track, 0, vr, null, 'adsb_icao', null, null, null, null];

/** A straight path of `n` points from A to B, `step` seconds apart, airborne unless told otherwise. */
function leg({ from, to, n, startDt, step = 10, ground = false }) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const f = n === 1 ? 0 : i / (n - 1);
    const onGround = ground || i === 0 || i === n - 1;
    rows.push(pt(startDt + i * step, from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, onGround ? 'ground' : 30000, 450, 40, 0));
  }
  return rows;
}

/** A full-day style trace: yesterday's completed leg, a long parked gap, then the current airborne leg. */
function dayTrace({ currentAirborne = true } = {}) {
  const yesterday = leg({ from: [33.64, -84.43], to: [25.79, -80.29], n: 800, startDt: 0, step: 20 });
  const parkedUntil = 50_000;
  const cur = leg({ from: [25.79, -80.29], to: [40.64, -73.78], n: 3000, startDt: parkedUntil, step: 10 });
  if (currentAirborne) cur[cur.length - 1] = pt(cur.at(-1)[0], 40.0, -74.0, 12000, 300, 30);
  return {
    icao: 'a40ca4', r: 'N360DN', t: 'A321', desc: 'AIRBUS A-321', ownOp: 'DELTA AIR LINES INC', year: '2018',
    timestamp: T0, trace: [...yesterday, ...cur],
  };
}

// -- ICAO24 validation ---------------------------------------------------------------------------------

test('only a 6-character lower-case ICAO24 is accepted, and only it reaches the upstream URL', () => {
  assert.equal(isValidTraceHex('a40ca4'), true);
  for (const bad of ['A40CA4', 'a40ca', 'a40ca44', '~a40ca4', 'a40ca4/../x', 'a40ca4?x=1', '', null, undefined, 42, 'zzzzzz', ' a40ca4']) assert.equal(isValidTraceHex(bad), false, String(bad));
  assert.equal(traceUpstreamUrl('a40ca4'), 'https://adsb.lol/data/traces/a4/trace_full_a40ca4.json');
});

// -- parsing -------------------------------------------------------------------------------------------

test('parse: readsb points become chronological [t, lat, lon, alt, gs, track, vertical-rate] tuples', () => {
  const parsed = parseTrace({ timestamp: T0, trace: [pt(0, 33.643093, -84.440403, 'ground', 4.24, 14.1, 0), pt(30, 33.7, -84.5, 3950, 228.94, 35.24, 640)] });
  assert.deepEqual(parsed.points[0], [T0, 33.64309, -84.4404, 'ground', 4.2, 14, 0]);
  assert.deepEqual(parsed.points[1], [T0 + 30, 33.7, -84.5, 3950, 228.9, 35, 640]);
});

test('parse: unusable points are dropped, a non-trace body is null, bad ordering is ignored', () => {
  assert.equal(parseTrace(null), null);
  assert.equal(parseTrace({ trace: [] }), null);
  assert.equal(parseTrace({ timestamp: T0 }), null);
  const parsed = parseTrace({ timestamp: T0, trace: [
    pt(0, 10, 10, 1000), 'junk', [5], pt(10, null, 10, 1000), pt(20, 91, 10, 1000), pt(30, 10, 181, 1000),
    pt(40, 10.1, 10.1, 'ground'), pt(35, 10.2, 10.2, 1000), pt(50, 10.3, 10.3, undefined),
  ] });
  assert.deepEqual(parsed.points.map((p) => p[0] - T0), [0, 40, 50], 'bad rows and the backwards step are gone');
  assert.equal(parsed.points[2][3], null, 'a missing altitude stays null, never invented');
});

test('static trace metadata is kept when present and left out when not, and is separate from the path', () => {
  const full = parseTrace(dayTrace());
  assert.deepEqual(full.meta, { registration: 'N360DN', description: 'AIRBUS A-321', owner: 'DELTA AIR LINES INC', year: '2018' });
  const bare = parseTrace({ timestamp: T0, trace: [pt(0, 1, 1, 100), pt(10, 1.1, 1.1, 100)] });
  assert.deepEqual(bare.meta, {});
  const slim = slimAdsbLolTrace(dayTrace());
  for (const p of slim.points) assert.equal(p.length, 7, 'points carry only position/time/telemetry');
});

// -- current leg ---------------------------------------------------------------------------------------

test('the current leg starts at the last time on the ground and includes that departure point', () => {
  const parsed = parseTrace(dayTrace());
  const legInfo = extractCurrentLeg(parsed.points);
  assert.equal(legInfo.atTraceStart, false);
  assert.equal(legInfo.onGroundNow, false);
  assert.equal(legInfo.end, parsed.points.length - 1);
  assert.equal(parsed.points[legInfo.start][3], 'ground');
  assert.equal(parsed.points[legInfo.start][0], T0 + 50_000, 'yesterday and the parked time are not part of it');
});

test('an aircraft already airborne at the start of the trace reports the trace beginning', () => {
  const airborne = [pt(0, 10, 10, 30000), pt(60, 10.5, 10.5, 30000), pt(120, 11, 11, 30000)].map((p) => [...p]);
  const parsed = parseTrace({ timestamp: T0, trace: airborne });
  assert.deepEqual(extractCurrentLeg(parsed.points), { start: 0, end: 2, atTraceStart: true, onGroundNow: false });
});

test('an aircraft on the ground now gets the leg it just finished, ending at touchdown (parked time excluded)', () => {
  const raw = dayTrace({ currentAirborne: false });
  raw.trace.push(pt(50_000 + 3000 * 10 + 600, 40.64, -73.78, 'ground', 0), pt(50_000 + 3000 * 10 + 7200, 40.64, -73.78, 'ground', 0));
  const parsed = parseTrace(raw);
  const legInfo = extractCurrentLeg(parsed.points);
  assert.equal(legInfo.onGroundNow, true);
  const slim = slimAdsbLolTrace(raw);
  assert.equal(slim.stats.onGroundNow, true);
  assert.ok(slim.stats.durationSec <= 3000 * 10 + 60, `parked hours are not counted (${slim.stats.durationSec}s)`);
});

test('degenerate traces', () => {
  assert.deepEqual(extractCurrentLeg([]), { start: 0, end: -1, atTraceStart: true, onGroundNow: false });
  assert.equal(slimAdsbLolTrace({ timestamp: T0, trace: [pt(0, 1, 1, 100)] }), null, 'one point is not a path');
  assert.equal(slimAdsbLolTrace({ timestamp: T0, trace: [] }), null);
  assert.equal(slimAdsbLolTrace('nonsense'), null);
  const taxi = parseTrace({ timestamp: T0, trace: [pt(0, 1, 1, 'ground'), pt(30, 1.001, 1.001, 'ground')] });
  assert.deepEqual(extractCurrentLeg(taxi.points), { start: 0, end: 1, atTraceStart: true, onGroundNow: true });
});

// -- downsampling --------------------------------------------------------------------------------------

test('downsampling is capped, keeps the first and last point, and stays chronological', () => {
  const raw = parseTrace(dayTrace()).points.slice(800); // 3000-point current leg
  const out = downsampleTrace(raw, 300);
  assert.equal(out.length, 300, 'exactly the cap');
  assert.equal(out[0], raw[0], 'first point preserved');
  assert.equal(out.at(-1), raw.at(-1), 'last point preserved');
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i][0] >= out[i - 1][0], 'time order kept');
  assert.equal(downsampleTrace(raw.slice(0, 50), 300).length, 50, 'short paths are untouched');
  assert.deepEqual(downsampleTrace(raw, 2), [raw[0], raw.at(-1)]);
  assert.equal(TRACE_MAX_POINTS, 300);
});

test('downsampling keeps the shape: a sharp turn survives even at a tiny budget', () => {
  // an L-shaped path: east 1000 points, then north 1000 points
  const rows = [];
  for (let i = 0; i < 1000; i += 1) rows.push([T0 + i, 10, 10 + i * 0.001, 30000, 400, 90, 0]);
  for (let i = 1; i <= 1000; i += 1) rows.push([T0 + 1000 + i, 10 + i * 0.001, 11, 30000, 400, 0, 0]);
  const out = downsampleTrace(rows, 5);
  assert.ok(out.length >= 3 && out.length <= 5, 'stops once the remaining points add no shape');
  assert.ok(out.some((p) => Math.abs(p[1] - 10) < 0.0015 && Math.abs(p[2] - 10.999) < 0.0015), 'the corner is one of the kept points');
  const uniform = rows.filter((_, i) => i % 500 === 0);
  const cornerKept = out.some((p) => p[2] > 10.99 && p[1] < 10.01);
  assert.equal(cornerKept, true);
  assert.ok(uniform.length >= 4);
});

test('a long parked cluster does not eat the budget', () => {
  const rows = [];
  for (let i = 0; i < 500; i += 1) rows.push([T0 + i, 10, 10, 'ground', 0, 0, 0]);
  for (let i = 0; i < 500; i += 1) rows.push([T0 + 500 + i, 10 + i * 0.01, 10 + i * 0.01, 30000, 400, 45, 0]);
  const out = downsampleTrace(rows, 40);
  assert.ok(out.filter((p) => p[3] === 'ground').length <= 3, 'a stationary cluster needs only its endpoints');
});

// -- calculated values ---------------------------------------------------------------------------------

test('distance is the sum of great-circle segments; duration is last minus first trace time', () => {
  const rows = [[T0, 0, 0, 1000, 0, 0, 0], [T0 + 600, 0, 1, 1000, 0, 0, 0], [T0 + 1800, 1, 1, 1000, 0, 0, 0]];
  const expected = greatCircleKm(0, 0, 0, 1) + greatCircleKm(0, 1, 1, 1);
  assert.ok(Math.abs(traceDistanceKm(rows) - expected) < 1e-9);
  assert.equal(traceDistanceKm([rows[0]]), 0);
  const slim = slimAdsbLolTrace({ timestamp: T0, trace: [pt(0, 0, 0, 'ground'), pt(600, 0, 1, 30000), pt(1800, 1, 1, 30000)] });
  assert.equal(slim.stats.durationSec, 1800);
  assert.equal(slim.stats.startEpoch, T0);
  assert.equal(slim.stats.endEpoch, T0 + 1800);
  assert.ok(Math.abs(slim.stats.distanceKm - Number(expected.toFixed(1))) < 0.11);
});

test('distance is measured on the full leg, not the downsampled path', () => {
  const slim = slimAdsbLolTrace(dayTrace());
  const full = parseTrace(dayTrace()).points.slice(800);
  assert.equal(slim.stats.legPoints, 3000);
  assert.equal(slim.stats.keptPoints, 300);
  assert.equal(slim.stats.rawPoints, 3800);
  assert.ok(Math.abs(slim.stats.distanceKm - traceDistanceKm(full)) < 0.06, 'stats come from every recorded point');
  assert.ok(slim.stats.distanceKm >= traceDistanceKm(slim.points) - 0.5, 'a simplified path can only be shorter');
});

test('no scheduled or actual flight time is ever fabricated', () => {
  const slim = slimAdsbLolTrace(dayTrace());
  assert.deepEqual(Object.keys(slim.stats).sort(), ['distanceKm', 'durationSec', 'endEpoch', 'keptPoints', 'legPoints', 'onGroundNow', 'rawPoints', 'startEpoch', 'startsAtTraceBeginning']);
  for (const key of Object.keys(slim.stats)) assert.equal(/depart|arriv|eta|schedul|delay|gate|status/i.test(key), false, key);
  assert.equal(slim.stats.startEpoch, slim.points[0][0], 'the "start" is the first trace point of the leg');
  assert.equal(slim.stats.endEpoch, slim.points.at(-1)[0]);
});

test('the slim payload is a small fraction of the raw trace', () => {
  const raw = JSON.stringify(dayTrace());
  const slim = JSON.stringify({ icao24: 'a40ca4', ...slimAdsbLolTrace(dayTrace()) });
  assert.ok(slim.length < raw.length / 20, `${slim.length} B vs ${raw.length} B`);
  assert.ok(slim.length < 25_000, 'well under 25 KB for the map path');
});

// -- service: validation, cache, coalescing, failures -----------------------------------------------------------

const readCapped = async (response, maxBytes) => {
  const bodyText = await response.text();
  return bodyText.length > maxBytes ? { tooLarge: true, text: '' } : { tooLarge: false, text: bodyText };
};
const okResponse = (body) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function harness(handler) {
  let clock = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, calls.length);
  };
  const service = createAdsbLolHistoryService({ fetchImpl, readCapped, now: () => clock });
  return { service, calls, advance: (ms) => { clock += ms; } };
}

test('the service refuses an invalid ICAO24 without any upstream call', async () => {
  const h = harness(() => okResponse(dayTrace()));
  for (const bad of ['', 'A40CA4', '../etc', 'a40ca4?x', undefined]) {
    const result = await h.service.load(bad);
    assert.equal(result.status, 400);
  }
  assert.equal(h.calls.length, 0);
});

test('a valid request fetches the ONE fixed upstream URL with a timeout and returns the slim result', async () => {
  const h = harness(() => okResponse(dayTrace()));
  const result = await h.service.load('a40ca4');
  assert.equal(result.status, 200);
  assert.equal(result.cache, 'MISS');
  assert.equal(result.body.icao24, 'a40ca4');
  assert.equal(result.body.points.length, 300);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://adsb.lol/data/traces/a4/trace_full_a40ca4.json');
  assert.ok(h.calls[0].init.signal, 'a timeout signal is attached');
});

test('repeat selection is served from the small cache; the raw upstream body is never stored', async () => {
  const h = harness(() => okResponse(dayTrace()));
  await h.service.load('a40ca4');
  const again = await h.service.load('a40ca4');
  assert.equal(again.cache, 'HIT');
  assert.equal(h.calls.length, 1, 'no second download');
  h.advance(TRACE_HISTORY_CACHE_MS - 1);
  assert.equal((await h.service.load('a40ca4')).cache, 'HIT');
  h.advance(2);
  assert.equal((await h.service.load('a40ca4')).cache, 'MISS', 'refreshed once it ages out');
  assert.equal(h.calls.length, 2);
  const stored = JSON.stringify(again.body);
  assert.ok(stored.length < 25_000, 'only the normalised result is held');
});

test('concurrent requests for one aircraft share a single upstream download', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness(async () => { await gate; return okResponse(dayTrace()); });
  const first = h.service.load('a40ca4');
  const second = h.service.load('a40ca4');
  const third = h.service.load('a40ca4');
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(results.map((r) => r.cache).sort(), ['INFLIGHT', 'INFLIGHT', 'MISS']);
  assert.ok(results.every((r) => r.status === 200));
});

test('the cache is bounded: the oldest entries are evicted', async () => {
  const h = harness(() => okResponse(dayTrace()));
  const hexes = Array.from({ length: TRACE_CACHE_MAX + 15 }, (_, i) => (0x100000 + i).toString(16));
  for (const hex of hexes) await h.service.load(hex);
  assert.equal(h.service.size(), TRACE_CACHE_MAX);
  assert.equal((await h.service.load(hexes.at(-1))).cache, 'HIT', 'newest kept');
  assert.equal((await h.service.load(hexes[0])).cache, 'MISS', 'oldest evicted');
});

test('no trace (404) and no usable trace are answered cleanly and remembered briefly', async () => {
  let mode = 404;
  const h = harness(() => (mode === 404 ? { ok: false, status: 404, text: async () => 'nope' } : okResponse({ timestamp: T0, trace: [] })));
  const missing = await h.service.load('aaaaaa');
  assert.equal(missing.status, 404);
  assert.equal((await h.service.load('aaaaaa')).cache, 'HIT');
  assert.equal(h.calls.length, 1);
  h.advance(TRACE_NEGATIVE_CACHE_MS + 1);
  mode = 200;
  assert.equal((await h.service.load('aaaaaa')).status, 404, 'an empty trace is also just "no usable trace"');
});

test('upstream errors, timeouts, oversize and malformed bodies degrade to a sanitised 502 and are not retried in a loop', async () => {
  const cases = [
    () => ({ ok: false, status: 500, text: async () => 'boom secret detail' }),
    () => { throw new Error('connect ETIMEDOUT 1.2.3.4'); },
    () => okResponse('x'.repeat(TRACE_RESPONSE_CAP_BYTES + 1)),
    () => okResponse('{not json'),
  ];
  for (const handler of cases) {
    const h = harness(handler);
    const result = await h.service.load('bbbbbb');
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: 'Flight history is temporarily unavailable.' });
    assert.equal(JSON.stringify(result.body).includes('secret'), false, 'no upstream detail leaks');
    assert.equal((await h.service.load('bbbbbb')).cache, 'HIT');
    assert.equal(h.calls.length, 1, 'a failing source is not hammered');
    h.advance(TRACE_FAILURE_CACHE_MS + 1);
    await h.service.load('bbbbbb');
    assert.equal(h.calls.length, 2, 'retried only after the short failure window');
  }
});

// -- route wiring and isolation ---------------------------------------------------------------------------------

test('the route is selection-only plumbing: GET only, rate limited, validated, no arbitrary upstream URL', () => {
  const vite = read('../vite.config.js');
  const start = vite.indexOf("middlewares.use('/api/adsblol/history'");
  const route = vite.slice(start, vite.indexOf("middlewares.use('/api/adsblol/trace'"));
  assert.ok(start > 0);
  assert.match(route, /req\.method !== 'GET'/);
  assert.match(route, /_historyRateLimiter\(clientKey\(req\)\)/);
  assert.match(route, /searchParams\.get\('hex'\)/);
  assert.match(route, /historyService\.load\(hex\)/);
  assert.equal(/fetch\(|https?:\/\/(?!localhost)/.test(route.replace(/\/\/.*$/gm, '')), false, 'the route builds no upstream URL of its own');
  assert.match(vite, /createAdsbLolHistoryService\(\{ readCapped: readCappedResponseText \}\)/);
  // The existing raw trace route the military layer uses is untouched.
  assert.match(vite, /middlewares\.use\('\/api\/adsblol\/trace'/);
  assert.match(vite, /`lol:\$\{hex\}`/);
});

test('no OpenSky, no AIS, no secrets anywhere in the history modules', () => {
  for (const file of ['./data/adsbLolTrace.js', './data/flightHistory.js']) {
    const source = code(file);
    assert.equal(/opensky/i.test(source), false, `${file} never touches OpenSky`);
    assert.equal(/\bais\b|vessel|AISStream/i.test(source), false, `${file} has no AIS code`);
    assert.equal(/process\.env|apiKey|token|secret|Authorization/i.test(source), false, `${file} uses no credential`);
  }
  const imports = [...code('./data/adsbLolTrace.js').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./routePlausible.js'], 'reuses the shared great-circle helper');
});

test('a long silent gap after the last ground point does not count as tracked time', () => {
  const g = (t) => [t, 48.7, 2.4, 'ground', 0, 0, 0];
  const a = (t, lat) => [t, lat, 2.4, 5000, 300, 0, 0];
  const pts = [g(0), g(60), a(30_000, 48.7), a(30_060, 48.8), a(30_120, 48.9)];
  const leg = extractCurrentLeg(pts);
  assert.equal(leg.start, 2, 'starts at the first point heard airborne, not the parked one');
  assert.equal(leg.onGroundNow, false);
  const near = extractCurrentLeg([g(0), g(60), a(120, 48.7), a(180, 48.8)]);
  assert.equal(near.start, 1, 'a normal takeoff still starts at the last ground point');
});
