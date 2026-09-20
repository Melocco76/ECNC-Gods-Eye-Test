// Server side of PERSONAL viewer filters: a trusted fixed subscription may cover all four
// regions (11 boxes), every vessel row carries additive region classification, and the
// server tells viewers which regions it covers. Interactive/global changes stay restricted.
// Fake key/token only; no network and no real AISStream connection is ever opened.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import {
  aisAvailableRegions,
  aisCoverageController,
  aisCoverageSummary,
  aisRegionsStatusPayload,
  aisStreamRows,
  aisStreamSubscription,
  ingestAisStreamEnvelope,
  processAisRegionsWrite,
  resetAisCoverageForTest,
  resetAisRegionsWriteLimiterForTest,
  resetAisStreamCacheForTest,
  resetAisWatchdogPolicyForTest,
} from '../vite.config.js';
import {
  AIS_REGION_CATALOGUE,
  AIS_REGION_LIMITS,
  AIS_TRUSTED_LIMITS,
  boxesForRegions,
  normalizeRegionIds,
  parseDefaultRegionsEnv,
  regionIdsForPoint,
  regionsTouchedByBoxes,
} from './data/aisRegions.js';

const ALL = ['gulf', 'east-coast', 'west-coast', 'great-lakes'];
const TOKEN = 'fake-admin-token-for-view-filter-tests';
const SAVED = {};
const ENV_KEYS = ['AISSTREAM_API_KEY', 'AISSTREAM_REGIONS_ENABLED', 'AIS_REGIONS_ADMIN_TOKEN', 'AISSTREAM_BOUNDING_BOXES', 'AISSTREAM_DEFAULT_REGIONS'];

const timeUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');
const position = (mmsi, lat, lon) => ({
  MessageType: 'PositionReport',
  MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: timeUtc(Date.now()) },
  Message: { PositionReport: { UserID: mmsi, Latitude: lat, Longitude: lon, Sog: 4, Cog: 90, TrueHeading: 88 } },
});

const POINTS = {
  gulf: [29.3, -94.8], // Galveston
  eastCoast: [40.7, -74.0], // New York
  westCoast: [37.8, -122.4], // San Francisco
  greatLakes: [41.5, -81.7], // Cleveland
  overlap: [30.9, -81.6], // Gulf second box AND East Coast second box
  nowhere: [10.0, -40.0],
};

let clients = 0;

beforeEach(() => {
  for (const key of ENV_KEYS) SAVED[key] = process.env[key];
  process.env.AISSTREAM_API_KEY = 'FAKE-AIS-KEY';
  process.env.AIS_REGIONS_ADMIN_TOKEN = TOKEN;
  delete process.env.AISSTREAM_REGIONS_ENABLED;
  delete process.env.AISSTREAM_BOUNDING_BOXES;
  delete process.env.AISSTREAM_DEFAULT_REGIONS;
  resetAisCoverageForTest();
  resetAisRegionsWriteLimiterForTest();
  resetAisStreamCacheForTest();
  resetAisWatchdogPolicyForTest();
});

