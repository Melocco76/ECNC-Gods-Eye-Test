// In-place resubscribe on the ONE owned AISStream socket. Fake sockets only -
// no network and no real key. Pins: same socket, exactly one live socket, no
// reconnect-ladder cost on success, the silence baseline reset, and that a
// failed/unavailable send leaves the normal reconnect path in charge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAisStreamAdapter } from './aisStreamAdapter.js';
import { boxesForRegions } from './aisRegions.js';

const KEY = 'FAKE-AIS-KEY-do-not-leak-123';
const OPEN = 1;

function makeHarness({ sendThrows = false } = {}) {
  let wall = 1_700_000_000_000;
  let mono = 10_000;
  let desired = ['gulf'];
  const created = [];
  const warnings = [];
  const sentNotifications = [];
  const state = { sendThrows };

  class MockSocket {
    constructor(url) {
      this.url = url;
      this.handlers = new Map();
      this.sent = [];
      this.terminated = false;
      this.readyState = 0; // CONNECTING until 'open'
      created.push(this);
    }

    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(handler);
    }

    emit(event, ...args) { for (const handler of [...(this.handlers.get(event) || [])]) handler(...args); }

    send(payload) {
      if (state.sendThrows) throw new Error(`send failed for ${KEY}`);
      this.sent.push(JSON.parse(payload));
    }

    terminate() {
      this.terminated = true;
      this.readyState = 3;
    }
  }

  const adapter = createAisStreamAdapter({
    createSocket: (url) => new MockSocket(url),
    resolveUrl: () => 'ws://mock.invalid/stream',
    buildSubscription: () => ({
      APIKey: KEY,
      BoundingBoxes: boxesForRegions(desired),
      FilterMessageTypes: ['PositionReport'],
    }),
    ingestEnvelope: (envelope) => envelope?.MessageType === 'PositionReport',
    clock: { wall: () => wall, mono: () => mono },
    warn: (message) => warnings.push(message),
    onSubscriptionSent: () => sentNotifications.push(desired.slice()),
    redact: (text) => text.split(KEY).join('[redacted]'),
  });
  adapter.setWatchdogOptions({
    staleMs: 1_000, recycleAfterMs: 2_500, backoffMs: [5_000, 15_000], downRetryMs: 60_000, authProbeMs: 3_600_000,
  });
  const env = { hasKey: true, hasTransport: true, keyFingerprint: 'k1' };
  return {
    adapter, created, warnings, sentNotifications, env,
    setDesired: (next) => { desired = next; },
    advance(ms) { wall += ms; mono += ms; },
    connect() {
      adapter.ensure(env);
      const socket = created.at(-1);
      socket.readyState = OPEN;
      socket.emit('open');
      return socket;
    },
    position(socket) {
      socket.emit('message', Buffer.from(JSON.stringify({ MessageType: 'PositionReport' })));
    },
    snapshot: () => adapter.snapshot(),
    setSendThrows: (value) => { state.sendThrows = value; },
  };
}

test('resubscribe replaces the subscription on the SAME open socket', () => {
  const h = makeHarness();
  const socket = h.connect();
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(socket.sent[0].BoundingBoxes, boxesForRegions(['gulf']));

  h.setDesired(['gulf', 'east-coast']);
  const result = h.adapter.resubscribe();
  assert.equal(result.sent, true);

  assert.equal(h.created.length, 1, 'no second WebSocket was created');
  assert.equal(h.adapter.debug().liveSockets, 1);
  assert.equal(socket.terminated, false, 'the socket was not torn down');
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.sent[1].BoundingBoxes, boxesForRegions(['gulf', 'east-coast']));
  // Same credential and filter as the original subscription.
  assert.equal(socket.sent[1].APIKey, KEY);
  assert.deepEqual(socket.sent[1].FilterMessageTypes, ['PositionReport']);
  assert.deepEqual(h.sentNotifications, [['gulf'], ['gulf', 'east-coast']], 'observer sees connect and update');
});

test('a successful resubscribe does not touch the reconnect ladder', () => {
  const h = makeHarness();
  const socket = h.connect();
  h.position(socket);
  assert.equal(h.snapshot().reconnectAttempt, 0);
  assert.equal(h.snapshot().status, 'live');
  h.setDesired(['west-coast']);
  h.adapter.resubscribe();
  h.adapter.resubscribe();
  assert.equal(h.snapshot().reconnectAttempt, 0);
  assert.equal(h.snapshot().status, 'live');
  assert.equal(h.adapter.debug().watchdog.generation, 1, 'same generation throughout');
  assert.equal(h.created.length, 1);
});

