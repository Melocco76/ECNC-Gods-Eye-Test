// Property Intelligence A2.4: the Virginia statewide provider, exercised
// with a fake fetch and FIXTURE response bodies shaped exactly like the
// real FeatureServer's fields (confirmed live during A2.4 research against
// https://services.dwr.virginia.gov/arcgis/rest/services/Projects/VA_Parcels/FeatureServer/0).
// No network; the live service is never touched by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getParcelProviderConfig } from '../parcelProviderRegistry.js';
import { createVirginiaStatewideProvider, normalizeVaParcelId, VIEWPORT_GEOMETRY_GENERALIZATION_DEGREES } from './virginiaStatewide.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const config = getParcelProviderConfig('va-statewide');
const LAYER_URL = `${config.featureServerUrl}/0/query`;

// Real-field-shaped fixtures — includes the owner/mailing fields the
// upstream service genuinely publishes, specifically so the "never
// requested" tests below are testing something real, not a straw man.
const FULL_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 55123, PARCELID: '338499', LOCALITY: 'Richmond City',
    Owner1: 'EXAMPLE OWNER LLC', Owner2: null,
    Address: '456 MAIN ST', City: 'Richmond', State: 'VA', Zip: '23219',
    M_Address: '123 PO BOX', M_City: 'Richmond', M_State: 'VA', M_Zip: '23219',
    GPIN: 'E000-1234-567', PIN: null, MapNumber: 'E0001234', Shape__Area: 1202345.6,
  },
  geometry: { rings: [[[-77.449, 37.534], [-77.448, 37.534], [-77.448, 37.533], [-77.449, 37.533], [-77.449, 37.534]]] },
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
    provider: createVirginiaStatewideProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 9, 6, 12, 0, 0),
    }),
  };
}

// -- 2. provider registered / usable -------------------------------------------------------------------

test('2. the provider is registered and resolvable', () => {
  assert.ok(config);
  assert.equal(config.providerId, 'virginia-statewide');
});

// -- 12. parcel id normalization ------------------------------------------------------------------------

test('12. normalizeVaParcelId prefers PARCELID, falls back to a namespaced objectid id', () => {
  const layer = config.layers.parcels;
  assert.equal(normalizeVaParcelId({ PARCELID: '338499', OBJECTID: 99 }, layer), '338499');
  assert.equal(normalizeVaParcelId({ PARCELID: '', OBJECTID: 55123 }, layer), 'va-oid-55123', 'blank PARCELID falls through to the OBJECTID fallback');
  assert.equal(normalizeVaParcelId({ PARCELID: '   ', OBJECTID: 55123 }, layer), 'va-oid-55123', 'whitespace-only id counts as missing');
  assert.equal(normalizeVaParcelId({ PARCELID: null, OBJECTID: null }, layer), null, 'no stable identity at all -> null, never a thrown error or a fabricated id');
});

test('12b. the objectid fallback is namespaced so it can never collide with a real parcel id or another provider\'s own fallback', () => {
  const layer = config.layers.parcels;
  const id = normalizeVaParcelId({ PARCELID: null, OBJECTID: 7 }, layer);
  assert.equal(id, 'va-oid-7');
  assert.ok(config.parcelIdPattern.test(id), 'the fallback format must pass this provider\'s own parcelIdPattern');
});

test('getParcelById accepts a PARCELID or a va-oid- fallback id', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const byId = await provider.getParcelById('338499');
  assert.equal(byId.parcelId, '338499');
  assert.match(new URL(calls[0]).searchParams.get('where'), /PARCELID = '338499'/);

  const byOid = await provider.getParcelById('va-oid-55123');
  assert.equal(byOid.parcelId, '338499');
  assert.match(new URL(calls[1]).searchParams.get('where'), /OBJECTID = '55123'/);
});

test('an invalid parcel id format is rejected before any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  assert.equal(await provider.getParcelById(''), null);
  assert.equal(await provider.getParcelById('; DROP TABLE'), null);
  assert.equal(calls.length, 0);
});

// -- 8/10. viewport geometry + outSR -------------------------------------------------------------------

test('8. getParcelsInViewport returns real identity + geometry, nothing else', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 37.53, west: -77.45, north: 37.55, east: -77.42 });
  assert.equal(result.parcels.length, 1);
  assert.deepEqual(Object.keys(result.parcels[0]).sort(), ['geometry', 'parcelId']);
  assert.equal(result.parcels[0].parcelId, '338499');
  assert.equal(result.parcels[0].geometry.type, 'Polygon');
  assert.equal(result.saturated, false);
  assert.equal(calls.length, 1, 'exactly one upstream query for the whole viewport');
});