afterEach(() => {
  resetAisCoverageForTest();
  resetAisStreamCacheForTest();
  resetAisWatchdogPolicyForTest();
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

// -- trusted fixed coverage ------------------------------------------------------------------

test('a trusted server configuration may subscribe to all four regions: 11 boxes', () => {
  assert.equal(boxesForRegions(ALL).length, 11);
  assert.equal(AIS_TRUSTED_LIMITS.maxRegions, AIS_REGION_CATALOGUE.length);
  assert.ok(boxesForRegions(ALL).length <= AIS_TRUSTED_LIMITS.maxBoxes);
  assert.deepEqual(normalizeRegionIds(ALL, AIS_TRUSTED_LIMITS), { ok: true, regions: ALL });
  assert.deepEqual(parseDefaultRegionsEnv(ALL.join(',')), { regions: ALL, warning: null });

  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AISSTREAM_DEFAULT_REGIONS = ALL.join(',');
  assert.deepEqual(aisCoverageController().getDesired(), ALL);
  const subscription = aisStreamSubscription();
  assert.equal(subscription.BoundingBoxes.length, 11, 'one combined 11-box subscription');
  assert.deepEqual(subscription.BoundingBoxes, boxesForRegions(ALL));
  assert.equal(aisRegionsStatusPayload().boxCount, 0, 'nothing is "subscribed" until a socket says so');
});

test('the trusted list only ever accepts catalogue IDs: no coordinates, no unknown regions', () => {
  for (const bad of ['atlantis', 'gulf,atlantis', '[[[0,0],[1,1]]]', '__proto__', 'constructor', 'gulf;drop']) {
    const parsed = parseDefaultRegionsEnv(bad);
    assert.deepEqual(parsed.regions, ['gulf'], `${bad} falls back to the default`);
    assert.match(parsed.warning, /Ignoring AISSTREAM_DEFAULT_REGIONS/);
  }
  assert.equal(normalizeRegionIds(['gulf', { id: 'east-coast' }], AIS_TRUSTED_LIMITS).ok, false);
  assert.equal(normalizeRegionIds([], AIS_TRUSTED_LIMITS).ok, false, 'at least one');
  assert.equal(AIS_TRUSTED_LIMITS.maxBoxes, 12, 'the hard box ceiling is unchanged');
});

test('interactive changes to LIVE coverage stay restricted to 2 regions even when the server started with 4', () => {
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AISSTREAM_DEFAULT_REGIONS = ALL.join(',');
  assert.equal(AIS_REGION_LIMITS.maxRegions, 2);
  const post = (headers, regions) => processAisRegionsWrite({
    headers: { 'content-type': 'application/json', ...headers },
    bodyText: JSON.stringify({ regions }),
    clientKey: `view-filter-${++clients}`,
  });
  const admin = { 'x-gev-admin-token': TOKEN };
  assert.equal(post(admin, ALL).status, 400, 'a global write may not widen to four');
  assert.equal(post(admin, ['gulf', 'east-coast', 'west-coast']).status, 400);
  assert.equal(post(admin, ['atlantis']).status, 400);
  assert.equal(post({}, ['gulf']).status, 401, 'public POST is rejected');
  assert.equal(post({ 'x-gev-admin-token': 'wrong' }, ['gulf']).status, 401);
  assert.deepEqual(aisCoverageController().getDesired(), ALL, 'nothing changed');
  assert.equal(post(admin, ['gulf', 'east-coast']).status, 202, 'a maintenance narrowing still works');
});

test('the ingest guard follows the trusted four-region set', () => {
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AISSTREAM_DEFAULT_REGIONS = ALL.join(',');
  for (const [i, p] of [POINTS.gulf, POINTS.eastCoast, POINTS.westCoast, POINTS.greatLakes].entries()) {
    assert.equal(ingestAisStreamEnvelope(position(`77700000${i}`, ...p)), true);
  }
  ingestAisStreamEnvelope(position('777000009', ...POINTS.nowhere));
  assert.equal(aisStreamRows(50).length, 4, 'all four regions are stored; the open ocean is dropped');
});

// -- classification ---------------------------------------------------------------------------------

test('every catalogue region classifies its own vessels, and open ocean gets none', () => {
  assert.deepEqual(regionIdsForPoint(...POINTS.gulf), ['gulf']);
  assert.deepEqual(regionIdsForPoint(...POINTS.eastCoast), ['east-coast']);
  assert.deepEqual(regionIdsForPoint(...POINTS.westCoast), ['west-coast']);
  assert.deepEqual(regionIdsForPoint(...POINTS.greatLakes), ['great-lakes']);
  assert.deepEqual(regionIdsForPoint(...POINTS.nowhere), []);
  assert.deepEqual(regionIdsForPoint(Number.NaN, 0), []);
  assert.deepEqual(regionIdsForPoint(null, undefined), []);
});

test('overlapping boxes give multiple region IDs, in catalogue order, once each', () => {
  assert.deepEqual(regionIdsForPoint(...POINTS.overlap), ['gulf', 'east-coast']);
  // A point inside two boxes of the SAME region still lists it once.
  const ids = regionIdsForPoint(30.5, -90.0); // shared edge of the two Gulf boxes
  assert.deepEqual(ids, ['gulf']);
});

test('vessel rows carry regionIds additively; MMSI stays the identity; rows are not duplicated', () => {
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AISSTREAM_DEFAULT_REGIONS = ALL.join(',');
  ingestAisStreamEnvelope(position('123456789', ...POINTS.overlap));
  ingestAisStreamEnvelope(position('123456789', ...POINTS.overlap)); // a second report: same vessel
  ingestAisStreamEnvelope(position('987654321', ...POINTS.westCoast));
  const rows = aisStreamRows(50);
  assert.equal(rows.length, 2, 'one row per MMSI');
  const overlap = rows.find((r) => r.mmsi === '123456789');
  assert.deepEqual(overlap.regionIds, ['gulf', 'east-coast']);
  assert.deepEqual(rows.find((r) => r.mmsi === '987654321').regionIds, ['west-coast']);
});

test('the classification is additive: every previous row field is still present and unchanged', () => {
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  ingestAisStreamEnvelope(position('123456789', ...POINTS.gulf));
  const [row] = aisStreamRows(10);
  for (const field of ['lat', 'lon', 'name', 'mmsi', 'imo', 'type', 'destination', 'speed', 'course', 'heading', 'last_position_UTC', 'last_position_epoch']) {
    assert.ok(field in row, `${field} is still returned`);
  }
  assert.equal(row.lat, POINTS.gulf[0]);
  assert.equal(row.mmsi, '123456789');
  assert.equal('_updatedAt' in row, false, 'internal fields are still stripped');
  assert.deepEqual(Object.keys(row).filter((k) => !['lat', 'lon', 'name', 'mmsi', 'imo', 'type', 'destination', 'speed', 'course', 'heading', 'last_position_UTC', 'last_position_epoch'].includes(k)), ['regionIds'], 'regionIds is the only new field');
});

test('legacy mode classifies too, so viewers can filter a legacy server honestly', () => {
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[27.5,-96.5],[30.5,-92.5]]]';
  ingestAisStreamEnvelope(position('123456789', ...POINTS.gulf));
  assert.deepEqual(aisStreamRows(10)[0].regionIds, ['gulf']);
});

