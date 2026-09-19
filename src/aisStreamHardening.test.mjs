// AISStream hardening: explicit permessage-deflate, SubscriptionConfirmation,
// bounded cache pruning, static-data lifetime, and narrow-box configuration.
// Fake sockets / fake keys only — no network, no real AISSTREAM_API_KEY.
//
// Run with: npm test   (node --test)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AIS_CACHE_LIMITS,
  AIS_SOCKET_OPTIONS,
  aisCacheDiagnostics,
  aisStreamRows,
  aisStreamSubscription,
  aisWatchdogPolicy,
  createAisWebSocket,
  ingestAisStreamEnvelope,
  logAisSubscriptionConfirmed,
  resetAisStreamCacheForTest,
  resetAisWatchdogPolicyForTest,
} from '../vite.config.js';
import { createAisStreamAdapter, parseSubscriptionConfirmation } from './data/aisStreamAdapter.js';
import { parseSilenceTimeoutEnv } from './data/aisWatchdog.js';

const KEY = 'FAKE-AIS-KEY-do-not-leak-123';
const T0 = Date.UTC(2026, 8, 19, 0, 0, 0);
const MIN = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── envelopes ────────────────────────────────────────────────────────────────
const timeUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');
const positionReport = (mmsi, lat, lon, { name = '', type = 'PositionReport' } = {}) => ({
  MessageType: type,
  MetaData: { MMSI: mmsi, ...(name ? { ShipName: name } : {}), latitude: lat, longitude: lon, time_utc: timeUtc(Date.now()) },
  Message: { [type]: { UserID: mmsi, Latitude: lat, Longitude: lon, Sog: 4.2, Cog: 90, TrueHeading: 88 } },
});
const shipStatic = (mmsi, { name = 'MV TEST', destination = 'HOUSTON', imo = 9000001, shipType = 70 } = {}) => ({
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: mmsi, ShipName: name },
  Message: { ShipStaticData: { UserID: mmsi, Name: name, Type: shipType, Destination: destination, ImoNumber: imo } },
});
const staticReport = (mmsi, { name = 'CLASS B', shipType = 37 } = {}) => ({
  MessageType: 'StaticDataReport',
  MetaData: { MMSI: mmsi, ShipName: name },
  Message: { StaticDataReport: { UserID: mmsi, ReportA: { Name: name }, ReportB: { ShipType: shipType } } },
});
const confirmation = (compressionEnabled) => ({
  MessageType: 'SubscriptionConfirmation',
  Message: compressionEnabled === undefined ? {} : { CompressionEnabled: compressionEnabled },
});

// ── mock socket + adapter harness (ws emitter semantics) ─────────────────────
function makeHarness({ redactKey = true } = {}) {
  let wall = 1_700_000_000_000;
  let mono = 10_000;
  const created = [];
  const warnings = [];
  const confirmations = [];
  const ingested = [];

  class MockSocket {
    constructor(url) {
      this.url = url;
      this.handlers = new Map();
      this.sent = [];
      this.terminated = false;
      created.push(this);
    }

    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(handler);
    }

    emit(event, ...args) { for (const handler of [...(this.handlers.get(event) || [])]) handler(...args); }

    send(payload) { this.sent.push(payload); }

    terminate() { this.terminated = true; }
  }

  const adapter = createAisStreamAdapter({
    createSocket: (url) => new MockSocket(url),
    resolveUrl: () => 'ws://mock.invalid/stream',
    buildSubscription: () => ({ APIKey: KEY, BoundingBoxes: [[[27.5, -96.5], [30.5, -92.5]]] }),
    ingestEnvelope: (envelope) => { ingested.push(envelope); return envelope?.MessageType === 'PositionReport'; },
    clock: { wall: () => wall, mono: () => mono },
    warn: (message) => warnings.push(message),
    onSubscriptionConfirmed: (value) => confirmations.push(value),
    redact: redactKey ? (text) => text.split(KEY).join('[redacted]') : undefined,
  });
  adapter.setWatchdogOptions({
    staleMs: 1_000, recycleAfterMs: 2_500, backoffMs: [5_000, 15_000], downRetryMs: 60_000, authProbeMs: 3_600_000,
  });
  const env = { hasKey: true, hasTransport: true, keyFingerprint: 'k1' };
  return {
    adapter, created, warnings, confirmations, ingested, env,
    advance(ms) { wall += ms; mono += ms; },
    connect() {
      adapter.ensure(env);
      const socket = created.at(-1);
      socket.emit('open');
      return socket;
    },
    send(socket, envelope) { socket.emit('message', Buffer.from(JSON.stringify(envelope))); },
    snapshot: () => adapter.snapshot(),
  };
}

