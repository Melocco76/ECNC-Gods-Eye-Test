// Property Intelligence Phase A1: pure normalization/validation/geometry unit tests.
// No network. Fixture shapes mirror the real fields confirmed against the live
// Deschutes County FeatureServer during Phase A planning research.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildNormalizedParcel,
  buildSearchResult,
  escapeArcgisTextLiteral,
  esriPolygonToGeoJsonGeometry,
  isValidLatitude,
  isValidLongitude,
  isValidParcelId,
  isWithinCoverageBbox,
  toPublicParcel,
  validateAddressQuery,
} from './parcelProviderData.js';

const BBOX = { west: -122.05, south: 43.55, east: -119.85, north: 44.45 };
const TAXLOT_PATTERN = /^[A-Z0-9]{1,13}$/;

// -- validators -----------------------------------------------------------------------------------

test('latitude/longitude validators accept only finite in-range numbers', () => {
  assert.equal(isValidLatitude(44.05), true);
  assert.equal(isValidLatitude(90), true);
  assert.equal(isValidLatitude(-90), true);
  assert.equal(isValidLatitude(90.0001), false);
  assert.equal(isValidLatitude(NaN), false);
  assert.equal(isValidLatitude(Infinity), false);
  assert.equal(isValidLatitude('44'), false);
  assert.equal(isValidLongitude(-121.3), true);
  assert.equal(isValidLongitude(180), true);
  assert.equal(isValidLongitude(-180.1), false);
  assert.equal(isValidLongitude(undefined), false);
});

test('coverage bbox rejects points outside Deschutes County and any invalid coordinate', () => {
  assert.equal(isWithinCoverageBbox(44.05, -121.3, BBOX), true, 'Bend, OR is inside');
  assert.equal(isWithinCoverageBbox(45.5, -122.6, BBOX), false, 'Portland, OR is outside');
  assert.equal(isWithinCoverageBbox(37.77, -122.41, BBOX), false, 'San Francisco is outside');
  assert.equal(isWithinCoverageBbox(NaN, -121.3, BBOX), false);
  assert.equal(isWithinCoverageBbox(44.05, -121.3, null), false);
});

test('parcel-id format check matches real Deschutes taxlot ids and rejects everything else', () => {
  assert.equal(isValidParcelId('1408000000200', TAXLOT_PATTERN), true, 'all-numeric taxlot');
  assert.equal(isValidParcelId('181209AC00700', TAXLOT_PATTERN), true, 'alphanumeric taxlot');
  assert.equal(isValidParcelId('', TAXLOT_PATTERN), false);
  assert.equal(isValidParcelId('14080000002001234567890', TAXLOT_PATTERN), false, 'too long');
  assert.equal(isValidParcelId("1408' OR '1'='1", TAXLOT_PATTERN), false, 'injection attempt');
  assert.equal(isValidParcelId('lowercase123', TAXLOT_PATTERN), false, 'lower case rejected');
  assert.equal(isValidParcelId(null, TAXLOT_PATTERN), false);
  assert.equal(isValidParcelId(12345, TAXLOT_PATTERN), false, 'non-string rejected outright');
});

test('address search validation enforces length bounds, an allowlist, and rejects punctuation-only input', () => {
  assert.deepEqual(validateAddressQuery('Brosterhous Rd', { minLength: 3, maxLength: 80 }), { ok: true, value: 'Brosterhous Rd' });
  assert.equal(validateAddressQuery('ab', { minLength: 3, maxLength: 80 }).ok, false, 'too short');
  assert.equal(validateAddressQuery('a'.repeat(81), { minLength: 3, maxLength: 80 }).ok, false, 'too long');
  assert.equal(validateAddressQuery('...---...', { minLength: 3, maxLength: 80 }).ok, false, 'no alphanumeric content');
  assert.equal(validateAddressQuery("61380 Brosterhous%' OR 1=1--", { minLength: 3, maxLength: 80 }).ok, false, 'wildcard/SQL metacharacters rejected');
  assert.equal(validateAddressQuery('61380 Brosterhous_Rd', { minLength: 3, maxLength: 80 }).ok, false, 'underscore (LIKE wildcard) rejected');
  assert.equal(validateAddressQuery('SW Century Dr #4', { minLength: 3, maxLength: 80 }).ok, true, 'unit-number punctuation is allowed');
  assert.equal(validateAddressQuery('   spaced   out   ', { minLength: 3, maxLength: 80 }).value, 'spaced out', 'whitespace is collapsed/trimmed');
  assert.equal(validateAddressQuery(42, { minLength: 3, maxLength: 80 }).ok, false, 'non-string rejected');
});

