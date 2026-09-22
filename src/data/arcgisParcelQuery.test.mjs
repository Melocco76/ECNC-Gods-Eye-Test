// Property Intelligence Phase A1: pure ArcGIS query-URL construction. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildContainsAnyWhere,
  buildExactMatchWhere,
  buildPointIdentifyUrl,
  buildQueryUrl,
  buildWhereQueryUrl,
} from './arcgisParcelQuery.js';

const TAXLOT_LAYER = 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer/0';

test('every built query always requests f=json and outSR=4326', () => {
  const url = new URL(buildQueryUrl(TAXLOT_LAYER, { where: '1=1' }));
  assert.equal(url.searchParams.get('f'), 'json');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.pathname, '/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer/0/query');
});

test('undefined/null params are omitted, never sent as the literal string "undefined"', () => {
  const url = new URL(buildQueryUrl(TAXLOT_LAYER, { where: '1=1', resultRecordCount: undefined, orderByFields: null }));
  assert.equal(url.searchParams.has('resultRecordCount'), false);
  assert.equal(url.searchParams.has('orderByFields'), false);
});

test('an explicit caller-supplied outSR overrides the default (still WGS84 in every route this app actually calls)', () => {
  const url = new URL(buildQueryUrl(TAXLOT_LAYER, { outSR: '3857' }));
  assert.equal(url.searchParams.get('outSR'), '3857');
});

test('point-identify builds geometry/geometryType/spatialRel correctly for a validated lat/lon', () => {
  const url = new URL(buildPointIdentifyUrl(TAXLOT_LAYER, 44.0578, -121.3153, { outFields: 'TAXLOT,DIAL', returnCentroid: true }));
  assert.equal(url.searchParams.get('geometry'), '-121.3153,44.0578', 'lon,lat order for esriGeometryPoint');
  assert.equal(url.searchParams.get('geometryType'), 'esriGeometryPoint');
  assert.equal(url.searchParams.get('inSR'), '4326');
  assert.equal(url.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
  assert.equal(url.searchParams.get('outFields'), 'TAXLOT,DIAL');
  assert.equal(url.searchParams.get('returnCentroid'), 'true');
  assert.equal(url.searchParams.get('resultRecordCount'), '1', 'defaults to exactly one result');
});

test('point-identify defaults returnGeometry to true and resultRecordCount to 1 unless overridden', () => {
  const url = new URL(buildPointIdentifyUrl(TAXLOT_LAYER, 44, -121));
  assert.equal(url.searchParams.get('returnGeometry'), 'true');
  assert.equal(url.searchParams.get('resultRecordCount'), '1');
});

test('where-clause query carries the clause through untouched and defaults returnGeometry to false', () => {
  const url = new URL(buildWhereQueryUrl(TAXLOT_LAYER, "TAXLOT = '1408000000200'", { outFields: 'TAXLOT' }));
  assert.equal(url.searchParams.get('where'), "TAXLOT = '1408000000200'");
  assert.equal(url.searchParams.get('returnGeometry'), 'false');
  assert.equal(url.searchParams.get('outFields'), 'TAXLOT');
});

test('exact-match where clause quotes the value and escapes an embedded single quote', () => {
  assert.equal(buildExactMatchWhere('TAXLOT', '1408000000200'), "TAXLOT = '1408000000200'");
  assert.equal(buildExactMatchWhere('NAME', "O'Brien"), "NAME = 'O''Brien'");
});

test('contains-any where clause ORs UPPER(...) LIKE across every given field, wrapping the value with % on both sides', () => {
  const clause = buildContainsAnyWhere(['Street_Name', 'Address'], 'BROSTERHOUS');
  assert.equal(clause, "(UPPER(Street_Name) LIKE UPPER('%BROSTERHOUS%')) OR (UPPER(Address) LIKE UPPER('%BROSTERHOUS%'))");
});

test('contains-any where clause with one field produces one LIKE term, not a dangling OR', () => {
  const clause = buildContainsAnyWhere(['Street_Name'], 'MAIN');
  assert.equal(clause, "(UPPER(Street_Name) LIKE UPPER('%MAIN%'))");
});

test('the base layer URL is always the caller-supplied fixed string — nothing here can redirect to a different host', () => {
  const url = buildPointIdentifyUrl('https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer/0', 44, -121);
  assert.match(url, /^https:\/\/services1\.arcgis\.com\/znO8Hz1SuVVohYhZ\//);
});
