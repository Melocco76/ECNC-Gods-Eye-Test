// Property Intelligence — Tennessee statewide provider, exercised with a
// fake fetch and FIXTURE response bodies shaped exactly like the real
// FeatureServer's fields (confirmed live during research against
// https://geoviewer.cot.tn.gov/arcgis/rest/services/GeoViewer/GeoViewer_Parcels/MapServer/0).
// No network; the live service is never touched by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getParcelProviderConfig, resolveParcelProvider } from '../parcelProviderRegistry.js';
import { createTennesseeStatewideProvider, normalizeTnParcelId, TN_KNOWN_MISSING_COUNTIES } from './tennesseeStatewide.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const config = getParcelProviderConfig('tn-statewide');
const LAYER_URL = `${config.featureServerUrl}/0/query`;

// Real-field-shaped fixture — includes the owner/mailing fields the
// upstream service genuinely publishes, specifically so the "never
// requested"/"never exposed" tests below are testing something real, not a
// straw man. PARCELID deliberately embeds a different-looking tax year
// than GISLINK would suggest, matching the live-confirmed field quirk.
const FULL_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 1571, GISLINK: '018113D C 00100', GISLINK2: ' ', PARID: '113D C 00100 000', PARCELID: '018 113D C 00100 000 2027',
    OWNER: 'EXAMPLE OWNER LLC', OWNER2: null, OWNJAN1: 'EXAMPLE OWNER LLC', MAILADDR: '123 MAIN ST', MAILCITY: 'CROSSVILLE', STATE: 'TN', ZIP: '38555',
    ADDRESS: 'DAYTON AVE 517', CITYNUM: '177', COUNTY: 'CUMBERLAND',
    CALC_ACRE: 0.84236135, ZONING: 'R1', LANDUSE: '11 - HOUSEHOLD UNITS',
    LANDVAL: 15000, IMPVAL: 85000, APPRAISAL: 100000,
    YRBLT: 1998, SFLA: 1840, TAXYR: 2027,
  },
  geometry: { rings: [[[-85.0124, 35.9449], [-85.0117, 35.9449], [-85.0117, 35.9442], [-85.0124, 35.9442], [-85.0124, 35.9449]]] },
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
    provider: createTennesseeStatewideProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
    }),
  };
}

// -- 1/2. provider registered, factory resolves ---------------------------------------------------------

test('1. tn-statewide is registered with the exact confirmed FeatureServer, layer id, and field mapping', () => {
  assert.ok(config);
  assert.equal(config.featureServerUrl, 'https://geoviewer.cot.tn.gov/arcgis/rest/services/GeoViewer/GeoViewer_Parcels/MapServer');
  assert.equal(config.layers.parcels.id, 0);
  assert.equal(config.layers.parcels.idField, 'GISLINK');
  assert.equal(config.state, 'TN');
  assert.match(config.sourceAgency, /Tennessee Comptroller/i);
});

test('2. resolveParcelProvider resolves tn-statewide via its own factory, with the full operation set', () => {
  const provider = resolveParcelProvider('tn-statewide', {});
  assert.ok(provider);
  for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getParcelsInViewport', 'getMetadata']) {
    assert.equal(typeof provider[op], 'function', op);
  }
});

// -- 6/7. parcel id normalization + OBJECTID fallback ----------------------------------------------------

test('6. normalizeTnParcelId prefers GISLINK, then GISLINK2, then PARID, then PARCELID', () => {
  const layer = config.layers.parcels;
  assert.equal(normalizeTnParcelId({ GISLINK: '018113D C 00100', GISLINK2: 'X', PARID: 'Y', PARCELID: 'Z' }, layer), '018113D C 00100');
  assert.equal(normalizeTnParcelId({ GISLINK: '', GISLINK2: 'ALT1', PARID: 'Y', PARCELID: 'Z' }, layer), 'ALT1', 'blank GISLINK falls through to GISLINK2');
  assert.equal(normalizeTnParcelId({ GISLINK: ' ', GISLINK2: ' ', PARID: '113D C 00100 000', PARCELID: 'Z' }, layer), '113D C 00100 000', 'whitespace-only ids count as missing');
  assert.equal(normalizeTnParcelId({ GISLINK: null, GISLINK2: null, PARID: null, PARCELID: '018 113D C 00100 000 2027' }, layer), '018 113D C 00100 000 2027', 'PARCELID is the last real-field fallback (embeds tax year, least stable)');
});

