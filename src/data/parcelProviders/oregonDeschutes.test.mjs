// Property Intelligence Phase A1: the Deschutes County provider, exercised with
// a fake fetch and FIXTURE response bodies shaped exactly like the real
// FeatureServer's fields (confirmed live during Phase A planning research).
// No network; the live service is never touched by this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getParcelProviderConfig } from '../parcelProviderRegistry.js';
import { createOregonDeschutesProvider } from './oregonDeschutes.js';

const config = getParcelProviderConfig('or-deschutes');
const TAXLOT_URL = `${config.featureServerUrl}/0/query`;
const ASSESSOR_URL = `${config.featureServerUrl}/1/query`;
const IMPROVEMENTS_URL = `${config.featureServerUrl}/3/query`;
const OWNERS_URL = `${config.featureServerUrl}/5/query`;
const ROLLVALUES_URL = `${config.featureServerUrl}/7/query`;
const ZONING_URL = `${config.zoning.serviceUrl}/query`;

const TAXLOT_FEATURE = {
  attributes: { TAXLOT: '1408000000200', MAPNUMBER: '14080000000', DIAL: 'http://dial.deschutes.org/results/taxlot?value=1408000000200', 'Shape__Area': 4046.8564224 },
  geometry: { rings: [[[-121.7362, 44.3934], [-121.7358, 44.3934], [-121.7358, 44.3930], [-121.7362, 44.3930], [-121.7362, 44.3934]]] },
  centroid: { x: -121.736, y: 44.3932 },
};
const ASSESSOR_ROW = { attributes: { TaxLot: '1408000000200', Address: '61380 BROSTERHOUS RD', City: 'BEND', State: 'OR', Zip: '97702' } };
const IMPROVEMENTS_ROW = { attributes: { Taxlot: '1408000000200', Land_Size_Acres: 1.23, Year_Built_1: '1998', Total_Sqft_1: 2140, Garage_Sqft_1: 480, Bedrooms: 3, Bathrooms: 2 } };
const OWNERS_ROW = { attributes: { MAP_TAXLOT: '1408000000200', NAME: 'EXAMPLE OWNER LLC' } };
const ROLLVALUES_ROW = { attributes: { Taxlot: '1408000000200', RMV_Land: 220000, RMV_Impr: 278200, RMV_Total: 498200, AV_Total: 412340 } };
const ZONING_ROW = { attributes: { ZONE: 'RR10' } };

/** Fake fetch dispatched by URL prefix; each layer is independently swappable/failable per test. */
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
const httpError = (status) => async () => ({ ok: false, status });
const throwing = async () => { throw new Error('network down'); };
const passthroughReadCapped = async (response) => ({ tooLarge: false, text: await response.text() });

function fullProvider(overrides = {}) {
  const f = fakeFetch([
    ...(overrides.responses || []), // overrides win: checked before the defaults below
    [TAXLOT_URL, okJson({ features: [TAXLOT_FEATURE] })],
    [ASSESSOR_URL, okJson({ features: [ASSESSOR_ROW] })],
    [IMPROVEMENTS_URL, okJson({ features: [IMPROVEMENTS_ROW] })],
    [OWNERS_URL, okJson({ features: [OWNERS_ROW] })],
    [ROLLVALUES_URL, okJson({ features: [ROLLVALUES_ROW] })],
    [ZONING_URL, okJson({ features: [ZONING_ROW] })],
  ]);
  return {
    calls: f.calls,
    provider: createOregonDeschutesProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 8, 21, 18, 0, 0),
      ...overrides.providerOptions,
    }),
  };
}

// -- identify / getById: full assembly -------------------------------------------------------------

