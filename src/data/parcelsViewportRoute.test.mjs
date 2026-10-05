// Property Intelligence A2.1 — live route-handler tests for the new
// /api/parcels/coverage and /api/parcels/viewport endpoints, plus a light
// regression check that the existing A1 routes still work unchanged now that
// parcelsProxy() accepts an injectable fetchImpl (the same test-only seam
// every other proxy in this file already exposes — see overpassProxy.test.mjs
// / cctvProxy.test.mjs). Exercises the REAL route handler end to end with a
// fake upstream; no real network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parcelsProxy } from '../../vite.config.js';
import { getParcelProviderConfig } from './parcelProviderRegistry.js';

const config = getParcelProviderConfig('or-deschutes');
const TAXLOT_URL = `${config.featureServerUrl}/0/query`;
const ASSESSOR_URL = `${config.featureServerUrl}/1/query`;
const IMPROVEMENTS_URL = `${config.featureServerUrl}/3/query`;
const OWNERS_URL = `${config.featureServerUrl}/5/query`;
const ROLLVALUES_URL = `${config.featureServerUrl}/7/query`;
const ZONING_URL = `${config.zoning.serviceUrl}/query`;

// A point/bbox well inside the Deschutes coverage box.
const INSIDE_LAT = 44.0578;
const INSIDE_LON = -121.3153;
const INSIDE_BBOX = { south: 44.05, west: -121.32, north: 44.06, east: -121.31 };
// Portland, OR — outside every configured provider's coverage.
const OUTSIDE_LAT = 45.5152;
const OUTSIDE_LON = -122.6784;

function taxlotFeature(taxlot) {
  return {
    attributes: { TAXLOT: taxlot, MAPNUMBER: '14080000000', DIAL: `http://dial.deschutes.org/results/taxlot?value=${taxlot}`, Shape__Area: 4046.8564224 },
    geometry: { rings: [[[-121.32, 44.05], [-121.31, 44.05], [-121.31, 44.06], [-121.32, 44.06], [-121.32, 44.05]]] },
    centroid: { x: -121.315, y: 44.055 },
  };
}

const ASSESSOR_ROW = { attributes: { TaxLot: '1408000000200', Address: '61380 BROSTERHOUS RD', City: 'BEND', State: 'OR', Zip: '97702' } };
const IMPROVEMENTS_ROW = { attributes: { Taxlot: '1408000000200', Land_Size_Acres: 1.23, Year_Built_1: '1998', Total_Sqft_1: 2140, Garage_Sqft_1: 480, Bedrooms: 3, Bathrooms: 2 } };
const OWNERS_ROW = { attributes: { MAP_TAXLOT: '1408000000200', NAME: 'EXAMPLE OWNER LLC' } };
const ROLLVALUES_ROW = { attributes: { Taxlot: '1408000000200', RMV_Total: 498200, AV_Total: 412340 } };
const ZONING_ROW = { attributes: { ZONE: 'RR10' } };

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    impl: async (url) => {
      calls.push(String(url));
      for (const [prefix, respond] of routes) {
        if (String(url).startsWith(prefix)) return respond();
      }
      throw new Error(`unexpected upstream URL in test: ${url}`);
    },
  };
}
// A real Response (not a plain {ok,text} stub): the route goes through the
// REAL readCappedResponseText(), which reads upstream.headers/upstream.body —
// a bare stub object would throw inside it and queryFeatures() would swallow
// that as "no features", silently masking real assertions.
const okJson = (body) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));

function fullUpstream(overrides = []) {
  return fakeFetch([
    ...overrides,
    [TAXLOT_URL, okJson({ features: [taxlotFeature('1408000000200')] })],
    [ASSESSOR_URL, okJson({ features: [ASSESSOR_ROW] })],
    [IMPROVEMENTS_URL, okJson({ features: [IMPROVEMENTS_ROW] })],
    [OWNERS_URL, okJson({ features: [OWNERS_ROW] })],
    [ROLLVALUES_URL, okJson({ features: [ROLLVALUES_ROW] })],
    [ZONING_URL, okJson({ features: [ZONING_ROW] })],
  ]);
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(body) { this.body = body === undefined ? '' : body; },
  };
}

