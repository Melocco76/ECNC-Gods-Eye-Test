// Overpass proxy Tier A hardening (voice-engine evaluation doc §4.1, field test
// 2026-07-23): region/state boundary pivots return multi-MB coastline geometry that
// blew the old 12 MB read cap and 16 s client budget (Sicily never traced). The proxy
// now simplifies giant `out geom` payloads server-side before caching/serving, and
// boundary-class queries (is_in / pivot) get a longer disk TTL — boundaries change
// ≈never. Pure-function tests, no network.
//
// Mirror-failover + cache-admission hardening (traffic audit, 2026-10-04): the
// primary mirror can return an unexpected non-2xx (e.g. a mirror-specific 406)
// without being rate-limited or a runtime-error body. fetchOverpassPayload()
// must fall through to the next mirror on ANY non-2xx, and the route must never
// cache/serve an error page as if it were real Overpass data.
//
// Run with: npm test   (node --test)
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  simplifyOverpassPayloadBody,
  isOverpassBoundaryQuery,
  resolveOverpassPreflight,
  fetchOverpassPayload,
  overpassProxy,
  readOverpassDisk,
  writeOverpassDisk,
} from '../../vite.config.js';

test('preflight checks memory, in-flight, then disk before consuming limiter quota', async () => {
  const key = 'normalized query';
  const fresh = { id: 'memory', cachedAt: 900 };
  const joined = { id: 'inflight', cachedAt: 950 };
  const disk = { id: 'disk', cachedAt: 975 };
  let diskReads = 0;
  let limiterCalls = 0;
  const allowUpstream = () => { limiterCalls += 1; return true; };

  const memoryHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, fresh]]),
    inFlight: new Map([[key, Promise.resolve(joined)]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(memoryHit.source, 'HIT');
  assert.equal(memoryHit.payload, fresh);
  assert.equal(diskReads, 0, 'memory hit must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'memory hit must not consume limiter quota');

  const inFlightHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, { id: 'stale', cachedAt: 0 }]]),
    inFlight: new Map([[key, Promise.resolve(joined)]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(inFlightHit.source, 'INFLIGHT');
  assert.equal(inFlightHit.payload, joined);
  assert.equal(diskReads, 0, 'in-flight join must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'in-flight join must not consume limiter quota');

  const diskHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
  });
  assert.equal(diskHit.source, 'DISK');
  assert.equal(diskHit.payload, disk);
  assert.equal(diskReads, 1);
  assert.equal(limiterCalls, 0, 'disk hit must not consume limiter quota');

  const upstreamMiss = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return null; },
    allowUpstream,
  });
  assert.equal(upstreamMiss.source, 'UPSTREAM');
  assert.equal(diskReads, 2, 'disk must be checked before upstream admission');
  assert.equal(limiterCalls, 1, 'only a complete cache miss consumes quota');

  const denied = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => null,
    allowUpstream: () => false,
  });
  assert.equal(denied.source, 'RATE_LIMITED');
});

/** Synthetic dense ring: N points on a circle with sub-tolerance jitter. */
function denseRing(n, { latC = 37.5, lonC = 14.2, radiusDeg = 0.5 } = {}) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    // Jitter far below the simplification tolerance so the ring is genuinely
    // redundant — a correct simplifier should collapse most of it.
    const jitter = (i % 7) * 0.000004;
    pts.push({
      lat: latC + Math.sin(a) * (radiusDeg + jitter),
      lon: lonC + Math.cos(a) * (radiusDeg + jitter),
    });
  }
  pts.push({ ...pts[0] }); // closed ring
  return pts;
}

const TEST_OPTS = { minBytes: 0, minPoints: 200, toleranceDeg: 0.0004 };

test('simplify: giant way geometry is decimated, endpoints preserved', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 1, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  assert.ok(g.length < ring.length * 0.5, `should shed most redundant points, got ${g.length}/${ring.length}`);
  assert.ok(g.length >= 16, `must keep enough points to stay a ring, got ${g.length}`);
  assert.deepEqual(g[0], ring[0]);
  assert.deepEqual(g[g.length - 1], ring[ring.length - 1]);
});

