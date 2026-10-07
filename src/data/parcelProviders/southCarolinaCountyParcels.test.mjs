// Property Intelligence — South Carolina county-parcel provider, exercised
// with a fake fetch and FIXTURE response bodies shaped exactly like the
// real FeatureServers' fields (confirmed live during research against
// York's and Horry's own public ArcGIS REST services, and SC's own
// statewide county-boundary FeatureServer). No network; the live services
// are never touched by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getParcelProviderConfig, resolveParcelProvider } from '../parcelProviderRegistry.js';
import { createSouthCarolinaCountyParcelsProvider } from './southCarolinaCountyParcels.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const config = getParcelProviderConfig('sc-counties');
const BOUNDARY_URL = `${config.countyBoundaryUrl}/query`;
const YORK_URL = `${config.counties.YORK.featureServerUrl}/0/query`;
const HORRY_URL = `${config.counties.HORRY.featureServerUrl}/0/query`;

// Real-field-shaped fixtures, including each county's own owner/mailing
// fields — specifically so the "never requested"/"never exposed" tests
// below test something real, not a straw man.
const YORK_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 101, ParcelID: '5400000013', TAXMAPID: '5400000013',
    Owner1: 'EXAMPLE OWNER', Owner2: null, PreviousOwner: 'PRIOR OWNER',
    MailAddr1: '456 MAIL ST', MailCity: 'ROCK HILL', MailState: 'SC', MailZip: '29730',
    PropertyAddress: '930 HOLLIS LAKES RD ', LandUse: 'RIO', LandUseDesc: 'RESIDENTIAL IMPROVED OC',
    GISSizeAC: 2.89, YearBuilt: 1998, FinishedSQFT: 1652,
    AprLandVal: 50000, AprBldgVal: 206900, AprTotVal: 256900, TaxTotVal: 167958, AsdTotVal: 6719,
  },
  geometry: { rings: [[[-81.083, 34.962], [-81.082, 34.962], [-81.082, 34.961], [-81.083, 34.961], [-81.083, 34.962]]] },
};
const HORRY_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 202, PARNO: '30413010131', OWNNAME: 'EXAMPLE OWNER',
    IMPROVVAL: 98600, LANDVAL: 0, PARVAL: 98600, Shape__Area: 91329.566,
  },
  geometry: { rings: [[[-78.690, 33.890], [-78.689, 33.890], [-78.689, 33.889], [-78.690, 33.889], [-78.690, 33.890]]] },
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
    provider: createSouthCarolinaCountyParcelsProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
    }),
  };
}

// -- registration -----------------------------------------------------------------------------------

test('sc-counties is registered and resolveParcelProvider resolves it via its own factory', () => {
  assert.ok(config);
  const provider = resolveParcelProvider('sc-counties', {});
  assert.ok(provider);
  for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getParcelsInViewport', 'getMetadata']) {
    assert.equal(typeof provider[op], 'function', op);
  }
});

// -- 1. SC county-boundary lookup --------------------------------------------------------------------

test('1. identifyParcel queries the real county-boundary service before any parcel layer', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'YORK' } }] })],
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(34.9618, -81.0824);
  assert.ok(parcel);
  assert.ok(calls[0].startsWith(BOUNDARY_URL), 'the county-boundary service must be queried first');
  assert.ok(calls[1].startsWith(YORK_URL), 'then the resolved county\'s own parcel layer');
});

// -- 2. supported county resolution ------------------------------------------------------------------

test('2. a point the boundary service resolves to HORRY is served by Horry\'s own layer', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'HORRY' } }] })],
    [HORRY_URL, okJson({ features: [HORRY_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(33.8893, -78.6900);
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'HORRY:30413010131');
  assert.equal(parcel.sourceAgency, config.counties.HORRY.sourceAgency);
});

// -- 3. unsupported county => no provider --------------------------------------------------------------

test('3. a point the boundary service resolves to an unsupported county returns null, never a fake-empty result', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'RICHLAND' } }] })],
  ]);
  const parcel = await provider.identifyParcel(34.0, -80.9);
  assert.equal(parcel, null);
  assert.equal(calls.length, 1, 'never queries any parcel layer for an unsupported county');
});

