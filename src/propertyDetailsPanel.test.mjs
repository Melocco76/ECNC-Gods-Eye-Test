// Property Intelligence A3 — the Property Details panel. Pure
// formatter/model tests need no DOM/network; the controller is tested with
// a fake fetch; the selection-bus wiring is tested with a fake
// window/document pair (same convention as trackedReadout.test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  buildPropertyDetailModel,
  createPropertyDetailsController,
  destroyPropertyDetailsPanel,
  formatAcreageValue,
  formatAddressLine,
  formatAreaValue,
  formatCountValue,
  formatCurrencyValue,
  formatRetrievedTimestamp,
  formatYearValue,
  initPropertyDetailsPanel,
  renderPropertyDetailsState,
  _getControllerForTest,
} from './propertyDetailsPanel.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// -- 12/13/14/15. pure formatters -----------------------------------------------------------------------

test('12. formatCurrencyValue formats whole dollars with thousands separators', () => {
  assert.equal(formatCurrencyValue(245800), '$245,800');
  assert.equal(formatCurrencyValue(412340.6), '$412,341', 'rounds to the nearest dollar');
  assert.equal(formatCurrencyValue(0), '$0', '0 is a legitimate reported value, not hidden');
});

test('13. formatAcreageValue formats acreage and marks a geometry-computed figure as estimated', () => {
  assert.equal(formatAcreageValue(2.37), '2.37 acres');
  assert.equal(formatAcreageValue(2.37, 'assessor'), '2.37 acres');
  assert.equal(formatAcreageValue(2.37, 'computed'), '2.37 acres (estimated)', 'A3 Part 6: never overstate a geometry-derived figure as authoritative');
});

test('14. formatAreaValue formats square footage with thousands separators', () => {
  assert.equal(formatAreaValue(1842), '1,842 sq ft');
  assert.equal(formatAreaValue(480), '480 sq ft');
});

test('formatYearValue and formatCountValue format plainly, including a legitimate fractional bathroom count', () => {
  assert.equal(formatYearValue(1998), '1998');
  assert.equal(formatCountValue(3), '3');
  assert.equal(formatCountValue(2.5), '2.5');
  assert.equal(formatCountValue(0), '0', '0 bedrooms/bathrooms is a legitimate reported value');
});

test('15. null/undefined/NaN are hidden (every formatter returns null, never the literal string)', () => {
  for (const bad of [null, undefined, NaN, 'not a number', {}]) {
    assert.equal(formatCurrencyValue(bad), null, `formatCurrencyValue(${String(bad)})`);
    assert.equal(formatAcreageValue(bad), null, `formatAcreageValue(${String(bad)})`);
    assert.equal(formatAreaValue(bad), null, `formatAreaValue(${String(bad)})`);
    assert.equal(formatYearValue(bad), null, `formatYearValue(${String(bad)})`);
    assert.equal(formatCountValue(bad), null, `formatCountValue(${String(bad)})`);
  }
  assert.equal(formatRetrievedTimestamp(null), null);
  assert.equal(formatRetrievedTimestamp(''), null);
  assert.equal(formatRetrievedTimestamp('not a date'), null);
  assert.equal(formatAddressLine(null), null);
});

test('formatRetrievedTimestamp renders a valid ISO timestamp as a readable local date/time', () => {
  const formatted = formatRetrievedTimestamp('2026-10-06T18:00:00.000Z');
  assert.equal(typeof formatted, 'string');
  assert.match(formatted, /2026/);
});

test('formatAddressLine joins whatever pieces exist and omits what does not (Virginia sparse-address case)', () => {
  assert.equal(formatAddressLine({ full: '456 FARM RD', city: 'YADKINVILLE', state: 'NC', zip: '27055' }), '456 FARM RD, YADKINVILLE, NC 27055');
  assert.equal(formatAddressLine({ full: null, city: 'Richmond', state: 'VA', zip: null }), 'Richmond, VA', 'no full street address, but locality pieces exist');
  assert.equal(formatAddressLine({ full: null, city: null, state: null, zip: null }), null, 'nothing at all — never a placeholder');
  assert.equal(formatAddressLine({ full: '456 FARM RD', city: null, state: null, zip: null }), '456 FARM RD');
});

