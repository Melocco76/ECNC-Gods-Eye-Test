// Flight Intelligence Phase B: airframe metadata (manufacturer, registered owner, owner
// country, operator code) from the adsbdb aircraft answer the app ALREADY requests.
// Parser, additive backward compatibility, sticky client metadata, panel rendering and
// the no-new-request / no-AIS guarantees. Fixture data only; nothing touches a network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import { buildFlightDetailsModel, initFlightPanel } from './flightPanel.js';
import { parseAdsbdbAircraft } from '../vite.config.js';
import flightsLayer, {
  _applyTypeEnrichmentForTest,
  _setTrackedFlightRefreshStateForTest,
} from './data/flights.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = 1_000_000;

/** The real shape adsbdb returned for a40ca4 during the audit (photo URLs left out on purpose). */
const ADSBDB = (over = {}) => ({
  response: {
    aircraft: {
      type: 'A321 211SL',
      icao_type: 'A321',
      manufacturer: 'Airbus',
      mode_s: 'A40CA4',
      registration: 'N360DN',
      registered_owner_country_iso_name: 'US',
      registered_owner_country_name: 'United States',
      registered_owner_operator_flag_code: 'DAL',
      registered_owner: 'Delta Air Lines',
      url_photo: 'https://image.example/photo.jpg',
      url_photo_thumbnail: 'https://image.example/thumb.jpg',
      ...over,
    },
  },
});

const details = (over = {}) => ({
  icao24: 'a40ca4',
  callsign: 'DAL1491',
  airline: 'Delta Air Lines',
  registration: 'N360DN',
  typeName: 'Airbus A321 211SL',
  typeCode: 'A321',
  manufacturer: 'Airbus',
  registeredOwner: 'Wilmington Trust Company',
  registeredOwnerCountry: 'United States',
  operatorFlagCode: 'DAL',
  klass: 'airliner',
  route: null,
  latitude: 36.0,
  longitude: -78.0,
  altitudeM: 10_668,
  onGround: false,
  velocityMps: 230,
  track: 20,
  stale: false,
  feed: { source: 'adsb.lol', coverage: '250nm regional fallback' },
  ...over,
});
const aircraftRows = (model) => model.sections.find((s) => s.id === 'aircraft')?.rows ?? [];
const rowsOf = (model) => Object.fromEntries(model.sections.flatMap((s) => s.rows.map((r) => [r.key, r.value])));

// -- backend parser ---------------------------------------------------------------------------------

test('the parser keeps the four airframe fields the provider returns, from exactly these source fields', () => {
  const parsed = parseAdsbdbAircraft(ADSBDB());
  assert.equal(parsed.manufacturer, 'Airbus', 'manufacturer');
  assert.equal(parsed.registeredOwner, 'Delta Air Lines', 'registered_owner');
  assert.equal(parsed.registeredOwnerCountry, 'United States', 'registered_owner_country_name');
  assert.equal(parsed.operatorFlagCode, 'DAL', 'registered_owner_operator_flag_code');
});

test('the original contract is unchanged (additive only)', () => {
  const parsed = parseAdsbdbAircraft(ADSBDB());
  assert.equal(parsed.typeCode, 'A321');
  assert.equal(parsed.typeName, 'Airbus A321 211SL');
  assert.equal(parsed.registration, 'N360DN');
  assert.deepEqual(Object.keys(parsed), ['typeCode', 'typeName', 'registration', 'manufacturer', 'registeredOwner', 'registeredOwnerCountry', 'operatorFlagCode'], 'original fields first, new ones appended');
  // The original three, computed as the old parser did, for a spread of inputs.
  const legacy = (a) => ({
    typeCode: a.icao_type || null,
    typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
    registration: a.registration || null,
  });
  for (const a of [
    ADSBDB().response.aircraft,
    { type: 'Cessna 172', registration: 'N12345' },
    { manufacturer: 'Boeing' },
    { icao_type: 'B738' },
    {},
  ]) {
    const { typeCode, typeName, registration } = parseAdsbdbAircraft({ response: { aircraft: a } });
    assert.deepEqual({ typeCode, typeName, registration }, legacy(a));
  }
});