test('7. the objectid fallback is namespaced so it can never collide with a real parcel id or another provider\'s own fallback', () => {
  const layer = config.layers.parcels;
  const id = normalizeTnParcelId({ GISLINK: null, GISLINK2: null, PARID: null, PARCELID: null, OBJECTID: 1571 }, layer);
  assert.equal(id, 'tn-oid-1571');
  assert.ok(config.parcelIdPattern.test(id), 'the fallback format must pass this provider\'s own parcelIdPattern');
  assert.equal(normalizeTnParcelId({ GISLINK: null, GISLINK2: null, PARID: null, PARCELID: null, OBJECTID: null }, layer), null, 'no stable identity at all -> null, never fabricated');
});

test('the parcelIdPattern accepts a real GISLINK\'s embedded spaces', () => {
  assert.ok(config.parcelIdPattern.test('018113D C 00100'));
});

// -- 4/5. viewport geometry + outSR -----------------------------------------------------------------------

test('4. getParcelsInViewport returns real identity + geometry, nothing else', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 35.93, west: -85.04, north: 35.97, east: -85.00 });
  assert.equal(result.parcels.length, 1);
  assert.deepEqual(Object.keys(result.parcels[0]).sort(), ['geometry', 'parcelId']);
  assert.equal(result.parcels[0].parcelId, '018113D C 00100');
  assert.equal(result.parcels[0].geometry.type, 'Polygon');
  assert.equal(result.saturated, false);
  assert.equal(calls.length, 1, 'exactly one upstream query for the whole viewport');
});

test('5. the viewport query always requests outSR=4326 (shared, provider-agnostic arcgisParcelQuery.js contract)', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [], exceededTransferLimit: false })]]);
  await provider.getParcelsInViewport({ south: 35.93, west: -85.04, north: 35.97, east: -85.00 });
  assert.ok(calls[0].includes('outSR=4326'));
});

// -- 10. saturation handling: exceededTransferLimit, since the server's own maxRecordCount (200) sits below maxResults (400) -----

test('10. saturation is derived from the upstream exceededTransferLimit flag, not merely a count comparison', async () => {
  // Exactly the confirmed-live scenario: the server silently caps at 200
  // even when 401 is requested, and flags the response instead.
  const twoHundredFeatures = Array.from({ length: 200 }, (_, i) => ({
    attributes: { OBJECTID: i, GISLINK: `TESTLINK${i}` },
    geometry: FULL_FEATURE_WITH_OWNER_FIELDS.geometry,
  }));
  const { provider } = providerWith([[LAYER_URL, okJson({ features: twoHundredFeatures, exceededTransferLimit: true })]]);
  const result = await provider.getParcelsInViewport({ south: 35.93, west: -85.04, north: 35.97, east: -85.00 }, { maxResults: 400 });
  assert.equal(result.parcels.length, 200, 'all 200 returned features pass through — 200 is well under the 400 public cap');
  assert.equal(result.saturated, true, 'exceededTransferLimit alone must mark this saturated, since features.length (200) never exceeds maxResults (400)');
});

test('10b. a genuinely complete (non-saturated) response is reported as such', async () => {
  const { provider } = providerWith([[LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })]]);
  const result = await provider.getParcelsInViewport({ south: 35.93, west: -85.04, north: 35.97, east: -85.00 });
  assert.equal(result.saturated, false);
});

test('a feature with no usable identity is dropped from the viewport, never emitted with a null id', async () => {
  const noIdFeature = { attributes: { OBJECTID: null, GISLINK: null, GISLINK2: null, PARID: null, PARCELID: null }, geometry: FULL_FEATURE_WITH_OWNER_FIELDS.geometry };
  const { provider } = providerWith([[LAYER_URL, okJson({ features: [noIdFeature, FULL_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })]]);
  const result = await provider.getParcelsInViewport({ south: 35.93, west: -85.04, north: 35.97, east: -85.00 });
  assert.equal(result.parcels.length, 1);
  assert.equal(result.parcels[0].parcelId, '018113D C 00100');
});

// -- 8/9. owner fields never requested, never exposed -------------------------------------------------

test('8. the viewport query\'s outFields never includes an owner/mailing field', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [], exceededTransferLimit: false })]]);
  await provider.getParcelsInViewport({ south: 35.93, west: -85.04, north: 35.97, east: -85.00 });
  const url = new URL(calls[0]);
  const outFields = (url.searchParams.get('outFields') || '').toLowerCase();
  for (const ownerField of ['owner', 'owner2', 'ownjan1', 'mailaddr', 'mailcity', 'mailline1', 'mailline2', 'mailline3', 'unlistown', 'unlistjan1', 'state', 'zip']) {
    assert.equal(outFields.includes(ownerField), false, `outFields must never include ${ownerField}`);
  }
});