test('SQL-literal escaping doubles single quotes and nothing else', () => {
  assert.equal(escapeArcgisTextLiteral("O'Brien"), "O''Brien");
  assert.equal(escapeArcgisTextLiteral('Brosterhous'), 'Brosterhous');
  assert.equal(escapeArcgisTextLiteral("'; DROP TABLE Taxlot; --"), "''; DROP TABLE Taxlot; --", 'quotes doubled, not stripped — still a literal string once quoted');
});

// -- geometry ---------------------------------------------------------------------------------------

test('a single-ring esri polygon becomes a GeoJSON Polygon with no holes', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]; // Esri exterior winding (clockwise, negative signed area)
  const geo = esriPolygonToGeoJsonGeometry({ rings: [square] });
  assert.deepEqual(geo, { type: 'Polygon', coordinates: [square] });
});

test('a second, opposite-winding ring nested inside the first becomes its hole; a fresh clockwise ring starts a new polygon', () => {
  const outerCW = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]; // clockwise (negative signed area) -> exterior
  const holeCCW = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]; // counter-clockwise (positive signed area), nested inside outerCW -> hole
  const secondOuterCW = [[20, 0], [20, 10], [30, 10], [30, 0], [20, 0]]; // clockwise again -> a second, separate polygon
  const geo = esriPolygonToGeoJsonGeometry({ rings: [outerCW, holeCCW, secondOuterCW] });
  assert.equal(geo.type, 'MultiPolygon');
  assert.equal(geo.coordinates.length, 2, 'two exterior rings -> two polygons');
  assert.equal(geo.coordinates[0].length, 2, 'first polygon carries its hole');
  assert.deepEqual(geo.coordinates[0][1], holeCCW);
  assert.equal(geo.coordinates[1].length, 1, 'second polygon has no hole');
});

test('degenerate/absent geometry is null, not thrown', () => {
  assert.equal(esriPolygonToGeoJsonGeometry(null), null);
  assert.equal(esriPolygonToGeoJsonGeometry(undefined), null);
  assert.equal(esriPolygonToGeoJsonGeometry({}), null);
  assert.equal(esriPolygonToGeoJsonGeometry({ rings: [] }), null);
  assert.equal(esriPolygonToGeoJsonGeometry({ rings: [[[0, 0], [1, 1]]] }), null, 'too few points to close a ring');
});

// -- normalization ------------------------------------------------------------------------------------

const FULL_INPUT = {
  providerId: 'oregon-deschutes-county',
  sourceAgency: "Deschutes County Assessor's Office",
  sourceUrl: 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer',
  retrievedAt: '2026-09-21T12:00:00.000Z',
  parcelId: '1408000000200', taxLot: '1408000000200',
  addressFull: '61380 BROSTERHOUS RD', city: 'BEND', state: 'OR', zip: '97702',
  acreageAssessor: 1.23,
  ownerName: 'EXAMPLE OWNER LLC',
  assessedValue: 412340, marketValue: 498200,
  zoning: 'RR10',
  yearBuilt: '1998', buildingArea: 2140, garageArea: 480, bedrooms: 3, bathrooms: 2,
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  officialLinks: [{ label: 'Official Deschutes County Property Record (DIAL)', url: 'http://dial.deschutes.org/results/taxlot?value=1408000000200' }],
};

test('a fully-populated record normalizes every field, including the acreage/source pairing', () => {
  const parcel = buildNormalizedParcel(FULL_INPUT);
  assert.equal(parcel.parcelId, '1408000000200');
  assert.equal(parcel.address.full, '61380 BROSTERHOUS RD');
  assert.equal(parcel.acreage, 1.23);
  assert.equal(parcel.acreageSource, 'assessor');
  assert.equal(parcel.owner.name, 'EXAMPLE OWNER LLC');
  assert.equal(parcel.values.assessed, 412340);
  assert.equal(parcel.values.market, 498200);
  assert.equal(parcel.values.taxable, null, 'this provider never supplies a distinct taxable value');
  assert.equal(parcel.zoning, 'RR10');
  assert.equal(parcel.improvements.yearBuilt, 1998);
  assert.equal(parcel.improvements.buildingArea, 2140);
  assert.equal(parcel.improvements.bedrooms, 3);
  assert.equal(parcel.officialLinks.length, 1);
  assert.equal(parcel.retrievedAt, '2026-09-21T12:00:00.000Z');
  assert.equal(parcel.effectiveDate, null, 'never claimed unless a provider genuinely supplies one');
  assert.equal(parcel.landUse, null, 'this provider does not distinguish land use from zoning');
});

