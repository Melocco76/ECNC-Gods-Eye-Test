// Server side of AIS regional coverage: subscription boxes from the region set,
// the ingest guard, cache purge on a coverage change, GET /api/ais-regions,
// the POST authorization seam, and /api/ais-live compatibility.
// Fake key/token only; no network and no real AISStream connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, beforeEach, afterEach } from 'node:test';
import {
  aisCacheDiagnostics,
  aisCoverageController,
  aisCoverageSummary,
  aisRegionsEnabled,
  aisRegionsStatusPayload,
  aisStreamRows,
  aisStreamSubscription,
  authorizeAisRegionsWrite,
  ingestAisStreamEnvelope,
  processAisRegionsWrite,
  resetAisCoverageForTest,
  resetAisRegionsWriteLimiterForTest,
  resetAisStreamCacheForTest,
  resetAisWatchdogPolicyForTest,
} from '../vite.config.js';
import { boxesForRegions } from './data/aisRegions.js';

const KEY = 'FAKE-AIS-KEY-do-not-leak-123';
const TOKEN = 'fake-admin-token-do-not-leak-456';

const SAVED = {};
const ENV_KEYS = ['AISSTREAM_API_KEY', 'AISSTREAM_REGIONS_ENABLED', 'AIS_REGIONS_ADMIN_TOKEN',
  'AISSTREAM_BOUNDING_BOXES', 'AISSTREAM_DEFAULT_REGIONS'];

const timeUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');
const position = (mmsi, lat, lon, atMs = Date.now()) => ({
  MessageType: 'PositionReport',
  MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: timeUtc(atMs) },
  Message: { PositionReport: { UserID: mmsi, Latitude: lat, Longitude: lon, Sog: 4, Cog: 90, TrueHeading: 88 } },
});
const shipStatic = (mmsi, name) => ({
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: mmsi, ShipName: name },
  Message: { ShipStaticData: { UserID: mmsi, Name: name, Type: 70, Destination: 'HOUSTON', ImoNumber: 9000001 } },
});

const GALVESTON = [29.3, -94.8];
const NEW_YORK = [40.7, -74.0];

let clientCounter = 0;
const freshClient = () => `test-client-${++clientCounter}`;
const post = (body, headers = {}, client = freshClient()) => processAisRegionsWrite({
  headers: { 'x-gev-admin-token': TOKEN, 'content-type': 'application/json', ...headers },
  bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  clientKey: client,
});

beforeEach(() => {
  for (const key of ENV_KEYS) SAVED[key] = process.env[key];
  process.env.AISSTREAM_API_KEY = KEY;
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AIS_REGIONS_ADMIN_TOKEN = TOKEN;
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

// -- subscription -------------------------------------------------------------

test('with regions enabled the subscription is the combined boxes of the desired regions', () => {
  assert.equal(aisRegionsEnabled(), true);
  const sub = aisStreamSubscription();
  assert.equal(sub.APIKey, KEY);
  assert.deepEqual(sub.BoundingBoxes, boxesForRegions(['gulf']), 'default is the Gulf');
  assert.ok(Array.isArray(sub.FilterMessageTypes) && sub.FilterMessageTypes.length > 0, 'filter unchanged');

  aisCoverageController().setDesired(['east-coast', 'gulf']);
  assert.deepEqual(aisStreamSubscription().BoundingBoxes, boxesForRegions(['gulf', 'east-coast']));
  assert.ok(aisStreamSubscription().BoundingBoxes.length <= 12);
});

test('without the flag the legacy AISSTREAM_BOUNDING_BOXES behaviour is untouched', () => {
  delete process.env.AISSTREAM_REGIONS_ENABLED;
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[27.5,-96.5],[30.5,-92.5]]]';
  assert.equal(aisRegionsEnabled(), false);
  assert.deepEqual(aisStreamSubscription().BoundingBoxes, [[[27.5, -96.5], [30.5, -92.5]]]);
  // No coverage guard in legacy mode: a New York fix is stored as before.
  ingestAisStreamEnvelope(position('111111111', ...NEW_YORK));
  assert.equal(aisStreamRows(10).length, 1);
  assert.deepEqual(aisCoverageSummary(), { desired: [], subscribed: [], applying: false });
  const payload = aisRegionsStatusPayload();
  assert.equal(payload.mode, 'legacy-env');
  assert.deepEqual(payload.desired, []);
});