// -- 9/10/11/16/17/18/19/21. normalized model builder ------------------------------------------------------

const OR_LIKE_PARCEL = {
  providerId: 'oregon-deschutes-county', sourceAgency: "Deschutes County Assessor's Office",
  sourceUrl: 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer',
  retrievedAt: '2026-10-06T18:00:00.000Z', effectiveDate: null,
  parcelId: '1408000000200', taxLot: '1408000000200', accountId: null,
  address: { full: '61380 BROSTERHOUS RD', city: 'BEND', state: 'OR', zip: '97702' },
  acreage: 1.23, acreageSource: 'assessor',
  values: { assessed: 412340, taxable: null, market: 498200, land: 220000, improvements: 278200 },
  landUse: null, zoning: 'RR10',
  improvements: { yearBuilt: 1998, buildingArea: 2140, garageArea: 480, bedrooms: 3, bathrooms: 2 },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  officialLinks: [{ label: 'Official Deschutes County Property Record (DIAL)', url: 'http://dial.deschutes.org/results/taxlot?value=1408000000200' }],
};

const NC_LIKE_PARCEL = {
  providerId: 'north-carolina-onemap', sourceAgency: 'NC OneMap (NC Integrated Cadastral Data Exchange)',
  sourceUrl: 'https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/FeatureServer', retrievedAt: '2026-10-06T18:00:00.000Z', effectiveDate: null,
  parcelId: '580602994649', taxLot: '580602994649', accountId: null,
  address: { full: '456 FARM RD', city: 'YADKINVILLE', state: 'NC', zip: '27055' },
  acreage: 20.87671745, acreageSource: 'assessor',
  values: { assessed: null, taxable: null, market: 220000, land: 95000, improvements: 125000 },
  landUse: 'Agricultural', zoning: null,
  improvements: { yearBuilt: null, buildingArea: null, garageArea: null, bedrooms: null, bathrooms: null },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  officialLinks: [],
};

const VA_SPARSE_PARCEL = {
  providerId: 'virginia-statewide', sourceAgency: 'Virginia Geographic Information Network (VGIN)',
  sourceUrl: 'https://services.dwr.virginia.gov/arcgis/rest/services/Projects/VA_Parcels/FeatureServer', retrievedAt: '2026-10-06T18:00:00.000Z', effectiveDate: null,
  parcelId: '338499', taxLot: '338499', accountId: 'E000-1234-567',
  address: { full: null, city: null, state: null, zip: null },
  acreage: 297.144, acreageSource: 'computed',
  values: { assessed: null, taxable: null, market: null, land: null, improvements: null },
  landUse: null, zoning: null,
  improvements: { yearBuilt: null, buildingArea: null, garageArea: null, bedrooms: null, bathrooms: null },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  officialLinks: [],
};

const TN_LIKE_PARCEL = {
  providerId: 'tennessee-statewide', sourceAgency: 'Tennessee Comptroller of the Treasury — Division of Property Assessments / Geographic Services',
  sourceUrl: 'https://geoviewer.cot.tn.gov/arcgis/rest/services/GeoViewer/GeoViewer_Parcels/MapServer', retrievedAt: '2026-10-10T12:00:00.000Z', effectiveDate: null,
  parcelId: '018113D C 00100', taxLot: '018113D C 00100', accountId: null,
  address: { full: 'DAYTON AVE 517', city: null, state: 'TN', zip: null },
  acreage: 0.84236135, acreageSource: 'assessor',
  values: { assessed: null, taxable: null, market: 100000, land: 15000, improvements: 85000 },
  landUse: '11 - HOUSEHOLD UNITS', zoning: 'R1',
  improvements: { yearBuilt: 1998, buildingArea: 1840, garageArea: null, bedrooms: null, bathrooms: null },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  officialLinks: [],
};

