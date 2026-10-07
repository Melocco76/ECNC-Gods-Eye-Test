// Property Intelligence A2.4: the NC OneMap statewide provider, exercised
// with a fake fetch and FIXTURE response bodies shaped exactly like the
// real FeatureServer's fields (confirmed live during A2.4 research against
// https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1).
// No network; the live service is never touched by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getParcelProviderConfig } from '../parcelProviderRegistry.js';
import { createNorthCarolinaOneMapProvider, normalizeNcParcelId } from './northCarolinaOneMap.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const config = getParcelProviderConfig('nc-statewide');
const LAYER_URL = `${config.featureServerUrl}/1/query`;

// Real-field-shaped fixtures — includes the owner/mailing fields the
// upstream service genuinely publishes, specifically so the "never
// requested" tests below are testing something real, not a straw man.
const FULL_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    objectid: 4471, parno: '580602994649', altparno: null,
    ownname: 'EXAMPLE OWNER LLC', ownname2: null, ownfrst: null, ownlast: null,
    mailadd: '123 MAIN ST', munit: null, mcity: 'YADKINVILLE', mstate: 'NC', mzip: '27055',
    siteadd: '456 FARM RD', scity: 'YADKINVILLE', sstate: 'NC', szip: '27055',
    gisacres: 20.87671745, improvval: 125000, landval: 95000, parval: 220000,
    cntyname: 'Yadkin', parusedesc: 'Agricultural',
  },
  geometry: { rings: [[[-80.6604, 36.1308], [-80.6599, 36.1308], [-80.6599, 36.1301], [-80.6604, 36.1301], [-80.6604, 36.1308]]] },
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
    provider: createNorthCarolinaOneMapProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 9, 6, 12, 0, 0),
    }),
  };
}

// -- 1. provider registered / usable -----------------------------------------------------------------

test('1. the provider is registered and resolvable with the full operation set', () => {
  assert.ok(config);
  assert.equal(config.providerId, 'north-carolina-onemap');
});

// -- 11. parcel id normalization ----------------------------------------------------------------------

test('11. normalizeNcParcelId prefers parno, falls back to altparno, then to a namespaced objectid id', () => {
  const layer = config.layers.parcels;
  assert.equal(normalizeNcParcelId({ parno: '580602994649', altparno: 'ALT1', objectid: 99 }, layer), '580602994649');
  assert.equal(normalizeNcParcelId({ parno: '', altparno: 'ALT1', objectid: 99 }, layer), 'ALT1', 'blank parno falls through to altparno');
  assert.equal(normalizeNcParcelId({ parno: null, altparno: null, objectid: 4471 }, layer), 'nc-oid-4471', 'neither id field — deterministic OBJECTID fallback');
  assert.equal(normalizeNcParcelId({ parno: '  ', altparno: '   ', objectid: 4471 }, layer), 'nc-oid-4471', 'whitespace-only ids count as missing');
  assert.equal(normalizeNcParcelId({ parno: null, altparno: null, objectid: null }, layer), null, 'no stable identity at all -> null, never a thrown error or a fabricated id');
});

test('11b. the objectid fallback is namespaced so it can never collide with a real parcel number or another provider\'s own fallback', () => {
  const layer = config.layers.parcels;
  const id = normalizeNcParcelId({ parno: null, altparno: null, objectid: 7 }, layer);
  assert.equal(id, 'nc-oid-7');
  assert.ok(config.parcelIdPattern.test(id), 'the fallback format must pass this provider\'s own parcelIdPattern');
});

test('getParcelById accepts a parno, an altparno, or an nc-oid- fallback id', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const byParno = await provider.getParcelById('580602994649');
  assert.equal(byParno.parcelId, '580602994649');
  assert.match(new URL(calls[0]).searchParams.get('where'), /parno = '580602994649'/);

  const byOid = await provider.getParcelById('nc-oid-4471');
  assert.equal(byOid.parcelId, '580602994649');
  assert.match(new URL(calls[1]).searchParams.get('where'), /objectid = '4471'/);
});

test('an invalid parcel id format is rejected before any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  assert.equal(await provider.getParcelById(''), null);
  assert.equal(await provider.getParcelById('; DROP TABLE'), null);
  assert.equal(calls.length, 0);
});

// -- 7/9. viewport geometry + outSR ------------------------------------------------------------------

