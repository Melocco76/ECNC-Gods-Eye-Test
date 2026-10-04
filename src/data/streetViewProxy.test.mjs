import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDeg,
  cctvProxy,
  haversineDistanceM,
  streetViewFallback,
  streetViewMetadataLookup,
  streetViewProxy,
} from '../../vite.config.js';

const SV_KEY = 'FAKE-SV-KEY-do-not-leak';
const SV_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9]);
const REQUESTED = { lat: 30.2672, lon: -97.7431 };
const PANO_POINT = { lat: 30.2680, lon: -97.7429 }; // ~90m from REQUESTED
const PANO_ID = 'PANO_TEST_123';

function metadataJson({ status = 'OK', lat = PANO_POINT.lat, lng = PANO_POINT.lon, panoId = PANO_ID } = {}) {
  const body = status === 'OK' ? { status, location: { lat, lng }, pano_id: panoId } : { status };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function installStreetView({
  metadata = 'ok', image = 'ok', metadataPoint = null,
} = {}) {
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/streetview/metadata')) {
      if (metadata === 'zero') return metadataJson({ status: 'ZERO_RESULTS' });
      if (metadata === 'throws') throw new Error(`metadata socket hang up ${href}`);
      if (metadata === 'error') return new Response('error', { status: 500 });
      return metadataPoint ? metadataJson(metadataPoint) : metadataJson();
    }
    if (image === 'fails') return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    if (image === 'throws') throw new Error(`socket hang up ${href}`);
    return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
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

// ── streetViewFallback (shared helper) ──────────────────────────────────────

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
  assert.equal(observedUrl.searchParams.has('radius'), false, 'no radius means CCTV keeps Google\'s own default search radius');
  assert.equal(observedUrl.searchParams.has('pano'), false);
});

test('streetViewFallback omits radius when not given and includes it when given', async () => {
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

  assert.equal((await capture({})).searchParams.has('radius'), false, 'radius omitted by default');
  assert.equal((await capture({ radius: 150 })).searchParams.get('radius'), '150');
});

test('streetViewFallback addresses an exact pano_id instead of location+radius when given', async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  let observedUrl = null;
  await streetViewFallback(
    {
      lat: 1, lon: 2, radius: 150, pano: PANO_ID, heading: 270,
    },
    {
      fetchImpl: async (url) => {
        observedUrl = new URL(String(url));
        return new Response(SV_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      },
    },
  );
  assert.equal(observedUrl.searchParams.get('pano'), PANO_ID);
  assert.equal(observedUrl.searchParams.has('location'), false, 'pano supersedes location, never both');
  assert.equal(observedUrl.searchParams.has('radius'), false, 'radius is meaningless once an exact pano is addressed');
  assert.equal(observedUrl.searchParams.get('heading'), '270');
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

// ── streetViewMetadataLookup ─────────────────────────────────────────────────

test('streetViewMetadataLookup queries the metadata endpoint with location/radius/source', async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  let observedUrl = null;
  const result = await streetViewMetadataLookup(
    { lat: REQUESTED.lat, lon: REQUESTED.lon, radius: 150 },
    {
      fetchImpl: async (url) => {
        observedUrl = new URL(String(url));
        return metadataJson();
      },
    },
  );
  assert.equal(observedUrl.origin + observedUrl.pathname, 'https://maps.googleapis.com/maps/api/streetview/metadata');
  assert.equal(observedUrl.searchParams.get('location'), `${REQUESTED.lat},${REQUESTED.lon}`);
  assert.equal(observedUrl.searchParams.get('radius'), '150');
  assert.equal(observedUrl.searchParams.get('source'), 'outdoor');
  assert.equal(observedUrl.searchParams.get('key'), SV_KEY);
  assert.deepEqual(result, { panoId: PANO_ID, lat: PANO_POINT.lat, lon: PANO_POINT.lon });
});

test('streetViewMetadataLookup returns null on ZERO_RESULTS, a request failure, or no key', async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
  const zero = await streetViewMetadataLookup(
    { lat: 1, lon: 2 },
    { fetchImpl: async () => metadataJson({ status: 'ZERO_RESULTS' }) },
  );
  assert.equal(zero, null);

  const thrown = await streetViewMetadataLookup(
    { lat: 1, lon: 2 },
    { fetchImpl: async () => { throw new Error('socket hang up'); } },
  );
  assert.equal(thrown, null);

  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  const noKey = await streetViewMetadataLookup({ lat: 1, lon: 2 }, { fetchImpl: async () => metadataJson() });
  assert.equal(noKey, null);
  process.env.GOOGLE_MAPS_SERVER_KEY = SV_KEY;
});

// ── geo math: bearingDeg / haversineDistanceM ───────────────────────────────