test('3b. a point the coarse coverage bbox rejects outright never even reaches the boundary service', async () => {
  const { provider, calls } = providerWith([]);
  const parcel = await provider.identifyParcel(40.0, -75.0); // nowhere near SC
  assert.equal(parcel, null);
  assert.equal(calls.length, 0);
});

// -- 4. viewport query for a supported county ------------------------------------------------------------

test('4. getParcelsInViewport queries only the county whose own bbox intersects the viewport', async () => {
  const { provider, calls } = providerWith([
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 34.95, west: -81.09, north: 34.97, east: -81.07 });
  assert.equal(result.parcels.length, 1);
  assert.equal(result.parcels[0].parcelId, 'YORK:5400000013');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(YORK_URL));
});

test('4b. a viewport over neither supported county\'s bbox returns an empty, non-saturated result with zero upstream calls', async () => {
  const { provider, calls } = providerWith([]);
  const result = await provider.getParcelsInViewport({ south: 34.0, west: -80.5, north: 34.02, east: -80.48 });
  assert.deepEqual(result, { parcels: [], saturated: false });
  assert.equal(calls.length, 0);
});

// -- 5. outSR=4326 -----------------------------------------------------------------------------------

test('5. every query (boundary, viewport, identify) always requests outSR=4326', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'YORK' } }] })],
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  await provider.identifyParcel(34.9618, -81.0824);
  for (const url of calls) assert.ok(url.includes('outSR=4326'), url);
});

// -- 6. parcel-id normalization (county namespacing) ------------------------------------------------------

test('6. every returned parcelId is namespaced with its county, and getParcelById round-trips it', async () => {
  const { provider, calls } = providerWith([
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.getParcelById('YORK:5400000013');
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'YORK:5400000013');
  const decoded = decodeURIComponent(calls[0].replace(/\+/g, ' '));
  assert.ok(decoded.includes("ParcelID = '5400000013'"), decoded);
});

test('6b. getParcelById for an unsupported county prefix returns null without any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  const parcel = await provider.getParcelById('RICHLAND:1');
  assert.equal(parcel, null);
  assert.equal(calls.length, 0, 'an invalid parcelId never even passes the pattern check');
});

// -- 7. safe fallback identity (OBJECTID) -------------------------------------------------------------

test('7. the OBJECTID fallback is namespaced per-county and can never collide across counties', async () => {
  const { provider } = providerWith([
    [YORK_URL, okJson({ features: [{ attributes: { OBJECTID: 101, ParcelID: null, TAXMAPID: null, PropertyAddress: 'X' }, geometry: YORK_FEATURE_WITH_OWNER_FIELDS.geometry }] })],
  ]);
  const parcel = await provider.getParcelById('YORK:sc-oid-101');
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'YORK:sc-oid-101');
});

// -- 8/9. owner fields never requested, never exposed --------------------------------------------------

test('8. no outFields list for either county ever includes an owner/mailing field', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'YORK' } }] })],
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  await provider.identifyParcel(34.9618, -81.0824);
  await provider.getParcelById('YORK:5400000013');
  await provider.searchAddress('HOLLIS LAKES');
  for (const url of calls) {
    const outFields = (new URL(url).searchParams.get('outFields') || '').toLowerCase();
    for (const ownerField of ['owner1', 'owner2', 'previousowner', 'mailaddr', 'mailcity', 'mailstate', 'mailzip', 'mailapt', 'mailcountry', 'ownname']) {
      assert.equal(outFields.includes(ownerField), false, `${url} outFields must never include ${ownerField}`);
    }
  }
});

test('9. even when the upstream mock RETURNS owner-shaped attributes, the normalized parcel never exposes them', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'YORK' } }] })],
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(34.9618, -81.0824);
  assert.equal(parcel.owner.name, null, 'ownerName is never even read from attrs for this provider');
  const serialized = JSON.stringify(parcel).toLowerCase();
  assert.equal(serialized.includes('example owner'), false);
  assert.equal(serialized.includes('456 mail st'), false, 'mailing address never leaks either');
});