const SC_HORRY_LIKE_PARCEL = {
  providerId: 'south-carolina-county-parcels', sourceAgency: 'Horry County, SC GIS/Assessor',
  sourceUrl: 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/HorryCountySCParcels/FeatureServer', retrievedAt: '2026-10-07T12:00:00.000Z', effectiveDate: null,
  parcelId: 'HORRY:30413010131', taxLot: '30413010131', accountId: null,
  address: { full: null, city: null, state: 'SC', zip: null },
  acreage: 2.097, acreageSource: 'computed',
  values: { assessed: null, taxable: null, market: 98600, land: 0, improvements: 98600 },
  landUse: null, zoning: null,
  improvements: { yearBuilt: null, buildingArea: null, garageArea: null, bedrooms: null, bathrooms: null },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  officialLinks: [],
};

test('16 (SC coverage expansion): a sparse-schema SC county (Horry — no address/land-use fields) omits those rows/sections without any SC-specific code', () => {
  const model = buildPropertyDetailModel(SC_HORRY_LIKE_PARCEL);
  const sectionIds = model.sections.map((s) => s.id);
  assert.deepEqual(sectionIds, ['overview', 'values', 'source'], 'Property/Improvements sections omitted entirely — nothing to show');
  const overview = model.sections.find((s) => s.id === 'overview');
  assert.deepEqual(overview.rows.map((r) => r.label), ['Parcel ID', 'Address', 'Acreage'], 'Address row still appears with just the fixed "SC" literal — no street/city for this county');
  const values = model.sections.find((s) => s.id === 'values');
  assert.ok(values.rows.some((r) => r.label === 'Market / Parcel Value'));
});

test('9. OR detail model renders Overview/Property/Values/Improvements/Source — the richest provider', () => {
  const model = buildPropertyDetailModel(OR_LIKE_PARCEL);
  const sectionIds = model.sections.map((s) => s.id);
  assert.deepEqual(sectionIds, ['overview', 'property', 'values', 'improvements', 'source']);
  const overview = model.sections.find((s) => s.id === 'overview');
  assert.deepEqual(overview.rows.map((r) => r.label), ['Parcel ID', 'Address', 'Acreage']);
  assert.equal(overview.rows.find((r) => r.label === 'Acreage').value, '1.23 acres');
  const values = model.sections.find((s) => s.id === 'values');
  assert.deepEqual(values.rows.map((r) => r.label), ['Assessed Value', 'Market / Parcel Value', 'Land Value', 'Improvement Value'], 'Taxable omitted — null for this provider');
  assert.equal(values.rows.find((r) => r.label === 'Land Value').value, '$220,000');
  assert.equal(model.officialLinks.length, 1);
  assert.equal(model.officialLinks[0].url, 'http://dial.deschutes.org/results/taxlot?value=1408000000200');
});

test('10. NC detail model renders available fields, labels the ambiguous value row generically, and omits sections with nothing to show', () => {
  const model = buildPropertyDetailModel(NC_LIKE_PARCEL);
  const sectionIds = model.sections.map((s) => s.id);
  assert.deepEqual(sectionIds, ['overview', 'property', 'values', 'source'], 'Improvements omitted — this fixture supplies none');
  assert.ok(model.sections.every((s) => s.id !== 'improvements'), 'NC supplies no improvement fields in this fixture — the whole section is omitted, not shown empty');
  const property = model.sections.find((s) => s.id === 'property');
  assert.deepEqual(property.rows.map((r) => r.label), ['Land Use'], 'Zoning omitted — null for this provider');
  const values = model.sections.find((s) => s.id === 'values');
  assert.ok(values.rows.some((r) => r.label === 'Market / Parcel Value'), 'never relabeled "Market Value" outright — A3 Part 6');
  assert.equal(model.officialLinks.length, 0, 'NC provider returns no official link');
});