test('bearingDeg points due north/east/south/west correctly', () => {
  assert.equal(Math.round(bearingDeg(0, 0, 1, 0)), 0, 'due north');
  assert.equal(Math.round(bearingDeg(0, 0, 0, 1)), 90, 'due east');
  assert.equal(Math.round(bearingDeg(0, 0, -1, 0)), 180, 'due south');
  assert.equal(Math.round(bearingDeg(0, 0, 0, -1)), 270, 'due west');
});

test('bearingDeg handles an oblique direction and is FROM point1 TO point2, not reversed', () => {
  // Point 2 is north-east of point 1: bearing should land in the first quadrant (0-90).
  const forward = bearingDeg(30.0, -97.0, 30.01, -96.99);
  assert.ok(forward > 0 && forward < 90, `expected a north-east bearing, got ${forward}`);
  // Reversing the arguments must NOT give the same bearing (it is the return bearing instead).
  const reverse = bearingDeg(30.01, -96.99, 30.0, -97.0);
  assert.notEqual(Math.round(forward), Math.round(reverse));
  assert.ok(reverse > 180 && reverse < 270, `expected the reverse to point south-west, got ${reverse}`);
});

test('haversineDistanceM is zero at the same point and matches a known approximate value', () => {
  assert.equal(haversineDistanceM(30, -97, 30, -97), 0);
  // ~0.001 degrees latitude is ~111 m.
  const d = haversineDistanceM(30, -97, 30.001, -97);
  assert.ok(d > 100 && d < 120, `expected ~111m, got ${d}`);
});

test('haversineDistanceM 75m/150m tier boundaries are computed consistently', () => {
  const near = haversineDistanceM(REQUESTED.lat, REQUESTED.lon, REQUESTED.lat + 0.0005, REQUESTED.lon);
  const far = haversineDistanceM(REQUESTED.lat, REQUESTED.lon, REQUESTED.lat + 0.0012, REQUESTED.lon);
  assert.ok(near < 75, `expected under 75m, got ${near}`);
  assert.ok(far > 75 && far < 150, `expected between 75 and 150m, got ${far}`);
});

// ── GET /api/streetview — open (no pano): metadata + bearing + pano request ─

test('first open resolves via metadata, requests the exact pano, and computes heading toward the target', async () => {
  const sv = installStreetView();
  const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-street-view-source'], 'static');
  assert.equal(res.headers['x-street-view-pano-id'], PANO_ID);
  assert.ok(res.headers['x-street-view-heading'], 'heading header present');
  assert.ok(res.headers['x-street-view-snap-distance-m'], 'snap distance header present');

  const metaCall = sv.calls.find((c) => c.includes('/streetview/metadata'));
  assert.ok(metaCall, 'metadata was looked up');
  const metaUrl = new URL(metaCall);
  assert.equal(metaUrl.searchParams.get('location'), `${REQUESTED.lat},${REQUESTED.lon}`);
  assert.equal(metaUrl.searchParams.get('radius'), '150');
  assert.equal(metaUrl.searchParams.get('source'), 'outdoor');

  const imageCall = sv.calls.find((c) => !c.includes('/metadata'));
  const imageUrl = new URL(imageCall);
  assert.equal(imageUrl.searchParams.get('pano'), PANO_ID, 'final image request addresses the exact resolved pano');
  assert.equal(imageUrl.searchParams.has('location'), false, 'no independent re-snap via location+radius');
  assert.equal(imageUrl.searchParams.has('radius'), false);

  // The header reports a rounded, concise value; the actual upstream request
  // carries the precise computed bearing so the image itself is not degraded.
  const computedHeading = bearingDeg(PANO_POINT.lat, PANO_POINT.lon, REQUESTED.lat, REQUESTED.lon);
  assert.equal(res.headers['x-street-view-heading'], String(Math.round(computedHeading)));
  assert.equal(imageUrl.searchParams.get('heading'), String(computedHeading));

  const expectedSnap = Math.round(haversineDistanceM(REQUESTED.lat, REQUESTED.lon, PANO_POINT.lat, PANO_POINT.lon));
  assert.equal(res.headers['x-street-view-snap-distance-m'], String(expectedSnap));
});

