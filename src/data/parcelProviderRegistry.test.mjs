// Property Intelligence Phase A1: the fixed provider registry is the ONLY place
// a region key resolves to an upstream host. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  PARCEL_PROVIDER_REGISTRY,
  getParcelProviderConfig,
  isKnownParcelRegion,
  listParcelRegions,
  resolveParcelProvider,
} from './parcelProviderRegistry.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('or-deschutes is registered with the exact confirmed FeatureServer and layer ids', () => {
  const config = getParcelProviderConfig('or-deschutes');
  assert.ok(config);
  assert.equal(config.featureServerUrl, 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer');
  assert.equal(config.layers.taxlot.id, 0);
  assert.equal(config.layers.assessorAccount.id, 1);
  assert.equal(config.layers.improvements.id, 3);
  assert.equal(config.layers.owners.id, 5);
  assert.equal(config.layers.rollValues.id, 7);
  assert.equal(config.zoning.serviceUrl, 'https://maps.deschutes.org/arcgis/rest/services/OpenData/LandFD/MapServer/3');
  assert.equal(config.sourceAgency, "Deschutes County Assessor's Office");
});

// -- A2.4: NC OneMap + Virginia statewide registry entries ------------------------------------------

test('1. nc-statewide is registered with the exact confirmed FeatureServer, layer id, and field mapping', () => {
  const config = getParcelProviderConfig('nc-statewide');
  assert.ok(config);
  assert.equal(config.featureServerUrl, 'https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/FeatureServer');
  assert.equal(config.layers.parcels.id, 1, 'confirmed live: "Parcels (polys)"');
  assert.equal(config.layers.parcels.idField, 'parno');
  assert.equal(config.layers.parcels.altIdField, 'altparno');
  assert.equal(config.layers.parcels.objectIdField, 'objectid');
  assert.equal(config.state, 'NC');
  assert.match(config.sourceAgency, /NC OneMap/i);
});

test('2. va-statewide is registered with the exact confirmed FeatureServer, layer id, and field mapping', () => {
  const config = getParcelProviderConfig('va-statewide');
  assert.ok(config);
  assert.equal(config.featureServerUrl, 'https://services.dwr.virginia.gov/arcgis/rest/services/Projects/VA_Parcels/FeatureServer');
  assert.equal(config.layers.parcels.id, 0, 'confirmed live: "VA_Parcels"');
  assert.equal(config.layers.parcels.idField, 'PARCELID');
  assert.equal(config.layers.parcels.objectIdField, 'OBJECTID');
  assert.equal(config.state, 'VA');
  assert.match(config.sourceAgency, /Virginia|VGIN/i);
});

test('an unknown region resolves to null everywhere — never a default/fallback provider', () => {
  assert.equal(getParcelProviderConfig('nc-forsyth'), null, 'per-county NC id not built — this provider is statewide');
  assert.equal(getParcelProviderConfig(''), null);
  assert.equal(getParcelProviderConfig(undefined), null);
  assert.equal(getParcelProviderConfig({ toString: () => 'or-deschutes' }), null, 'must be a real string, not something that stringifies to a known key');
  assert.equal(isKnownParcelRegion('or-deschutes'), true);
  assert.equal(isKnownParcelRegion('or-portland'), false);
  assert.equal(resolveParcelProvider('does-not-exist', {}), null);
});

test('listParcelRegions reflects exactly the compiled-in registry keys', () => {
  assert.deepEqual(listParcelRegions(), Object.keys(PARCEL_PROVIDER_REGISTRY));
  assert.deepEqual(listParcelRegions(), ['or-deschutes', 'nc-statewide', 'va-statewide'], 'A2.4 ships three regions');
});

test('resolving any known region returns a usable provider object with the five required operations — no region-specific special-casing in the resolver', () => {
  for (const region of listParcelRegions()) {
    const provider = resolveParcelProvider(region, {});
    assert.ok(provider, region);
    for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getParcelsInViewport', 'getMetadata']) {
      assert.equal(typeof provider[op], 'function', `${region}.${op}`);
    }
  }
});

test('the registry is frozen — no runtime mutation of a compiled-in host/layer id is possible', () => {
  assert.throws(() => { PARCEL_PROVIDER_REGISTRY['or-deschutes'].featureServerUrl = 'https://evil.example/'; }, TypeError);
  assert.throws(() => { PARCEL_PROVIDER_REGISTRY['nc-forsyth'] = { featureServerUrl: 'https://evil.example/' }; }, TypeError);
});

test('resolveParcelProvider dispatches purely via each entry\'s own compiled-in `factory` reference — no region-string branch in the resolver', () => {
  const source = read('./parcelProviderRegistry.js');
  // The resolver function body itself (not the module as a whole, which
  // legitimately names every providerId/region string in the registry
  // entries above it) must contain no `if`/`switch` keyed on a provider id
  // or region string.
  const resolverBody = source.slice(source.indexOf('export function resolveParcelProvider'));
  assert.equal(/providerId === |region === |case '/.test(resolverBody), false);
  assert.match(resolverBody, /config\.factory/);
});

test('every registered region carries owner: false except or-deschutes (Phase A1\'s pre-existing, server-side-only owner normalization)', () => {
  for (const region of listParcelRegions()) {
    const config = getParcelProviderConfig(region);
    if (region === 'or-deschutes') continue;
    assert.equal(config.capabilities.owner, false, region);
  }
});

test('nothing in the registry module reads process.env or request input for a host/URL', () => {
  const source = read('./parcelProviderRegistry.js');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/req\.|request\./.test(source), false);
});
