import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  cctvProxy,
  fetchCctvImageFromUpstream,
  isKnownCctvPlaceholder,
} from '../../vite.config.js';

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

// ── Offline-placeholder detection and fallback ───────────────────────────────
const PLACEHOLDER = fs.readFileSync(new URL('./fixtures/austin-cctv-placeholder.jpg', import.meta.url));
const SV_KEY = 'FAKE-SV-KEY-do-not-leak';
const UPSTREAM_HOST = 'cctv.example.invalid';
const LIVE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7), Buffer.from([0xff, 0xd9])]);
const SV_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9]);
// Same byte length as the real placeholder but different content: length alone must never identify it.
const LOOKALIKE = Buffer.alloc(PLACEHOLDER.length, 9);

const CAMERAS = [
  { id: 'aus-offline', name: 'OFFLINE CAM', city: 'Austin', provider: 'Austin Transportation & Public Works', lat: 30.2672, lon: -97.7431, feedType: 'image', sourceKind: 'austin-open-data', url: `https://${UPSTREAM_HOST}/aus-offline.jpg` },
  { id: 'aus-live', name: 'LIVE CAM', city: 'Austin', provider: 'Austin Transportation & Public Works', lat: 30.27, lon: -97.74, feedType: 'image', sourceKind: 'austin-open-data', url: `https://${UPSTREAM_HOST}/aus-live.jpg` },
  { id: 'aus-lookalike', name: 'LOOKALIKE CAM', city: 'Austin', provider: 'Austin Transportation & Public Works', lat: 30.28, lon: -97.75, feedType: 'image', sourceKind: 'austin-open-data', url: `https://${UPSTREAM_HOST}/aus-lookalike.jpg` },
  { id: 'ca-1', name: 'CA CAM', city: 'San Diego', provider: 'Caltrans', lat: 32.7, lon: -117.1, feedType: 'image', sourceKind: 'caltrans-open-data', url: `https://${UPSTREAM_HOST}/ca-1.jpg` },
  { id: 'tfl-1', name: 'TFL CAM', city: 'London', provider: 'Transport for London', lat: 51.5, lon: -0.12, feedType: 'image', sourceKind: 'tfl-open-data', url: `https://${UPSTREAM_HOST}/tfl-1.jpg` },
];

function installCctv({ streetView = 'ok' } = {}) {
  process.env.CCTV_SOURCES_JSON = JSON.stringify(CAMERAS);
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  const calls = [];
  const bodies = {
    'aus-offline.jpg': PLACEHOLDER,
    'aus-live.jpg': LIVE_JPEG,
    'aus-lookalike.jpg': LOOKALIKE,
    'ca-1.jpg': LOOKALIKE, // a Caltrans frame that happens to share the placeholder's size
    'tfl-1.jpg': LIVE_JPEG,
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('maps.googleapis.com/maps/api/streetview')) {
      if (streetView === 'ok') return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      if (streetView === 'throws') throw new Error(`socket hang up ${href}`);
      return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    const name = href.split('/').at(-1);
    return new Response(bodies[name], { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };
  const routes = new Map();
  cctvProxy({ fetchImpl }).configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
  const handler = routes.get('/api/cctv');
  const call = async (url) => {
    const res = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
    res.writeHead = (status, headers = {}) => {
      res.statusCode = status;
      res.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    };
    res.end = (body) => { res.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); };
    await handler({ url, headers: {} }, res);
    return res;
  };
  const healthOf = async (id) => JSON.parse((await call('/health')).body).cameras.find((c) => c.id === id);
  return { call, calls, healthOf };
}

test('the known Austin placeholder is identified by content hash, not by size or camera', () => {
  assert.equal(PLACEHOLDER.length, 12805);
  assert.equal(isKnownCctvPlaceholder(PLACEHOLDER), true);
  assert.equal(isKnownCctvPlaceholder(Uint8Array.from(PLACEHOLDER)), true);
  assert.equal(isKnownCctvPlaceholder(LOOKALIKE), false, 'same length, different bytes');
  assert.equal(isKnownCctvPlaceholder(LIVE_JPEG), false);
  assert.equal(isKnownCctvPlaceholder(Buffer.alloc(0)), false);
  assert.equal(isKnownCctvPlaceholder(null), false);
  const flipped = Buffer.from(PLACEHOLDER);
  flipped[flipped.length - 20] ^= 0xff;
  assert.equal(isKnownCctvPlaceholder(flipped), false, 'one changed byte is a different image');
});

test('upstream fetch reports the placeholder as a miss and passes normal images through untouched', async () => {
  const image = (body) => async () => new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  const offline = await fetchCctvImageFromUpstream('https://example.com/a.jpg', { fetchImpl: image(PLACEHOLDER) });
  assert.deepEqual(offline, { ok: false, placeholder: true });

  const normal = await fetchCctvImageFromUpstream('https://example.com/b.jpg', { fetchImpl: image(LIVE_JPEG) });
  assert.equal(normal.ok, true);
  assert.equal(normal.body.equals(LIVE_JPEG), true);
  assert.equal(normal.contentType, 'image/jpeg');

  const sameSize = await fetchCctvImageFromUpstream('https://example.com/c.jpg', { fetchImpl: image(LOOKALIKE) });
  assert.equal(sameSize.ok, true, 'a same-size image that is not the placeholder is a real frame');
});

test('placeholder falls through to the Street View fallback and is reported degraded, not healthy', async () => {
  const cctv = installCctv({ streetView: 'ok' });
  const frame = await cctv.call('/frame/aus-offline');
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers['x-cctv-source'], 'streetview');
  assert.equal(frame.headers['content-type'], 'image/jpeg');
  assert.equal(frame.body.equals(SV_JPEG), true);
  assert.equal(frame.body.equals(PLACEHOLDER), false, 'the placeholder is never returned as a live frame');

  const health = await cctv.healthOf('aus-offline');
  assert.equal(health.status, 'degraded');
  assert.equal(health.sourceKind, 'streetview');
  assert.notEqual(health.message, 'Upstream snapshot active');
  assert.match(health.message, /offline.*placeholder/i);
});