test('missing or blank provider fields become null: nothing is inferred', () => {
  const bare = parseAdsbdbAircraft({ response: { aircraft: { registration: 'N1', type: 'Piper PA-28' } } });
  assert.equal(bare.manufacturer, null);
  assert.equal(bare.registeredOwner, null);
  assert.equal(bare.registeredOwnerCountry, null);
  assert.equal(bare.operatorFlagCode, null);
  const blank = parseAdsbdbAircraft(ADSBDB({ registered_owner: '   ', registered_owner_country_name: '', registered_owner_operator_flag_code: null, manufacturer: '  ' }));
  assert.equal(blank.registeredOwner, null);
  assert.equal(blank.registeredOwnerCountry, null);
  assert.equal(blank.operatorFlagCode, null);
  assert.equal(blank.manufacturer, null);
  const trimmed = parseAdsbdbAircraft(ADSBDB({ registered_owner: '  Delta Air Lines  ' }));
  assert.equal(trimmed.registeredOwner, 'Delta Air Lines');
  // A non-string value is ignored, not stringified.
  assert.equal(parseAdsbdbAircraft(ADSBDB({ registered_owner: 42 })).registeredOwner, null);
  // The country falls back to nothing, not to the ISO code: only the provider's name is shown.
  assert.equal(parseAdsbdbAircraft(ADSBDB({ registered_owner_country_name: undefined })).registeredOwnerCountry, null);
});

test('unknown aircraft and malformed bodies still parse to null exactly as before', () => {
  for (const body of [null, undefined, {}, { response: {} }, { response: 'unknown aircraft' }, { response: { aircraft: null } }]) {
    assert.equal(parseAdsbdbAircraft(body), null);
  }
});

test('no photo URL, serial or year leaks into this phase', () => {
  const parsed = parseAdsbdbAircraft(ADSBDB());
  for (const key of Object.keys(parsed)) assert.equal(/photo|url|serial|msn|year/i.test(key), false, key);
  assert.equal(JSON.stringify(parsed).includes('image.example'), false);
});

// -- no new request ----------------------------------------------------------------------------------