test('identifyParcel assembles every confirmed field from the related tables', async () => {
  const { provider } = fullProvider();
  const parcel = await provider.identifyParcel(44.3932, -121.736);
  assert.equal(parcel.parcelId, '1408000000200');
  assert.equal(parcel.taxLot, '1408000000200');
  assert.equal(parcel.address.full, '61380 BROSTERHOUS RD');
  assert.equal(parcel.address.city, 'BEND');
  assert.equal(parcel.acreage, 1.23);
  assert.equal(parcel.acreageSource, 'assessor');
  assert.equal(parcel.owner.name, 'EXAMPLE OWNER LLC');
  assert.equal(parcel.values.assessed, 412340);
  assert.equal(parcel.values.market, 498200);
  assert.equal(parcel.values.taxable, null);
  assert.equal(parcel.zoning, 'RR10');
  assert.equal(parcel.improvements.yearBuilt, 1998);
  assert.equal(parcel.improvements.buildingArea, 2140);
  assert.equal(parcel.improvements.garageArea, 480);
  assert.equal(parcel.improvements.bedrooms, 3);
  assert.equal(parcel.improvements.bathrooms, 2);
  assert.equal(parcel.geometry.type, 'Polygon');
  assert.equal(parcel.sourceAgency, "Deschutes County Assessor's Office");
  assert.equal(parcel.retrievedAt, '2026-09-21T18:00:00.000Z');
  assert.equal(parcel.effectiveDate, null, 'this provider never supplies one — never invented');
});

test('the DIAL official link is used VERBATIM as returned by the provider, never constructed/guessed here', () => {
  // asserted structurally: the provider module never builds a dial.deschutes.org URL itself
  const src = createOregonDeschutesProvider.toString();
  assert.equal(/dial\.deschutes\.org/i.test(src), false, 'no hardcoded DIAL host/template anywhere in the provider');
});

test('identifyParcel returns the exact DIAL value from the Taxlot feature as the only official link', async () => {
  const { provider } = fullProvider();
  const parcel = await provider.identifyParcel(44.3932, -121.736);
  assert.deepEqual(parcel.officialLinks, [{ label: 'Official Deschutes County Property Record (DIAL)', url: 'http://dial.deschutes.org/results/taxlot?value=1408000000200' }]);
});

test('getParcelById returns the same assembled shape as identify, for a validated taxlot id', async () => {
  const { provider, calls } = fullProvider();
  const parcel = await provider.getParcelById('1408000000200');
  assert.equal(parcel.parcelId, '1408000000200');
  assert.ok(decodeURIComponent(calls[0].replace(/\+/g, ' ')).includes("TAXLOT = '1408000000200'"));
});

test('getParcelById rejects a malformed id WITHOUT making any network call', async () => {
  const { provider, calls } = fullProvider();
  for (const bad of ["1408' OR '1'='1", 'toolongtoolongtoolong', '', 'has space', null, 42]) {
    const parcel = await provider.getParcelById(bad);
    assert.equal(parcel, null, JSON.stringify(bad));
  }
  assert.deepEqual(calls, [], 'no upstream request for any invalid id');
});

test('identifyParcel rejects out-of-coverage coordinates WITHOUT making any network call', async () => {
  const { provider, calls } = fullProvider();
  const parcel = await provider.identifyParcel(45.5, -122.6); // Portland, OR — outside Deschutes County
  assert.equal(parcel, null);
  assert.deepEqual(calls, []);
});

test('identify/getById on a taxlot with no feature returns null cleanly', async () => {
  const f = fakeFetch([[TAXLOT_URL, okJson({ features: [] })]]);
  const provider = createOregonDeschutesProvider({ config, fetchImpl: f.impl, readCapped: passthroughReadCapped });
  assert.equal(await provider.identifyParcel(44.3932, -121.736), null);
});

// -- missing/absent related data does not fail the parcel --------------------------------------------