test('11. VA sparse detail model omits unavailable rows entirely — no Address, no Values, no Improvements section, never a placeholder', () => {
  const model = buildPropertyDetailModel(VA_SPARSE_PARCEL);
  const sectionIds = model.sections.map((s) => s.id);
  assert.deepEqual(sectionIds, ['overview', 'source'], 'Property/Values/Improvements sections are entirely omitted — nothing to show');
  const overview = model.sections.find((s) => s.id === 'overview');
  assert.deepEqual(overview.rows.map((r) => r.label), ['Parcel ID', 'Acreage'], 'Address row omitted — no address pieces at all');
  assert.equal(overview.rows.find((r) => r.label === 'Acreage').value, '297.14 acres (estimated)', 'geometry-computed acreage is marked, never presented as an assessor figure');
  assert.equal(model.officialLinks.length, 0);
});

test('11b (TN coverage expansion): TN detail model renders address/acreage/zoning/land-use/values/improvements through the SAME generic sections — no provider-specific code needed', () => {
  const model = buildPropertyDetailModel(TN_LIKE_PARCEL);
  const sectionIds = model.sections.map((s) => s.id);
  assert.deepEqual(sectionIds, ['overview', 'property', 'values', 'improvements', 'source']);
  const overview = model.sections.find((s) => s.id === 'overview');
  assert.equal(overview.rows.find((r) => r.label === 'Address').value, 'DAYTON AVE 517, TN');
  assert.equal(overview.rows.find((r) => r.label === 'Acreage').value, '0.84 acres');
  const values = model.sections.find((s) => s.id === 'values');
  assert.deepEqual(values.rows.map((r) => r.label), ['Market / Parcel Value', 'Land Value', 'Improvement Value'], 'Assessed/Taxable omitted — null for this provider');
  const improvements = model.sections.find((s) => s.id === 'improvements');
  assert.deepEqual(improvements.rows.map((r) => r.label), ['Year Built', 'Building Area'], 'Garage/bedrooms/bathrooms omitted — this schema has none');
  assert.equal(model.officialLinks.length, 0);
});

test('16. an official link is included only when the provider actually returned one', () => {
  assert.equal(buildPropertyDetailModel(OR_LIKE_PARCEL).officialLinks.length, 1);
  assert.equal(buildPropertyDetailModel(NC_LIKE_PARCEL).officialLinks.length, 0);
  assert.equal(buildPropertyDetailModel(VA_SPARSE_PARCEL).officialLinks.length, 0);
  assert.equal(buildPropertyDetailModel(TN_LIKE_PARCEL).officialLinks.length, 0);
  const malformed = buildPropertyDetailModel({ ...OR_LIKE_PARCEL, officialLinks: [{ label: 'no url' }, null, { label: 'ok', url: '  ' }] });
  assert.equal(malformed.officialLinks.length, 0, 'a link with no real url is never rendered, never a speculative/constructed one');
});

test('17. source agency is always shown for every provider that supplies one', () => {
  for (const parcel of [OR_LIKE_PARCEL, NC_LIKE_PARCEL, VA_SPARSE_PARCEL, TN_LIKE_PARCEL]) {
    const model = buildPropertyDetailModel(parcel);
    const source = model.sections.find((s) => s.id === 'source');
    assert.ok(source.rows.some((r) => r.label === 'Source Agency' && r.value === parcel.sourceAgency));
  }
});

test('18/19. owner fields are never rendered and never present in the panel model, even when the input carries one', () => {
  const withOwnerField = { ...OR_LIKE_PARCEL, owner: { name: 'EXAMPLE OWNER LLC' }, ownerMailingAddress: '123 MAIN ST' };
  const model = buildPropertyDetailModel(withOwnerField);
  const serialized = JSON.stringify(model).toLowerCase();
  assert.equal(serialized.includes('owner'), false, 'the model never surfaces an owner field, even when present on the input');
  assert.equal(serialized.includes('example owner llc'), false);
  assert.equal(serialized.includes('123 main st'.toLowerCase().replace(/ /g, '')), false, 'checked loosely; the real guard is the "owner" substring check above');
});