// ── explicit permessage-deflate ──────────────────────────────────────────────
test('the AIS socket explicitly requests permessage-deflate and changes nothing else', () => {
  assert.equal(Object.isFrozen(AIS_SOCKET_OPTIONS), true);
  assert.deepEqual({ ...AIS_SOCKET_OPTIONS }, { perMessageDeflate: true });

  const seen = [];
  class FakeWs { constructor(...args) { seen.push(args); } }
  createAisWebSocket('wss://stream.aisstream.io/v0/stream', FakeWs);
  assert.deepEqual(seen, [['wss://stream.aisstream.io/v0/stream', { perMessageDeflate: true }]]);
  assert.equal(JSON.stringify(seen).includes('APIKey'), false, 'the subscription/key is never a socket option');
  assert.throws(() => createAisWebSocket('wss://x', null), /ws transport unavailable/);

  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(source, /const AISSTREAM_URL = 'wss:\/\/stream\.aisstream\.io\/v0\/stream';/, 'endpoint unchanged');
});

test('a real ws client built by createAisWebSocket negotiates permessage-deflate', async () => {
  const server = new WebSocketServer({ port: 0, perMessageDeflate: true });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const client = createAisWebSocket(`ws://127.0.0.1:${port}`, WebSocket);
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    assert.match(client.extensions, /permessage-deflate/);
    client.terminate();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── SubscriptionConfirmation ─────────────────────────────────────────────────
test('SubscriptionConfirmation parsing: compression true/false/unknown, and non-confirmations ignored', () => {
  assert.deepEqual(parseSubscriptionConfirmation(confirmation(true)), { compressionEnabled: true });
  assert.deepEqual(parseSubscriptionConfirmation(confirmation(false)), { compressionEnabled: false });
  assert.deepEqual(parseSubscriptionConfirmation(confirmation(undefined)), { compressionEnabled: null });
  // Tolerated alternate shapes.
  assert.deepEqual(
    parseSubscriptionConfirmation({ SubscriptionConfirmation: { Message: { CompressionEnabled: true } } }),
    { compressionEnabled: true },
  );
  assert.equal(parseSubscriptionConfirmation(positionReport('1', 1, 1)), null);
  assert.equal(parseSubscriptionConfirmation({ error: 'nope' }), null);
  assert.equal(parseSubscriptionConfirmation(null), null);
  assert.equal(parseSubscriptionConfirmation([]), null);
});

test('a confirmation is protocol activity: reported, never ingested as a vessel, never claims live', async () => {
  for (const flag of [true, false, undefined]) {
    const h = makeHarness();
    const socket = h.connect();
    h.advance(800);
    h.send(socket, confirmation(flag));
    await flush();
    assert.equal(h.confirmations.length, 1);
    assert.deepEqual(h.confirmations[0], { compressionEnabled: flag === undefined ? null : flag });
    assert.equal(h.ingested.length, 0, 'not a vessel record');
    assert.notEqual(h.snapshot().status, 'live', 'a confirmation is not data');
    assert.equal(h.snapshot().lastMessageAt, null);
    assert.equal(h.snapshot().silentForMs, 0, 'protocol activity restarts the silence window');
    assert.equal(h.adapter.debug().lastConfirmation.compressionEnabled, flag === undefined ? null : flag);

    h.send(socket, positionReport('123456789', 29, -94));
    await flush();
    assert.equal(h.snapshot().status, 'live', 'real data still proves liveness');
  }
});

test('a confirmation never resets the retry ladder (a confirm-then-drop server cannot loop fast)', async () => {
  const h = makeHarness();
  const delays = [];
  for (let round = 0; round < 2; round += 1) {
    const socket = h.connect();
    h.send(socket, confirmation(true));
    await flush();
    socket.emit('close'); // the server drops us right after confirming
    const snap = h.snapshot();
    delays.push(snap.nextAttemptAt - 1_700_000_000_000 - (round === 0 ? 0 : 5_000));
    h.advance(round === 0 ? 5_000 : 15_000);
  }
  assert.equal(h.snapshot().reconnectAttempt >= 2, true);
  assert.deepEqual(delays, [5_000, 15_000], 'backoff keeps escalating across confirmed-then-dropped sessions');
});

test('a confirmation lifts an auth-failed/down label back to connecting without lying about data', async () => {
  const h = makeHarness();
  const socket = h.connect();
  h.send(socket, { error: 'Invalid API key' });
  await flush();
  assert.equal(h.snapshot().status, 'auth-failed');
  h.advance(3_600_001);
  const probe = h.connect();
  h.send(probe, confirmation(true));
  await flush();
  assert.equal(h.snapshot().status, 'connecting');
  assert.equal(h.snapshot().error, null);
});

test('the API key never appears in logs, warnings, or surfaced errors', async () => {
  const h = makeHarness();
  const socket = h.connect();
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].includes(KEY), true, 'the key is sent only inside the subscription frame');
  h.send(socket, { error: `Invalid api key ${KEY}` });
  await flush();
  const snap = h.snapshot();
  assert.equal(String(snap.error).includes(KEY), false, 'upstream error text is redacted before it reaches /api/ais-live');
  assert.equal(h.warnings.some((line) => line.includes(KEY)), false);

  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    logAisSubscriptionConfirmed({ compressionEnabled: true });
    logAisSubscriptionConfirmed({ compressionEnabled: false });
    logAisSubscriptionConfirmed({ compressionEnabled: null });
    logAisSubscriptionConfirmed();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  assert.equal(logs.length, 4);
  assert.match(logs[0], /compression negotiated/i);
  assert.match(logs[1], /NOT negotiated/);
  assert.match(logs[2], /not reported/i);
  for (const line of logs) {
    assert.equal(line.includes(KEY), false);
    assert.equal(/APIKey|BoundingBoxes/.test(line), false, 'no subscription payload in logs');
  }
});