test('an explicit heading on the open request overrides the computed bearing', async () => {
  const sv = installStreetView();
  const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}&heading=12`);
  assert.equal(res.headers['x-street-view-heading'], '12');
  const imageUrl = new URL(sv.calls.find((c) => !c.includes('/metadata')));
  assert.equal(imageUrl.searchParams.get('heading'), '12');
});

// ── GET /api/streetview — pano given: LEFT/RIGHT look-around, no re-snap ────

test('a request with an explicit pano skips metadata and addresses that exact panorama', async () => {
  const sv = installStreetView();
  const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}&heading=270&pano=${PANO_ID}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-street-view-heading'], '270');
  assert.equal(res.headers['x-street-view-pano-id'], PANO_ID);
  assert.equal(res.headers['x-street-view-snap-distance-m'], undefined, 'snap distance is not recomputed on a pano-based follow-up');
  assert.equal(sv.calls.some((c) => c.includes('/metadata')), false, 'no metadata re-lookup for an already-resolved panorama');
  assert.equal(sv.calls.length, 1, 'exactly one upstream request: the image itself');
  const imageUrl = new URL(sv.calls[0]);
  assert.equal(imageUrl.searchParams.get('pano'), PANO_ID);
  assert.equal(imageUrl.searchParams.get('heading'), '270');
  assert.equal(imageUrl.searchParams.has('location'), false);
});

// ── Validation / errors ──────────────────────────────────────────────────────

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

test('no panorama found by metadata (ZERO_RESULTS) returns 404 JSON', async () => {
  const sv = installStreetView({ metadata: 'zero' });
  const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body.toString()), { error: 'Street View unavailable here' });
});

test('a metadata request failure or throw is treated as unavailable, not a 502', async () => {
  for (const metadata of ['throws', 'error']) {
    const sv = installStreetView({ metadata });
    const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}`);
    assert.equal(res.statusCode, 404, `metadata=${metadata}`);
  }
});

test('metadata succeeds but the resolved pano image itself fails returns 404 JSON', async () => {
  for (const image of ['fails', 'throws']) {
    const sv = installStreetView({ image });
    const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}`);
    assert.equal(res.statusCode, 404, `image=${image}`);
    assert.deepEqual(JSON.parse(res.body.toString()), { error: 'Street View unavailable here' });
  }
});

test('a panorama defensively farther than the search radius is treated as unavailable', async () => {
  // Metadata technically returned a hit, but its location is implausibly far
  // from the request (~1.1km) — the route must not trust radius=150 blindly.
  const sv = installStreetView({ metadataPoint: { lat: REQUESTED.lat + 0.01, lng: REQUESTED.lon } });
  const res = await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}`);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body.toString()), { error: 'Street View unavailable here' });
});

test('the server key never appears in any /api/streetview response or error body', async () => {
  for (const metadata of ['ok', 'zero', 'throws']) {
    const sv = installStreetView({ metadata });
    const outputs = [
      await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}`),
      await sv.call('/api/streetview?lat=999&lon=2'),
      await sv.call('/api/streetview', { method: 'POST' }),
      await sv.call(`/api/streetview?lat=${REQUESTED.lat}&lon=${REQUESTED.lon}&heading=90&pano=${PANO_ID}`),
    ];
    for (const res of outputs) {
      const text = res.headers['content-type'] === 'image/jpeg' ? '' : res.body.toString();
      assert.equal(text.includes(SV_KEY), false);
      assert.equal(Object.values(res.headers).some((v) => v.includes(SV_KEY)), false);
    }
  }
});

// ── CCTV invariant: no metadata, no pano, no radius, unchanged behavior ─────

test('CCTV Street View fallback and /api/streetview share the same hoisted implementation, with deliberately different inputs', async () => {
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
  assert.equal(streetViewCalls.length, 1, 'CCTV made exactly one Street View request — no metadata lookup');
  assert.equal(streetViewCalls[0].includes('/metadata'), false, 'CCTV never calls the metadata endpoint');

  const sv = installStreetView();
  const directRes = await sv.call(`/api/streetview?lat=30.2672&lon=-97.7431`);
  assert.equal(directRes.body.equals(SV_JPEG), true);
  assert.ok(sv.calls.some((c) => c.includes('/metadata')), 'the user-facing route DOES call metadata');

  const cctvRequestUrl = new URL(streetViewCalls[0]);
  const directImageUrl = new URL(sv.calls.find((c) => !c.includes('/metadata')));
  assert.equal(cctvRequestUrl.pathname, directImageUrl.pathname, 'identical Street View Static endpoint path');
  for (const param of ['size', 'source', 'return_error_code']) {
    assert.equal(cctvRequestUrl.searchParams.get(param), directImageUrl.searchParams.get(param), `same ${param} value from the shared helper`);
  }
  // The two call sites deliberately differ: CCTV addresses by location (no
  // radius, no pano, Google's own default search), while the user-facing
  // route always resolves and addresses an exact pano_id. Both still go
  // through the same streetViewFallback() implementation.
  assert.equal(cctvRequestUrl.searchParams.has('radius'), false, 'CCTV keeps no radius param');
  assert.equal(cctvRequestUrl.searchParams.has('pano'), false, 'CCTV never uses pano-based addressing');
  assert.equal(cctvRequestUrl.searchParams.get('location'), '30.2672,-97.7431', 'CCTV still addresses by location');
  assert.equal(directImageUrl.searchParams.get('pano'), PANO_ID, 'the user-facing route addresses by the resolved pano_id');
  assert.equal(directImageUrl.searchParams.has('location'), false);
});