test('simplify: relation member geometries are decimated too', () => {
  const ring = denseRing(3000);
  const body = JSON.stringify({
    elements: [{
      type: 'relation',
      id: 2,
      members: [
        { type: 'way', role: 'outer', geometry: ring },
        { type: 'node', role: 'admin_centre' }, // no geometry — must survive untouched
      ],
    }],
  });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.ok(out.elements[0].members[0].geometry.length < ring.length * 0.5);
  assert.equal(out.elements[0].members[1].geometry, undefined);
});

test('simplify: small geometries (building footprints) pass through untouched', () => {
  const square = [
    { lat: 30.27, lon: -97.74 }, { lat: 30.271, lon: -97.74 },
    { lat: 30.271, lon: -97.741 }, { lat: 30.27, lon: -97.741 },
    { lat: 30.27, lon: -97.74 },
  ];
  const body = JSON.stringify({ elements: [{ type: 'way', id: 3, geometry: square }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.deepEqual(out.elements[0].geometry, square);
});

test('simplify: geometry stays within tolerance of the original shape', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 4, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  // Every original vertex must lie near SOME kept vertex — a circle of kept
  // points at spacing s has every dropped point within ~s/2 along the arc, and
  // DP guarantees perpendicular deviation ≤ tolerance. Loose sanity bound: no
  // original point farther than 8× tolerance from the nearest kept point pair
  // is possible for a smooth ring; check a sampled subset for speed.
  for (let i = 0; i < ring.length; i += 97) {
    const p = ring[i];
    let best = Infinity;
    for (let j = 1; j < g.length; j++) {
      const d = pointSegDistDeg(p, g[j - 1], g[j]);
      if (d < best) best = d;
    }
    assert.ok(best <= TEST_OPTS.toleranceDeg * 1.01, `vertex ${i} deviates ${best} deg`);
  }
});

test('simplify: sub-threshold bodies and non-JSON pass through byte-identical', () => {
  const tiny = JSON.stringify({ elements: [{ type: 'way', geometry: denseRing(3000) }] });
  assert.equal(simplifyOverpassPayloadBody(tiny, { ...TEST_OPTS, minBytes: tiny.length + 1 }), tiny);
  const junk = 'this is not json {';
  assert.equal(simplifyOverpassPayloadBody(junk, TEST_OPTS), junk);
});

test('boundary-class queries detected for the long disk TTL', () => {
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];is_in(37.5,14.2)->.a;area.a["boundary"="administrative"]["admin_level"];out tags;',
  ), true);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];area(3600039152)->.x;rel(pivot.x);out geom;',
  ), true);
  // The enclosing-compound sweep and road fetches keep the default TTL.
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];( way(around:1200,30.27,-97.74)["leisure"]["name"]; );out geom;',
  ), false);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:12];way["highway"~"motorway|trunk"](30.1,-97.9,30.5,-97.5);out geom;',
  ), false);
});

/** Perpendicular distance (deg, planar approx) from p to segment a-b. */
function pointSegDistDeg(p, a, b) {
  const vx = b.lon - a.lon;
  const vy = b.lat - a.lat;
  const wx = p.lon - a.lon;
  const wy = p.lat - a.lat;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.lon - b.lon, p.lat - b.lat);
  const t = c1 / c2;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

// ── Mirror failover + cache admission (traffic audit root-cause fix) ───────
//
// The route's disk cache lives under the real project .gev-cache/overpass/
// (OVERPASS_DISK_DIR is resolved once from process.cwd() at module load, so
// it cannot be redirected per-test). Wipe it once up front so a disk entry
// left over from an earlier run of this same file can never masquerade as a
// fresh upstream response in these tests — it's pure cache, safe to clear.
before(() => {
  fs.rmSync(path.join(process.cwd(), '.gev-cache', 'overpass'), { recursive: true, force: true });
});

// A real Overpass QL body, spatially bounded (passes sanitizeOverpassBody).
// Each call gets a distinct bbox so every test gets its own cache key — the
// route's in-memory/disk caches are process-wide, so cross-test cache hits
// would make these tests order-dependent.
let _n = 0;
function overpassBody() {
  _n += 1;
  const lat = (30 + _n * 0.001).toFixed(6);
  const lat2 = (30 + _n * 0.001 + 0.0005).toFixed(6);
  return `data=${encodeURIComponent(`[out:json];way(${lat},-97.7,${lat2},-97.6)["highway"];out geom;`)}`;
}