// ── cache pruning ────────────────────────────────────────────────────────────
function withClock(t, start = T0) {
  const clock = { now: start };
  t.mock.method(Date, 'now', () => clock.now);
  resetAisStreamCacheForTest();
  return clock;
}

test('high-rate messages do not trigger a full sweep each time; sweeps follow the bounded cadence', (t) => {
  const clock = withClock(t);
  for (let i = 0; i < 2000; i += 1) ingestAisStreamEnvelope(positionReport(String(300000000 + i), 29 + (i % 100) / 1000, -94));
  assert.ok(aisCacheDiagnostics().sweeps <= 1, `2,000 messages caused ${aisCacheDiagnostics().sweeps} sweeps`);

  clock.now += AIS_CACHE_LIMITS.pruneIntervalMs - 1;
  for (let i = 0; i < 500; i += 1) ingestAisStreamEnvelope(positionReport(String(300000000 + i), 29, -94));
  assert.equal(aisCacheDiagnostics().sweeps, 1, 'still inside the interval');

  clock.now += 2;
  ingestAisStreamEnvelope(positionReport('300000001', 29, -94));
  assert.equal(aisCacheDiagnostics().sweeps, 2, 'one more sweep once the interval elapsed');
});

test('pruning uses no timer or loop and no per-message full scan in the source', () => {
  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const start = source.indexOf('function evictAisVessel');
  const end = source.indexOf('export const AIS_CACHE_LIMITS');
  const block = source.slice(start, end);
  assert.ok(block.length > 200);
  assert.doesNotMatch(block, /setInterval|setTimeout|\.sort\(/);
  assert.match(block, /AISSTREAM_PRUNE_INTERVAL_MS/);
});

test('stale vessels are removed with their static metadata, tracks and pending fixes', (t) => {
  const clock = withClock(t);
  ingestAisStreamEnvelope(shipStatic('111111111', { name: 'OLD ONE' }));
  ingestAisStreamEnvelope(positionReport('111111111', 29.5, -94.5));
  ingestAisStreamEnvelope(staticReport('222222222', { name: 'STATIC ONLY' })); // never sent a position
  clock.now += 20 * MIN;
  ingestAisStreamEnvelope(positionReport('333333333', 28.5, -95.5)); // a newer vessel
  assert.deepEqual(
    { vessels: aisCacheDiagnostics().vessels, static: aisCacheDiagnostics().static },
    { vessels: 2, static: 2 },
    'nothing expires early',
  );

  clock.now += 11 * MIN; // 31 min since the first two arrived; the newer one is 11 min old
  ingestAisStreamEnvelope(positionReport('444444444', 28, -95));
  const diagnostics = aisCacheDiagnostics();
  assert.equal(diagnostics.vessels, 2, 'the 31-minute-old vessel was evicted; 333… and 444… remain');
  assert.equal(diagnostics.static, 0, 'static metadata left with its vessels (including the static-only one)');
  assert.deepEqual(aisStreamRows(100).map((row) => row.mmsi).sort(), ['333333333', '444444444']);
});

test('an active vessel keeps its static enrichment; a silent one loses it', (t) => {
  const clock = withClock(t);
  ingestAisStreamEnvelope(shipStatic('555555555', { name: 'ACTIVE SHIP', destination: 'GALVESTON', imo: 9123456 }));
  ingestAisStreamEnvelope(shipStatic('666666666', { name: 'GONE SHIP' }));
  for (let step = 0; step < 6; step += 1) {
    clock.now += 10 * MIN; // 60 minutes total, well past the 30-minute TTL
    ingestAisStreamEnvelope(positionReport('555555555', 29 + step / 100, -94)); // no name in the position itself
  }
  const rows = aisStreamRows(100);
  assert.deepEqual(rows.map((row) => row.mmsi), ['555555555']);
  assert.equal(rows[0].name, 'ACTIVE SHIP', 'enrichment survived far beyond the TTL because the vessel stayed active');
  assert.equal(rows[0].destination, 'GALVESTON');
  assert.equal(rows[0].imo, '9123456');
  assert.equal(aisCacheDiagnostics().static, 1, 'the silent vessel\'s static entry was dropped');
});

test('the 50k hard cap is enforced promptly, keeps the newest vessels, and never sorts', (t) => {
  withClock(t);
  const max = AIS_CACHE_LIMITS.maxVessels;
  assert.equal(max, 50_000);
  const originalSort = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function countingSort(...args) { sorts += 1; return originalSort.apply(this, args); };
  try {
    for (let i = 0; i < max + 25; i += 1) {
      ingestAisStreamEnvelope(positionReport(String(200000000 + i), 29 + (i % 1000) / 10_000, -94 - (i % 500) / 10_000));
      assert.ok(aisCacheDiagnostics().vessels <= max, 'never allowed to stay over the cap');
    }
  } finally {
    Array.prototype.sort = originalSort;
  }
  const diagnostics = aisCacheDiagnostics();
  assert.equal(diagnostics.vessels, max);
  assert.equal(sorts, 0, 'cap enforcement evicts from the ordered head; no full-cache sort');
  assert.ok(diagnostics.sweeps <= 2);
  const rows = new Set(aisStreamRows(max).map((row) => row.mmsi));
  assert.equal(rows.has(String(200000000 + max + 24)), true, 'newest vessel retained');
  assert.equal(rows.has('200000000'), false, 'oldest vessel evicted');
  assert.equal(diagnostics.tracks + diagnostics.pending <= max, true, 'derived data is evicted with its vessel');
});

test('static-only traffic is capped too', (t) => {
  withClock(t);
  for (let i = 0; i < AIS_CACHE_LIMITS.maxVessels + 10; i += 1) ingestAisStreamEnvelope(shipStatic(String(100000000 + i)));
  assert.equal(aisCacheDiagnostics().static, AIS_CACHE_LIMITS.maxVessels);
});

test('all five subscribed message types are consumed', (t) => {
  withClock(t);
  const types = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'];
  types.forEach((type, index) => {
    assert.equal(ingestAisStreamEnvelope(positionReport(String(700000000 + index), 29 + index / 10, -94, { type })), true, type);
  });
  assert.equal(aisStreamRows(10).length, 3, 'each position type produces a vessel row');

  ingestAisStreamEnvelope(shipStatic('700000000', { name: 'FROM SHIP STATIC', destination: 'FREEPORT', imo: 9777777, shipType: 80 }));
  ingestAisStreamEnvelope(staticReport('700000001', { name: 'FROM CLASS B', shipType: 37 }));
  const byMmsi = Object.fromEntries(aisStreamRows(10).map((row) => [row.mmsi, row]));
  assert.equal(byMmsi['700000000'].name, 'FROM SHIP STATIC');
  assert.equal(byMmsi['700000000'].destination, 'FREEPORT');
  assert.equal(byMmsi['700000000'].imo, '9777777');
  assert.equal(byMmsi['700000001'].name, 'FROM CLASS B');
  assert.equal(byMmsi['700000001'].type, '37');

  // The subscription still asks for exactly these five.
  assert.deepEqual(aisStreamSubscription().FilterMessageTypes, [
    'PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport',
  ]);
});

// ── narrow-box and silence-timeout configuration ─────────────────────────────
function withEnv(overrides, fn) {
  const previous = {};
  for (const name of Object.keys(overrides)) previous[name] = process.env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAisWatchdogPolicyForTest();
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAisWatchdogPolicyForTest();
  }
}