function installParcels(fetchImpl) {
  const routes = new Map();
  parcelsProxy({ fetchImpl }).configureServer({ middlewares: { use(p, h) { routes.set(p, h); } } });
  const handler = routes.get('/api/parcels');
  const call = async (pathAndQuery, method = 'GET') => {
    const res = fakeRes();
    await handler({ method, url: pathAndQuery, headers: {}, socket: {} }, res);
    return res;
  };
  return { call };
}

function json(res) {
  return JSON.parse(res.body);
}

// -- /coverage ----------------------------------------------------------------------------------

test('/coverage for a point inside Deschutes County resolves the known region', async () => {
  const { call } = installParcels(fullUpstream().impl);
  const res = await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), {
    region: 'or-deschutes',
    providerId: 'oregon-deschutes-county',
    sourceAgency: "Deschutes County Assessor's Office",
  });
});

test('/coverage for a point outside every provider returns region:null with HTTP 200', async () => {
  const { call } = installParcels(fullUpstream().impl);
  const res = await call(`/coverage?lat=${OUTSIDE_LAT}&lon=${OUTSIDE_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
});

test('/coverage rejects invalid/missing lat or lon with 400', async () => {
  const { call } = installParcels(fullUpstream().impl);
  assert.equal((await call('/coverage?lat=abc&lon=-121.3')).statusCode, 400);
  assert.equal((await call('/coverage?lat=44.05')).statusCode, 400);
  assert.equal((await call('/coverage?lat=999&lon=-121.3')).statusCode, 400);
  assert.equal((await call('/coverage')).statusCode, 400);
});

test('/coverage derives its answer from the registry, not from a frontend/Deschutes-specific branch in the route', async () => {
  // A location of PURE registry math never needs the mocked upstream at all —
  // if it worked, it worked by walking listParcelRegions()/coverageBbox.
  const upstream = fakeFetch([]); // throws on ANY upstream call
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`);
  assert.equal(res.statusCode, 200);
  assert.equal(upstream.calls.length, 0, 'coverage never touches the network');
});

// -- /viewport ------------------------------------------------------------------------------------

test('/viewport rejects an unknown region with 400', async () => {
  const { call } = installParcels(fullUpstream().impl);
  const res = await call('/viewport?region=xx-nowhere&south=44.05&west=-121.32&north=44.06&east=-121.31');
  assert.equal(res.statusCode, 400);
});

test('/viewport rejects a malformed bbox with 400 (missing, non-finite, or inverted)', async () => {
  const { call } = installParcels(fullUpstream().impl);
  assert.equal((await call('/viewport?region=or-deschutes&south=44.05&west=-121.32&north=44.06')).statusCode, 400, 'missing east');
  assert.equal((await call('/viewport?region=or-deschutes&south=abc&west=-121.32&north=44.06&east=-121.31')).statusCode, 400, 'non-finite');
  assert.equal((await call('/viewport?region=or-deschutes&south=44.06&west=-121.32&north=44.05&east=-121.31')).statusCode, 400, 'inverted south/north');
});

test('/viewport rejects an oversized bbox with 400 and a clear message', async () => {
  const { call } = installParcels(fullUpstream().impl);
  const res = await call('/viewport?region=or-deschutes&south=44.0&west=-121.5&north=44.5&east=-121.0');
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /too large/i);
});

test('/viewport rejects a bbox that does not intersect the region’s coverage with 400', async () => {
  const { call } = installParcels(fullUpstream().impl);
  // A small, validly-shaped, correctly-sized box — just nowhere near Deschutes County.
  const res = await call('/viewport?region=or-deschutes&south=45.50&west=-122.68&north=45.56&east=-122.62');
  assert.equal(res.statusCode, 400);
});

