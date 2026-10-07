// Property Intelligence — Georgia county-parcel provider, exercised with a
// fake fetch and FIXTURE response bodies shaped exactly like the real
// FeatureServers' fields (confirmed live during research against each
// supported county's own public ArcGIS REST service, and Georgia's own
// statewide county-boundary FeatureServer). No network; the live services
// are never touched by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getParcelProviderConfig, resolveParcelProvider } from '../parcelProviderRegistry.js';
import { createGeorgiaCountyParcelsProvider } from './georgiaCountyParcels.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const config = getParcelProviderConfig('ga-counties');
const BOUNDARY_URL = `${config.countyBoundaryUrl}/query`;
const FULTON_URL = `${config.counties.FULTON.featureServerUrl}/0/query`;
const DEKALB_URL = `${config.counties.DEKALB.featureServerUrl}/0/query`;
const GWINNETT_URL = `${config.counties.GWINNETT.featureServerUrl}/0/query`;

// Real-field-shaped fixtures, including owner/mailing-adjacent fields that
// genuinely exist upstream for at least one county, so the "never
// requested"/"never exposed" tests test something real.
const FULTON_FEATURE = {
  attributes: { OBJECTID: 1, ParcelID: '07 410001590187', Address: '0 GULLATT RD', LandAcres: 5.02, LUCode: '100' },
  geometry: { rings: [[[-84.615, 33.503], [-84.614, 33.503], [-84.614, 33.502], [-84.615, 33.502], [-84.615, 33.503]]] },
};
const DEKALB_FEATURE_WITH_SHAPE_AREA = {
  attributes: {
    OBJECTID: 2, ParcelID: '12 228 01 021', ZONING: 'R-100', LANDUSE: 'SUB',
    ASSESSED_VALUE: 138120, APPRAISED_VALUE: 345300, LAND_VALUE: 55248, BLDG_VALUE: 290052,
    Shape__Area: 11831, // State-Plane SQUARE FEET
  },
  geometry: { rings: [[[-84.226, 33.635], [-84.225, 33.635], [-84.225, 33.634], [-84.226, 33.634], [-84.226, 33.635]]] },
};
// Gwinnett's base Parcels layer (id 0) has no owner field at all — used to
// prove the related, owner-carrying Tax Master/Owner tables are never
// joined.
const GWINNETT_FEATURE = {
  attributes: { OBJECTID: 3, PIN: '6324 030', ADDRESS: '4204', CALCULATEDACREAGE: 0.59746622 },
  geometry: { rings: [[[-84.156, 34.021], [-84.155, 34.021], [-84.155, 34.020], [-84.156, 34.020], [-84.156, 34.021]]] },
};

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url) => {
      calls.push(url);
      for (const [prefix, respond] of responses) {
        if (url.startsWith(prefix)) return respond(url);
      }
      throw new Error(`unexpected URL in test: ${url}`);
    },
  };
}
const okJson = (body) => async () => ({ ok: true, text: async () => JSON.stringify(body) });
const passthroughReadCapped = async (response) => ({ tooLarge: false, text: await response.text() });

function providerWith(responses) {
  const f = fakeFetch(responses);
  return {
    calls: f.calls,
    provider: createGeorgiaCountyParcelsProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
    }),
  };
}

// -- 1. registration ----------------------------------------------------------------------------------

test('1. ga-counties is registered and resolveParcelProvider resolves it via its own factory', () => {
  assert.ok(config);
  const provider = resolveParcelProvider('ga-counties', {});
  assert.ok(provider);
  for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getParcelsInViewport', 'getMetadata']) {
    assert.equal(typeof provider[op], 'function', op);
  }
});

// -- 2. county resolution -------------------------------------------------------------------------------

test('2. identifyParcel queries the real county-boundary service before any parcel layer', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Fulton County' } }] })],
    [FULTON_URL, okJson({ features: [FULTON_FEATURE] })],
  ]);
  const parcel = await provider.identifyParcel(33.5025, -84.6145);
  assert.ok(parcel);
  assert.ok(calls[0].startsWith(BOUNDARY_URL), 'the county-boundary service must be queried first');
  assert.ok(calls[1].startsWith(FULTON_URL), 'then the resolved county\'s own parcel layer');
  assert.equal(parcel.parcelId, 'FULTON:07 410001590187');
});

// -- 3. supported county config resolution --------------------------------------------------------------

test('3. a point the boundary service resolves to DEKALB is served by DeKalb\'s own layer', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'DeKalb County' } }] })],
    [DEKALB_URL, okJson({ features: [DEKALB_FEATURE_WITH_SHAPE_AREA] })],
  ]);
  const parcel = await provider.identifyParcel(33.6365, -84.2278);
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'DEKALB:12 228 01 021');
  assert.equal(parcel.sourceAgency, config.counties.DEKALB.sourceAgency);
});