test('the recommended narrow box is parsed exactly; the default stays the whole world', () => {
  withEnv({ AISSTREAM_API_KEY: KEY, AISSTREAM_BOUNDING_BOXES: '[[[27.5,-96.5],[30.5,-92.5]]]', AISSTREAM_MESSAGE_TYPES: undefined }, () => {
    const subscription = aisStreamSubscription();
    assert.deepEqual(subscription.BoundingBoxes, [[[27.5, -96.5], [30.5, -92.5]]]);
    assert.equal(subscription.APIKey, KEY);
    assert.equal(subscription.FilterMessageTypes.length, 5);
  });
  withEnv({ AISSTREAM_API_KEY: KEY, AISSTREAM_BOUNDING_BOXES: undefined }, () => {
    assert.deepEqual(aisStreamSubscription().BoundingBoxes, [[[-90, -180], [90, 180]]], 'backward-compatible default');
  });
  withEnv({ AISSTREAM_API_KEY: KEY, AISSTREAM_BOUNDING_BOXES: '[[[27.5,-96.5],[30.5,-92.5]],[[33.4,-119.0],[34.2,-117.7]]]' }, () => {
    assert.equal(aisStreamSubscription().BoundingBoxes.length, 2, 'several boxes are allowed');
  });
});

test('invalid box JSON falls back to the world default with a warning (documented in .env.example)', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    withEnv({ AISSTREAM_API_KEY: KEY, AISSTREAM_BOUNDING_BOXES: '[[[27.5,-96.5],[30.5,' }, () => {
      assert.deepEqual(aisStreamSubscription().BoundingBoxes, [[[-90, -180], [90, 180]]]);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.some((line) => /AISSTREAM_BOUNDING_BOXES/.test(line)), true);
  assert.equal(warnings.some((line) => line.includes(KEY)), false);
});