test('the default region can come from AISSTREAM_DEFAULT_REGIONS', () => {
  process.env.AISSTREAM_DEFAULT_REGIONS = 'west-coast';
  resetAisCoverageForTest();
  assert.deepEqual(aisCoverageController().getDesired(), ['west-coast']);
});

// -- ingest guard and cache purge ---------------------------------------------

test('the ingest guard drops positions outside desired coverage but still counts them as feed liveness', () => {
  aisCoverageController().markSubscribed();
  assert.equal(ingestAisStreamEnvelope(position('211111111', ...GALVESTON)), true);
  assert.equal(ingestAisStreamEnvelope(position('222222222', ...NEW_YORK)), true, 'liveness is still credited');
  const rows = aisStreamRows(10);
  assert.deepEqual(rows.map((r) => r.mmsi), ['211111111']);
  assert.equal(aisRegionsStatusPayload().messages.droppedOutOfCoverage, 1);
});

test('the guard follows DESIRED coverage, so a removed region stops refreshing during the debounce', () => {
  const controller = aisCoverageController();
  controller.markSubscribed(); // upstream believes: gulf
  controller.setDesired(['east-coast']); // pending; not yet sent
  assert.deepEqual(controller.getSubscribed(), ['gulf']);
  assert.equal(controller.isApplying(), true);
  ingestAisStreamEnvelope(position('211111111', ...GALVESTON)); // upstream still sends Gulf
  assert.equal(aisStreamRows(10).length, 0, 'not repopulated');
  ingestAisStreamEnvelope(position('222222222', ...NEW_YORK));
  assert.equal(aisStreamRows(10).length, 1, 'the newly wanted region is accepted the moment data arrives');
  controller.dispose();
});

test('removing a region evicts its vessels and tracks, keeps static metadata and other regions', () => {
  const controller = aisCoverageController();
  controller.markSubscribed(); // gulf
  const t0 = Date.now();
  // A Gulf vessel with a real track (two fixes >30 s and >25 m apart) and static metadata.
  ingestAisStreamEnvelope(shipStatic('211111111', 'GULF TANKER'));
  ingestAisStreamEnvelope(position('211111111', 29.30, -94.80, t0 - 120_000));
  ingestAisStreamEnvelope(position('211111111', 29.31, -94.79, t0 - 60_000));
  assert.equal(aisCacheDiagnostics().tracks, 1, 'the Gulf vessel has a track');
  // A vessel with only a single pending fix.
  ingestAisStreamEnvelope(position('233333333', 28.0, -95.0, t0));
  assert.equal(aisCacheDiagnostics().pending, 1);

  controller.setDesired(['east-coast']);
  ingestAisStreamEnvelope(position('222222222', ...NEW_YORK, t0)); // an East Coast vessel arrives
  assert.equal(aisStreamRows(10).length, 3, 'Gulf rows linger only until the new subscription is applied');

  controller.markSubscribed(); // the transport reports the update hit the wire

  const after = aisCacheDiagnostics();
  assert.deepEqual(aisStreamRows(10).map((r) => r.mmsi), ['222222222'], 'only the East Coast vessel remains');
  assert.equal(after.tracks, 0, 'the Gulf vessel track was evicted with it');
  assert.equal(after.pending, 1, 'pending fix for the removed region evicted; the East Coast one kept');
  assert.equal(after.static, 1, 'static metadata survives');
  assert.equal(after.vessels, 1);
});

test('the 50,000 cap and TTL constants are unchanged by regional coverage', () => {
  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(source, /const AISSTREAM_CACHE_MAX = 50000;/);
  assert.match(source, /const AISSTREAM_STALE_MS = 30 \* 60 \* 1000;/);
});

// -- GET /api/ais-regions -----------------------------------------------------

test('GET payload shape, limits and safe counters', () => {
  aisCoverageController().markSubscribed();
  ingestAisStreamEnvelope(position('211111111', ...GALVESTON));
  const payload = aisRegionsStatusPayload();
  assert.equal(payload.mode, 'regions');
  assert.deepEqual(payload.regions.map((r) => r.id), ['gulf', 'east-coast', 'west-coast', 'great-lakes']);
  assert.deepEqual(payload.desired, ['gulf']);
  assert.deepEqual(payload.subscribed, ['gulf']);
  assert.equal(payload.applying, false);
  assert.equal(payload.maxRegions, 2);
  assert.equal(payload.minRegions, 1);
  assert.equal(payload.maxBoxes, 12);
  assert.equal(payload.boxCount, 2);
  assert.equal(payload.vessels, 1);
  assert.equal(typeof payload.lastSubscribedAt, 'number');
  assert.equal(payload.messages.total, 1);
  assert.equal(payload.connection.status, 'idle');
  assert.equal(payload.writeEnabled, true);
  assert.ok(Number.isFinite(Date.parse(new Date(payload.lastSubscribedAt).toISOString())));
});