test('10. the viewport query always requests outSR=4326 (shared, provider-agnostic arcgisParcelQuery.js contract)', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [] })]]);
  await provider.getParcelsInViewport({ south: 37.53, west: -77.45, north: 37.55, east: -77.42 });
  assert.ok(calls[0].includes('outSR=4326'));
});

test('the viewport query generalizes geometry (maxAllowableOffset) to stay under the shared response-size cap — the confirmed live upstream-size quirk', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [] })]]);
  await provider.getParcelsInViewport({ south: 37.53, west: -77.45, north: 37.55, east: -77.42 });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('maxAllowableOffset'), String(VIEWPORT_GEOMETRY_GENERALIZATION_DEGREES));
});

test('a feature with neither PARCELID nor a usable objectid is dropped from the viewport, never emitted with a null id', async () => {
  const noIdFeature = { attributes: { OBJECTID: null, PARCELID: null }, geometry: FULL_FEATURE_WITH_OWNER_FIELDS.geometry };
  const { provider } = providerWith([[LAYER_URL, okJson({ features: [noIdFeature, FULL_FEATURE_WITH_OWNER_FIELDS] })]]);
  const result = await provider.getParcelsInViewport({ south: 37.53, west: -77.45, north: 37.55, east: -77.42 });
  assert.equal(result.parcels.length, 1);
  assert.equal(result.parcels[0].parcelId, '338499');
});

// -- 14/16. owner fields never requested, never exposed --------------------------------------------------

test('14. the viewport query\'s outFields never includes an owner/mailing field', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [] })]]);
  await provider.getParcelsInViewport({ south: 37.53, west: -77.45, north: 37.55, east: -77.42 });
  const url = new URL(calls[0]);
  const outFields = (url.searchParams.get('outFields') || '').toLowerCase();
  for (const ownerField of ['owner1', 'owner2', 'm_address', 'm_city', 'm_state', 'm_zip']) {
    assert.equal(outFields.includes(ownerField), false, `outFields must never include ${ownerField}`);
  }
});

test('14b. identify/getById/search outFields never include an owner/mailing field either', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  await provider.identifyParcel(37.534, -77.449);
  await provider.getParcelById('338499');
  await provider.searchAddress('MAIN ST');
  for (const url of calls) {
    const outFields = (new URL(url).searchParams.get('outFields') || '').toLowerCase();
    for (const ownerField of ['owner1', 'owner2', 'm_address', 'm_city', 'm_state', 'm_zip']) {
      assert.equal(outFields.includes(ownerField), false, `${url} outFields must never include ${ownerField}`);
    }
  }
});

test('16. even when the upstream mock RETURNS owner-shaped attributes, the normalized parcel never exposes them', async () => {
  const { provider } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(37.534, -77.449);
  assert.equal(parcel.owner.name, null, 'ownerName is never even read from attrs for this provider');
  const serialized = JSON.stringify(parcel).toLowerCase();
  assert.equal(serialized.includes('example owner llc'), false);
  assert.equal(serialized.includes('123 po box'), false, 'mailing address never leaks either');
});

test('16b. the normalized parcel carries the safe, non-owner fields confirmed live (address, locality-derived GPIN, computed acreage)', async () => {
  const { provider } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(37.534, -77.449);
  assert.equal(parcel.address.full, '456 MAIN ST');
  assert.equal(parcel.address.city, 'Richmond');
  assert.equal(parcel.accountId, 'E000-1234-567', 'GPIN used as the account identifier');
  assert.equal(parcel.acreageSource, 'computed', 'this dataset publishes no acreage field — always geometry-derived');
  assert.ok(parcel.acreage > 0);
  assert.equal(parcel.geometry.type, 'Polygon');
  assert.equal(parcel.sourceAgency, config.sourceAgency);
});

test('this provider module never names an owner/mailing field anywhere in its source', () => {
  const source = code('./virginiaStatewide.js');
  for (const ownerField of ['Owner1', 'Owner2', 'M_Address', 'M_City', 'M_State', 'M_Zip']) {
    assert.equal(new RegExp(ownerField, 'i').test(source), false, ownerField);
  }
});