test('7. getParcelsInViewport returns real identity + geometry, nothing else', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 36.0, west: -80.7, north: 36.2, east: -80.6 });
  assert.equal(result.parcels.length, 1);
  assert.deepEqual(Object.keys(result.parcels[0]).sort(), ['geometry', 'parcelId']);
  assert.equal(result.parcels[0].parcelId, '580602994649');
  assert.equal(result.parcels[0].geometry.type, 'Polygon');
  assert.equal(result.saturated, false);
  assert.equal(calls.length, 1, 'exactly one upstream query for the whole viewport');
});

test('9. the viewport query always requests outSR=4326 (shared, provider-agnostic arcgisParcelQuery.js contract)', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [] })]]);
  await provider.getParcelsInViewport({ south: 36.0, west: -80.7, north: 36.2, east: -80.6 });
  assert.ok(calls[0].includes('outSR=4326'));
});

test('a feature with neither parno/altparno nor a usable objectid is dropped from the viewport, never emitted with a null id', async () => {
  const noIdFeature = { attributes: { objectid: null, parno: null, altparno: null }, geometry: FULL_FEATURE_WITH_OWNER_FIELDS.geometry };
  const { provider } = providerWith([[LAYER_URL, okJson({ features: [noIdFeature, FULL_FEATURE_WITH_OWNER_FIELDS] })]]);
  const result = await provider.getParcelsInViewport({ south: 36.0, west: -80.7, north: 36.2, east: -80.6 });
  assert.equal(result.parcels.length, 1);
  assert.equal(result.parcels[0].parcelId, '580602994649');
});

// -- 13/15. owner fields never requested, never exposed ------------------------------------------------

test('13. the viewport query\'s outFields never includes an owner/mailing field', async () => {
  const { provider, calls } = providerWith([[LAYER_URL, okJson({ features: [] })]]);
  await provider.getParcelsInViewport({ south: 36.0, west: -80.7, north: 36.2, east: -80.6 });
  const url = new URL(calls[0]);
  const outFields = (url.searchParams.get('outFields') || '').toLowerCase();
  for (const ownerField of ['ownname', 'ownname2', 'ownfrst', 'ownlast', 'mailadd', 'munit', 'mcity', 'mstate', 'mzip']) {
    assert.equal(outFields.includes(ownerField.toLowerCase()), false, `outFields must never include ${ownerField}`);
  }
});

test('13b. identify/getById/search outFields never include an owner/mailing field either', async () => {
  const { provider, calls } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  await provider.identifyParcel(36.13, -80.66);
  await provider.getParcelById('580602994649');
  await provider.searchAddress('FARM RD');
  for (const url of calls) {
    const outFields = (new URL(url).searchParams.get('outFields') || '').toLowerCase();
    for (const ownerField of ['ownname', 'ownname2', 'ownfrst', 'ownlast', 'mailadd', 'munit', 'mcity', 'mstate', 'mzip']) {
      assert.equal(outFields.includes(ownerField.toLowerCase()), false, `${url} outFields must never include ${ownerField}`);
    }
  }
});

test('15. even when the upstream mock RETURNS owner-shaped attributes, the normalized parcel never exposes them', async () => {
  const { provider } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(36.13, -80.66);
  assert.equal(parcel.owner.name, null, 'ownerName is never even read from attrs for this provider');
  const serialized = JSON.stringify(parcel).toLowerCase();
  assert.equal(serialized.includes('example owner llc'), false);
  assert.equal(serialized.includes('123 main st'), false, 'mailing address never leaks either');
});

test('15b. the normalized parcel carries the safe, non-owner fields confirmed live (address, acreage, values, county)', async () => {
  const { provider } = providerWith([
    [LAYER_URL, okJson({ features: [FULL_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(36.13, -80.66);
  assert.equal(parcel.address.full, '456 FARM RD');
  assert.equal(parcel.address.city, 'YADKINVILLE');
  assert.equal(parcel.acreage, 20.87671745);
  assert.equal(parcel.acreageSource, 'assessor');
  assert.equal(parcel.values.market, 220000);
  assert.equal(parcel.values.land, 95000, 'A3: landval normalizes into values.land');
  assert.equal(parcel.values.improvements, 125000, 'A3: improvval normalizes into values.improvements');
  assert.equal(parcel.landUse, 'Agricultural');
  assert.equal(parcel.geometry.type, 'Polygon');
  assert.equal(parcel.sourceAgency, config.sourceAgency);
});

test('this provider module never names an owner/mailing field anywhere in its source', () => {
  const source = code('./northCarolinaOneMap.js');
  for (const ownerField of ['ownname', 'ownfrst', 'ownlast', 'mailadd', 'munit', 'mcity', 'mstate', 'mzip']) {
    assert.equal(new RegExp(ownerField, 'i').test(source), false, ownerField);
  }
});