const RUNTIME_ERROR_BODY = JSON.stringify({ remark: 'runtime error: Query run out of memory' });
const GOOD_BODY = JSON.stringify({ version: 0.6, elements: [{ type: 'way', id: 1, geometry: [] }] });

function jsonResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function htmlResponse(status, text = '<html><body>Not Acceptable</body></html>') {
  return new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
}

function fakeReq(body) {
  return {
    method: 'POST',
    url: '/',
    headers: {},
    socket: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    res.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  };
  res.end = (body) => { res.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); };
  return res;
}

function installOverpass(fetchImpl) {
  const routes = new Map();
  overpassProxy({ fetchImpl }).configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
  const handler = routes.get('/api/overpass');
  const call = async (body) => {
    const res = fakeRes();
    await handler(fakeReq(body), res);
    return res;
  };
  return { call };
}

/** Scripted multi-mirror fetch: returns responses[i] on the i-th call, records every call URL. */
function scriptedFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === 'function' ? r() : r;
  };
  return { fetchImpl, calls };
}

test('fetchOverpassPayload: primary mirror 406 falls through to the secondary mirror', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => htmlResponse(406),
    () => jsonResponse(GOOD_BODY),
  ]);
  const payload = await fetchOverpassPayload('data=test', undefined, fetchImpl);
  assert.equal(calls.length, 2, 'both mirrors were tried');
  assert.equal(payload.status, 200);
  assert.equal(payload.body, GOOD_BODY);
});

test('fetchOverpassPayload: primary 500 still falls back to the secondary mirror (unchanged)', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => htmlResponse(503, 'Service Unavailable'),
    () => jsonResponse(GOOD_BODY),
  ]);
  const payload = await fetchOverpassPayload('data=test', undefined, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(payload.status, 200);
  assert.equal(payload.body, GOOD_BODY);
});

test('fetchOverpassPayload: a 429 rate-limit still falls back as before', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => jsonResponse('{}', 429),
    () => jsonResponse(GOOD_BODY),
  ]);
  const payload = await fetchOverpassPayload('data=test', undefined, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(payload.status, 200);
  assert.equal(payload.body, GOOD_BODY);
});

test('fetchOverpassPayload: a runtime-error body (200 status) still falls back as before', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => jsonResponse(RUNTIME_ERROR_BODY, 200),
    () => jsonResponse(GOOD_BODY),
  ]);
  const payload = await fetchOverpassPayload('data=test', undefined, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(payload.status, 200);
  assert.equal(payload.body, GOOD_BODY);
});

test('fetchOverpassPayload: a successful primary 200 does NOT call the secondary mirror', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => jsonResponse(GOOD_BODY),
    () => { throw new Error('secondary must not be called'); },
  ]);
  const payload = await fetchOverpassPayload('data=test', undefined, fetchImpl);
  assert.equal(calls.length, 1, 'only the primary mirror was called');
  assert.equal(payload.status, 200);
  assert.equal(payload.body, GOOD_BODY);
});

test('fetchOverpassPayload: every mirror returning 406 throws rather than returning an error page as data', async () => {
  const { fetchImpl, calls } = scriptedFetch([() => htmlResponse(406)]);
  await assert.rejects(() => fetchOverpassPayload('data=test', undefined, fetchImpl));
  assert.ok(calls.length >= 2, `every configured mirror was tried before giving up (got ${calls.length})`);
});

test('route: primary 406 is never cached; a later good response for the same query IS cacheable', async () => {
  const body = overpassBody();
  const firstScript = scriptedFetch([() => htmlResponse(406)]);
  const first = installOverpass(firstScript.fetchImpl);
  const failedRes = await first.call(body);
  assert.equal(failedRes.statusCode, 502, 'every mirror failing surfaces as a clean proxy error, not a passed-through 406');
  assert.ok(firstScript.calls.length >= 2, `every configured mirror was tried on the first attempt (got ${firstScript.calls.length})`);

  // Same exact query again: if the 406 had been cached, this would never reach
  // fetchImpl at all (or would replay the bad HTML). It must reach upstream
  // fresh and this time succeed.
  const secondScript = scriptedFetch([() => jsonResponse(GOOD_BODY)]);
  const second = installOverpass(secondScript.fetchImpl);
  const goodRes = await second.call(body);
  assert.equal(goodRes.statusCode, 200);
  assert.equal(goodRes.body.toString(), GOOD_BODY);
  assert.equal(secondScript.calls.length, 1, 'the bad 406 was never cached — upstream was hit fresh');
  assert.doesNotMatch(goodRes.body.toString(), /<html/i, 'the client never receives HTML as road data');

  // Same query a third time: the GOOD response from the second call must now
  // be served from cache, with no further upstream calls at all.
  const thirdScript = scriptedFetch([() => { throw new Error('must not be called — should be a cache hit'); }]);
  const third = installOverpass(thirdScript.fetchImpl);
  const cachedRes = await third.call(body);
  assert.equal(cachedRes.statusCode, 200);
  assert.equal(cachedRes.body.toString(), GOOD_BODY);
  assert.equal(cachedRes.headers['x-overpass-cache'], 'HIT');
  assert.equal(thirdScript.calls.length, 0, 'the good response was cached — no upstream call needed');
});

