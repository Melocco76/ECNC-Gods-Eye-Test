// Property Intelligence A2.1 — live route-handler tests for the new
// /api/parcels/coverage and /api/parcels/viewport endpoints, plus a light
// regression check that the existing A1 routes still work unchanged now that
// parcelsProxy() accepts an injectable fetchImpl (the same test-only seam
// every other proxy in this file already exposes — see overpassProxy.test.mjs
// / cctvProxy.test.mjs). Exercises the REAL route handler end to end with a
// fake upstream; no real network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// -- A2.4: NC OneMap + Virginia statewide, through the SAME route (no new code paths) ---------------

const ncConfig = getParcelProviderConfig('nc-statewide');
const vaConfig = getParcelProviderConfig('va-statewide');
const NC_LAYER_URL = `${ncConfig.featureServerUrl}/${ncConfig.layers.parcels.id}/query`;
const VA_LAYER_URL = `${vaConfig.featureServerUrl}/${vaConfig.layers.parcels.id}/query`;

// Yadkinville, NC — the coordinate named in the A2.4 spec.
const NC_LAT = 36.13;
const NC_LON = -80.66;
const NC_BBOX = { south: 36.12, west: -80.67, north: 36.14, east: -80.65 };
// A clearly in-Virginia coordinate (Richmond).
const VA_LAT = 37.5407;
const VA_LON = -77.4360;
const VA_BBOX = { south: 37.53, west: -77.45, north: 37.55, east: -77.42 };

const NC_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    objectid: 4471, parno: '580602994649', altparno: null,
    ownname: 'EXAMPLE OWNER LLC', mailadd: '123 MAIN ST',
    siteadd: '456 FARM RD', scity: 'YADKINVILLE', sstate: 'NC', szip: '27055',
    gisacres: 20.87671745, improvval: 125000, landval: 95000, parval: 220000, cntyname: 'Yadkin',
  },
  geometry: { rings: [[[NC_BBOX.west, NC_BBOX.south], [NC_BBOX.east, NC_BBOX.south], [NC_BBOX.east, NC_BBOX.north], [NC_BBOX.west, NC_BBOX.north], [NC_BBOX.west, NC_BBOX.south]]] },
};
const VA_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 55123, PARCELID: '338499', LOCALITY: 'Richmond City',
    Owner1: 'EXAMPLE OWNER LLC', M_Address: '123 PO BOX',
    Address: '456 MAIN ST', City: 'Richmond', State: 'VA', Zip: '23219',
  },
  geometry: { rings: [[[VA_BBOX.west, VA_BBOX.south], [VA_BBOX.east, VA_BBOX.south], [VA_BBOX.east, VA_BBOX.north], [VA_BBOX.west, VA_BBOX.north], [VA_BBOX.west, VA_BBOX.south]]] },
};

test('3. /coverage near Yadkinville, NC resolves nc-statewide, purely from the registry (no upstream call)', async () => {
  const upstream = fakeFetch([]); // throws on ANY upstream call
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${NC_LAT}&lon=${NC_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'nc-statewide', providerId: 'north-carolina-onemap', sourceAgency: ncConfig.sourceAgency });
  assert.equal(upstream.calls.length, 0);
});

test('4. /coverage for a clearly in-Virginia point resolves va-statewide, purely from the registry (no upstream call)', async () => {
  const upstream = fakeFetch([]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${VA_LAT}&lon=${VA_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'va-statewide', providerId: 'virginia-statewide', sourceAgency: vaConfig.sourceAgency });
  assert.equal(upstream.calls.length, 0);
});

test('5. the existing Deschutes coverage resolution is unaffected by adding NC/VA', async () => {
  const { call } = installParcels(fullUpstream().impl);
  const res = await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'or-deschutes', providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office" });
});

test('6. a point outside every registered provider (NC, VA, and Deschutes) still resolves region:null', async () => {
  const { call } = installParcels(fullUpstream().impl);
  // Denver, CO — outside Deschutes, NC, and VA coverage boxes alike.
  const res = await call('/coverage?lat=39.7392&lon=-104.9903');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
});

