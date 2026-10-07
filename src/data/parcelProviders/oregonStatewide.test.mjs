// Property Intelligence — Oregon statewide (beyond Deschutes) provider,
// exercised with a fake fetch and FIXTURE response bodies shaped exactly
// like the real FeatureServers' fields (confirmed live during research
// against each supported county's own public ArcGIS REST service, and
// Oregon's own statewide county-boundary FeatureServer). No network; the
// live services are never touched by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getParcelProviderConfig, resolveParcelProvider } from '../parcelProviderRegistry.js';
import { createOregonDeschutesProvider } from './oregonDeschutes.js';
import { createOregonStatewideProvider, OREGON_ODF_LAYER_IDS } from './oregonStatewide.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const config = getParcelProviderConfig('or-statewide');
const BOUNDARY_URL = `${config.countyBoundaryUrl}/query`;
const RLIS_URL = `${config.counties.MULTNOMAH.featureServerUrl}/3/query`;
const MARION_URL = `${config.counties.MARION.featureServerUrl}/2/query`;
const LANE_URL = `${config.counties.LANE.featureServerUrl}/2/query`;

const MULTNOMAH_FEATURE = {
  attributes: {
    FID: 1, ORTAXLOT: '1N117AA08200', TLID: '1N117AA08200', SITEADDR: '7813 NW 146TH TER',
    SITECITY: 'PORTLAND', SITEZIP: '97229', A_T_ACRES: 0.09, LANDUSE: 'VAC',
    TOTALVAL: 342000, ASSESSVAL: 184540, LANDVAL: 342000, BLDGVAL: 0, YEARBUILT: 2025, BLDGSQFT: 2485,
    COUNTY: 'M',
  },
  geometry: { rings: [[[-122.678, 45.577], [-122.677, 45.577], [-122.677, 45.576], [-122.678, 45.576], [-122.678, 45.577]]] },
};
const WASHINGTON_FEATURE = { ...MULTNOMAH_FEATURE, attributes: { ...MULTNOMAH_FEATURE.attributes, COUNTY: 'W' } };
const MARION_FEATURE = {
  attributes: { OBJECTID: 2, ORTaxlot: '2403.00S02.00W2900--000000400', MapTaxlot: '032W290000400', TaxlotAcre: 166.6, REFLink: 'https://mcasr.co.marion.or.us/PropertySummary.aspx?pid=510174&da=true' },
  geometry: { rings: [[[-122.964, 45.284], [-122.963, 45.284], [-122.963, 45.283], [-122.964, 45.283], [-122.964, 45.284]]] },
};
// Lane's real schema carries an owner/mailing block (OWNNAME/ADDR1-3/
// OWNERCITY/OWNERPRVST/OWNERZIP) with NO separate safe site-address field
// at all — used to prove this provider never reads it.
const LANE_FEATURE_WITH_OWNER_FIELDS = {
  attributes: {
    OBJECTID: 3, MAPTAXLOT: '1501000000100', TAXLOT: '00100', MAPACRES: 54.11808539,
    OWNNAME: 'EXAMPLE OWNER', ADDR1: '456 MAIL ST', OWNERCITY: 'EUGENE', OWNERPRVST: 'OR', OWNERZIP: '97401',
    PROPCLDES: 'Forest Land Highest & Best Use, Vacant', zoningdesc: 'Non-Impacted Forest',
    ASSDTOTVAL: 42908, TAXABLE_VALUE: 0, LANDVAL: 85187, IMPVAL: 0, YEARBLT: null,
  },
  geometry: { rings: [[[-122.754, 44.287], [-122.753, 44.287], [-122.753, 44.286], [-122.754, 44.286], [-122.754, 44.287]]] },
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
    provider: createOregonStatewideProvider({
      config, fetchImpl: f.impl, readCapped: passthroughReadCapped, now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
    }),
  };
}

// -- 1. provider registered -------------------------------------------------------------------------

test('1. or-statewide is registered and resolveParcelProvider resolves it via its own factory', () => {
  assert.ok(config);
  const provider = resolveParcelProvider('or-statewide', {});
  assert.ok(provider);
  for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getParcelsInViewport', 'getMetadata']) {
    assert.equal(typeof provider[op], 'function', op);
  }
});

// -- 2. all 36 county layer mappings -----------------------------------------------------------------