test('8b. identify/getById/search outFields never include an owner/mailing field either', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  await provider.identifyParcel(35.9449, -85.0124);
  await provider.getParcelById('018113D C 00100');
  await provider.searchAddress('DAYTON AVE');
  for (const url of calls) {
    const outFields = (new URL(url).searchParams.get('outFields') || '').toLowerCase();
    for (const ownerField of ['owner', 'owner2', 'ownjan1', 'mailaddr', 'mailcity', 'mailline1', 'mailline2', 'mailline3', 'unlistown', 'unlistjan1', 'state', 'zip']) {
      assert.equal(outFields.includes(ownerField), false, `${url} outFields must never include ${ownerField}`);
    }
  }
});

test('9. even when the upstream mock RETURNS owner-shaped attributes, the normalized parcel never exposes them', async () => {
  const { provider } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  const parcel = await provider.identifyParcel(35.9449, -85.0124);
  assert.equal(parcel.owner.name, null, 'ownerName is never even read from attrs for this provider');
  const serialized = JSON.stringify(parcel).toLowerCase();
  assert.equal(serialized.includes('example owner llc'), false);
  assert.equal(serialized.includes('123 main st'), false, 'mailing address never leaks either');
  assert.equal(parcel.address.zip, null, 'ZIP sits in the ambiguous mailing block upstream and is never read');
});

test('this provider module never names an owner/mailing field anywhere in its source', () => {
  // `ownerName` (the generic `buildNormalizedParcel` parameter every
  // provider sets to `undefined`) is the one expected, safe occurrence of
  // the word "owner" — strip it before scanning for the actual upstream
  // field names, same convention as northCarolinaOneMap.test.mjs/
  // virginiaStatewide.test.mjs's equivalent guard.
  const source = code('./tennesseeStatewide.js').replace(/ownerName/g, '');
  for (const ownerField of ['OWNER', 'OWNJAN1', 'MAILADDR', 'MAILCITY', 'MAILLINE', 'UNLISTOWN', 'UNLISTJAN1']) {
    assert.equal(new RegExp(ownerField, 'i').test(source), false, ownerField);
  }
});

// -- 11. TN property detail normalization ------------------------------------------------------------

test('11. the normalized parcel carries the safe, non-owner fields confirmed live (address, acreage, zoning, land use, values, improvements)', async () => {
  const { provider } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  const parcel = await provider.identifyParcel(35.9449, -85.0124);
  assert.equal(parcel.address.full, 'DAYTON AVE 517');
  assert.equal(parcel.address.state, 'TN', 'fixed literal — never read from the ambiguous upstream STATE field');
  assert.equal(parcel.acreage, 0.84236135);
  assert.equal(parcel.acreageSource, 'assessor');
  assert.equal(parcel.zoning, 'R1');
  assert.equal(parcel.landUse, '11 - HOUSEHOLD UNITS');
  assert.equal(parcel.values.land, 15000);
  assert.equal(parcel.values.improvements, 85000);
  assert.equal(parcel.values.market, 100000);
  assert.equal(parcel.values.assessed, null, 'no distinct assessed-value field in this schema');
  assert.equal(parcel.improvements.yearBuilt, 1998);
  assert.equal(parcel.improvements.buildingArea, 1840);
  assert.equal(parcel.improvements.bedrooms, null, 'no bedroom/bathroom fields in this schema');
  assert.equal(parcel.geometry.type, 'Polygon');
  assert.equal(parcel.sourceAgency, config.sourceAgency);
  assert.deepEqual(parcel.officialLinks, []);
});

test('an invalid parcel id format is rejected before any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  assert.equal(await provider.getParcelById(''), null);
  assert.equal(await provider.getParcelById('; DROP TABLE'), null);
  assert.equal(calls.length, 0);
});

test('TN_KNOWN_MISSING_COUNTIES documents the live-confirmed gap and is never used to special-case a request', () => {
  assert.ok(TN_KNOWN_MISSING_COUNTIES.includes('DAVIDSON'));
  assert.ok(TN_KNOWN_MISSING_COUNTIES.includes('SHELBY'));
  assert.ok(TN_KNOWN_MISSING_COUNTIES.includes('KNOX'));
  assert.ok(TN_KNOWN_MISSING_COUNTIES.includes('HAMILTON'));
  const providerSource = code('./tennesseeStatewide.js');
  // Referenced only in the constant's own definition/docstring — never
  // branched on anywhere in the actual request-building code.
  const nonDeclarationUses = providerSource.split('TN_KNOWN_MISSING_COUNTIES').length - 1;
  assert.ok(nonDeclarationUses <= 1, 'the constant is documentation, not request-shaping logic');
});