// -- 4. unsupported county => no provider --------------------------------------------------------------

test('4. a point the boundary service resolves to an unsupported county returns null, never a fake-empty result', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Chatham County' } }] })],
  ]);
  const parcel = await provider.identifyParcel(33.78, -83.75); // inside the coarse coverage bbox, but Chatham is not a supported county
  assert.equal(parcel, null);
  assert.equal(calls.length, 1, 'never queries any parcel layer for an unsupported county');
});

test('4b. a point the coarse coverage bbox rejects outright never even reaches the boundary service', async () => {
  const { provider, calls } = providerWith([]);
  const parcel = await provider.identifyParcel(40.0, -75.0); // nowhere near GA
  assert.equal(parcel, null);
  assert.equal(calls.length, 0);
});

// -- 5. viewport query ----------------------------------------------------------------------------------

test('5. getParcelsInViewport queries only the county whose own bbox intersects the viewport', async () => {
  const { provider, calls } = providerWith([
    [FULTON_URL, okJson({ features: [FULTON_FEATURE], exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 33.49, west: -84.62, north: 33.51, east: -84.60 });
  assert.equal(result.parcels.length, 1);
  assert.equal(result.parcels[0].parcelId, 'FULTON:07 410001590187');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(FULTON_URL));
});

test('5b. a viewport over no supported county\'s bbox returns an empty, non-saturated result with zero upstream calls', async () => {
  const { provider, calls } = providerWith([]);
  const result = await provider.getParcelsInViewport({ south: 31.0, west: -82.0, north: 31.02, east: -81.98 });
  assert.deepEqual(result, { parcels: [], saturated: false });
  assert.equal(calls.length, 0);
});

// -- 6. outSR=4326 --------------------------------------------------------------------------------------

test('6. every query (boundary, viewport, identify) always requests outSR=4326', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Fulton County' } }] })],
    [FULTON_URL, okJson({ features: [FULTON_FEATURE] })],
  ]);
  await provider.identifyParcel(33.5025, -84.6145);
  for (const url of calls) assert.ok(url.includes('outSR=4326'), url);
});

// -- 7. parcel identity + county namespacing -------------------------------------------------------------

test('7. every returned parcelId is namespaced with its county, and getParcelById round-trips it', async () => {
  const { provider, calls } = providerWith([
    [FULTON_URL, okJson({ features: [FULTON_FEATURE] })],
  ]);
  const parcel = await provider.getParcelById('FULTON:07 410001590187');
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'FULTON:07 410001590187');
  const decoded = decodeURIComponent(calls[0].replace(/\+/g, ' '));
  assert.ok(decoded.includes("ParcelID = '07 410001590187'"), decoded);
});

test('7b. getParcelById for an unsupported county prefix returns null without any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  const parcel = await provider.getParcelById('CHATHAM:1');
  assert.equal(parcel, null);
  assert.equal(calls.length, 0, 'an invalid parcelId never even passes the pattern check');
});

// -- 8. deterministic OBJECTID fallback ------------------------------------------------------------------

test('8. the OBJECTID fallback is namespaced per-county and can never collide across counties', async () => {
  const { provider } = providerWith([
    [FULTON_URL, okJson({ features: [{ attributes: { OBJECTID: 1, ParcelID: null, Address: 'X' }, geometry: FULTON_FEATURE.geometry }] })],
  ]);
  const parcel = await provider.getParcelById('FULTON:ga-oid-1');
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'FULTON:ga-oid-1');
});

// -- 9/10. owner fields never requested, never exposed --------------------------------------------------

test('9. no outFields list for any county ever includes an owner/mailing field', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Fulton County' } }] })],
    [FULTON_URL, okJson({ features: [FULTON_FEATURE] })],
  ]);
  await provider.identifyParcel(33.5025, -84.6145);
  await provider.getParcelById('FULTON:07 410001590187');
  await provider.searchAddress('GULLATT RD');
  for (const url of calls) {
    const outFields = (new URL(url).searchParams.get('outFields') || '').toLowerCase();
    for (const ownerField of ['owner', 'owneraddr1', 'owneraddr2', 'mailaddr', 'mailcity', 'mailstat', 'mailzip', 'lastname', 'owner_name', 'owner_add']) {
      assert.equal(outFields.includes(ownerField), false, `${url} outFields must never include ${ownerField}`);
    }
  }
});

test('10. even when the upstream mock RETURNS owner-shaped attributes, the normalized parcel never exposes them', async () => {
  const featureWithOwnerShapedExtra = {
    attributes: { ...FULTON_FEATURE.attributes, Owner: 'EXAMPLE OWNER LLC', OwnerAddr1: '456 MAIL ST' },
    geometry: FULTON_FEATURE.geometry,
  };
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Fulton County' } }] })],
    [FULTON_URL, okJson({ features: [featureWithOwnerShapedExtra] })],
  ]);
  const parcel = await provider.identifyParcel(33.5025, -84.6145);
  assert.equal(parcel.owner.name, null, 'ownerName is never even read from attrs for this provider');
  const serialized = JSON.stringify(parcel).toLowerCase();
  assert.equal(serialized.includes('example owner'), false);
  assert.equal(serialized.includes('456 mail st'), false, 'mailing address never leaks either, even if an upstream mock includes it');
});