test('GET never leaks the API key, the admin token, or raw environment data', () => {
  const text = JSON.stringify(aisRegionsStatusPayload());
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(/APIKey|API_KEY|process\.env|ADMIN/i.test(text), false);
  // Public catalogue metadata carries no coordinates.
  assert.equal(/-98|-122|-92\.3/.test(text), false);
  // writeEnabled is a boolean, not the token.
  assert.equal(typeof aisRegionsStatusPayload().writeEnabled, 'boolean');
});

test('GET reflects a pending change as desired != subscribed with applying=true', () => {
  const controller = aisCoverageController();
  controller.markSubscribed();
  controller.setDesired(['gulf', 'east-coast']);
  const payload = aisRegionsStatusPayload();
  assert.deepEqual(payload.desired, ['gulf', 'east-coast']);
  assert.deepEqual(payload.subscribed, ['gulf']);
  assert.equal(payload.applying, true);
  controller.dispose();
});

test('message rate is cheap: null until two samples 10s apart, no cache scan', () => {
  assert.equal(aisRegionsStatusPayload().messages.ratePerSec, null);
  assert.equal(aisRegionsStatusPayload().messages.ratePerSec, null);
});

// -- POST authorization seam --------------------------------------------------

test('writes are refused outright when no admin token is configured (the default)', () => {
  delete process.env.AIS_REGIONS_ADMIN_TOKEN;
  const result = post({ regions: ['gulf'] });
  assert.equal(result.status, 403);
  assert.equal(aisRegionsStatusPayload().writeEnabled, false);
  assert.equal(authorizeAisRegionsWrite({}, {}).ok, false);
  assert.equal(authorizeAisRegionsWrite({ 'x-gev-admin-token': 'anything' }, {}).status, 403);
});

test('a missing or wrong token is 401, and the right token passes', () => {
  assert.equal(post({ regions: ['gulf'] }, { 'x-gev-admin-token': '' }).status, 401);
  assert.equal(post({ regions: ['gulf'] }, { 'x-gev-admin-token': 'wrong' }).status, 401);
  const noHeader = processAisRegionsWrite({
    headers: { 'content-type': 'application/json' }, bodyText: '{"regions":["gulf"]}', clientKey: freshClient(),
  });
  assert.equal(noHeader.status, 401);
  assert.equal(post({ regions: ['gulf'] }).status, 202);
  assert.equal(authorizeAisRegionsWrite({ 'x-gev-admin-token': TOKEN }, { AIS_REGIONS_ADMIN_TOKEN: TOKEN }).ok, true);
  for (const result of [post({ regions: ['gulf'] }, { 'x-gev-admin-token': 'wrong' })]) {
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'errors never echo the token');
  }
});

test('POST applies allow-listed regions, normalised, and reports desired/subscribed/applying', () => {
  aisCoverageController().markSubscribed();
  const result = post({ regions: ['east-coast', 'gulf', 'gulf'] });
  assert.equal(result.status, 202);
  assert.deepEqual(result.payload, { desired: ['gulf', 'east-coast'], subscribed: ['gulf'], applying: true });
  aisCoverageController().dispose();
});

test('POST rejects unknown, empty, oversized and malformed region lists', () => {
  assert.equal(post({ regions: ['atlantis'] }).status, 400);
  assert.equal(post({ regions: [] }).status, 400, 'all-regions-off is not allowed');
  assert.equal(post({ regions: ['gulf', 'east-coast', 'west-coast'] }).status, 400);
  assert.equal(post({ regions: 'gulf' }).status, 400);
  assert.equal(post({}).status, 400);
  assert.equal(post([]).status, 400);
  assert.equal(post('not json').status, 400);
  assert.deepEqual(aisCoverageController().getDesired(), ['gulf'], 'nothing changed');
});

test('POST cannot smuggle arbitrary boxes: only region IDs are ever read', () => {
  const evil = [[[-90, -180], [90, 180]]];
  const result = post({ regions: ['gulf'], BoundingBoxes: evil, boxes: evil, bbox: evil });
  assert.equal(result.status, 202);
  assert.deepEqual(aisStreamSubscription().BoundingBoxes, boxesForRegions(['gulf']));
  assert.equal(post({ regions: [{ id: 'gulf', boxes: evil }] }).status, 400);
});