test('route: secondary-mirror success after a primary failure reaches the client as a valid 200', async () => {
  const body = overpassBody();
  const { fetchImpl, calls } = scriptedFetch([
    () => htmlResponse(406),
    () => jsonResponse(GOOD_BODY),
  ]);
  const { call } = installOverpass(fetchImpl);
  const res = await call(body);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.body.toString(), GOOD_BODY);
  assert.deepEqual(JSON.parse(res.body.toString()), JSON.parse(GOOD_BODY));
  assert.equal(calls.length, 2);
});

test('route: a malformed/error HTML body from every mirror is never persisted as road data', async () => {
  const body = overpassBody();
  const { fetchImpl } = scriptedFetch([
    () => htmlResponse(406, '<!DOCTYPE HTML><html><body>Not Acceptable</body></html>'),
  ]);
  const { call } = installOverpass(fetchImpl);
  const res = await call(body);
  assert.equal(res.statusCode, 502);
  const errorText = res.body.toString();
  assert.doesNotMatch(errorText, /Not Acceptable/i, 'the upstream HTML error page never reaches the client body');
  assert.doesNotThrow(() => JSON.parse(errorText), 'the client always gets a parseable JSON error shape');
});

// ── Aggregate cascade timeout (traffic audit, 2026-10-05) ───────────────────
//
// A per-mirror 22s AbortController already existed; what was missing was a
// bound on the WHOLE sequential cascade (up to 4 mirrors), which could
// previously stretch a single request to 45-90+s if more than one mirror
// hung rather than failing fast. fetchOverpassPayload()'s 4th parameter
// (aggregateTimeoutMs) makes that budget injectable for these tests.

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/** A mirror response that never settles on its own — only the AbortSignal
 * fetchOverpassPayload() passes in can end it, exactly like a real hung
 * upstream connection. Takes the fetch `opts` object (as scriptedFetchWithSignal
 * invokes it below). */