test('this provider module never names an owner/mailing field anywhere in its source', () => {
  const source = code('./georgiaCountyParcels.js').replace(/ownerName/g, '');
  for (const ownerField of ['OWNER_NAME', 'OWNER_ADD', 'MAILADDR', 'MAILCITY', 'MAILSTAT', 'MAILZIP', 'lastname']) {
    assert.equal(new RegExp(ownerField, 'i').test(source), false, ownerField);
  }
});

test('neither the registry nor the provider ever requests outFields: \'*\' for Georgia', () => {
  const registrySource = fs.readFileSync(new URL('../parcelProviderRegistry.js', import.meta.url), 'utf8');
  const gaSection = registrySource.slice(registrySource.indexOf("'ga-counties':"));
  assert.equal(/outFields\s*:\s*['"]\*['"]/.test(gaSection), false);
  assert.equal(/outFields\s*:\s*['"]\*['"]/.test(code('./georgiaCountyParcels.js')), false);
});

// -- 11. cross-county viewport behavior -------------------------------------------------------------------

test('11. a viewport that happens to intersect multiple supported counties\' own bboxes queries all of them and merges results', async () => {
  const { provider } = providerWith([
    [FULTON_URL, okJson({ features: [FULTON_FEATURE], exceededTransferLimit: false })],
    [DEKALB_URL, okJson({ features: [DEKALB_FEATURE_WITH_SHAPE_AREA], exceededTransferLimit: false })],
  ]);
  const wideBbox = { south: 33.25, west: -84.85, north: 34.0, east: -83.95 };
  const result = await provider.getParcelsInViewport(wideBbox);
  const ids = result.parcels.map((p) => p.parcelId).sort();
  assert.deepEqual(ids, ['DEKALB:12 228 01 021', 'FULTON:07 410001590187']);
});

// -- 12. saturation ---------------------------------------------------------------------------------------

test('12. saturation is reported when a county\'s own response exceeds the per-county remaining budget', async () => {
  const manyFeatures = Array.from({ length: 5 }, (_, i) => ({
    attributes: { OBJECTID: i, ParcelID: `ID${i}` }, geometry: FULTON_FEATURE.geometry,
  }));
  const { provider } = providerWith([
    [FULTON_URL, okJson({ features: manyFeatures, exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 33.49, west: -84.62, north: 33.51, east: -84.60 }, { maxResults: 3 });
  assert.equal(result.parcels.length, 3);
  assert.equal(result.saturated, true);
});

// -- 13. detail normalization ------------------------------------------------------------------------------

test('13. the normalized parcel carries each county\'s own safe fields; Gwinnett\'s base layer omits what only the unjoined related tables have', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'DeKalb County' } }] })],
    [DEKALB_URL, okJson({ features: [DEKALB_FEATURE_WITH_SHAPE_AREA] })],
  ]);
  const dekalb = await provider.identifyParcel(33.6365, -84.2278);
  assert.equal(dekalb.zoning, 'R-100');
  assert.equal(dekalb.landUse, 'SUB');
  assert.equal(dekalb.values.assessed, 138120);
  assert.equal(dekalb.values.market, 345300);
  assert.equal(dekalb.values.land, 55248);
  assert.equal(dekalb.values.improvements, 290052);
  assert.equal(dekalb.address.full, null, 'DeKalb has no address field at all');
  assert.equal(dekalb.acreageSource, 'computed', 'DeKalb has no assessor acreage field — derived from Shape__Area instead');
  assert.ok(dekalb.acreage > 0);

  const { provider: provider2 } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { NAME: 'Gwinnett County' } }] })],
    [GWINNETT_URL, okJson({ features: [GWINNETT_FEATURE] })],
  ]);
  const gwinnett = await provider2.identifyParcel(34.021, -84.156);
  assert.equal(gwinnett.address.full, '4204', 'Gwinnett\'s base layer only has a bare street number');
  assert.equal(gwinnett.zoning, null, 'Gwinnett\'s zoning only lives in the unjoined related table');
  assert.equal(gwinnett.values.assessed, null, 'Gwinnett\'s values only live in the unjoined related table');
  assert.equal(gwinnett.acreage, 0.59746622);
  assert.equal(gwinnett.acreageSource, 'assessor');
});

test('an invalid parcel id format is rejected before any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  assert.equal(await provider.getParcelById(''), null);
  assert.equal(await provider.getParcelById('; DROP TABLE'), null);
  assert.equal(calls.length, 0);
});