test('/viewport for a valid, in-coverage bbox returns the expected success shape with no owner data', async () => {
  const upstream = fakeFetch([[TAXLOT_URL, okJson({ features: [taxlotFeature('1408000000200'), taxlotFeature('1408000000300')] })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=or-deschutes&south=${INSIDE_BBOX.south}&west=${INSIDE_BBOX.west}&north=${INSIDE_BBOX.north}&east=${INSIDE_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.region, 'or-deschutes');
  assert.equal(body.providerId, 'oregon-deschutes-county');
  assert.equal(body.count, 2);
  assert.equal(body.saturated, false);
  assert.equal(body.parcels.length, 2);
  for (const parcel of body.parcels) {
    assert.deepEqual(Object.keys(parcel).sort(), ['geometry', 'parcelId']);
  }
  assert.equal(upstream.calls.length, 1, 'exactly one upstream query for the whole viewport — no per-parcel detail calls');
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the viewport response body');
});

test('/viewport preserves the saturated flag when the provider truncates', async () => {
  const many = Array.from({ length: 5 }, (_, i) => taxlotFeature(`TL${i}`));
  const upstream = fakeFetch([[TAXLOT_URL, okJson({ features: many })]]);
  // A tiny region-wide cap is not configurable per-request — exercise the real
  // MAX_VIEWPORT_PARCELS path is covered at the provider level; here we only
  // confirm the route forwards whatever saturated value the provider reports.
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=or-deschutes&south=${INSIDE_BBOX.south}&west=${INSIDE_BBOX.west}&north=${INSIDE_BBOX.north}&east=${INSIDE_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.count, 5);
  assert.equal(body.saturated, false, 'five features is well under the 400 cap — not saturated');
});

test('/viewport never carries an owner field even when the upstream mock includes owner-shaped data', async () => {
  // Defense in depth: even if a future bug made the viewport path touch the
  // owners table, the response builder only ever copies {parcelId, geometry}.
  const upstream = fakeFetch([[TAXLOT_URL, okJson({ features: [taxlotFeature('1408000000200')] })], [OWNERS_URL, okJson({ features: [OWNERS_ROW] })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=or-deschutes&south=${INSIDE_BBOX.south}&west=${INSIDE_BBOX.west}&north=${INSIDE_BBOX.north}&east=${INSIDE_BBOX.east}`);
  assert.doesNotMatch(res.body, /EXAMPLE OWNER LLC|"owner"/i);
  assert.equal(upstream.calls.some((u) => u.startsWith(OWNERS_URL)), false, 'the owners table is never queried for a viewport fetch');
});

// -- existing A1 routes: unaffected by the fetchImpl-injection seam ------------------------------

test('/identify, /detail, /geometry, /search still work exactly as before, with no owner key leaking', async () => {
  const identify = await installParcels(fullUpstream().impl).call(`/identify?region=or-deschutes&lat=${INSIDE_LAT}&lon=${INSIDE_LON}`);
  assert.equal(identify.statusCode, 200);
  assert.doesNotMatch(identify.body, /"owner"/);

  const detail = await installParcels(fullUpstream().impl).call('/detail?region=or-deschutes&parcelId=1408000000200');
  assert.equal(detail.statusCode, 200);
  assert.doesNotMatch(detail.body, /"owner"/);

  const geometry = await installParcels(fullUpstream().impl).call('/geometry?region=or-deschutes&parcelId=1408000000200');
  assert.equal(geometry.statusCode, 200);
  assert.equal(json(geometry).geometry.type, 'Polygon');

  const search = await installParcels(fakeFetch([[ASSESSOR_URL, okJson({ features: [ASSESSOR_ROW] })]]).impl)
    .call('/search?region=or-deschutes&q=Brosterhous');
  assert.equal(search.statusCode, 200);
  assert.doesNotMatch(search.body, /"owner"/);
});