test('2. OREGON_ODF_LAYER_IDS documents all 36 confirmed-live ODF layer ids, 0-35, as reference only', () => {
  assert.equal(Object.keys(OREGON_ODF_LAYER_IDS).length, 36);
  const ids = Object.values(OREGON_ODF_LAYER_IDS).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 36 }, (_, i) => i));
  assert.equal(OREGON_ODF_LAYER_IDS.DESCHUTES, 8, 'confirmed live against the ODF service metadata');
  assert.equal(OREGON_ODF_LAYER_IDS.BAKER, 0);
  assert.equal(OREGON_ODF_LAYER_IDS.YAMHILL, 35);
  // Documentation only — never referenced by the provider's own request-building code.
  const providerSource = code('./oregonStatewide.js');
  const nonDeclarationUses = providerSource.split('OREGON_ODF_LAYER_IDS').length - 1;
  assert.ok(nonDeclarationUses <= 1, 'the constant is documentation, not request-shaping logic');
});

// -- 3. Oregon county resolution ----------------------------------------------------------------------

test('3. identifyParcel queries the real county-boundary service before any parcel layer', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Multnomah' } }] })],
    [RLIS_URL, okJson({ features: [MULTNOMAH_FEATURE] })],
  ]);
  const parcel = await provider.identifyParcel(45.5765, -122.6775);
  assert.ok(parcel);
  assert.ok(calls[0].startsWith(BOUNDARY_URL), 'the county-boundary service must be queried first');
  assert.ok(calls[1].startsWith(RLIS_URL), 'then the resolved county\'s own parcel layer');
  assert.equal(parcel.parcelId, 'MULTNOMAH:1N117AA08200');
});

// -- 4. unsupported/outside Oregon => no statewide provider --------------------------------------------

test('4. a point the boundary service resolves to an unsupported county returns null, never a fake-empty result', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Lincoln' } }] })],
  ]);
  const parcel = await provider.identifyParcel(44.6, -124.0);
  assert.equal(parcel, null);
  assert.equal(calls.length, 1, 'never queries any parcel layer for an unsupported county');
});

test('4b. a point the coarse coverage bbox rejects outright never even reaches the boundary service', async () => {
  const { provider, calls } = providerWith([]);
  const parcel = await provider.identifyParcel(40.0, -100.0); // nowhere near Oregon
  assert.equal(parcel, null);
  assert.equal(calls.length, 0);
});

// -- 5. Deschutes-specific provider takes precedence ---------------------------------------------------

test('5. a point the boundary service resolves to DESCHUTES returns null from the statewide provider — it never races or replaces the existing Deschutes provider', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Deschutes' } }] })],
  ]);
  const parcel = await provider.identifyParcel(44.0578, -121.3153); // Bend, confirmed Deschutes
  assert.equal(parcel, null, 'Deschutes is deliberately absent from config.counties');
  assert.equal(calls.length, 1, 'the boundary query happens, but no Deschutes parcel layer is ever queried by this provider');
});

test('5b. the registry\'s or-deschutes entry is completely untouched — it still resolves its own richer provider with DIAL/detail functionality intact', () => {
  const deschutesConfig = getParcelProviderConfig('or-deschutes');
  assert.ok(deschutesConfig);
  assert.equal(deschutesConfig.featureServerUrl, 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer');
  const deschutesProvider = resolveParcelProvider('or-deschutes', {});
  assert.ok(deschutesProvider);
  for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getParcelsInViewport', 'getMetadata']) {
    assert.equal(typeof deschutesProvider[op], 'function', op);
  }
  assert.equal(typeof createOregonDeschutesProvider, 'function', 'the Deschutes factory itself is still exported and usable, unmodified');
});

// -- 6. statewide viewport query ------------------------------------------------------------------------