test('a parcel with NO improvements/owner/rollValues/assessor row still returns, with those fields null', async () => {
  const f = fakeFetch([
    [TAXLOT_URL, okJson({ features: [TAXLOT_FEATURE] })],
    [ASSESSOR_URL, okJson({ features: [] })],
    [IMPROVEMENTS_URL, okJson({ features: [] })],
    [OWNERS_URL, okJson({ features: [] })],
    [ROLLVALUES_URL, okJson({ features: [] })],
    [ZONING_URL, okJson({ features: [] })],
  ]);
  const provider = createOregonDeschutesProvider({ config, fetchImpl: f.impl, readCapped: passthroughReadCapped });
  const parcel = await provider.identifyParcel(44.3932, -121.736);
  assert.equal(parcel.parcelId, '1408000000200', 'the taxlot itself still resolves');
  assert.equal(parcel.address.full, null);
  assert.equal(parcel.owner.name, null);
  assert.equal(parcel.values.assessed, null);
  assert.equal(parcel.zoning, null);
  assert.equal(parcel.improvements.yearBuilt, null);
  // Shape__Area IS present on the taxlot feature itself, so acreage still computes as a fallback.
  assert.equal(parcel.acreageSource, 'computed');
});

test('zoning is optional enrichment: a failing/unavailable zoning service never fails the parcel lookup', async () => {
  const { provider: viaHttpError } = fullProvider({ responses: [[ZONING_URL, httpError(503)]] });
  const p1 = await viaHttpError.identifyParcel(44.3932, -121.736);
  assert.equal(p1.zoning, null);
  assert.equal(p1.parcelId, '1408000000200', 'the rest of the parcel is unaffected');

  const { provider: viaThrow } = fullProvider({ responses: [[ZONING_URL, throwing]] });
  const p2 = await viaThrow.identifyParcel(44.3932, -121.736);
  assert.equal(p2.zoning, null);
  assert.equal(p2.values.assessed, 412340, 'other tables are unaffected by the zoning failure');
});

test('any single related-table upstream failure (5xx, thrown, malformed JSON) degrades that table to absent, never throws', async () => {
  for (const [layerUrl, bad] of [[ASSESSOR_URL, httpError(500)], [IMPROVEMENTS_URL, throwing], [OWNERS_URL, async () => ({ ok: true, text: async () => 'not json' })], [ROLLVALUES_URL, httpError(429)]]) {
    const { provider } = fullProvider({ responses: [[layerUrl, bad]] });
    const parcel = await provider.identifyParcel(44.3932, -121.736);
    assert.equal(parcel.parcelId, '1408000000200', layerUrl);
  }
});

test('a response the size cap rejects is treated as absent, not thrown', async () => {
  // Only the assessor-account response is marked "too large"; every other layer's response is capped normally.
  const cappingReadCapped = async (response) => {
    const text = await response.text();
    return response._url === ASSESSOR_URL ? { tooLarge: true, text: '' } : { tooLarge: false, text };
  };
  const tagged = (url, respond) => [url, async (u) => ({ ...(await respond(u)), _url: url })];
  const f = fakeFetch([
    tagged(TAXLOT_URL, okJson({ features: [TAXLOT_FEATURE] })),
    tagged(ASSESSOR_URL, okJson({ features: [ASSESSOR_ROW] })), // marked oversize above regardless of actual body size
    tagged(IMPROVEMENTS_URL, okJson({ features: [] })),
    tagged(OWNERS_URL, okJson({ features: [] })),
    tagged(ROLLVALUES_URL, okJson({ features: [] })),
    tagged(ZONING_URL, okJson({ features: [] })),
  ]);
  const provider = createOregonDeschutesProvider({ config, fetchImpl: f.impl, readCapped: cappingReadCapped });
  const parcel = await provider.identifyParcel(44.3932, -121.736);
  assert.equal(parcel.address.full, null, 'the oversize response never reaches JSON.parse or the model');
  assert.equal(parcel.parcelId, '1408000000200');
});

