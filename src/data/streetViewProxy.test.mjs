import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cctvProxy,
  streetViewFallback,
  streetViewProxy,
} from '../../vite.config.js';

const SV_KEY = 'FAKE-SV-KEY-do-not-leak';
const SV_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9]);

function installStreetView({ response = 'ok' } = {}) {
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (response === 'ok') return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    if (response === 'throws') throw new Error(`socket hang up ${href}`);
    return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
  const routes = new Map();
  streetViewProxy({ fetchImpl }).configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
  const handler = routes.get('/api/streetview');
  const call = async (url, { method = 'GET' } = {}) => {
    const res = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
    res.writeHead = (status, headers = {}) => {
      res.statusCode = status;
      res.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    };
    res.end = (body) => { res.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); };
    await handler({ url, method, headers: {} }, res);
    return res;
  };
  return { call, calls };
}

test('streetViewFallback builds the correct Google Street View Static request', async () => {
  let observedUrl = null;
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  const result = await streetViewFallback(
    { lat: 30.2672, lon: -97.7431, heading: 45, fov: 80, pitch: 0 },
    {
      fetchImpl: async (url) => {
        observedUrl = new URL(String(url));
        return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(observedUrl.origin + observedUrl.pathname, 'https://maps.googleapis.com/maps/api/streetview');
  assert.equal(observedUrl.searchParams.get('size'), '960x540');
  assert.equal(observedUrl.searchParams.get('location'), '30.2672,-97.7431');
  assert.equal(observedUrl.searchParams.get('heading'), '45');
  assert.equal(observedUrl.searchParams.get('fov'), '80');
  assert.equal(observedUrl.searchParams.get('pitch'), '0');
  assert.equal(observedUrl.searchParams.get('source'), 'outdoor');
  assert.equal(observedUrl.searchParams.get('return_error_code'), 'true');
  assert.equal(observedUrl.searchParams.get('key'), SV_KEY);
});

test('streetViewFallback defaults heading/fov/pitch and clamps fov and pitch', async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  const capture = async (overrides) => {
    let observedUrl = null;
    await streetViewFallback(
      { lat: 1, lon: 2, ...overrides },
      {
        fetchImpl: async (url) => {
          observedUrl = new URL(String(url));
          return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
        },
      },
    );
    return observedUrl;
  };

  const defaults = await capture({});
  assert.equal(defaults.searchParams.get('heading'), '0');
  assert.equal(defaults.searchParams.get('fov'), '80');
  assert.equal(defaults.searchParams.get('pitch'), '0');

  assert.equal((await capture({ fov: 5 })).searchParams.get('fov'), '20', 'fov floor is 20');
  assert.equal((await capture({ fov: 500 })).searchParams.get('fov'), '120', 'fov ceiling is 120');
  assert.equal((await capture({ pitch: -90 })).searchParams.get('pitch'), '-40', 'pitch floor is -40');
  assert.equal((await capture({ pitch: 90 })).searchParams.get('pitch'), '20', 'pitch ceiling is 20');
});

test('GET /api/streetview returns the image with the static-source header on success', async () => {
  const sv = installStreetView({ response: 'ok' });
  const res = await sv.call('/api/streetview?lat=30.2672&lon=-97.7431&heading=90');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-street-view-source'], 'static');
  assert.equal(res.body.equals(SV_JPEG), true);
  assert.ok(sv.calls[0].includes('heading=90'));
});

test('non-GET requests are rejected with 405', async () => {
  const sv = installStreetView();
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await sv.call('/api/streetview?lat=1&lon=2', { method });
    assert.equal(res.statusCode, 405);
  }
});

test('missing lat or lon returns 400', async () => {
  const sv = installStreetView();
  assert.equal((await sv.call('/api/streetview?lon=2')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview?lat=1')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview')).statusCode, 400);
});

test('invalid or out-of-range lat/lon returns 400', async () => {
  const sv = installStreetView();
  assert.equal((await sv.call('/api/streetview?lat=abc&lon=2')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview?lat=1&lon=xyz')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview?lat=91&lon=2')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview?lat=-91&lon=2')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview?lat=1&lon=181')).statusCode, 400);
  assert.equal((await sv.call('/api/streetview?lat=1&lon=-181')).statusCode, 400);
});

test('unavailable imagery returns 404 JSON', async () => {
  for (const response of ['fails', 'throws']) {
    const sv = installStreetView({ response });
    const res = await sv.call('/api/streetview?lat=1&lon=2');
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body.toString()), { error: 'Street View unavailable here' });
  }
});

test('the server key never appears in any /api/streetview response or error body', async () => {
  for (const response of ['ok', 'fails', 'throws']) {
    const sv = installStreetView({ response });
    const outputs = [
      await sv.call('/api/streetview?lat=1&lon=2'),
      await sv.call('/api/streetview?lat=999&lon=2'),
      await sv.call('/api/streetview', { method: 'POST' }),
    ];
    for (const res of outputs) {
      const text = res.headers['content-type'] === 'image/jpeg' ? '' : res.body.toString();
      assert.equal(text.includes(SV_KEY), false);
      assert.equal(Object.values(res.headers).some((v) => v.includes(SV_KEY)), false);
    }
  }
});

test('CCTV Street View fallback and /api/streetview share the same hoisted implementation', async () => {
  const CAMERAS = [
    { id: 'aus-offline', name: 'OFFLINE CAM', city: 'Austin', provider: 'Austin Transportation & Public Works', lat: 30.2672, lon: -97.7431, feedType: 'image', sourceKind: 'austin-open-data', url: 'https://cctv.example.invalid/aus-offline.jpg' },
  ];
  const fs = await import('node:fs');
  const PLACEHOLDER = fs.readFileSync(new URL('./fixtures/austin-cctv-placeholder.jpg', import.meta.url));
  process.env.CCTV_SOURCES_JSON = JSON.stringify(CAMERAS);
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;

  const streetViewCalls = [];
  const sharedFetch = async (url) => {
    const href = String(url);
    if (href.includes('maps.googleapis.com/maps/api/streetview')) {
      streetViewCalls.push(href);
      return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    }
    return new Response(PLACEHOLDER, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };

  const cctvRoutes = new Map();
  cctvProxy({ fetchImpl: sharedFetch }).configureServer({ middlewares: { use(p, h) { cctvRoutes.set(p, h); } } });
  const cctvHandler = cctvRoutes.get('/api/cctv');
  const callCctv = async (url) => {
    const res = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
    res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headers = headers; };
    res.end = (body) => { res.body = Buffer.from(body); };
    await cctvHandler({ url, headers: {} }, res);
    return res;
  };

  const cctvFrame = await callCctv('/frame/aus-offline');
  assert.equal(cctvFrame.body.equals(SV_JPEG), true, 'CCTV fallback used the Street View Static image');

  const sv = installStreetView({ response: 'ok' });
  const directRes = await sv.call(`/api/streetview?lat=30.2672&lon=-97.7431`);
  assert.equal(directRes.body.equals(SV_JPEG), true);

  assert.equal(streetViewCalls.length, 1, 'only the CCTV call hit the Street View upstream in this assertion');
  const cctvRequestUrl = new URL(streetViewCalls[0]);
  const directRequestUrl = new URL(sv.calls[0]);
  assert.equal(cctvRequestUrl.pathname, directRequestUrl.pathname, 'identical Street View Static endpoint path');
  for (const param of ['size', 'source', 'return_error_code']) {
    assert.equal(cctvRequestUrl.searchParams.get(param), directRequestUrl.searchParams.get(param), `same ${param} value from the shared helper`);
  }
});
