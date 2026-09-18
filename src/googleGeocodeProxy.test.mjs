// Server-side /api/google/geocode proxy contract (moves Geocoding off the
// browser, which cannot carry a referrer-restricted key for a web-service
// REST API). Mirrors the harness in googlePlacesKeyless.test.mjs.
//
// Run with: npm test   (node --test)
import assert from 'node:assert/strict';
import test from 'node:test';
import { googlePlacesContextProxy } from '../vite.config.js';

function installGoogleGeocodeRoute() {
  const routes = new Map();
  googlePlacesContextProxy().configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes.get('/api/google/geocode');
}

function invokeRoute(handler, { method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

test('missing server key returns a configured-but-empty response, never REQUEST_DENIED from Google', () => withEnv(
  { GOOGLE_MAPS_SERVER_KEY: '', GOOGLE_MAPS_API_KEY: '' },
  async () => {
    const geocode = installGoogleGeocodeRoute();
    assert.equal(typeof geocode, 'function');
    const response = await invokeRoute(geocode, { url: '/?address=austin' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body, {
      status: 'REQUEST_DENIED',
      results: [],
      error_message: 'Geocoding is not configured on this server.',
    });
  },
));

test('forward geocode proxy: passes address/bounds through to Google and returns the upstream shape', () => withEnv(
  { GOOGLE_MAPS_SERVER_KEY: 'server-secret-key', GEV_RATELIMIT_GOOGLE_PER_MIN: '' },
  async () => {
    const previousFetch = globalThis.fetch;
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return {
        text: async () => JSON.stringify({
          status: 'OK',
          results: [{
            formatted_address: 'Austin, TX, USA',
            geometry: { location: { lat: 30.2672, lng: -97.7431 } },
          }],
        }),
      };
    };
    try {
      const geocode = installGoogleGeocodeRoute();
      const response = await invokeRoute(geocode, {
        url: '/?address=austin&bounds=29,-98%7C31,-96',
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        status: 'OK',
        results: [{
          formatted_address: 'Austin, TX, USA',
          geometry: { location: { lat: 30.2672, lng: -97.7431 } },
        }],
      });
      assert.ok(capturedUrl.startsWith('https://maps.googleapis.com/maps/api/geocode/json?'), capturedUrl);
      const upstream = new URL(capturedUrl);
      assert.equal(upstream.searchParams.get('address'), 'austin');
      assert.equal(upstream.searchParams.get('bounds'), '29,-98|31,-96');
      assert.equal(upstream.searchParams.get('key'), 'server-secret-key');
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
));

test('reverse geocode proxy: forwards latlng and returns the upstream shape', () => withEnv(
  { GOOGLE_MAPS_SERVER_KEY: 'server-secret-key', GEV_RATELIMIT_GOOGLE_PER_MIN: '' },
  async () => {
    const previousFetch = globalThis.fetch;
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return {
        text: async () => JSON.stringify({
          status: 'OK',
          results: [{ formatted_address: '30 Something St, Austin, TX', address_components: [] }],
        }),
      };
    };
    try {
      const geocode = installGoogleGeocodeRoute();
      const response = await invokeRoute(geocode, { url: '/?latlng=30.2672,-97.7431' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, 'OK');
      assert.equal(response.body.results.length, 1);
      const upstream = new URL(capturedUrl);
      assert.equal(upstream.searchParams.get('latlng'), '30.2672,-97.7431');
      assert.equal(upstream.searchParams.get('key'), 'server-secret-key');
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
));

test('invalid/bounded inputs: missing address+latlng, out-of-range latlng, and malformed bounds are rejected or dropped', () => withEnv(
  { GOOGLE_MAPS_SERVER_KEY: 'server-secret-key', GEV_RATELIMIT_GOOGLE_PER_MIN: '' },
  async () => {
    const geocode = installGoogleGeocodeRoute();

    const missing = await invokeRoute(geocode, { url: '/' });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.status, 'INVALID_REQUEST');

    const outOfRange = await invokeRoute(geocode, { url: '/?latlng=999,999' });
    assert.equal(outOfRange.statusCode, 400);
    assert.equal(outOfRange.body.status, 'INVALID_REQUEST');

    const malformedLatLng = await invokeRoute(geocode, { url: '/?latlng=not-a-number' });
    assert.equal(malformedLatLng.statusCode, 400);

    const blankAddress = await invokeRoute(geocode, { url: '/?address=%20%20' });
    assert.equal(blankAddress.statusCode, 400);

    // A malformed bounds string is silently dropped (not forwarded, not fatal) —
    // the request still succeeds as a bare address geocode.
    const previousFetch = globalThis.fetch;
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return { text: async () => JSON.stringify({ status: 'OK', results: [] }) };
    };
    try {
      const droppedBounds = await invokeRoute(geocode, { url: '/?address=austin&bounds=garbage' });
      assert.equal(droppedBounds.statusCode, 200);
      const upstream = new URL(capturedUrl);
      assert.equal(upstream.searchParams.has('bounds'), false, 'malformed bounds must never reach Google');
    } finally {
      globalThis.fetch = previousFetch;
    }

    // A non-GET method is rejected outright.
    const wrongMethod = await invokeRoute(geocode, { method: 'POST', url: '/?address=austin' });
    assert.equal(wrongMethod.statusCode, 405);
  },
));

test('the server key never appears in any error response body', () => withEnv(
  { GOOGLE_MAPS_SERVER_KEY: 'server-secret-key', GEV_RATELIMIT_GOOGLE_PER_MIN: '' },
  async () => {
    const geocode = installGoogleGeocodeRoute();

    // Upstream returns garbage (invalid JSON) — proxy must fail closed without
    // leaking the key it just sent upstream.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ text: async () => 'not json' });
    try {
      const badUpstream = await invokeRoute(geocode, { url: '/?address=austin' });
      assert.equal(badUpstream.statusCode, 502);
      assert.equal(JSON.stringify(badUpstream.body).includes('server-secret-key'), false);
    } finally {
      globalThis.fetch = previousFetch;
    }

    // fetch itself throws (network failure) — same fail-closed contract.
    globalThis.fetch = async () => { throw new Error('boom server-secret-key leaked?'); };
    try {
      const thrown = await invokeRoute(geocode, { url: '/?address=austin' });
      assert.equal(thrown.statusCode, 502);
      assert.equal(JSON.stringify(thrown.body).includes('server-secret-key'), false);
    } finally {
      globalThis.fetch = previousFetch;
    }

    // Validation errors never echo the key either.
    const invalid = await invokeRoute(geocode, { url: '/?latlng=999,999' });
    assert.equal(JSON.stringify(invalid.body).includes('server-secret-key'), false);
  },
));