test('6. getParcelsInViewport queries only the county whose own bbox intersects the viewport', async () => {
  const { provider, calls } = providerWith([
    [MARION_URL, okJson({ features: [MARION_FEATURE], exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 45.28, west: -122.97, north: 45.29, east: -122.96 });
  assert.equal(result.parcels.length, 1);
  assert.equal(result.parcels[0].parcelId, 'MARION:2403.00S02.00W2900--000000400');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(MARION_URL));
});

test('6b. a viewport over no supported county\'s bbox returns an empty, non-saturated result with zero upstream calls', async () => {
  const { provider, calls } = providerWith([]);
  const result = await provider.getParcelsInViewport({ south: 44.5, west: -124.2, north: 44.52, east: -124.18 });
  assert.deepEqual(result, { parcels: [], saturated: false });
  assert.equal(calls.length, 0);
});

// -- 7. cross-county viewport behavior ------------------------------------------------------------------

test('7. the three RLIS-backed counties never cross-contaminate — each viewport query carries its own countyFilterField/Value', async () => {
  const { provider, calls } = providerWith([
    [RLIS_URL, okJson({ features: [MULTNOMAH_FEATURE], exceededTransferLimit: false })],
  ]);
  await provider.getParcelsInViewport({ south: 45.4, west: -123.0, north: 45.65, east: -122.35 });
  const where = new URL(calls[0]).searchParams.get('where');
  assert.match(where, /COUNTY\s*=\s*'M'/);
});

test('7b. a viewport intersecting multiple supported counties\' own bboxes queries all of them and merges results', async () => {
  const { provider } = providerWith([
    [MARION_URL, okJson({ features: [MARION_FEATURE], exceededTransferLimit: false })],
    [LANE_URL, okJson({ features: [LANE_FEATURE_WITH_OWNER_FIELDS], exceededTransferLimit: false })],
  ]);
  // A synthetic wide bbox spanning both Marion's and Lane's configured bboxes.
  const result = await provider.getParcelsInViewport({ south: 43.4, west: -124.2, north: 45.3, east: -121.8 });
  const ids = result.parcels.map((p) => p.parcelId).sort();
  assert.deepEqual(ids, ['LANE:1501000000100', 'MARION:2403.00S02.00W2900--000000400']);
});

// -- 8. outSR=4326 --------------------------------------------------------------------------------------

test('8. every query (boundary, viewport, identify) always requests outSR=4326', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Marion' } }] })],
    [MARION_URL, okJson({ features: [MARION_FEATURE] })],
  ]);
  await provider.identifyParcel(45.284, -122.964);
  for (const url of calls) assert.ok(url.includes('outSR=4326'), url);
});

// -- 9. parcel identity normalization -------------------------------------------------------------------

test('9. every returned parcelId is namespaced with its county, and getParcelById round-trips it', async () => {
  const { provider, calls } = providerWith([
    [MARION_URL, okJson({ features: [MARION_FEATURE] })],
  ]);
  const parcel = await provider.getParcelById('MARION:2403.00S02.00W2900--000000400');
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'MARION:2403.00S02.00W2900--000000400');
  const decoded = decodeURIComponent(calls[0].replace(/\+/g, ' '));
  assert.ok(decoded.includes("ORTaxlot = '2403.00S02.00W2900--000000400'"), decoded);
});

test('9b. getParcelById for an unsupported county prefix returns null without any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  const parcel = await provider.getParcelById('DESCHUTES:1');
  assert.equal(parcel, null);
  assert.equal(calls.length, 0, 'an invalid parcelId never even passes the pattern check');
});

// -- 10. deterministic OBJECTID fallback -----------------------------------------------------------------

test('10. the OBJECTID fallback is namespaced per-county and can never collide across counties', async () => {
  const { provider } = providerWith([
    [MARION_URL, okJson({ features: [{ attributes: { OBJECTID: 7, ORTaxlot: null, MapTaxlot: null }, geometry: MARION_FEATURE.geometry }] })],
  ]);
  const parcel = await provider.getParcelById('MARION:or-oid-7');
  assert.ok(parcel);
  assert.equal(parcel.parcelId, 'MARION:or-oid-7');
});

// -- 11/12. owner fields never requested, never exposed -----------------------------------------------

