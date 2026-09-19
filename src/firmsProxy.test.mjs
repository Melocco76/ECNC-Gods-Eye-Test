// /api/firms proxy hardening: streaming ingestion, caps, gzip, cache, rate limit.
// Fake upstream + fake key only — no network, no real FIRMS_MAP_KEY.
//
// Run with: npm test   (node --test)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { firmsProxy } from '../vite.config.js';
import { FIRMS_SOURCES, FIRMS_SOURCE_LIMITS } from './data/firmsSources.js';

const KEY = 'FAKEKEY-abc123-DO-NOT-LEAK';
const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const NOW = Date.UTC(2026, 8, 18, 12, 0);
const TTL_MS = 30 * 60_000;

const row = (lat, lon, date, time, satellite = 'N20') =>
  `${lat},${lon},330.5,0.39,0.36,${date},${time},${satellite},VIIRS,n,2.0NRT,290.1,1.5,D`;

const csvFor = (n, satellite) => [
  HEADER,
  ...Array.from({ length: n }, (_, i) => row((10 + i * 0.01).toFixed(2), (20 + i * 0.01).toFixed(2), '2026-09-18', String(1000 + (i % 100)), satellite)),
  row('1', '1', '2026-09-01', '1200', satellite), // outside the trailing window
].join('\n');

function streamOf(text, chunkSize = 37) {
  const bytes = Buffer.from(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

/** Fake upstream keyed by source name (or 'status'). */
function makeUpstream(plan) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('mapkey_status')) {
      return new Response(JSON.stringify({ current_transactions: 7, transaction_limit: 5000 }), { status: 200 });
    }
    const source = FIRMS_SOURCES.find((s) => href.includes(`/${s}/`)) || href.split('/').at(-3);
    const step = plan[source] ?? plan['*'];
    if (!step) throw new Error(`unplanned source ${source}`);
    if (step.throws) throw new Error(step.throws.replace('{URL}', href));
    if (step.status && step.status !== 200) return new Response('nope', { status: step.status });
    return new Response(streamOf(step.csv, step.chunk), { status: 200 });
  };
  return { fetchImpl, calls };
}

function mockResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    res.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    res.headersSent = true;
  };
  res.done = new Promise((resolve) => res.on('finish', resolve));
  res.bodyBuffer = () => Buffer.concat(chunks);
  return res;
}

function makeProxy(options = {}) {
  const { fetchImpl, calls } = options.upstream || makeUpstream({ '*': { csv: csvFor(5) } });
  const clock = { now: NOW };
  const routes = new Map();
  firmsProxy({
    fetchImpl,
    now: () => clock.now,
    getKey: () => (options.key === undefined ? KEY : options.key),
    diskCacheDir: options.diskCacheDir ?? false,
    rateLimiter: options.rateLimiter ?? (() => true),
    sources: options.sources,
    limits: options.limits,
    maxPlainBytes: options.maxPlainBytes,
  }).configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
  const handler = routes.get('/api/firms');
  const call = async (url = '/', headers = {}) => {
    const res = mockResponse();
    await handler({ method: 'GET', url, headers, socket: { remoteAddress: '203.0.113.9' } }, res);
    if (!res.writableEnded) res.end();
    await res.done;
    return { status: res.statusCode, headers: res.headers, body: res.bodyBuffer() };
  };
  return { call, calls, clock };
}

const decode = (response) => JSON.parse(
  (response.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(response.body) : response.body).toString('utf8'),
);

function captureWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  return { lines, restore: () => { console.warn = original; } };
}

test('keyless: 503 no_key, status reports hasKey false, upstream never touched', async () => {
  const proxy = makeProxy({ key: '' });
  const data = await proxy.call('/');
  assert.equal(data.status, 503);
  assert.deepEqual(JSON.parse(data.body), { error: 'no_key' });
  const status = await proxy.call('/status');
  assert.deepEqual(JSON.parse(status.body), { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: TTL_MS, transactions: null });
  assert.equal(proxy.calls.length, 0);
});