test('silence-timeout parsing and policy: default, narrow box, explicit 900000, kill switch, garbage', () => {
  assert.deepEqual(parseSilenceTimeoutEnv('900000'), { kind: 'timeout', value: 900000 });
  assert.deepEqual(parseSilenceTimeoutEnv('0'), { kind: 'off' });
  assert.deepEqual(parseSilenceTimeoutEnv(undefined), { kind: 'default' });
  assert.deepEqual(parseSilenceTimeoutEnv('  '), { kind: 'default' });
  const warnings = [];
  assert.deepEqual(parseSilenceTimeoutEnv('soon', (message) => warnings.push(message)), { kind: 'default' });
  assert.equal(warnings.length, 1);

  const cases = [
    [{ AISSTREAM_BOUNDING_BOXES: undefined, AISSTREAM_MESSAGE_TYPES: undefined, AISSTREAM_SILENCE_TIMEOUT_MS: undefined }, true, 120_000],
    [{ AISSTREAM_BOUNDING_BOXES: '[[[27.5,-96.5],[30.5,-92.5]]]', AISSTREAM_SILENCE_TIMEOUT_MS: undefined }, false, 120_000],
    [{ AISSTREAM_BOUNDING_BOXES: '[[[27.5,-96.5],[30.5,-92.5]]]', AISSTREAM_SILENCE_TIMEOUT_MS: '900000' }, true, 900_000],
    [{ AISSTREAM_BOUNDING_BOXES: undefined, AISSTREAM_SILENCE_TIMEOUT_MS: '0' }, false, 120_000],
  ];
  for (const [env, silenceWatch, reportMs] of cases) {
    withEnv(env, () => {
      const policy = aisWatchdogPolicy();
      assert.equal(policy.silenceWatch, silenceWatch, JSON.stringify(env));
      assert.equal(policy.reportMs, reportMs);
      assert.equal(policy.recycleMs, Math.round(reportMs * 2.5));
      assert.equal(policy.url, 'wss://stream.aisstream.io/v0/stream', 'protocol URL unchanged');
    });
  }
});

// ── docs / stale comments ────────────────────────────────────────────────────
test('.env.example shows the narrow first Cloud Run config and discourages the world default', () => {
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /AISSTREAM_BOUNDING_BOXES=\[\[\[27\.5,-96\.5\],\[30\.5,-92\.5\]\]\]/);
  assert.match(env, /AISSTREAM_SILENCE_TIMEOUT_MS=900000/);
  assert.match(env, /DISCOURAGED/);
  assert.match(env, /3 subscribed connections per account/);
});

test('no comment or test title still claims AISStream allows one connection per key', () => {
  for (const file of [
    '../vite.config.js', './data/aisStreamAdapter.js', './data/aisWatchdog.js',
    './data/aisStreamAdapter.test.mjs', './data/aisWatchdog.test.mjs', './data/aisWatchdogTransport.test.mjs',
  ]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /one[- ]connection[- ]per[- ]key|allows only one per key|single per-key connection|one connection per key/i, file);
  }
  const adapter = fs.readFileSync(new URL('./data/aisStreamAdapter.js', import.meta.url), 'utf8');
  assert.match(adapter, /AT MOST ONE live socket per process/);
  assert.match(adapter, /3 subscribed connections per account/);
});