test('20. no owner-search affordance exists anywhere in this module\'s source', () => {
  const source = code('./propertyDetailsPanel.js');
  assert.equal(/owner.{0,20}search|search.{0,20}owner/i.test(source), false);
  assert.equal(/ownname|Owner1|Owner2|mailadd|M_Address/i.test(source), false, 'no provider-specific owner field name ever named here either');
});

test('21. the generic model builder never branches on providerId/state — same function for every provider', () => {
  const source = code('./propertyDetailsPanel.js');
  assert.equal(/providerId\s*===|state\s*===\s*'(OR|NC|VA|TN|SC|GA)'|'(oregon-deschutes|oregon-statewide|north-carolina|virginia|tennessee|south-carolina|georgia)/i.test(source), false);
});

test('14 (TN coverage expansion): no Tennessee-specific branching anywhere in this module either', () => {
  const source = code('./propertyDetailsPanel.js');
  for (const needle of ['tn-statewide', 'tennessee', 'geoviewer', 'gislink', 'comptroller']) {
    assert.equal(new RegExp(needle, 'i').test(source), false, needle);
  }
});

test('15 (SC coverage expansion): no South-Carolina-specific branching anywhere in this module either', () => {
  const source = code('./propertyDetailsPanel.js');
  for (const needle of ['sc-counties', 'south-carolina', 'south carolina', 'york', 'horry', 'parno']) {
    assert.equal(new RegExp(needle, 'i').test(source), false, needle);
  }
});

test('16 (GA coverage expansion): no Georgia-specific branching anywhere in this module either', () => {
  const source = code('./propertyDetailsPanel.js');
  for (const needle of ['ga-counties', 'georgia', 'fulton', 'dekalb', 'gwinnett', 'forsyth', 'clarke', 'richmond']) {
    assert.equal(new RegExp(needle, 'i').test(source), false, needle);
  }
});

test('17 (OR statewide coverage expansion): no Oregon-statewide-specific branching anywhere in this module either', () => {
  const source = code('./propertyDetailsPanel.js');
  for (const needle of ['or-statewide', 'multnomah', 'washington', 'clackamas', 'marion', 'umatilla', 'maptaxlot', 'ortaxlot']) {
    assert.equal(new RegExp(needle, 'i').test(source), false, needle);
  }
});

// -- 2/3/4/5. fetch controller: URL shape, dedupe, abort/generation guard ------------------------------

function fakeFetch(responder) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url: String(url), signal: init?.signal });
      return responder(String(url), init);
    },
  };
}
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('2. selecting a parcel requests exactly /api/parcels/detail?region=&parcelId=', async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(200, { parcel: { parcelId: 'A1' } }));
  const states = [];
  const controller = createPropertyDetailsController({ fetchImpl: impl, onStateChange: (s) => states.push(s) });
  controller.selectParcel('nc-statewide', '580602994649');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, 'http://localhost');
  assert.equal(url.pathname, '/api/parcels/detail');
  assert.equal(url.searchParams.get('region'), 'nc-statewide');
  assert.equal(url.searchParams.get('parcelId'), '580602994649');
  assert.equal(states.at(-1).status, 'ready');
});

test('3. selecting the SAME already-loaded parcel again does not cause a duplicate fetch', async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse(200, { parcel: { parcelId: 'A1' } }));
  const controller = createPropertyDetailsController({ fetchImpl: impl });
  controller.selectParcel('or-deschutes', '1408000000200');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  controller.selectParcel('or-deschutes', '1408000000200'); // same region+parcelId, already ready
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1, 'no second fetch for the same already-loaded selection');
});