function hangsUntilAborted() {
  return (opts) => new Promise((_resolve, reject) => {
    const signal = opts?.signal;
    if (!signal) return;
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

/** Like scriptedFetch, but passes the fetch options object (for the
 * AbortSignal) through to function-valued responses as their one argument. */
function scriptedFetchWithSignal(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    calls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === 'function' ? r(opts) : r;
  };
  return { fetchImpl, calls };
}

test('fetchOverpassPayload: the aggregate timeout bounds the whole cascade even when a mirror hangs', async () => {
  const { fetchImpl } = scriptedFetchWithSignal([hangsUntilAborted()]);
  const t0 = Date.now();
  await assert.rejects(() => fetchOverpassPayload('data=test', undefined, fetchImpl, 150));
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 2000, `expected the 150ms aggregate budget to bound the call, took ${elapsedMs}ms`);
});

test('fetchOverpassPayload: once the aggregate timeout is exhausted, remaining mirrors are not attempted', async () => {
  const { fetchImpl, calls } = scriptedFetchWithSignal([
    hangsUntilAborted(),
    () => { throw new Error('a later mirror must not be attempted once the aggregate budget is spent'); },
  ]);
  await assert.rejects(() => fetchOverpassPayload('data=test', undefined, fetchImpl, 120));
  assert.equal(calls.length, 1, 'only the first (hanging) mirror was attempted before the budget ran out');
});

// Note: "a timed-out/hung cascade is never cached" is not retested at the
// route level with a real hang — the route always uses the full 10s default
// aggregate budget, which would make that test take ~10s of real wall-clock
// time for no extra assurance. Cache admission only looks at whether
// fetchOverpassPayload() resolved or threw, not how long it took to get
// there; "route: primary 406 is never cached" above already exercises that
// exact same resolve/throw boundary, just via a fast failure instead of a
// slow one. The aggregate-budget tests above independently prove the thrown
// path is what a hang produces.

// ── Poisoned disk cache (traffic audit, 2026-10-05) ─────────────────────────
//
// A response written to disk before the mirror-failover hardening (or any
// future bug) could be an error page with status >= 400. readOverpassDisk()
// must refuse to serve it regardless of age; a fresh upstream attempt must
// run instead. Good (status < 400) entries must keep working exactly as
// before. Tested directly against readOverpassDisk()/writeOverpassDisk()
// with test-owned cache keys — no need to reconstruct the route's own
// cache-key derivation, since resolveOverpassPreflight() is the exact same
// function the route calls with whatever key it computes.

test('readOverpassDisk: a poisoned entry (status >= 400) is never served, even very fresh', async () => {
  const key = `test-poisoned-${Date.now()}-${Math.random()}`;
  await writeOverpassDisk(key, {
    status: 406,
    body: '<html><body>Not Acceptable</body></html>',
    contentType: 'text/html',
    endpoint: 'https://overpass-api.de/api/interpreter',
    rateLimited: false,
    runtimeError: false,
    cachedAt: Date.now(),
  });
  const result = await readOverpassDisk(key, Infinity);
  assert.equal(result, null, 'a >=400 disk entry must never be returned, regardless of maxAgeMs');
});

test('readOverpassDisk: a good entry (status < 400) is still served exactly as before', async () => {
  const key = `test-good-${Date.now()}-${Math.random()}`;
  const payload = {
    status: 200,
    body: GOOD_BODY,
    contentType: 'application/json',
    endpoint: 'https://overpass-api.de/api/interpreter',
    rateLimited: false,
    runtimeError: false,
    cachedAt: Date.now(),
  };
  await writeOverpassDisk(key, payload);
  const result = await readOverpassDisk(key, 60000);
  assert.ok(result, 'a good entry must still be returned');
  assert.equal(result.status, 200);
  assert.equal(result.body, GOOD_BODY);
});

test('readOverpassDisk: an expired good entry is still rejected by age, unaffected by the status check', async () => {
  const key = `test-expired-${Date.now()}-${Math.random()}`;
  await writeOverpassDisk(key, {
    status: 200,
    body: GOOD_BODY,
    contentType: 'application/json',
    endpoint: 'test',
    rateLimited: false,
    runtimeError: false,
    cachedAt: Date.now() - 100000,
  });
  const result = await readOverpassDisk(key, 1000);
  assert.equal(result, null, 'age rejection must still work for good entries');
});

test('resolveOverpassPreflight backed by the real readOverpassDisk falls through to UPSTREAM on a poisoned entry', async () => {
  const key = `test-preflight-poisoned-${Date.now()}-${Math.random()}`;
  await writeOverpassDisk(key, {
    status: 406,
    body: '<html>bad</html>',
    contentType: 'text/html',
    endpoint: 'test',
    rateLimited: false,
    runtimeError: false,
    cachedAt: Date.now(),
  });
  const result = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: () => readOverpassDisk(key, Infinity),
    allowUpstream: () => true,
  });
  assert.equal(result.source, 'UPSTREAM', 'a poisoned disk entry must never short-circuit to a DISK hit');
});

test('resolveOverpassPreflight backed by the real readOverpassDisk still serves a good entry as DISK', async () => {
  const key = `test-preflight-good-${Date.now()}-${Math.random()}`;
  await writeOverpassDisk(key, {
    status: 200,
    body: GOOD_BODY,
    contentType: 'application/json',
    endpoint: 'test',
    rateLimited: false,
    runtimeError: false,
    cachedAt: Date.now(),
  });
  let upstreamCalled = false;
  const result = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: () => readOverpassDisk(key, 60000),
    allowUpstream: () => { upstreamCalled = true; return true; },
  });
  assert.equal(result.source, 'DISK');
  assert.equal(result.payload.body, GOOD_BODY);
  assert.equal(upstreamCalled, false, 'a good disk hit must not consume upstream rate-limiter quota');
});