test('response schema is unchanged: same keys/order, per-source counts, 24 h-clamped fires', async () => {
  const proxy = makeProxy();
  const response = await proxy.call('/', { 'accept-encoding': 'gzip' });
  const payload = decode(response);
  assert.deepEqual(Object.keys(payload), ['fetchedAt', 'stale', 'ttlMs', 'sources', 'count', 'fires']);
  assert.equal(payload.fetchedAt, NOW);
  assert.equal(payload.stale, false);
  assert.equal(payload.ttlMs, TTL_MS);
  assert.deepEqual(payload.sources, FIRMS_SOURCES.map((source) => ({ source, count: 5, ok: true })));
  assert.equal(payload.count, 15);
  assert.equal(payload.fires.length, 15);
  assert.deepEqual(Object.keys(payload.fires[0]), [
    'lat', 'lon', 'frp', 'confidence', 'brightness', 'brightnessTi5',
    'daynight', 'acqDate', 'acqTime', 'satellite', 'instrument',
  ]);
  assert.equal(payload.fires.every((fire) => fire.acqDate === '2026-09-18'), true, 'old rows never served');
});

test('gzip when accepted (single compression), plain JSON otherwise, identical decoded payloads', async () => {
  const proxy = makeProxy({ upstream: makeUpstream({ '*': { csv: csvFor(2000) } }) });
  const gz = await proxy.call('/', { 'accept-encoding': 'br, gzip;q=0.8' });
  const plain = await proxy.call('/', {});
  const star = await proxy.call('/', { 'accept-encoding': '*' });
  const refused = await proxy.call('/', { 'accept-encoding': 'gzip;q=0' });

  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers['content-type'], 'application/json');
  assert.equal(gz.headers.vary, 'Accept-Encoding');
  assert.equal(gz.headers['content-length'], String(gz.body.length));
  assert.equal(gz.body[0], 0x1f);
  assert.equal(gz.body[1], 0x8b);

  for (const response of [plain, refused]) {
    assert.equal(response.headers['content-encoding'], undefined, 'no Content-Encoding on uncompressed bodies');
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['content-length'], String(response.body.length));
    assert.equal(response.body[0], 0x7b, 'plain JSON starts with {');
  }
  assert.equal(star.headers['content-encoding'], 'gzip');

  assert.deepEqual(decode(gz), decode(plain));
  assert.deepEqual(decode(gz), decode(star));

  const decodedGzip = zlib.gunzipSync(gz.body);
  assert.equal(decodedGzip.toString().startsWith('{"fetchedAt"'), true, 'not double-compressed');
  console.log(`[firms test] fixture ratio: ${plain.body.length} B JSON -> ${gz.body.length} B gzip (${(plain.body.length / gz.body.length).toFixed(1)}x, 6,000 synthetic rows)`);
  assert.ok(gz.body.length < plain.body.length / 3, 'gzip meaningfully smaller on the fixture');
});