test('resubscribe restarts the silence baseline so a quieter region is not recycled early', () => {
  const h = makeHarness();
  const socket = h.connect();
  h.position(socket);
  // 2.4s of silence: just under the 2.5s recycle budget.
  h.advance(2_400);
  h.adapter.ensure(h.env);
  assert.equal(h.created.length, 1);
  h.setDesired(['great-lakes']);
  assert.equal(h.adapter.resubscribe().sent, true);
  // Another 2.4s: without the reset the socket would now be 4.8s silent and recycled.
  h.advance(2_400);
  h.adapter.ensure(h.env);
  assert.equal(socket.terminated, false, 'baseline was reset by the resubscribe');
  assert.equal(h.created.length, 1);
  // ...but genuine silence still recycles on the normal budget.
  h.advance(2_600);
  h.adapter.ensure(h.env);
  assert.equal(socket.terminated, true);
});

test('with no socket, or one that is not open, nothing is sent and nothing is opened', () => {
  const h = makeHarness();
  assert.deepEqual(h.adapter.resubscribe(), { sent: false, reason: 'no-socket' });
  h.adapter.ensure(h.env); // commissions socket 1, still CONNECTING
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.adapter.resubscribe(), { sent: false, reason: 'not-open' });
  assert.equal(h.created[0].sent.length, 0);
  assert.equal(h.created.length, 1, 'still just the one socket');
});

test('a send failure goes through the normal watchdog and the key never leaks', () => {
  const h = makeHarness();
  const socket = h.connect();
  h.position(socket);
  h.setDesired(['east-coast']);
  h.setSendThrows(true);
  const result = h.adapter.resubscribe();
  assert.deepEqual(result, { sent: false, reason: 'send-failed' });
  assert.equal(socket.terminated, true, 'terminated before any reconnect');
  assert.equal(h.snapshot().reconnectAttempt, 1, 'a genuine failure costs a ladder step');
  assert.equal(h.snapshot().status, 'reconnecting');
  assert.equal(JSON.stringify(h.snapshot()).includes(KEY), false, 'status carries no key');
  assert.equal(h.warnings.join('\n').includes(KEY), false);
});

test('after a failed update the NEXT socket opens with the CURRENT desired boxes, one socket at a time', () => {
  const h = makeHarness();
  const first = h.connect();
  h.position(first);
  h.setDesired(['east-coast']);
  h.setSendThrows(true);
  h.adapter.resubscribe();
  h.setSendThrows(false);
  assert.equal(first.terminated, true);
  assert.equal(h.adapter.debug().liveSockets, 0, 'the old socket is gone BEFORE the new one exists');
  assert.equal(h.created.length, 1);

  h.advance(5_000); // first rung of the backoff ladder
  h.adapter.ensure(h.env);
  assert.equal(h.created.length, 2);
  const second = h.created.at(-1);
  second.readyState = OPEN;
  second.emit('open');
  assert.deepEqual(second.sent[0].BoundingBoxes, boxesForRegions(['east-coast']));
  assert.equal(h.adapter.debug().liveSockets, 1, 'exactly one live socket');
  assert.notEqual(first.handlers, second.handlers);
});

test('a socket that closes on its own is replaced through the ladder with the current boxes', () => {
  const h = makeHarness();
  const first = h.connect();
  h.setDesired(['great-lakes']);
  // Not open at the moment of the update (e.g. mid-reconnect): nothing is sent.
  first.readyState = 2;
  assert.equal(h.adapter.resubscribe().sent, false);
  first.emit('close');
  h.advance(5_000);
  h.adapter.ensure(h.env);
  const second = h.created.at(-1);
  second.readyState = OPEN;
  second.emit('open');
  assert.deepEqual(second.sent[0].BoundingBoxes, boxesForRegions(['great-lakes']));
});

test('a throwing subscription observer cannot break the socket', () => {
  const warnings = [];
  const created = [];
  const adapter = createAisStreamAdapter({
    createSocket: () => {
      const socket = {
        readyState: OPEN, handlers: {}, on(e, fn) { this.handlers[e] = fn; }, send() {}, terminate() {},
      };
      created.push(socket);
      return socket;
    },
    resolveUrl: () => 'ws://mock.invalid',
    buildSubscription: () => ({ APIKey: KEY, BoundingBoxes: [] }),
    ingestEnvelope: () => true,
    onSubscriptionSent: () => { throw new Error(`observer boom ${KEY}`); },
    warn: (m) => warnings.push(m),
    redact: (t) => t.split(KEY).join('[redacted]'),
  });
  adapter.ensure({ hasKey: true, hasTransport: true, keyFingerprint: 'k' });
  created[0].handlers.open();
  assert.equal(adapter.debug().liveSockets, 1);
  assert.equal(warnings.some((w) => w.includes('observer failed')), true);
  assert.equal(warnings.join('\n').includes(KEY), false);
});