test('4/5. selecting a different parcel aborts the previous in-flight request and ignores its (late) stale response', async () => {
  let resolveSlow;
  const slow = new Promise((resolve) => { resolveSlow = resolve; });
  let callCount = 0;
  const abortedFlags = [];
  const impl = async (url, init) => {
    callCount += 1;
    const myCall = callCount;
    init?.signal?.addEventListener('abort', () => { abortedFlags[myCall] = true; });
    if (myCall === 1) {
      await slow;
      if (init?.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return jsonResponse(200, { parcel: { parcelId: 'STALE' } });
    }
    return jsonResponse(200, { parcel: { parcelId: 'FRESH' } });
  };
  const states = [];
  const controller = createPropertyDetailsController({ fetchImpl: impl, onStateChange: (s) => states.push({ ...s }) });
  controller.selectParcel('or-deschutes', 'STALE_ID'); // starts the slow first request
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.selectParcel('or-deschutes', 'FRESH_ID'); // supersedes it immediately
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).model.parcelId, 'FRESH', 'the second selection won, before the first ever resolved');
  resolveSlow(); // let the stale first request finish late
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).model.parcelId, 'FRESH', 'the late stale response never overwrote the fresh one');
  assert.equal(abortedFlags[1], true, 'the first request\'s AbortController was actually aborted');
});

test('404 (no parcel at this id) maps to status "empty"; a non-ok upstream failure maps to status "error"', async () => {
  let lastState;
  const nf = createPropertyDetailsController({
    fetchImpl: async () => jsonResponse(404, {}),
    onStateChange: (s) => { lastState = s; },
  });
  nf.selectParcel('va-statewide', 'does-not-exist');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lastState.status, 'empty');

  let errState;
  const failing = createPropertyDetailsController({
    fetchImpl: async () => jsonResponse(502, { error: 'upstream ArcGIS stack trace should never reach here' }),
    onStateChange: (s) => { errState = s; },
  });
  failing.selectParcel('va-statewide', 'X');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errState.status, 'error');
});