test('this provider module never names an owner/mailing field anywhere in its source', () => {
  const source = code('./southCarolinaCountyParcels.js').replace(/ownerName/g, '');
  for (const ownerField of ['Owner1', 'Owner2', 'PreviousOwner', 'MailAddr', 'MailCity', 'MailState', 'MailZip', 'OWNNAME']) {
    assert.equal(new RegExp(ownerField, 'i').test(source), false, ownerField);
  }
});

test('neither county config in the registry ever requests outFields: \'*\'', () => {
  const registrySource = fs.readFileSync(new URL('../parcelProviderRegistry.js', import.meta.url), 'utf8');
  const scSection = registrySource.slice(registrySource.indexOf("'sc-counties':"));
  assert.equal(/outFields\s*:\s*['"]\*['"]/.test(scSection), false);
});

// -- 10. county-crossing-lines behavior -----------------------------------------------------------------

test('10. a viewport that happens to intersect BOTH supported counties\' own bboxes queries both and merges results', async () => {
  // Synthetic scenario (York and Horry are never actually adjacent in real
  // data) purely to prove the merge logic itself never silently picks one
  // county over the other.
  const { provider } = providerWith([
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
    [HORRY_URL, okJson({ features: [HORRY_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  const wideBbox = { south: 33.3, west: -81.4, north: 35.25, east: -78.5 };
  const result = await provider.getParcelsInViewport(wideBbox);
  const ids = result.parcels.map((p) => p.parcelId).sort();
  assert.deepEqual(ids, ['HORRY:30413010131', 'YORK:5400000013']);
});

// -- 11. saturation -----------------------------------------------------------------------------------

test('11. saturation is reported when a county\'s own response exceeds the per-county remaining budget', async () => {
  const manyFeatures = Array.from({ length: 5 }, (_, i) => ({
    attributes: { OBJECTID: i, ParcelID: `ID${i}` }, geometry: YORK_FEATURE_WITH_OWNER_FIELDS.geometry,
  }));
  const { provider } = providerWith([
    [YORK_URL, okJson({ features: manyFeatures, exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 34.95, west: -81.09, north: 34.97, east: -81.07 }, { maxResults: 3 });
  assert.equal(result.parcels.length, 3);
  assert.equal(result.saturated, true);
});

// -- 12. detail normalization --------------------------------------------------------------------------

test('12. the normalized York parcel carries its safe fields; Horry\'s sparser schema omits what it lacks', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'YORK' } }] })],
    [YORK_URL, okJson({ features: [YORK_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const york = await provider.identifyParcel(34.9618, -81.0824);
  assert.equal(york.address.full, '930 HOLLIS LAKES RD');
  assert.equal(york.acreage, 2.89);
  assert.equal(york.acreageSource, 'assessor');
  assert.equal(york.landUse, 'RESIDENTIAL IMPROVED OC');
  assert.equal(york.zoning, null, 'York\'s schema has no zoning field');
  assert.equal(york.values.land, 50000);
  assert.equal(york.values.market, 256900);
  assert.equal(york.values.assessed, 6719);
  assert.equal(york.improvements.yearBuilt, 1998);
  assert.equal(york.improvements.buildingArea, 1652);

  const { provider: provider2 } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { County: 'HORRY' } }] })],
    [HORRY_URL, okJson({ features: [HORRY_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const horry = await provider2.identifyParcel(33.8893, -78.6900);
  assert.equal(horry.address.full, null, 'Horry has no address field at all');
  assert.equal(horry.landUse, null);
  assert.equal(horry.zoning, null);
  assert.equal(horry.values.land, 0);
  assert.equal(horry.values.improvements, 98600);
  assert.equal(horry.values.market, 98600);
  assert.equal(horry.acreageSource, 'computed', 'Horry has no assessor acreage field — derived from Shape__Area instead');
  assert.ok(horry.acreage > 0);
});

test('an invalid parcel id format is rejected before any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  assert.equal(await provider.getParcelById(''), null);
  assert.equal(await provider.getParcelById('; DROP TABLE'), null);
  assert.equal(calls.length, 0);
});