test('an upstream timeout (AbortSignal firing) degrades that table to absent, never throws out of the provider', async () => {
  const abortingFetch = async (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const f = fakeFetch([
    [TAXLOT_URL, okJson({ features: [TAXLOT_FEATURE] })],
    [ASSESSOR_URL, okJson({ features: [ASSESSOR_ROW] })],
    [IMPROVEMENTS_URL, okJson({ features: [IMPROVEMENTS_ROW] })],
    [OWNERS_URL, okJson({ features: [OWNERS_ROW] })],
    [ROLLVALUES_URL, okJson({ features: [ROLLVALUES_ROW] })],
    [ZONING_URL, okJson({ features: [ZONING_ROW] })],
  ]);
  const provider = createOregonDeschutesProvider({ config, fetchImpl: async (url, init) => (url.startsWith(ZONING_URL) ? abortingFetch(url, init) : f.impl(url, init)), readCapped: passthroughReadCapped, timeoutMs: 1 });
  const parcel = await provider.identifyParcel(44.3932, -121.736);
  assert.equal(parcel.zoning, null);
  assert.equal(parcel.parcelId, '1408000000200');
});

// -- geometry-only ---------------------------------------------------------------------------------

test('getParcelGeometry fetches ONLY the taxlot layer — no related-table calls at all', async () => {
  const { provider, calls } = fullProvider();
  const geometry = await provider.getParcelGeometry('1408000000200');
  assert.equal(geometry.type, 'Polygon');
  assert.equal(calls.length, 1, 'geometry-only lookup makes exactly one upstream request');
  assert.ok(calls[0].startsWith(TAXLOT_URL));
});

test('getParcelGeometry rejects an invalid id without any network call', async () => {
  const { provider, calls } = fullProvider();
  assert.equal(await provider.getParcelGeometry('bad id!'), null);
  assert.deepEqual(calls, []);
});

// -- address search: bounded, compact, no owner search anywhere ---------------------------------------

test('searchAddress returns compact rows and queries ONLY the assessor-account table (never owners, never full parcel assembly)', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ attributes: { TaxLot: `TL${i}`, Address: `${i} BROSTERHOUS RD`, City: 'BEND', State: 'OR', Zip: '97702' } }));
  const f = fakeFetch([[ASSESSOR_URL, okJson({ features: rows })]]);
  const provider = createOregonDeschutesProvider({ config, fetchImpl: f.impl, readCapped: passthroughReadCapped });
  const results = await provider.searchAddress('Brosterhous Rd');
  assert.ok(results.length <= config.search.resultCap, `capped at ${config.search.resultCap}`);
  assert.deepEqual(Object.keys(results[0]).sort(), ['address', 'city', 'parcelId', 'state', 'zip']);
  assert.equal(f.calls.length, 1, 'exactly one upstream request for a search');
  assert.equal(f.calls[0].startsWith(ASSESSOR_URL), true, 'owners/improvements/rollValues are never queried for a search');
});

test('searchAddress rejects an invalid query without any network call: too short, too long, wildcard-only, punctuation-only', async () => {
  const { provider, calls } = fullProvider();
  for (const bad of ['a', 'x'.repeat(200), '%%%', '...', '']) {
    assert.deepEqual(await provider.searchAddress(bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(calls, []);
});

test('searchAddress never exposes an owner-name search: no code path here accepts or forwards an owner parameter', () => {
  const src = createOregonDeschutesProvider.toString();
  assert.equal(/searchAddress\s*\([^)]*owner/i.test(src), false);
});

test('the provider module never queries the owners table from searchAddress (source-level guarantee)', () => {
  const src = createOregonDeschutesProvider.toString();
  const searchFn = src.slice(src.indexOf('async searchAddress'), src.indexOf('async searchAddress') + src.slice(src.indexOf('async searchAddress')).indexOf('\n    },'));
  assert.equal(/owners/i.test(searchFn), false, 'searchAddress must never reference the owners table');
});

// -- metadata ---------------------------------------------------------------------------------------

test('getMetadata makes no network call and reports the fixed capability set', async () => {
  const { provider, calls } = fullProvider();
  const meta = provider.getMetadata();
  assert.equal(meta.providerId, 'oregon-deschutes-county');
  assert.equal(meta.sourceAgency, "Deschutes County Assessor's Office");
  assert.equal(meta.capabilities.owner, true);
  assert.equal(meta.capabilities.taxable, false);
  assert.deepEqual(calls, []);
});