test('a thrown network error also maps to status "error", never an uncaught rejection', async () => {
  let lastState;
  const controller = createPropertyDetailsController({
    fetchImpl: async () => { throw new Error('network down'); },
    onStateChange: (s) => { lastState = s; },
  });
  await assert.doesNotReject(async () => {
    controller.selectParcel('or-deschutes', 'X');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(lastState.status, 'error');
});

test('6. clear() resets to idle and cancels any in-flight request', async () => {
  let aborted = false;
  const controller = createPropertyDetailsController({
    fetchImpl: async (url, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      await new Promise(() => {}); // never resolves on its own
    },
  });
  controller.selectParcel('or-deschutes', 'X');
  controller.clear();
  assert.equal(controller.getState().status, 'idle');
  assert.equal(aborted, true);
});

// -- renderPropertyDetailsState: thin DOM glue, fake elements (same convention as layerDrawer.test.mjs) ---

function fakeElement() {
  const classes = new Set(['collapsed']);
  return {
    hidden: true,
    innerHTML: '',
    classList: { remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
}

test('renderPropertyDetailsState shows loading/empty/error text and hides the panel when idle', () => {
  const panelEl = fakeElement();
  const bodyEl = fakeElement();
  renderPropertyDetailsState({ status: 'idle' }, { panelEl, bodyEl });
  assert.equal(panelEl.hidden, true);
  assert.equal(bodyEl.innerHTML, '');

  renderPropertyDetailsState({ status: 'loading' }, { panelEl, bodyEl });
  assert.equal(panelEl.hidden, false);
  assert.equal(panelEl.classList.contains('collapsed'), false, 'a new selection expands the panel — never leaves it collapsed-to-header');
  assert.match(bodyEl.innerHTML, /Loading property details/);

  renderPropertyDetailsState({ status: 'empty' }, { panelEl, bodyEl });
  assert.match(bodyEl.innerHTML, /Property details unavailable/);

  renderPropertyDetailsState({ status: 'error' }, { panelEl, bodyEl });
  assert.match(bodyEl.innerHTML, /Property data temporarily unavailable/);
});

test('renderPropertyDetailsState renders sections and an official-link anchor for a ready state', () => {
  const panelEl = fakeElement();
  const bodyEl = fakeElement();
  const model = buildPropertyDetailModel(OR_LIKE_PARCEL);
  renderPropertyDetailsState({ status: 'ready', model }, { panelEl, bodyEl });
  assert.equal(panelEl.hidden, false);
  assert.match(bodyEl.innerHTML, /Overview/);
  assert.match(bodyEl.innerHTML, /\$220,000/);
  assert.match(bodyEl.innerHTML, /target="_blank"/);
  assert.match(bodyEl.innerHTML, /rel="noopener noreferrer"/);
  assert.doesNotMatch(bodyEl.innerHTML, /owner/i);
});

test('renderPropertyDetailsState never throws when the panel markup is absent (e.g. no container refs)', () => {
  assert.doesNotThrow(() => renderPropertyDetailsState({ status: 'ready', model: null }, {}));
});

// -- 1/6/7/8. selection-bus wiring (init/destroy against a fake window + document) ----------------------

function fakeDocWithPanel() {
  const panelEl = { hidden: true, innerHTML: '' };
  const bodyEl = { hidden: true, innerHTML: '' };
  Object.defineProperty(panelEl, 'querySelector', { value: () => null });
  return {
    panelEl,
    bodyEl,
    getElementById: (id) => (id === 'property-details-panel' ? panelEl : id === 'property-details-body' ? bodyEl : null),
  };
}

async function withWiredPanel(run) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const host = new EventTarget();
  const fakeDoc = fakeDocWithPanel();
  globalThis.window = host;
  globalThis.document = fakeDoc;
  try {
    // `run` is async: without this `await`, `finally` below would restore
    // `window`/`document` as soon as `run(...)` returns its pending
    // promise, long before the test's later `await`s actually run — see
    // the identical bug already found and fixed in parcels.test.mjs's
    // `withWindow` helper during the A2.3 hardening pass.
    return await run({ host, fakeDoc });
  } finally {
    destroyPropertyDetailsPanel();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
}

const selectParcelEvent = (overrides = {}) => new CustomEvent('gev:entity-selected', {
  detail: { layerId: 'property-parcels', id: 'property-parcel:A1:abc12345', properties: { parcelId: 'A1', region: 'or-deschutes' }, ...overrides },
});

test('1. a parcel selection event opens the panel and triggers a detail fetch', async () => {
  await withWiredPanel(async ({ host, fakeDoc }) => {
    const calls = [];
    initPropertyDetailsPanel({ fetchImpl: async (url) => { calls.push(String(url)); return jsonResponse(200, { parcel: { parcelId: 'A1', sourceAgency: 'X' } }); } });
    host.dispatchEvent(selectParcelEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/parcels\/detail/);
    assert.equal(fakeDoc.panelEl.hidden, false);
  });
});

test('a non-parcel selection (e.g. an aircraft) clears any open property panel — contextStore does not dispatch a separate clear for the loser of the shared slot', async () => {
  await withWiredPanel(async ({ host, fakeDoc }) => {
    initPropertyDetailsPanel({ fetchImpl: async () => jsonResponse(200, { parcel: { parcelId: 'A1' } }) });
    host.dispatchEvent(selectParcelEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fakeDoc.panelEl.hidden, false);
    host.dispatchEvent(new CustomEvent('gev:entity-selected', { detail: { layerId: 'flights', id: 'aaa001' } }));
    assert.equal(fakeDoc.panelEl.hidden, true, 'the property panel closes once the shared selection slot moves to a different kind of entity');
  });
});

test('6/7/8. a gev:entity-selection-cleared event for this layer resets/hides the panel — covers deliberate clear, layer-disable, and viewport-eviction alike (contextStore dispatches the same event for all three)', async () => {
  await withWiredPanel(async ({ host, fakeDoc }) => {
    initPropertyDetailsPanel({ fetchImpl: async () => jsonResponse(200, { parcel: { parcelId: 'A1' } }) });
    host.dispatchEvent(selectParcelEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fakeDoc.panelEl.hidden, false);

    host.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', { detail: { layerId: 'property-parcels', reason: 'deliberate' } }));
    assert.equal(fakeDoc.panelEl.hidden, true);
    assert.equal(_getControllerForTest().getState().status, 'idle');

    // Re-select, then prove the SAME handling applies to an 'evicted' clear (viewport refresh dropped the selection).
    host.dispatchEvent(selectParcelEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fakeDoc.panelEl.hidden, false);
    host.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', { detail: { layerId: 'property-parcels', reason: 'evicted' } }));
    assert.equal(fakeDoc.panelEl.hidden, true);
  });
});

test('a gev:entity-selection-cleared event for a DIFFERENT layer is ignored (never closes an unrelated open panel)', async () => {
  await withWiredPanel(async ({ host, fakeDoc }) => {
    initPropertyDetailsPanel({ fetchImpl: async () => jsonResponse(200, { parcel: { parcelId: 'A1' } }) });
    host.dispatchEvent(selectParcelEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fakeDoc.panelEl.hidden, false);
    host.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', { detail: { layerId: 'flights', reason: 'deliberate' } }));
    assert.equal(fakeDoc.panelEl.hidden, false, 'unrelated layer\'s clear must not touch this panel');
  });
});

test('destroyPropertyDetailsPanel removes both listeners and clears the controller', async () => {
  await withWiredPanel(async ({ host, fakeDoc }) => {
    const calls = [];
    initPropertyDetailsPanel({ fetchImpl: async (url) => { calls.push(String(url)); return jsonResponse(200, { parcel: { parcelId: 'A1' } }); } });
    destroyPropertyDetailsPanel();
    host.dispatchEvent(selectParcelEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 0, 'no fetch after destroy — the listener is really gone');
    assert.equal(_getControllerForTest(), null);
  });
});

test('initPropertyDetailsPanel is a safe no-op when the panel markup is absent (no window/document crash)', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: () => null };
  try {
    assert.doesNotThrow(() => initPropertyDetailsPanel({}));
  } finally {
    destroyPropertyDetailsPanel();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

// -- 22. mobile/narrow layout: the panel's own CSS wraps long values instead of overflowing -------------

test('22. the panel stylesheet defines word-wrapping for long values/links (no horizontal overflow on narrow screens)', () => {
  const css = read('../style.css');
  const panelBlockMatch = css.match(/\.property-details-panel-inner\s*\{[^}]*\}/);
  assert.ok(panelBlockMatch, 'the panel card style block exists');
  assert.match(css, /\.property-details-(value|link|row)[^{]*\{[^}]*(word-break|overflow-wrap)/s, 'long parcel ids/urls wrap rather than overflow horizontally');
});

test('22b. the panel markup exists in index.html with the exact required id/title/collapse-target wiring', () => {
  const html = read('../index.html');
  assert.match(html, /id="property-details-panel"/);
  assert.match(html, /id="property-details-body"/);
  assert.match(html, /data-collapse-target="property-details-panel"/);
  assert.match(html, /PROPERTY DETAILS/);
});

test('ui.js wires init/destroy exactly once each, alongside the existing trackedReadout wiring', () => {
  const source = read('./ui.js');
  assert.match(source, /import \{ destroyPropertyDetailsPanel, initPropertyDetailsPanel \} from '\.\/propertyDetailsPanel\.js';/);
  assert.match(source, /initPropertyDetailsPanel\(\);/);
  assert.match(source, /destroyPropertyDetailsPanel\(\);/);
});