test('oversized plain body: gzip-refusing clients get a small controlled 406, gzip clients are unchanged', async () => {
  const proxy = makeProxy({ upstream: makeUpstream({ '*': { csv: csvFor(2000) } }), maxPlainBytes: 100_000 });
  const gz = await proxy.call('/', { 'accept-encoding': 'gzip' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(decode(gz).count > 1000);

  for (const headers of [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': 'gzip;q=0' }, { 'accept-encoding': 'gzip;q=0, identity' }]) {
    const response = await proxy.call('/', headers);
    assert.equal(response.status, 406, JSON.stringify(headers));
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers['content-length'], String(response.body.length));
    assert.deepEqual(JSON.parse(response.body), { error: 'gzip_required', message: 'FIRMS response requires gzip encoding' });
    assert.ok(response.body.length < 200, 'controlled body is tiny; the oversized payload is never written');
    const text = response.body.toString();
    for (const leak of [KEY, 'firms.modaps', 'MAP_KEY', '.gev-cache', 'fires']) assert.equal(text.includes(leak), false, leak);
  }
});

test('small plain body is still served plain to clients that do not accept gzip', async () => {
  const proxy = makeProxy({ maxPlainBytes: 1_000_000 });
  for (const headers of [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': 'gzip;q=0' }]) {
    const response = await proxy.call('/', headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(decode(response).count, 15);
  }
});

test('the serialized payload is cached: no upstream calls and no JSON.stringify per request', async () => {
  const proxy = makeProxy();
  await proxy.call('/', { 'accept-encoding': 'gzip' });
  const upstreamCalls = proxy.calls.length;
  assert.equal(upstreamCalls, FIRMS_SOURCES.length);

  const original = JSON.stringify;
  const originalParse = JSON.parse;
  let stringifyCalls = 0;
  let parseCalls = 0;
  let responses = [];
  JSON.stringify = (...args) => { stringifyCalls += 1; return original(...args); };
  JSON.parse = (...args) => { parseCalls += 1; return originalParse(...args); };
  try {
    proxy.clock.now += 5 * 60_000;
    responses = [
      await proxy.call('/', { 'accept-encoding': 'gzip' }),
      await proxy.call('/', {}),
      await proxy.call('/', { 'accept-encoding': 'gzip' }),
    ];
  } finally {
    JSON.stringify = original;
    JSON.parse = originalParse;
  }
  assert.equal(proxy.calls.length, upstreamCalls, 'still within the 30 min TTL');
  assert.equal(stringifyCalls, 0, 'requests never re-serialize the payload');
  assert.equal(parseCalls, 0, 'requests never rebuild an object graph from cached bytes');
  const [a, b, c] = responses;
  assert.equal(a.body.equals(c.body), true, 'identical cached gzip bytes');
  assert.equal(decode(a).fetchedAt, decode(b).fetchedAt);
});

test('partial source failure still serves the healthy sources and marks the failed one', async () => {
  const warnings = captureWarnings();
  try {
    const upstream = makeUpstream({
      VIIRS_NOAA20_NRT: { csv: csvFor(3) },
      VIIRS_NOAA21_NRT: { status: 500 },
      VIIRS_SNPP_NRT: { csv: '<html>Invalid MAP_KEY</html>' },
    });
    const payload = decode(await makeProxy({ upstream }).call('/', { 'accept-encoding': 'gzip' }));
    assert.deepEqual(payload.sources, [
      { source: 'VIIRS_NOAA20_NRT', count: 3, ok: true },
      { source: 'VIIRS_NOAA21_NRT', count: 0, ok: false },
      { source: 'VIIRS_SNPP_NRT', count: 0, ok: false },
    ]);
    assert.equal(payload.count, 3);
    assert.equal(payload.fires.length, 3);
  } finally {
    warnings.restore();
  }
});

test('all sources failing serves the stale cache (stale:true) clamped to the rolling window; no cache → 502', async () => {
  const warnings = captureWarnings();
  try {
    let healthy = true;
    const good = makeUpstream({ '*': { csv: csvFor(4) } });
    const proxy = makeProxy({
      upstream: {
        calls: good.calls,
        fetchImpl: async (url) => {
          if (healthy) return good.fetchImpl(url);
          throw new Error('offline');
        },
      },
    });
    const fresh = decode(await proxy.call('/', { 'accept-encoding': 'gzip' }));
    assert.equal(fresh.stale, false);

    healthy = false;
    proxy.clock.now += TTL_MS + 1;
    const staleGz = await proxy.call('/', { 'accept-encoding': 'gzip' });
    const stalePlain = await proxy.call('/', {});
    assert.equal(staleGz.status, 200);
    assert.equal(decode(staleGz).stale, true);
    assert.equal(decode(stalePlain).stale, true);
    assert.equal(decode(staleGz).fetchedAt, fresh.fetchedAt);
    assert.deepEqual(decode(staleGz).fires, fresh.fires, 'still inside 24 h: nothing dropped yet');
    assert.equal(staleGz.headers['content-encoding'], 'gzip');

    proxy.clock.now += 7 * 3600_000;
    const hoursLater = decode(await proxy.call('/', {}));
    assert.equal(hoursLater.stale, true);
    assert.deepEqual(hoursLater.fires, fresh.fires, 'no arbitrary stale cap: served while still within 24 h');

    proxy.clock.now += 30 * 3600_000;
    const expired = await proxy.call('/', { 'accept-encoding': 'gzip' });
    assert.equal(expired.status, 200);
    const expiredPayload = decode(expired);
    assert.equal(expiredPayload.stale, true);
    assert.deepEqual(expiredPayload.fires, [], 'every detection aged past 24 h');
    assert.equal(expiredPayload.count, 0);

    const empty = await makeProxy({ upstream: makeUpstream({ '*': { status: 503 } }) }).call('/', {});
    assert.equal(empty.status, 502);
    assert.deepEqual(JSON.parse(empty.body), { error: 'firms fetch failed and no cache available' });
  } finally {
    warnings.restore();
  }
});

test('byte cap and record cap fail only the offending source', async () => {
  const warnings = captureWarnings();
  try {
    const upstream = makeUpstream({
      VIIRS_NOAA20_NRT: { csv: csvFor(500) }, // exceeds maxRecords
      VIIRS_NOAA21_NRT: { csv: csvFor(2) },
      VIIRS_SNPP_NRT: { csv: `${csvFor(2)}\n${'x'.repeat(5000)}` }, // exceeds maxBytes
    });
    const proxy = makeProxy({ upstream, limits: { maxRecords: 100, maxBytes: 4000, maxRows: 100_000 } });
    const payload = decode(await proxy.call('/', { 'accept-encoding': 'gzip' }));
    assert.deepEqual(payload.sources.map((s) => [s.source, s.ok, s.count]), [
      ['VIIRS_NOAA20_NRT', false, 0],
      ['VIIRS_NOAA21_NRT', true, 2],
      ['VIIRS_SNPP_NRT', false, 0],
    ]);
    assert.equal(payload.fires.length, 2, 'a failed source leaves no partial records behind');
    const rowCap = makeProxy({ upstream: makeUpstream({ '*': { csv: csvFor(50) } }), limits: { maxRows: 10 } });
    assert.equal((await rowCap.call('/')).status, 502);
  } finally {
    warnings.restore();
  }
});

test('the default caps are explicit, conservative and enforced through the proxy defaults', () => {
  assert.equal(Object.isFrozen(FIRMS_SOURCE_LIMITS), true);
  assert.equal(FIRMS_SOURCE_LIMITS.timeoutMs, 60_000, 'existing 60 s timeout preserved');
  assert.ok(FIRMS_SOURCE_LIMITS.maxRows >= 200_000, 'above the documented ~100k/day x 2 days');
  assert.ok(FIRMS_SOURCE_LIMITS.maxRecords >= 100_000, 'above the documented single-day maximum');
  assert.ok(FIRMS_SOURCE_LIMITS.maxBytes >= FIRMS_SOURCE_LIMITS.maxRows * 100, 'bytes cover rows at >=100 B each');
});

test('the FIRMS_MAP_KEY never appears in responses, warnings, or cached bytes', async () => {
  const warnings = captureWarnings();
  try {
    const upstream = makeUpstream({
      VIIRS_NOAA20_NRT: { throws: `connect ECONNRESET {URL}` },
      VIIRS_NOAA21_NRT: { status: 401 },
      VIIRS_SNPP_NRT: { csv: csvFor(3) },
    });
    const proxy = makeProxy({ upstream });
    const gz = await proxy.call('/', { 'accept-encoding': 'gzip' });
    const plain = await proxy.call('/', {});
    const status = await proxy.call('/status', {});
    for (const bytes of [zlib.gunzipSync(gz.body), plain.body, status.body]) {
      assert.equal(bytes.toString().includes(KEY), false);
      assert.equal(bytes.toString().includes('MAP_KEY'), false);
    }
    assert.equal(warnings.lines.length >= 2, true);
    assert.equal(warnings.lines.some((line) => line.includes(KEY)), false, 'log lines are redacted');
    assert.equal(warnings.lines.some((line) => line.includes('[redacted]')), true);

    const failing = makeProxy({ upstream: makeUpstream({ '*': { throws: 'boom {URL}' } }) });
    const error = await failing.call('/');
    assert.equal(error.status, 502);
    assert.equal(error.body.toString().includes(KEY), false);
  } finally {
    warnings.restore();
  }
});

test('/api/firms is rate limited (clean 429); status and keyless paths are not', async () => {
  let allowed = 2;
  const proxy = makeProxy({ rateLimiter: () => allowed-- > 0 });
  assert.equal((await proxy.call('/', {})).status, 200);
  assert.equal((await proxy.call('/', {})).status, 200);
  const limited = await proxy.call('/', {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '30');
  assert.deepEqual(JSON.parse(limited.body), { error: 'rate_limited' });
  assert.equal((await proxy.call('/status', {})).status, 200, 'status is not limited');

  const keyless = makeProxy({ key: '', rateLimiter: () => false });
  assert.equal((await keyless.call('/', {})).status, 503, 'keyless answers before the limiter');
});

test('the default limiter allows normal polling but stops a runaway caller', async () => {
  const routes = new Map();
  const { fetchImpl } = makeUpstream({ '*': { csv: csvFor(2) } });
  firmsProxy({ fetchImpl, now: () => NOW, getKey: () => KEY, diskCacheDir: false })
    .configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
  const handler = routes.get('/api/firms');
  const statuses = [];
  for (let i = 0; i < 25; i += 1) {
    const res = mockResponse();
    await handler({ method: 'GET', url: '/', headers: {}, socket: { remoteAddress: '198.51.100.7' } }, res);
    if (!res.writableEnded) res.end();
    await res.done;
    statuses.push(res.statusCode);
  }
  assert.equal(statuses.slice(0, 20).every((s) => s === 200), true, 'a 10-minute poller is nowhere near the cap');
  assert.equal(statuses.slice(20).every((s) => s === 429), true);
});

test('the source list comes from one configurable place (SNPP retirement is a one-line change)', async () => {
  assert.equal(Object.isFrozen(FIRMS_SOURCES), true);
  assert.deepEqual([...FIRMS_SOURCES], ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT']);

  const defaults = makeProxy();
  await defaults.call('/');
  assert.deepEqual(
    defaults.calls.map((url) => url.match(/csv\/[^/]+\/([^/]+)\/world\/2$/)?.[1]),
    [...FIRMS_SOURCES],
    'default proxy walks FIRMS_SOURCES in order',
  );

  const custom = makeProxy({ sources: ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'] });
  const payload = decode(await custom.call('/'));
  assert.deepEqual(payload.sources.map((s) => s.source), ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']);
  assert.equal(custom.calls.length, 2);
  assert.equal(payload.count, 10, 'removing a source lowers count; there is no cross-source dedup to redo');

  const header = fs.readFileSync(new URL('./data/firmsSources.js', import.meta.url), 'utf8');
  assert.match(header, /2026-11-01/);
  assert.match(header, /NOAA-20 and NOAA-21/);
});

test('disk cache: skipped when disabled; local dir stores compact gzip and reloads without refetching', async () => {
  const none = makeProxy({ diskCacheDir: false });
  await none.call('/');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-firms-'));
  try {
    const first = makeProxy({ diskCacheDir: dir });
    const fresh = decode(await first.call('/', { 'accept-encoding': 'gzip' }));
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['firms-v3.data.gz', 'firms-v3.meta.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'firms-v3.data.gz'))[0], 0x1f);
    assert.equal(fs.readFileSync(path.join(dir, 'firms-v3.meta.json'), 'utf8').includes(KEY), false);

    const restarted = makeProxy({ diskCacheDir: dir, upstream: makeUpstream({}) });
    const fromDisk = await restarted.call('/', { 'accept-encoding': 'gzip' });
    assert.equal(restarted.calls.length, 0, 'fresh disk cache prevents any upstream fetch');
    assert.deepEqual(decode(fromDisk), fresh);
    const plainFromDisk = await restarted.call('/', {});
    assert.deepEqual(decode(plainFromDisk), fresh);
    const status = JSON.parse((await restarted.call('/status')).body);
    assert.equal(status.count, fresh.count);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cloud Run (K_SERVICE) disables the disk cache by default', async () => {
  const previous = process.env.K_SERVICE;
  process.env.K_SERVICE = 'gods-eye-view';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-firms-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const routes = new Map();
    const { fetchImpl } = makeUpstream({ '*': { csv: csvFor(2) } });
    firmsProxy({ fetchImpl, now: () => NOW, getKey: () => KEY, rateLimiter: () => true })
      .configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
    const res = mockResponse();
    await routes.get('/api/firms')({ method: 'GET', url: '/', headers: {}, socket: {} }, res);
    await res.done;
    assert.equal(res.statusCode, 200);
    assert.equal(fs.existsSync(path.join(dir, '.gev-cache')), false, 'nothing written to the (memory-backed) Cloud Run filesystem');
  } finally {
    process.chdir(originalCwd);
    if (previous === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the client FIRMS contract this proxy serves is still what the layer consumes', () => {
  const layer = fs.readFileSync(new URL('./data/firmsHeatmap.js', import.meta.url), 'utf8');
  assert.match(layer, /fetch\(FIRMS_API_URL, \{ cache: 'no-store' \}\)/);
  assert.match(layer, /payload\?\.stale/);
  assert.match(layer, /adaptFirmsRecords\(payload\?\.fires\)/);
});

// ── Rolling trailing-24 h semantics at serve time ────────────────────────────
const MIN = 60_000;
/** A CSV row acquired `ageMin` minutes before NOW; `lat` identifies it in assertions. */
const rowAged = (ageMin, lat, satellite = 'N20') => {
  const at = new Date(NOW - ageMin * MIN);
  const date = at.toISOString().slice(0, 10);
  const time = String(at.getUTCHours() * 100 + at.getUTCMinutes());
  return row(String(lat), '10', date, time, satellite);
};
const csvAged = (rows) => [HEADER, ...rows].join('\n');
const lats = (payload) => payload.fires.map((fire) => fire.lat);
const one = (csv) => ({ sources: ['VIIRS_NOAA20_NRT'], upstream: makeUpstream({ '*': { csv } }) });

test('fresh cache: detections older than 24 h are never served, the boundary is inclusive', async () => {
  const proxy = makeProxy(one(csvAged([
    rowAged(1500, 1), // 25 h old: dropped at ingest
    rowAged(1440, 2), // exactly 24 h: inclusive
    rowAged(1439, 3),
    rowAged(600, 4),
    rowAged(30, 5),
  ])));
  const first = decode(await proxy.call('/', { 'accept-encoding': 'gzip' }));
  assert.deepEqual(lats(first), [2, 3, 4, 5]);
  assert.equal(first.count, 4);
  assert.deepEqual(first.sources, [{ source: 'VIIRS_NOAA20_NRT', count: 4, ok: true }], 'per-source refresh count is a refresh-time fact');
});

test('advancing time drops detections without any upstream refresh (fresh cache)', async () => {
  const proxy = makeProxy(one(csvAged([rowAged(1440, 2), rowAged(1435, 3), rowAged(600, 4), rowAged(30, 5)])));
  assert.deepEqual(lats(decode(await proxy.call('/'))), [2, 3, 4, 5]);
  const upstreamCalls = proxy.calls.length;

  proxy.clock.now += 1 * MIN; // 1440 → 1441 min: expired
  assert.deepEqual(lats(decode(await proxy.call('/'))), [3, 4, 5]);
  proxy.clock.now += 5 * MIN; // 1435 → 1446 min
  const later = decode(await proxy.call('/', { 'accept-encoding': 'gzip' }));
  assert.deepEqual(lats(later), [4, 5]);
  assert.equal(later.count, 2);
  assert.equal(later.stale, false, 'still fresh: TTL not reached, so no refresh happened');
  assert.equal(proxy.calls.length, upstreamCalls, 'the returned set changed with no upstream call');
});

test('stale cache keeps aging: records drop as they pass 24 h while upstream is down', async () => {
  const warnings = captureWarnings();
  try {
    let healthy = true;
    const good = makeUpstream({ '*': { csv: csvAged([rowAged(1400, 1), rowAged(1000, 2), rowAged(500, 3), rowAged(10, 4)]) } });
    const proxy = makeProxy({
      sources: ['VIIRS_NOAA20_NRT'],
      upstream: { calls: good.calls, fetchImpl: async (url) => { if (healthy) return good.fetchImpl(url); throw new Error('offline'); } },
    });
    assert.deepEqual(lats(decode(await proxy.call('/'))), [1, 2, 3, 4]);
    healthy = false;
    const expectations = [
      [31, [1, 2, 3, 4]], // 1431 / 1031 / 531 / 41 min
      [61, [2, 3, 4]], // 1461 → gone
      [900, [3, 4]], // 1900 gone; 1400 kept
      [950, [4]], // 1450 gone; 960 kept
      [1500, []], // 1510 gone
    ];
    for (const [minutes, expected] of expectations) {
      proxy.clock.now = NOW + minutes * MIN;
      const gz = await proxy.call('/', { 'accept-encoding': 'gzip' });
      const plain = await proxy.call('/', {});
      const payload = decode(gz);
      assert.equal(payload.stale, true, `+${minutes} min`);
      assert.deepEqual(lats(payload), expected, `+${minutes} min`);
      assert.equal(payload.count, expected.length);
      assert.deepEqual(decode(plain), payload, `gzip and plain agree at +${minutes} min`);
      assert.equal(payload.fetchedAt, NOW, 'stale data keeps its original fetchedAt');
    }
  } finally {
    warnings.restore();
  }
});

test('partial-source stale data: failed source stays ok:false, survivors age out per source in source order', async () => {
  const warnings = captureWarnings();
  try {
    let healthy = true;
    const good = makeUpstream({
      VIIRS_NOAA20_NRT: { csv: csvAged([rowAged(1300, 1), rowAged(10, 2)]) },
      VIIRS_NOAA21_NRT: { status: 500 },
      VIIRS_SNPP_NRT: { csv: csvAged([rowAged(1350, 3, 'N'), rowAged(20, 4, 'N')]) },
    });
    const proxy = makeProxy({
      upstream: { calls: good.calls, fetchImpl: async (url) => { if (healthy) return good.fetchImpl(url); throw new Error('offline'); } },
    });
    const fresh = decode(await proxy.call('/', { 'accept-encoding': 'gzip' }));
    assert.deepEqual(lats(fresh), [1, 2, 3, 4], 'NOAA-20 then SNPP; NOAA-21 contributed nothing');

    healthy = false;
    proxy.clock.now = NOW + 200 * MIN; // 1500 / 210 / 1550 / 220 min
    const stale = decode(await proxy.call('/', { 'accept-encoding': 'gzip' }));
    assert.equal(stale.stale, true);
    assert.deepEqual(lats(stale), [2, 4]);
    assert.equal(stale.count, 2);
    assert.deepEqual(stale.sources, [
      { source: 'VIIRS_NOAA20_NRT', count: 2, ok: true },
      { source: 'VIIRS_NOAA21_NRT', count: 0, ok: false },
      { source: 'VIIRS_SNPP_NRT', count: 2, ok: true },
    ]);
  } finally {
    warnings.restore();
  }
});

test('gzip and plain decode to the same rolling-window result; gzip is cached per distinct window', async () => {
  const proxy = makeProxy(one(csvAged([rowAged(1440, 1), rowAged(700, 2), rowAged(5, 3)])));
  const a = await proxy.call('/', { 'accept-encoding': 'gzip' });
  const a2 = await proxy.call('/', { 'accept-encoding': 'gzip' });
  const aPlain = await proxy.call('/', {});
  assert.equal(a.body.equals(a2.body), true, 'same window → same cached gzip bytes');
  assert.deepEqual(decode(a), decode(aPlain));
  assert.deepEqual(lats(decode(a)), [1, 2, 3]);

  proxy.clock.now += 2 * MIN; // the 1440-minute record expires
  const b = await proxy.call('/', { 'accept-encoding': 'gzip' });
  const bPlain = await proxy.call('/', {});
  assert.equal(b.body.equals(a.body), false, 'a new window gets its own gzip');
  assert.deepEqual(decode(b), decode(bPlain));
  assert.deepEqual(lats(decode(b)), [2, 3]);
  assert.equal(b.headers['content-length'], String(b.body.length));
  assert.equal(bPlain.headers['content-length'], String(bPlain.body.length));
});

test('every record keeps its full field set, including the acqDate/acqTime the client parses', async () => {
  const proxy = makeProxy(one(csvAged([rowAged(90, 7)])));
  const [fire] = decode(await proxy.call('/', { 'accept-encoding': 'gzip' })).fires;
  assert.deepEqual(Object.keys(fire), [
    'lat', 'lon', 'frp', 'confidence', 'brightness', 'brightnessTi5',
    'daynight', 'acqDate', 'acqTime', 'satellite', 'instrument',
  ]);
  assert.match(fire.acqDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(fire.acqTime, /^\d{1,4}$/);
  assert.equal(Date.UTC(
    Number(fire.acqDate.slice(0, 4)), Number(fire.acqDate.slice(5, 7)) - 1, Number(fire.acqDate.slice(8, 10)),
    Math.floor(Number(fire.acqTime) / 100), Number(fire.acqTime) % 100,
  ), NOW - 90 * MIN, 'the served timestamp fields are the acquisition time, unmodified');
});

test('serving from cache never re-parses, re-stringifies, or re-fetches while the window moves', async () => {
  const proxy = makeProxy(one(csvAged([rowAged(1439, 1), rowAged(500, 2), rowAged(5, 3)])));
  await proxy.call('/', { 'accept-encoding': 'gzip' });
  const upstreamCalls = proxy.calls.length;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  let stringifyCalls = 0;
  let parseCalls = 0;
  JSON.stringify = (...args) => { stringifyCalls += 1; return stringify(...args); };
  JSON.parse = (...args) => { parseCalls += 1; return parse(...args); };
  try {
    for (let step = 0; step < 6; step += 1) {
      proxy.clock.now += 3 * MIN;
      await proxy.call('/', { 'accept-encoding': 'gzip' });
      await proxy.call('/', {});
    }
  } finally {
    JSON.stringify = stringify;
    JSON.parse = parse;
  }
  assert.equal(stringifyCalls, 0);
  assert.equal(parseCalls, 0);
  assert.equal(proxy.calls.length, upstreamCalls);
});

test('the key is absent from rolling-window payloads and error paths', async () => {
  const warnings = captureWarnings();
  try {
    let healthy = true;
    const good = makeUpstream({ '*': { csv: csvAged([rowAged(30, 1)]) } });
    const proxy = makeProxy({
      sources: ['VIIRS_NOAA20_NRT'],
      upstream: { calls: good.calls, fetchImpl: async (url) => { if (healthy) return good.fetchImpl(url); throw new Error(`down ${url}`); } },
    });
    const outputs = [await proxy.call('/', { 'accept-encoding': 'gzip' })];
    healthy = false;
    proxy.clock.now += TTL_MS + 1;
    outputs.push(await proxy.call('/', { 'accept-encoding': 'gzip' }), await proxy.call('/', {}), await proxy.call('/status', {}));
    for (const response of outputs) {
      const bytes = response.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(response.body) : response.body;
      assert.equal(bytes.toString().includes(KEY), false);
    }
    assert.equal(warnings.lines.some((line) => line.includes(KEY)), false);
  } finally {
    warnings.restore();
  }
});