test('11. no outFields list for any county ever includes an owner/mailing field', async () => {
  const { provider, calls } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Lane' } }] })],
    [LANE_URL, okJson({ features: [LANE_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  await provider.identifyParcel(44.287, -122.754);
  await provider.getParcelById('LANE:1501000000100');
  for (const url of calls) {
    const outFields = (new URL(url).searchParams.get('outFields') || '').toLowerCase();
    for (const ownerField of ['ownname', 'addr1', 'addr2', 'addr3', 'ownercity', 'ownerprvst', 'ownerzip', 'feeowner', 'incareof', 'mailing_na', 'in_care_of', 'agent', 'm_address', 'm_city', 'm_state']) {
      assert.equal(outFields.includes(ownerField), false, `${url} outFields must never include ${ownerField}`);
    }
  }
});

test('12. even when the upstream mock RETURNS owner-shaped attributes, the normalized parcel never exposes them', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Lane' } }] })],
    [LANE_URL, okJson({ features: [LANE_FEATURE_WITH_OWNER_FIELDS] })],
  ]);
  const parcel = await provider.identifyParcel(44.287, -122.754);
  assert.equal(parcel.owner.name, null, 'ownerName is never even read from attrs for this provider');
  const serialized = JSON.stringify(parcel).toLowerCase();
  assert.equal(serialized.includes('example owner'), false);
  assert.equal(serialized.includes('456 mail st'), false, 'mailing address never leaks either, even if an upstream mock includes it');
  assert.equal(parcel.address.full, null, 'Lane has no separate safe site-address field — never read');
});

test('this provider module never names an owner/mailing field anywhere in its source', () => {
  const source = code('./oregonStatewide.js').replace(/ownerName/g, '');
  for (const ownerField of ['OWNNAME', 'OWNERCITY', 'OWNERPRVST', 'OWNERZIP', 'FEEOWNER', 'INCAREOF', 'MAILING_NA', 'IN_CARE_OF', 'M_ADDRESS', 'M_CITY']) {
    assert.equal(new RegExp(ownerField, 'i').test(source), false, ownerField);
  }
});

test('neither the registry nor the provider ever requests outFields: \'*\' for Oregon', () => {
  const registrySource = fs.readFileSync(new URL('../parcelProviderRegistry.js', import.meta.url), 'utf8');
  const orSection = registrySource.slice(registrySource.indexOf("'or-statewide':"));
  assert.equal(/outFields\s*:\s*['"]\*['"]/.test(orSection), false);
  assert.equal(/outFields\s*:\s*['"]\*['"]/.test(code('./oregonStatewide.js')), false);
});

// -- 13. saturation -----------------------------------------------------------------------------------

test('13. saturation is reported when a county\'s own response exceeds the per-county remaining budget', async () => {
  const manyFeatures = Array.from({ length: 5 }, (_, i) => ({
    attributes: { OBJECTID: i, ORTaxlot: `ID${i}` }, geometry: MARION_FEATURE.geometry,
  }));
  const { provider } = providerWith([
    [MARION_URL, okJson({ features: manyFeatures, exceededTransferLimit: false })],
  ]);
  const result = await provider.getParcelsInViewport({ south: 45.28, west: -122.97, north: 45.29, east: -122.96 }, { maxResults: 3 });
  assert.equal(result.parcels.length, 3);
  assert.equal(result.saturated, true);
});

// -- 14. detail normalization ---------------------------------------------------------------------------

test('14. the normalized parcel carries each county\'s own safe fields, including a genuine official-record link when present', async () => {
  const { provider } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Marion' } }] })],
    [MARION_URL, okJson({ features: [MARION_FEATURE] })],
  ]);
  const marion = await provider.identifyParcel(45.284, -122.964);
  assert.equal(marion.acreage, 166.6);
  assert.equal(marion.acreageSource, 'assessor');
  assert.equal(marion.officialLinks.length, 1);
  assert.equal(marion.officialLinks[0].url, 'https://mcasr.co.marion.or.us/PropertySummary.aspx?pid=510174&da=true');

  const { provider: provider2 } = providerWith([
    [BOUNDARY_URL, okJson({ features: [{ attributes: { COUNTY: 'Multnomah' } }] })],
    [RLIS_URL, okJson({ features: [MULTNOMAH_FEATURE] })],
  ]);
  const multnomah = await provider2.identifyParcel(45.5765, -122.6775);
  assert.equal(multnomah.address.full, '7813 NW 146TH TER');
  assert.equal(multnomah.address.city, 'PORTLAND');
  assert.equal(multnomah.values.market, 342000);
  assert.equal(multnomah.improvements.yearBuilt, 2025);
});

test('an invalid parcel id format is rejected before any upstream call', async () => {
  const { provider, calls } = providerWith([]);
  assert.equal(await provider.getParcelById(''), null);
  assert.equal(await provider.getParcelById('; DROP TABLE'), null);
  assert.equal(calls.length, 0);
});