// -- what the server says it covers -----------------------------------------------------------------

test('legacy production box offers viewers only the Gulf', () => {
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[27.5,-96.5],[30.5,-92.5]]]';
  assert.deepEqual(aisAvailableRegions(), ['gulf']);
  assert.deepEqual(aisCoverageSummary().available, ['gulf']);
  assert.deepEqual(aisRegionsStatusPayload().available, ['gulf']);
  assert.equal(aisRegionsStatusPayload().mode, 'legacy-env');
});

test('a legacy world box or garbage config is handled honestly', () => {
  assert.deepEqual(aisAvailableRegions(), ALL, 'unset legacy box = the whole world = every region');
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[40,-75],[41,-73]]]';
  assert.deepEqual(aisAvailableRegions(), ['east-coast']);
  process.env.AISSTREAM_BOUNDING_BOXES = 'not json';
  assert.ok(Array.isArray(aisAvailableRegions()));
  assert.deepEqual(regionsTouchedByBoxes('nope'), []);
  assert.deepEqual(regionsTouchedByBoxes([[[0, 0]], 5, null, [['a', 1], [2, 3]]]), []);
});

test('regional mode reports the subscribed regions (desired until the first subscription)', () => {
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AISSTREAM_DEFAULT_REGIONS = ALL.join(',');
  assert.deepEqual(aisAvailableRegions(), ALL, 'before any socket: what the server intends');
  aisCoverageController().markSubscribed();
  assert.deepEqual(aisCoverageSummary().available, ALL);
  const payload = aisRegionsStatusPayload();
  assert.deepEqual(payload.available, ALL);
  assert.equal(payload.trustedMaxRegions, 4);
  assert.equal(payload.maxRegions, 2, 'the interactive limit is reported separately');
  assert.equal(payload.boxCount, 11);
  aisCoverageController().dispose();
});

test('a viewer request can never change coverage: nothing in the read endpoints mutates it', () => {
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AISSTREAM_DEFAULT_REGIONS = 'gulf';
  const before = aisCoverageController().getDesired();
  for (let i = 0; i < 5; i += 1) { aisRegionsStatusPayload(); aisCoverageSummary(); aisStreamRows(10); }
  assert.deepEqual(aisCoverageController().getDesired(), before);
});