test('a missing provider field is null/omitted, never fabricated', () => {
  const parcel = buildNormalizedParcel({
    providerId: 'oregon-deschutes-county', sourceAgency: 'x', sourceUrl: 'x', retrievedAt: 'x',
    parcelId: 'ABC123',
  });
  assert.equal(parcel.address.full, null);
  assert.equal(parcel.owner.name, null);
  assert.equal(parcel.values.assessed, null);
  assert.equal(parcel.values.market, null);
  assert.equal(parcel.zoning, null);
  assert.equal(parcel.improvements.yearBuilt, null);
  assert.equal(parcel.improvements.buildingArea, null);
  assert.equal(parcel.geometry, null);
  assert.deepEqual(parcel.officialLinks, []);
  assert.equal(parcel.acreage, null);
  assert.equal(parcel.acreageSource, null);
});

test('acreage falls back to a computed figure from Shape__Area only when the assessor value is absent, and is labelled as computed', () => {
  const computed = buildNormalizedParcel({ ...FULL_INPUT, acreageAssessor: undefined, shapeAreaSqM: 4046.8564224 });
  assert.equal(computed.acreage, 1, 'one acre in square meters');
  assert.equal(computed.acreageSource, 'computed');

  const assessorWins = buildNormalizedParcel({ ...FULL_INPUT, acreageAssessor: 2.5, shapeAreaSqM: 4046.8564224 });
  assert.equal(assessorWins.acreage, 2.5, 'assessor-supplied figure takes priority over the geometry estimate');
  assert.equal(assessorWins.acreageSource, 'assessor');
});

test('a bogus improvement year (0, blank, out of range) is rejected rather than shown as a fabricated year', () => {
  for (const bad of ['0', '', 'N/A', 9999, -1]) {
    const parcel = buildNormalizedParcel({ ...FULL_INPUT, yearBuilt: bad });
    assert.equal(parcel.improvements.yearBuilt, null, `yearBuilt=${JSON.stringify(bad)}`);
  }
});

test('officialLinks drops any entry without a usable url', () => {
  const parcel = buildNormalizedParcel({ ...FULL_INPUT, officialLinks: [{ label: 'no url' }, null, { label: 'ok', url: 'http://dial.deschutes.org/x' }] });
  assert.equal(parcel.officialLinks.length, 1);
  assert.equal(parcel.officialLinks[0].url, 'http://dial.deschutes.org/x');
});

test('a compact search result carries only the five listed fields', () => {
  const row = buildSearchResult({ parcelId: '181209AC00700', address: '61380 BROSTERHOUS RD', city: 'BEND', state: 'OR', zip: '97702', extraField: 'should not leak through' });
  assert.deepEqual(Object.keys(row).sort(), ['address', 'city', 'parcelId', 'state', 'zip']);
  assert.equal(row.extraField, undefined);
});

// -- client-safe serialization (privacy hardening) ------------------------------------------------------

test('toPublicParcel removes the owner field ENTIRELY, not merely to null', () => {
  const parcel = buildNormalizedParcel({ ...FULL_INPUT, ownerName: 'EXAMPLE OWNER LLC' });
  assert.equal(parcel.owner.name, 'EXAMPLE OWNER LLC', 'sanity check: the full record really does carry it');
  const publicParcel = toPublicParcel(parcel);
  assert.equal('owner' in publicParcel, false, 'the key itself is gone, not just nulled');
  assert.equal(JSON.stringify(publicParcel).includes('EXAMPLE OWNER LLC'), false);
});

test('toPublicParcel leaves every other field exactly as it was', () => {
  const parcel = buildNormalizedParcel(FULL_INPUT);
  const publicParcel = toPublicParcel(parcel);
  const { owner, ...expected } = parcel;
  assert.deepEqual(publicParcel, expected);
  assert.equal(publicParcel.parcelId, parcel.parcelId);
  assert.equal(publicParcel.values.assessed, parcel.values.assessed);
  assert.deepEqual(publicParcel.officialLinks, parcel.officialLinks);
});

test('toPublicParcel does not mutate the record it was given (the internal/cached copy keeps owner)', () => {
  const parcel = buildNormalizedParcel({ ...FULL_INPUT, ownerName: 'EXAMPLE OWNER LLC' });
  toPublicParcel(parcel);
  assert.equal(parcel.owner.name, 'EXAMPLE OWNER LLC', 'the original object passed in is untouched');
});

test('toPublicParcel is a safe no-op on null/undefined (the "parcel not found" case)', () => {
  assert.equal(toPublicParcel(null), null);
  assert.equal(toPublicParcel(undefined), undefined);
});

test('a parcel with no owner data at all still serializes fine (nothing to strip)', () => {
  const parcel = buildNormalizedParcel({ ...FULL_INPUT, ownerName: undefined });
  const publicParcel = toPublicParcel(parcel);
  assert.equal('owner' in publicParcel, false);
});