test('no additional network request: still one aircraft lookup and one route lookup', () => {
  const vite = read('../vite.config.js');
  const proxy = vite.slice(vite.indexOf('function adsbdbProxy()'), vite.indexOf('function overpassLooksRateLimited'));
  assert.equal((proxy.match(/https:\/\/api\.adsbdb\.com\//g) || []).length, 2, 'the same two upstream URLs');
  assert.equal((proxy.match(/\bfetch\(/g) || []).length, 1, 'one fetch call site, shared by both lookups');
  assert.match(proxy, /const parseAircraft = parseAdsbdbAircraft;/);
  const parser = vite.slice(vite.indexOf('export function parseAdsbdbAircraft'), vite.indexOf('function adsbdbProxy()'));
  assert.equal(/fetch\(|http/.test(parser.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'the parser only reads the answer it was given');
  const flights = code('./data/flights.js');
  assert.equal((flights.match(/_enqueueEnrich\(/g) || []).length, 3, 'definition + type + route: unchanged');
  assert.equal((flights.match(/\/api\/adsbdb\//g) || []).length, 2, 'the same two client URLs');
  assert.equal(/\/api\/adsbdb\/(aircraft|owner|meta)/.test(flights), false, 'no new endpoint');
  const panel = code('./flightPanel.js');
  assert.equal(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(panel), false, 'the panel still requests nothing');
});

test('the proxy route table is unchanged: no new endpoint', () => {
  const vite = read('../vite.config.js');
  const proxy = vite.slice(vite.indexOf('function adsbdbProxy()'), vite.indexOf('function overpassLooksRateLimited'));
  assert.deepEqual([...proxy.matchAll(/if \(kind === '([a-z]+)'\) \{/g)].map((m) => m[1]), ['route', 'type'], 'only the route and type endpoints');
  assert.match(proxy, /return send\(404, \{ error: 'unknown endpoint' \}\)/);
});

// -- client metadata: sticky airframe facts ------------------------------------------------------------

const ICAO = 'a40ca4';
const POSITION = Cesium.Cartesian3.fromDegrees(-78.0, 36.0, 10_668);
function seed({ icao24 = ICAO, meta = {}, tracked = true } = {}) {
  _setTrackedFlightRefreshStateForTest({
    icao24,
    entity: null,
    billboard: { position: POSITION, color: Cesium.Color.WHITE, show: true },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked,
    meta: {
      callsign: 'DAL1491', altitude: 10_668, renderAltitudeM: 10_760, velocity: 230, true_track: 20,
      klass: 'airliner', onGround: false, wasAirborne: true, turnRateDps: 0, rawLat: 36.0, rawLon: -78.0,
      ...meta,
    },
  });
}
const parsedAnswer = (over) => ({ found: true, ...parseAdsbdbAircraft(ADSBDB(over)) });

test('an adsbdb answer fills the airframe metadata and the details description carries it', () => {
  seed();
  _applyTypeEnrichmentForTest(ICAO, parsedAnswer());
  const d = flightsLayer.getTrackedDetails();
  assert.equal(d.manufacturer, 'Airbus');
  assert.equal(d.registeredOwner, 'Delta Air Lines');
  assert.equal(d.registeredOwnerCountry, 'United States');
  assert.equal(d.operatorFlagCode, 'DAL');
  assert.equal(d.registration, 'N360DN');
  assert.equal(d.typeCode, 'A321');
});

test('airframe facts are sticky: a later answer missing a field never erases it, a new value wins', () => {
  seed();
  _applyTypeEnrichmentForTest(ICAO, parsedAnswer());
  _applyTypeEnrichmentForTest(ICAO, { found: true, typeCode: 'A321', typeName: null, registration: null, manufacturer: null, registeredOwner: null, registeredOwnerCountry: null, operatorFlagCode: null });
  let d = flightsLayer.getTrackedDetails();
  assert.equal(d.registeredOwner, 'Delta Air Lines', 'kept');
  assert.equal(d.manufacturer, 'Airbus');
  assert.equal(d.operatorFlagCode, 'DAL');
  assert.equal(d.registration, 'N360DN');
  _applyTypeEnrichmentForTest(ICAO, parsedAnswer({ registered_owner: 'Bank of Utah Trustee' }));
  d = flightsLayer.getTrackedDetails();
  assert.equal(d.registeredOwner, 'Bank of Utah Trustee', 'a changed owner of record replaces the old one');
});

test('an older cached answer without the new fields is harmless', () => {
  seed();
  _applyTypeEnrichmentForTest(ICAO, { found: true, typeCode: 'A321', typeName: 'Airbus A321 211SL', registration: 'N360DN' });
  const d = flightsLayer.getTrackedDetails();
  assert.equal(d.manufacturer, null);
  assert.equal(d.registeredOwner, null);
  assert.equal(d.registeredOwnerCountry, null);
  assert.equal(d.operatorFlagCode, null);
  assert.equal(d.typeCode, 'A321');
});

test('the metadata belongs to one aircraft: switching aircraft never carries owner or manufacturer across', () => {
  seed();
  _applyTypeEnrichmentForTest(ICAO, parsedAnswer());
  seed({ icao24: 'ae1fa4', meta: { callsign: 'SWA696' } }); // a different contact, nothing enriched yet
  const other = flightsLayer.getTrackedDetails();
  assert.equal(other.icao24, 'ae1fa4');
  assert.equal(other.registeredOwner, null);
  assert.equal(other.manufacturer, null);
  assert.equal(other.operatorFlagCode, null);
  assert.equal(other.registeredOwnerCountry, null);
});

test('an unknown contact is ignored by the enrichment (evicted while the lookup was in flight)', () => {
  seed();
  assert.doesNotThrow(() => _applyTypeEnrichmentForTest('ffffff', parsedAnswer()));
  assert.equal(flightsLayer.getTrackedDetails().registeredOwner, null);
});

test('metadata is carried across polls like type and registration, and only static fields are', () => {
  const flights = read('./data/flights.js');
  assert.match(flights, /manufacturer: prevMeta\?\.manufacturer \?\? null,\s*registeredOwner: prevMeta\?\.registeredOwner \?\? null,\s*registeredOwnerCountry: prevMeta\?\.registeredOwnerCountry \?\? null,\s*operatorFlagCode: prevMeta\?\.operatorFlagCode \?\? null,/);
  const apply = flights.slice(flights.indexOf('function _applyTypeEnrichment'), flights.indexOf('function _requestTypeEnrichment'));
  for (const fast of ['altitude', 'velocity', 'squawk', 'verticalRate', 'lastContact', 'true_track']) {
    assert.equal(apply.includes(fast), false, `${fast} never rides the sticky enrichment path`);
  }
});

// -- panel rendering ---------------------------------------------------------------------------------------

test('the AIRCRAFT section shows the new rows in the requested order with precise labels', () => {
  const model = buildFlightDetailsModel(details({ typeName: 'A321 211SL' }), { nowMs: NOW });
  assert.deepEqual(aircraftRows(model).map((r) => [r.key, r.label, r.value]), [
    ['registration', 'Registration', 'N360DN'],
    ['manufacturer', 'Manufacturer', 'Airbus'],
    ['type', 'Type', 'A321 211SL'],
    ['typeCode', 'ICAO type', 'A321'],
    ['registeredOwner', 'Registered owner', 'Wilmington Trust Company'],
    ['ownerCountry', 'Owner country', 'United States'],
    ['operatorCode', 'Operator code', 'DAL'],
    ['class', 'Class', 'Airliner'],
    ['icao24', 'ICAO24', 'A40CA4'],
  ]);
});

test('no redundant manufacturer row when the type string already names it', () => {
  const rows = rowsOf(buildFlightDetailsModel(details(), { nowMs: NOW })); // typeName "Airbus A321 211SL"
  assert.equal(rows.manufacturer, undefined);
  assert.equal(rows.type, 'Airbus A321 211SL');
  const caseInsensitive = rowsOf(buildFlightDetailsModel(details({ typeName: 'AIRBUS A-321', manufacturer: 'Airbus' }), { nowMs: NOW }));
  assert.equal(caseInsensitive.manufacturer, undefined);
  const manufacturerOnly = rowsOf(buildFlightDetailsModel(details({ typeName: null, typeCode: null, manufacturer: 'Airbus' }), { nowMs: NOW }));
  assert.equal(manufacturerOnly.manufacturer, 'Airbus', 'shown when it adds something');
});

test('absent rows are omitted and never rendered as blanks', () => {
  const none = buildFlightDetailsModel(details({ manufacturer: null, registeredOwner: null, registeredOwnerCountry: null, operatorFlagCode: undefined }), { nowMs: NOW });
  const r = rowsOf(none);
  for (const key of ['manufacturer', 'registeredOwner', 'ownerCountry', 'operatorCode']) assert.equal(r[key], undefined, key);
  const partial = rowsOf(buildFlightDetailsModel(details({ registeredOwner: null, operatorFlagCode: 'DAL' }), { nowMs: NOW }));
  assert.equal(partial.registeredOwner, undefined);
  assert.equal(partial.operatorCode, 'DAL');
  assert.equal(partial.ownerCountry, 'United States');
  for (const model of [none, buildFlightDetailsModel(details({ registeredOwner: '  ', operatorFlagCode: ' ' }), { nowMs: NOW })]) {
    for (const section of model.sections) for (const row of section.rows) assert.ok(row.value.trim() && !/undefined|null/.test(row.value), row.key);
  }
});

test('the flight airline stays in FLIGHT and is never derived from the registered owner', () => {
  const model = buildFlightDetailsModel(details({ airline: 'Delta Air Lines', registeredOwner: 'Wilmington Trust Company' }), { nowMs: NOW });
  const flight = model.sections.find((s) => s.id === 'flight').rows;
  assert.equal(flight.find((r) => r.key === 'operator').value, 'Delta Air Lines');
  assert.equal(flight.some((r) => /Wilmington/.test(r.value)), false, 'the owner is not shown as the flight operator');
  const withoutAirline = buildFlightDetailsModel(details({ airline: null, registeredOwner: 'Delta Air Lines', operatorFlagCode: 'DAL' }), { nowMs: NOW });
  assert.equal(withoutAirline.sections.find((s) => s.id === 'flight')?.rows.some((r) => r.key === 'operator') ?? false, false, 'no airline is invented from owner or operator code');
  assert.equal(rowsOf(withoutAirline).registeredOwner, 'Delta Air Lines', 'owner is still shown, as an owner');
  const labels = model.sections.flatMap((s) => s.rows.map((r) => r.label));
  assert.ok(labels.includes('Registered owner') && labels.includes('Operator code'));
  assert.equal(labels.some((label) => /^(Owner|Operator|Airline)$/i.test(label)), false, 'no ambiguous label');
});

test('Phase A rows and behaviour are unchanged when the new metadata is absent', () => {
  const model = buildFlightDetailsModel(details({ manufacturer: null, registeredOwner: null, registeredOwnerCountry: null, operatorFlagCode: null }), { nowMs: NOW });
  assert.deepEqual(aircraftRows(model).map((r) => r.key), ['registration', 'type', 'typeCode', 'class', 'icao24']);
});

test('the identity line credits adsbdb when only the new metadata arrived', () => {
  const r = rowsOf(buildFlightDetailsModel({ icao24: 'abc123', registeredOwner: 'Some Owner LLC', feed: { source: 'adsb.lol' } }, { nowMs: NOW }));
  assert.equal(r.identity, 'adsbdb');
  assert.equal(r.registeredOwner, 'Some Owner LLC');
});

// -- controller: switching aircraft clears old metadata ---------------------------------------------------------

function makeNode(tag = 'div') {
  const node = {
    tag, children: [], className: '', hidden: false, textContent: '', scrollTop: 0, attributes: {}, listeners: {},
    classList: { contains: (name) => String(node.className).split(/\s+/).includes(name) },
    appendChild(child) { node.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    replaceChildren() { node.children = []; },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of node.listeners.click || []) fn({}); },
    focus() {},
    querySelector: () => null,
  };
  return node;
}
const textOf = (node) => [node.textContent, ...node.children.map(textOf)].join(' ').replace(/\s+/g, ' ').trim();

test('an open panel replaces owner/manufacturer/operator values when the selected aircraft changes', async () => {
  let current = details({ manufacturer: 'Boeing', typeName: '737-800', typeCode: 'B738', registeredOwner: 'Aircastle Ltd', registeredOwnerCountry: 'Ireland', operatorFlagCode: 'RYR' });
  const ids = {};
  for (const id of ['flight-details-btn', 'flight-details-panel', 'flight-details-body', 'flight-details-title', 'layer-drawer']) ids[id] = makeNode();
  ids['flight-details-btn'].hidden = true;
  ids['flight-details-panel'].hidden = true;
  ids['flight-details-panel'].querySelector = () => makeNode();
  const win = new EventTarget();
  win.setInterval = () => ({ unref() {} });
  win.clearInterval = () => {};
  win.setTimeout = (fn, ms) => setTimeout(fn, ms);
  win.clearTimeout = (h) => clearTimeout(h);
  initFlightPanel({ getDetails: () => current, doc: { getElementById: (id) => ids[id] || null, createElement: makeNode, body: null }, win, now: () => NOW });
  const select = (id) => win.dispatchEvent(new CustomEvent('gev:awareness-subject-selected', { detail: { layerId: 'flights', id } }));
  select('a40ca4');
  ids['flight-details-btn'].click();
  let body = textOf(ids['flight-details-body']);
  for (const expected of ['Boeing', 'Aircastle Ltd', 'Ireland', 'RYR', 'Registered owner', 'Owner country', 'Operator code']) assert.ok(body.includes(expected), expected);
  win.dispatchEvent(new CustomEvent('gev:awareness-subject-cleared', { detail: { layerId: 'flights', id: 'a40ca4' } }));
  current = details({ icao24: 'ae1fa4', callsign: 'SWA696', registration: 'N123AB', typeName: 'Boeing 737-700', typeCode: 'B737', manufacturer: null, registeredOwner: null, registeredOwnerCountry: null, operatorFlagCode: null });
  select('ae1fa4');
  await new Promise((r) => setTimeout(r, 5));
  body = textOf(ids['flight-details-body']);
  for (const stale of ['Aircastle', 'Ireland', 'RYR', 'Registered owner', 'Owner country', 'Operator code']) assert.equal(body.includes(stale), false, `${stale} did not follow the old aircraft`);
  assert.ok(body.includes('N123AB'));
});

// -- isolation ---------------------------------------------------------------------------------------------------

test('no AIS code is imported or touched, and no server/row-shape file beyond the adsbdb parser changed', () => {
  for (const file of ['./flightPanel.js', './flightPanelMetadata.test.mjs']) {
    const imports = [...code(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.equal(imports.some((i) => /ais|vessel/i.test(i)), false, `${file} imports no AIS module`);
  }
  for (const file of ['./data/aisLiveVessels.js', './data/aisViewFilter.js', './data/aisRegions.js', './data/aisCoverageStatus.js']) {
    assert.equal(/registeredOwner|operatorFlagCode|parseAdsbdbAircraft/.test(read(file)), false, `${file} is untouched`);
  }
  // The 18-element row contract and the fallback normalizer are as they were.
  const fallback = read('./data/adsbLolFallback.js');
  assert.equal(/registeredOwner|manufacturer|owner/i.test(fallback), false);
  assert.match(fallback, /emitterCategory\(aircraft\?\.category\),\s*\];/);
});