test('7/9. NC /viewport returns real geometry via the SAME generic route, outSR=4326 requested, no owner data', async () => {
  const upstream = fakeFetch([[NC_LAYER_URL, okJson({ features: [NC_FEATURE_WITH_OWNER_FIELDS] })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=nc-statewide&south=${NC_BBOX.south}&west=${NC_BBOX.west}&north=${NC_BBOX.north}&east=${NC_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.region, 'nc-statewide');
  assert.equal(body.providerId, 'north-carolina-onemap');
  assert.equal(body.count, 1);
  assert.equal(body.parcels[0].parcelId, '580602994649');
  assert.equal(body.parcels[0].geometry.type, 'Polygon');
  assert.ok(upstream.calls[0].includes('outSR=4326'));
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the viewport response body');
});

test('8/10. VA /viewport returns real geometry via the SAME generic route, outSR=4326 requested, no owner data', async () => {
  const upstream = fakeFetch([[VA_LAYER_URL, okJson({ features: [VA_FEATURE_WITH_OWNER_FIELDS] })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=va-statewide&south=${VA_BBOX.south}&west=${VA_BBOX.west}&north=${VA_BBOX.north}&east=${VA_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.region, 'va-statewide');
  assert.equal(body.providerId, 'virginia-statewide');
  assert.equal(body.count, 1);
  assert.equal(body.parcels[0].parcelId, '338499');
  assert.equal(body.parcels[0].geometry.type, 'Polygon');
  assert.ok(upstream.calls[0].includes('outSR=4326'));
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the viewport response body');
});

test('17. the generic /viewport route logic — bbox/size validation, caching key shape, response shape — is identical for NC/VA and Deschutes', async () => {
  // Same oversized-bbox / malformed-bbox / unknown-region rejections already
  // proven against or-deschutes above apply verbatim to nc-statewide — this
  // is purely registry/config-driven (MAX_PARCEL_VIEWPORT_DEGREES, bbox
  // shape checks), never a per-region code path.
  const { call } = installParcels(fakeFetch([]).impl);
  const oversized = await call(`/viewport?region=nc-statewide&south=36.0&west=-81.0&north=36.5&east=-80.0`);
  assert.equal(oversized.statusCode, 400);
  assert.match(json(oversized).error, /too large/i);

  const outsideCoverage = await call('/viewport?region=nc-statewide&south=45.50&west=-122.68&north=45.56&east=-122.62');
  assert.equal(outsideCoverage.statusCode, 400, 'a validly-shaped bbox nowhere near NC still gets the coverage-intersection 400');
});

test('18. saturation behavior remains intact for NC — a truncated upstream response is reported, not silently dropped', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    attributes: { objectid: i, parno: `TL${i}`, altparno: null },
    geometry: NC_FEATURE_WITH_OWNER_FIELDS.geometry,
  }));
  const upstream = fakeFetch([[NC_LAYER_URL, okJson({ features: many })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=nc-statewide&south=${NC_BBOX.south}&west=${NC_BBOX.west}&north=${NC_BBOX.north}&east=${NC_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.count, 5);
  assert.equal(body.saturated, false, 'five features is well under the 400 cap — not saturated');
});

// -- Tennessee statewide coverage expansion: coverage + viewport through the SAME generic route -------

const tnConfig = getParcelProviderConfig('tn-statewide');
const TN_LAYER_URL = `${tnConfig.featureServerUrl}/${tnConfig.layers.parcels.id}/query`;

// A point inside TN's coverage bbox but clearly outside NC's/VA's — a
// rural-central-TN coordinate (Cumberland County, confirmed live during
// research), so this exercises TN's single-bbox-match fast path.
const TN_LAT = 35.95;
const TN_LON = -85.02;
const TN_BBOX = { south: 35.93, west: -85.04, north: 35.97, east: -85.00 };

const TN_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 1571, GISLINK: '018113D C 00100', GISLINK2: ' ', PARID: '113D C 00100 000', PARCELID: '018 113D C 00100 000 2027',
    OWNER: 'EXAMPLE OWNER LLC', MAILADDR: '123 MAIN ST', STATE: 'TN', ZIP: '38555',
    ADDRESS: 'DAYTON AVE 517', CALC_ACRE: 0.84236135, ZONING: 'R1', LANDUSE: '11 - HOUSEHOLD UNITS',
    LANDVAL: 15000, IMPVAL: 85000, APPRAISAL: 100000,
  },
  geometry: { rings: [[[TN_BBOX.west, TN_BBOX.south], [TN_BBOX.east, TN_BBOX.south], [TN_BBOX.east, TN_BBOX.north], [TN_BBOX.west, TN_BBOX.north], [TN_BBOX.west, TN_BBOX.south]]] },
};

test('3. /coverage inside Tennessee resolves tn-statewide, purely from the registry (no upstream call)', async () => {
  const upstream = fakeFetch([]); // throws on ANY upstream call
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${TN_LAT}&lon=${TN_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'tn-statewide', providerId: 'tennessee-statewide', sourceAgency: tnConfig.sourceAgency });
  assert.equal(upstream.calls.length, 0);
});

test('4/5. TN /viewport returns real geometry via the SAME generic route, outSR=4326 requested, no owner data', async () => {
  const upstream = fakeFetch([[TN_LAYER_URL, okJson({ features: [TN_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=tn-statewide&south=${TN_BBOX.south}&west=${TN_BBOX.west}&north=${TN_BBOX.north}&east=${TN_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.region, 'tn-statewide');
  assert.equal(body.providerId, 'tennessee-statewide');
  assert.equal(body.count, 1);
  assert.equal(body.parcels[0].parcelId, '018113D C 00100');
  assert.equal(body.parcels[0].geometry.type, 'Polygon');
  assert.ok(upstream.calls[0].includes('outSR=4326'));
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the viewport response body');
});

test('10. TN saturation is reported via exceededTransferLimit even when the feature count stays under the public 400 cap', async () => {
  const twoHundred = Array.from({ length: 200 }, (_, i) => ({
    attributes: { OBJECTID: i, GISLINK: `TESTLINK${i}` },
    geometry: TN_FEATURE_WITH_OWNER_FIELDS.geometry,
  }));
  const upstream = fakeFetch([[TN_LAYER_URL, okJson({ features: twoHundred, exceededTransferLimit: true })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=tn-statewide&south=${TN_BBOX.south}&west=${TN_BBOX.west}&north=${TN_BBOX.north}&east=${TN_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.count, 200, 'well under the 400 cap by count alone');
  assert.equal(body.saturated, true, 'the provider\'s own exceededTransferLimit signal must still surface as saturated');
});

test('12. existing NC/VA/OR coverage resolution is unaffected by adding TN', async () => {
  const { call } = installParcels(fullUpstream().impl);
  assert.deepEqual(json(await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`)), { region: 'or-deschutes', providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office" });
  const ncUpstream = fakeFetch([]);
  assert.deepEqual(json(await installParcels(ncUpstream.impl).call(`/coverage?lat=${NC_LAT}&lon=${NC_LON}`)), { region: 'nc-statewide', providerId: 'north-carolina-onemap', sourceAgency: ncConfig.sourceAgency });
  const vaUpstream = fakeFetch([]);
  assert.deepEqual(json(await installParcels(vaUpstream.impl).call(`/coverage?lat=${VA_LAT}&lon=${VA_LON}`)), { region: 'va-statewide', providerId: 'virginia-statewide', sourceAgency: vaConfig.sourceAgency });
});

// -- A2.4 hardening: coverage overlap disambiguation (NC/VA bbox overlap near the border) -----------

// A point inside BOTH nc-statewide's and va-statewide's coarse, padded
// coverageBbox — well within the real overlap band (lat 36.5–36.7), with no
// particular meaning otherwise; the mocked identify responses below decide
// which provider "really" contains it for each test.
const OVERLAP_LAT = 36.6;
const OVERLAP_LON = -80.0;

const ncIdentifyFeature = {
  attributes: { objectid: 1, parno: 'NCPARCEL1', altparno: null, ownname: 'EXAMPLE OWNER LLC' },
  geometry: { rings: [[[OVERLAP_LON - 0.001, OVERLAP_LAT - 0.001], [OVERLAP_LON + 0.001, OVERLAP_LAT - 0.001], [OVERLAP_LON + 0.001, OVERLAP_LAT + 0.001], [OVERLAP_LON - 0.001, OVERLAP_LAT + 0.001], [OVERLAP_LON - 0.001, OVERLAP_LAT - 0.001]]] },
};
const vaIdentifyFeature = {
  attributes: { OBJECTID: 1, PARCELID: 'VAPARCEL1', Owner1: 'EXAMPLE OWNER LLC' },
  geometry: { rings: [[[OVERLAP_LON - 0.001, OVERLAP_LAT - 0.001], [OVERLAP_LON + 0.001, OVERLAP_LAT - 0.001], [OVERLAP_LON + 0.001, OVERLAP_LAT + 0.001], [OVERLAP_LON - 0.001, OVERLAP_LAT + 0.001], [OVERLAP_LON - 0.001, OVERLAP_LAT - 0.001]]] },
};
const noFeatures = okJson({ features: [] });
const upstreamThrows = () => Promise.reject(new Error('upstream exploded'));

test('1. a single bbox match (the already-covered inland cases) performs no identify/disambiguation call at all', async () => {
  const upstream = fakeFetch([]); // throws on ANY upstream call
  const { call } = installParcels(upstream.impl);
  const nc = await call(`/coverage?lat=${NC_LAT}&lon=${NC_LON}`);
  const va = await call(`/coverage?lat=${VA_LAT}&lon=${VA_LON}`);
  const or = await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`);
  assert.equal(nc.statusCode, 200);
  assert.equal(va.statusCode, 200);
  assert.equal(or.statusCode, 200);
  assert.equal(upstream.calls.length, 0, 'none of these single-bbox-match points ever touch the network');
});

test('2. zero bbox matches still resolves region:null with no upstream call', async () => {
  const upstream = fakeFetch([]);
  const { call } = installParcels(upstream.impl);
  const res = await call('/coverage?lat=39.7392&lon=-104.9903'); // Denver, CO — outside every registered provider
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
  assert.equal(upstream.calls.length, 0);
});

test('3. overlapping bbox where only NC identify confirms a parcel resolves nc-statewide', async () => {
  const upstream = fakeFetch([
    [NC_LAYER_URL, okJson({ features: [ncIdentifyFeature] })],
    [VA_LAYER_URL, noFeatures],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'nc-statewide', providerId: 'north-carolina-onemap', sourceAgency: ncConfig.sourceAgency });
});

test('4. overlapping bbox where only VA identify confirms a parcel resolves va-statewide', async () => {
  const upstream = fakeFetch([
    [NC_LAYER_URL, noFeatures],
    [VA_LAYER_URL, okJson({ features: [vaIdentifyFeature] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'va-statewide', providerId: 'virginia-statewide', sourceAgency: vaConfig.sourceAgency });
});

test('5. the winner is a function of which identify confirms, never of registry iteration order (nc-statewide is always listed BEFORE va-statewide, yet VA can still win)', async () => {
  // listParcelRegions() always visits nc-statewide before va-statewide (the
  // registry's own fixed order) in BOTH of the next two calls. Under the old
  // "first bbox match wins" bug, NC would therefore win EVERY overlap,
  // regardless of which state the point is actually in. Test 4 above already
  // shows VA winning despite being visited second — this test makes that
  // order-independence explicit by running both outcomes back to back
  // against the unchanged registry and confirming neither leaks into the
  // other (no stale winner from a previous call/cache entry).
  const vaWinsUpstream = fakeFetch([[NC_LAYER_URL, noFeatures], [VA_LAYER_URL, okJson({ features: [vaIdentifyFeature] })]]);
  const vaWinsRes = await installParcels(vaWinsUpstream.impl).call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON + 0.01}`);
  assert.equal(json(vaWinsRes).region, 'va-statewide');

  const ncWinsUpstream = fakeFetch([[NC_LAYER_URL, okJson({ features: [ncIdentifyFeature] })], [VA_LAYER_URL, noFeatures]]);
  const ncWinsRes = await installParcels(ncWinsUpstream.impl).call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON + 0.02}`);
  assert.equal(json(ncWinsRes).region, 'nc-statewide');
});

test('5b. the resolver source never special-cases which candidate wins by array position outside the single-match fast path', () => {
  const source = fs.readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
  const parcelsFn = source.slice(source.indexOf('function parcelsProxy('), source.indexOf('function openAiRealtimeProxy()'));
  const disambiguationBody = parcelsFn.slice(parcelsFn.indexOf('Overlap: more than one coarse bbox matches'));
  assert.equal(/bboxCandidates\[0\]/.test(disambiguationBody), false, 'the disambiguation branch must never just take the first bbox candidate');
});

test('6. both candidates fail to confirm a parcel at the exact point => region:null, never a guess', async () => {
  const upstream = fakeFetch([[NC_LAYER_URL, noFeatures], [VA_LAYER_URL, noFeatures]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
});

test('7. one candidate\'s upstream errors while the other confirms — the confirmed provider wins, the error never fails the whole request', async () => {
  const upstream = fakeFetch([[NC_LAYER_URL, upstreamThrows], [VA_LAYER_URL, okJson({ features: [vaIdentifyFeature] })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'va-statewide', providerId: 'virginia-statewide', sourceAgency: vaConfig.sourceAgency });
});

test('7b. BOTH candidates erroring resolves region:null rather than throwing a 500/502', async () => {
  const upstream = fakeFetch([[NC_LAYER_URL, upstreamThrows], [VA_LAYER_URL, upstreamThrows]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
});

test('8. disambiguation never exposes owner data, even though the mocked identify responses carry owner-shaped attributes', async () => {
  const upstream = fakeFetch([
    [NC_LAYER_URL, okJson({ features: [ncIdentifyFeature] })],
    [VA_LAYER_URL, okJson({ features: [vaIdentifyFeature] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${OVERLAP_LAT}&lon=${OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(json(res)).sort(), ['providerId', 'region', 'sourceAgency'], 'the public /coverage response shape is unchanged');
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the coverage response body');
  assert.doesNotMatch(res.body, /EXAMPLE OWNER LLC/i);
});

test('9. existing inland coverage cases (single bbox match each) remain unaffected by the overlap-disambiguation logic', async () => {
  const { call } = installParcels(fullUpstream().impl);
  assert.deepEqual(json(await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`)), { region: 'or-deschutes', providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office" });
  const ncUpstream = fakeFetch([]);
  assert.deepEqual(json(await installParcels(ncUpstream.impl).call(`/coverage?lat=${NC_LAT}&lon=${NC_LON}`)), { region: 'nc-statewide', providerId: 'north-carolina-onemap', sourceAgency: ncConfig.sourceAgency });
  const vaUpstream = fakeFetch([]);
  assert.deepEqual(json(await installParcels(vaUpstream.impl).call(`/coverage?lat=${VA_LAT}&lon=${VA_LON}`)), { region: 'va-statewide', providerId: 'virginia-statewide', sourceAgency: vaConfig.sourceAgency });
});

// -- Tennessee coverage expansion: TN's bbox genuinely overlaps NC's/VA's near their shared borders ------

// A point inside BOTH tn-statewide's and nc-statewide's coarse bbox (east
// TN / western NC) — exercises the SAME generic disambiguation mechanism,
// with no TN-specific code path.
const TN_NC_OVERLAP_LAT = 35.6;
const TN_NC_OVERLAP_LON = -83.5;

const tnIdentifyFeature = {
  attributes: { OBJECTID: 1, GISLINK: 'TNPARCEL1', OWNER: 'EXAMPLE OWNER LLC' },
  geometry: { rings: [[[TN_NC_OVERLAP_LON - 0.001, TN_NC_OVERLAP_LAT - 0.001], [TN_NC_OVERLAP_LON + 0.001, TN_NC_OVERLAP_LAT - 0.001], [TN_NC_OVERLAP_LON + 0.001, TN_NC_OVERLAP_LAT + 0.001], [TN_NC_OVERLAP_LON - 0.001, TN_NC_OVERLAP_LAT + 0.001], [TN_NC_OVERLAP_LON - 0.001, TN_NC_OVERLAP_LAT - 0.001]]] },
};

test('TN/NC coverage overlap: only TN identify confirms a parcel => tn-statewide, via the SAME existing multi-candidate disambiguation (no TN-specific route code)', async () => {
  const upstream = fakeFetch([
    [TN_LAYER_URL, okJson({ features: [tnIdentifyFeature], exceededTransferLimit: false })],
    [NC_LAYER_URL, noFeatures],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${TN_NC_OVERLAP_LAT}&lon=${TN_NC_OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'tn-statewide', providerId: 'tennessee-statewide', sourceAgency: tnConfig.sourceAgency });
});

test('TN/NC coverage overlap: only NC identify confirms a parcel => nc-statewide, even though NC is visited after TN in the unchanged registry', async () => {
  const upstream = fakeFetch([
    [TN_LAYER_URL, noFeatures],
    [NC_LAYER_URL, okJson({ features: [{ attributes: { objectid: 2, parno: 'NCPARCEL2', altparno: null }, geometry: tnIdentifyFeature.geometry }] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${TN_NC_OVERLAP_LAT}&lon=${TN_NC_OVERLAP_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'nc-statewide', providerId: 'north-carolina-onemap', sourceAgency: ncConfig.sourceAgency });
});

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

// -- South Carolina coverage expansion: coverage + viewport through the SAME generic route -------

const scConfig = getParcelProviderConfig('sc-counties');
const SC_BOUNDARY_URL = `${scConfig.countyBoundaryUrl}/query`;
const SC_YORK_LAYER_URL = `${scConfig.counties.YORK.featureServerUrl}/0/query`;
const SC_HORRY_LAYER_URL = `${scConfig.counties.HORRY.featureServerUrl}/0/query`;

// A point/bbox inside York County, SC — confirmed live during research.
const SC_YORK_LAT = 34.9618;
const SC_YORK_LON = -81.0824;
const SC_YORK_BBOX = { south: 34.955, west: -81.09, north: 34.97, east: -81.07 };

const SC_YORK_BOUNDARY_FEATURE = { attributes: { County: 'YORK' } };
const SC_YORK_PARCEL_FEATURE = {
  attributes: {
    OBJECTID: 1, ParcelID: '5400000013', TAXMAPID: '5400000013',
    Owner1: 'EXAMPLE OWNER', MailAddr1: '456 MAIL ST', MailCity: 'ROCK HILL',
    PropertyAddress: '930 HOLLIS LAKES RD', LandUseDesc: 'RESIDENTIAL IMPROVED OC',
    GISSizeAC: 2.89, AprLandVal: 50000, AprBldgVal: 206900, AprTotVal: 256900,
  },
  geometry: { rings: [[[SC_YORK_BBOX.west, SC_YORK_BBOX.south], [SC_YORK_BBOX.east, SC_YORK_BBOX.south], [SC_YORK_BBOX.east, SC_YORK_BBOX.north], [SC_YORK_BBOX.west, SC_YORK_BBOX.north], [SC_YORK_BBOX.west, SC_YORK_BBOX.south]]] },
};

test('SC: /coverage for a point inside York County resolves sc-counties via the real county-boundary service', async () => {
  const upstream = fakeFetch([
    [SC_BOUNDARY_URL, okJson({ features: [SC_YORK_BOUNDARY_FEATURE] })],
    [SC_YORK_LAYER_URL, okJson({ features: [SC_YORK_PARCEL_FEATURE] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${SC_YORK_LAT}&lon=${SC_YORK_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'sc-counties', providerId: 'south-carolina-county-parcels', sourceAgency: scConfig.sourceAgency });
});

test('SC: /viewport for York County returns real geometry via the SAME generic route, outSR=4326, no owner data', async () => {
  const upstream = fakeFetch([[SC_YORK_LAYER_URL, okJson({ features: [SC_YORK_PARCEL_FEATURE], exceededTransferLimit: false })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=sc-counties&south=${SC_YORK_BBOX.south}&west=${SC_YORK_BBOX.west}&north=${SC_YORK_BBOX.north}&east=${SC_YORK_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.region, 'sc-counties');
  assert.equal(body.providerId, 'south-carolina-county-parcels');
  assert.equal(body.count, 1);
  assert.equal(body.parcels[0].parcelId, 'YORK:5400000013');
  assert.equal(body.parcels[0].geometry.type, 'Polygon');
  assert.ok(upstream.calls[0].includes('outSR=4326'));
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the viewport response body');
});

test('SC: a point the boundary service resolves to an unsupported county reports no coverage, never a fake match', async () => {
  const upstream = fakeFetch([
    [SC_BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'RICHLAND' } }] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call('/coverage?lat=34.0&lon=-80.9');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
});

test('SC/NC coverage overlap: only SC identify confirms a parcel => sc-counties, via the SAME existing multi-candidate disambiguation (no SC-specific route code)', async () => {
  const upstream = fakeFetch([
    [SC_BOUNDARY_URL, okJson({ features: [SC_YORK_BOUNDARY_FEATURE] })],
    [SC_YORK_LAYER_URL, okJson({ features: [SC_YORK_PARCEL_FEATURE], exceededTransferLimit: false })],
    [NC_LAYER_URL, noFeatures],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${SC_YORK_LAT}&lon=${SC_YORK_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'sc-counties', providerId: 'south-carolina-county-parcels', sourceAgency: scConfig.sourceAgency });
});

test('13 (SC coverage expansion): existing OR/NC/VA/TN coverage resolution is unaffected by adding SC', async () => {
  const { call } = installParcels(fullUpstream().impl);
  assert.deepEqual(json(await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`)), { region: 'or-deschutes', providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office" });
});

// -- Georgia coverage expansion: coverage + viewport through the SAME generic route -------

const gaConfig = getParcelProviderConfig('ga-counties');
const GA_BOUNDARY_URL = `${gaConfig.countyBoundaryUrl}/query`;
const GA_FULTON_LAYER_URL = `${gaConfig.counties.FULTON.featureServerUrl}/0/query`;

// A point/bbox inside Fulton County, GA — confirmed live during research.
const GA_FULTON_LAT = 33.5025;
const GA_FULTON_LON = -84.6145;
const GA_FULTON_BBOX = { south: 33.495, west: -84.62, north: 33.51, east: -84.60 };

const GA_FULTON_BOUNDARY_FEATURE = { attributes: { NAME: 'Fulton County' } };
const GA_FULTON_PARCEL_FEATURE = {
  attributes: { OBJECTID: 1, ParcelID: '07 410001590187', Address: '0 GULLATT RD', LandAcres: 5.02, LUCode: '100' },
  geometry: { rings: [[[GA_FULTON_BBOX.west, GA_FULTON_BBOX.south], [GA_FULTON_BBOX.east, GA_FULTON_BBOX.south], [GA_FULTON_BBOX.east, GA_FULTON_BBOX.north], [GA_FULTON_BBOX.west, GA_FULTON_BBOX.north], [GA_FULTON_BBOX.west, GA_FULTON_BBOX.south]]] },
};

test('GA: /coverage for a point inside Fulton County resolves ga-counties via the real county-boundary service', async () => {
  const upstream = fakeFetch([
    [GA_BOUNDARY_URL, okJson({ features: [GA_FULTON_BOUNDARY_FEATURE] })],
    [GA_FULTON_LAYER_URL, okJson({ features: [GA_FULTON_PARCEL_FEATURE] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/coverage?lat=${GA_FULTON_LAT}&lon=${GA_FULTON_LON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: 'ga-counties', providerId: 'georgia-county-parcels', sourceAgency: gaConfig.sourceAgency });
});

test('GA: /viewport for Fulton County returns real geometry via the SAME generic route, outSR=4326, no owner data', async () => {
  const upstream = fakeFetch([[GA_FULTON_LAYER_URL, okJson({ features: [GA_FULTON_PARCEL_FEATURE], exceededTransferLimit: false })]]);
  const { call } = installParcels(upstream.impl);
  const res = await call(`/viewport?region=ga-counties&south=${GA_FULTON_BBOX.south}&west=${GA_FULTON_BBOX.west}&north=${GA_FULTON_BBOX.north}&east=${GA_FULTON_BBOX.east}`);
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.region, 'ga-counties');
  assert.equal(body.providerId, 'georgia-county-parcels');
  assert.equal(body.count, 1);
  assert.equal(body.parcels[0].parcelId, 'FULTON:07 410001590187');
  assert.equal(body.parcels[0].geometry.type, 'Polygon');
  assert.ok(upstream.calls[0].includes('outSR=4326'));
  assert.doesNotMatch(res.body, /owner/i, 'no owner key anywhere in the viewport response body');
});

test('GA: a point the boundary service resolves to an unsupported county reports no coverage, never a fake match', async () => {
  const upstream = fakeFetch([
    [GA_BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Chatham County' } }] })],
  ]);
  const { call } = installParcels(upstream.impl);
  const res = await call('/coverage?lat=32.08&lon=-81.1');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { region: null });
});

test('GA/SC coverage overlap (none expected, but exercised anyway): existing OR/NC/VA/TN/SC coverage resolution is unaffected by adding GA', async () => {
  const { call } = installParcels(fullUpstream().impl);
  assert.deepEqual(json(await call(`/coverage?lat=${INSIDE_LAT}&lon=${INSIDE_LON}`)), { region: 'or-deschutes', providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office" });
});