test('POST enforces JSON content type, a small body, and same-origin browsers', () => {
  assert.equal(post({ regions: ['gulf'] }, { 'content-type': 'text/plain' }).status, 415);
  assert.equal(post({ regions: ['gulf'] }, { 'content-type': undefined }).status, 415);
  assert.equal(post(JSON.stringify({ regions: ['gulf'], pad: 'x'.repeat(4096) })).status, 413);
  const host = 'godseye.example.com';
  assert.equal(post({ regions: ['gulf'] }, { origin: 'https://evil.example', host }).status, 403);
  assert.equal(post({ regions: ['gulf'] }, { origin: 'not a url', host }).status, 403);
  assert.equal(post({ regions: ['gulf'] }, { origin: `https://${host}`, host }).status, 202);
  assert.equal(post({ regions: ['gulf'] }).status, 202, 'no Origin header (non-browser client) is fine');
});

test('POST is rate limited per client', () => {
  const client = freshClient();
  let limited = 0;
  for (let i = 0; i < 20; i += 1) {
    if (post({ regions: ['gulf'] }, {}, client).status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'the limiter kicks in');
  assert.equal(post({ regions: ['gulf'] }, {}, freshClient()).status, 202, 'other clients are unaffected');
});

test('POST is refused with 409 when regional coverage is not enabled', () => {
  delete process.env.AISSTREAM_REGIONS_ENABLED;
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[27.5,-96.5],[30.5,-92.5]]]';
  assert.equal(post({ regions: ['gulf'] }).status, 409);
});

test('auth runs before validation, so an unauthorised caller learns nothing about the catalogue', () => {
  const result = post({ regions: ['atlantis'] }, { 'x-gev-admin-token': 'wrong' });
  assert.equal(result.status, 401);
  assert.equal(JSON.stringify(result.payload).includes('unknown region'), false);
});

// -- /api/ais-live compatibility and wiring -----------------------------------

test('/api/ais-live keeps every existing field and only ADDS coverage', () => {
  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const start = source.indexOf("middlewares.use('/api/ais-live'");
  const block = source.slice(start, source.indexOf('} catch (error) {', start));
  for (const field of ['rows,', "source: 'AISStream'", 'status: feed.status', 'error: feed.error',
    'refreshing: feed.status', 'newestPositionAt', 'lastMessageAt: feed.lastMessageAt', 'silentForMs',
    'reconnectAttempt: feed.reconnectAttempt', 'nextAttemptAt', 'staleAfterMs', 'watchdog: feed.watchdog']) {
    assert.ok(block.includes(field), `/api/ais-live must still carry ${field}`);
  }
  assert.ok(block.includes('coverage: aisCoverageSummary(),'), 'the additive coverage block');
  assert.deepEqual(Object.keys(aisCoverageSummary()).sort(), ['applying', 'desired', 'subscribed']);
});

test('the browser layer never carries region-write credentials or names the regions endpoint (owner writes live in ownerCoverage.js)', () => {
  const layer = fs.readFileSync(new URL('./data/aisLiveVessels.js', import.meta.url), 'utf8');
  assert.equal(layer.includes('ais-regions'), false, 'the layer itself never writes; the owner controller does, via the session cookie');
  assert.equal(layer.includes('x-gev-admin-token'), false);
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('ais-regions'), false);
  assert.equal(html.includes('AIS_REGIONS_ADMIN_TOKEN'), false);
});

test('the route is mounted for both dev and preview through the shared install()', () => {
  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(source, /middlewares\.use\('\/api\/ais-regions'/);
  const install = source.indexOf('function aisLiveProxy()');
  assert.ok(install > 0 && source.indexOf("'/api/ais-regions'", install) > install);
});

test('no log line or thrown error from the region path contains the key', () => {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    process.env.AISSTREAM_DEFAULT_REGIONS = 'atlantis';
    resetAisCoverageForTest();
    aisCoverageController();
    post({ regions: ['atlantis'] });
    aisRegionsStatusPayload();
  } finally {
    console.warn = original;
  }
  assert.ok(lines.some((line) => line.includes('Ignoring AISSTREAM_DEFAULT_REGIONS')));
  assert.equal(lines.join('\n').includes(KEY), false);
  assert.equal(lines.join('\n').includes(TOKEN), false);
});
