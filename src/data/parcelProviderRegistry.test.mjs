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

test('an unknown region resolves to null everywhere — never a default/fallback provider', () => {
  assert.equal(getParcelProviderConfig('nc-forsyth'), null, 'not built in Phase A1');
  assert.equal(getParcelProviderConfig(''), null);
  assert.equal(getParcelProviderConfig(undefined), null);
  assert.equal(getParcelProviderConfig({ toString: () => 'or-deschutes' }), null, 'must be a real string, not something that stringifies to a known key');
  assert.equal(isKnownParcelRegion('or-deschutes'), true);
  assert.equal(isKnownParcelRegion('or-portland'), false);
  assert.equal(resolveParcelProvider('does-not-exist', {}), null);
});

test('listParcelRegions reflects exactly the compiled-in registry keys', () => {
  assert.deepEqual(listParcelRegions(), Object.keys(PARCEL_PROVIDER_REGISTRY));
  assert.deepEqual(listParcelRegions(), ['or-deschutes'], 'Phase A1 ships exactly one region');
});

test('resolving a known region returns a usable provider object with the four required operations', () => {
  const provider = resolveParcelProvider('or-deschutes', {});
  assert.ok(provider);
  for (const op of ['identifyParcel', 'getParcelById', 'searchAddress', 'getParcelGeometry', 'getMetadata']) {
    assert.equal(typeof provider[op], 'function', op);
  }
});

test('the registry is frozen — no runtime mutation of a compiled-in host/layer id is possible', () => {
  assert.throws(() => { PARCEL_PROVIDER_REGISTRY['or-deschutes'].featureServerUrl = 'https://evil.example/'; }, TypeError);
  assert.throws(() => { PARCEL_PROVIDER_REGISTRY['nc-forsyth'] = { featureServerUrl: 'https://evil.example/' }; }, TypeError);
});

test('nothing in the registry module reads process.env or request input for a host/URL', () => {
  const source = read('./parcelProviderRegistry.js');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/req\.|request\./.test(source), false);
});