test('placeholder falls through to the synthetic fallback when Street View also fails', async () => {
  for (const streetView of ['fails', 'throws']) {
    const cctv = installCctv({ streetView });
    const frame = await cctv.call('/frame/aus-offline');
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers['x-cctv-source'], 'synthetic');
    assert.equal(frame.headers['content-type'], 'image/svg+xml');
    assert.match(frame.body.toString(), /UPSTREAM CAMERA OFFLINE/);
    const health = await cctv.healthOf('aus-offline');
    assert.equal(health.status, 'degraded');
    assert.equal(health.sourceKind, 'synthetic');
    assert.match(health.message, /offline.*placeholder/i);
  }
  // No server key at all: Street View is skipped and the synthetic frame is served.
  const cctv = installCctv();
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  const noKey = await cctv.call('/frame/aus-offline');
  assert.equal(noKey.headers['x-cctv-source'], 'synthetic');
  assert.equal(cctv.calls.some((href) => href.includes('streetview')), false);
});

test('a normal Austin JPEG still passes through untouched and stays healthy', async () => {
  const cctv = installCctv();
  const frame = await cctv.call('/frame/aus-live');
  assert.equal(frame.headers['x-cctv-source'], 'upstream-image');
  assert.equal(frame.body.equals(LIVE_JPEG), true);
  assert.equal(cctv.calls.some((href) => href.includes('streetview')), false, 'no fallback for a healthy camera');
  const health = await cctv.healthOf('aus-live');
  assert.deepEqual([health.status, health.sourceKind, health.message], ['ok', 'snapshot', 'Upstream snapshot active']);

  const lookalike = await cctv.call('/frame/aus-lookalike');
  assert.equal(lookalike.headers['x-cctv-source'], 'upstream-image', 'size alone never triggers the fallback');
  assert.equal(lookalike.body.equals(LOOKALIKE), true);
});

test('Caltrans and TfL frames are unaffected', async () => {
  const cctv = installCctv();
  const california = await cctv.call('/frame/ca-1');
  const london = await cctv.call('/frame/tfl-1');
  assert.equal(california.headers['x-cctv-source'], 'upstream-image');
  assert.equal(california.body.equals(LOOKALIKE), true);
  assert.equal(london.headers['x-cctv-source'], 'upstream-image');
  assert.equal(london.body.equals(LIVE_JPEG), true);
  assert.equal((await cctv.healthOf('ca-1')).message, 'Upstream snapshot active');
  assert.equal((await cctv.healthOf('tfl-1')).message, 'Upstream snapshot active');
});

test('health distinguishes an offline placeholder camera from healthy ones in the same report', async () => {
  const cctv = installCctv();
  await cctv.call('/frame/aus-offline');
  await cctv.call('/frame/aus-live');
  const report = JSON.parse((await cctv.call('/health')).body).cameras;
  const byId = Object.fromEntries(report.map((c) => [c.id, c]));
  assert.equal(byId['aus-live'].status, 'ok');
  assert.equal(byId['aus-offline'].status, 'degraded');
});

test('neither the server key nor the upstream URL leaks into frames, health, or errors', async () => {
  for (const streetView of ['ok', 'fails', 'throws']) {
    const cctv = installCctv({ streetView });
    const outputs = [
      await cctv.call('/frame/aus-offline'),
      await cctv.call('/frame/aus-live'),
      await cctv.call('/health'),
      await cctv.call('/frame/does-not-exist'),
    ];
    for (const response of outputs) {
      const text = response.headers['content-type'] === 'image/jpeg' ? '' : response.body.toString();
      assert.equal(text.includes(SV_KEY), false, `key absent (${streetView})`);
      assert.equal(text.includes(UPSTREAM_HOST), false, `upstream URL absent (${streetView})`);
      assert.equal(Object.values(response.headers).some((value) => value.includes(SV_KEY) || value.includes(UPSTREAM_HOST)), false);
    }
  }
});
