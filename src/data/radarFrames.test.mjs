// Radar frame metadata: latest-frame selection, tile URL construction,
// malformed/empty handling, and staleness. Pure — no network, no Cesium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RADAR_PROVIDERS,
  RADAR_STALE_MS,
  RadarFrameError,
  buildRadarTileTemplate,
  fetchLatestRadarFrame,
  formatRadarStatus,
  isRadarFrameStale,
  parseRainViewerIndex,
  radarFrameAgeMs,
  radarFrameClock,
} from './radarFrames.js';

const T0 = Date.UTC(2026, 8, 19, 14, 20, 0) / 1000;

const index = (past, overrides = {}) => ({
  version: '2.0',
  generated: T0 + 30,
  host: 'https://tilecache.rainviewer.com',
  radar: { past, nowcast: [] },
  ...overrides,
});

test('selects the latest past frame (by time, not array position)', () => {
  const frame = parseRainViewerIndex(index([
    { time: T0, path: '/v2/radar/newest' },
    { time: T0 - 600, path: '/v2/radar/older' },
    { time: T0 - 1200, path: '/v2/radar/oldest' },
  ]));
  assert.equal(frame.path, '/v2/radar/newest');
  assert.equal(frame.time, T0);
  assert.equal(frame.timeMs, T0 * 1000);
  assert.equal(frame.provider, 'rainviewer');
  assert.equal(frame.tileSize, 256);
  assert.equal(frame.maximumLevel, 7);
});

test('builds the XYZ template from the API host and path — nothing hard-coded', () => {
  const frame = parseRainViewerIndex(index([{ time: T0, path: '/v2/radar/abc123def' }], {
    host: 'https://tilecache.rainviewer.com/',
  }));
  assert.equal(
    frame.urlTemplate,
    'https://tilecache.rainviewer.com/v2/radar/abc123def/256/{z}/{x}/{y}/2/1_1.png',
  );
  assert.equal(
    buildRadarTileTemplate(RADAR_PROVIDERS.rainviewer, 'https://tilecache.rainviewer.com', '/v2/radar/x'),
    'https://tilecache.rainviewer.com/v2/radar/x/256/{z}/{x}/{y}/2/1_1.png',
  );
  // A different host/path from the API flows straight through.
  const other = parseRainViewerIndex(index([{ time: T0, path: '/v3/radar/zzz' }], {
    host: 'https://cdn.rainviewer.com',
  }));
  assert.equal(other.urlTemplate, 'https://cdn.rainviewer.com/v3/radar/zzz/256/{z}/{x}/{y}/2/1_1.png');
});

test('empty and malformed indexes yield no frame', () => {
  assert.equal(parseRainViewerIndex(null), null);
  assert.equal(parseRainViewerIndex('nope'), null);
  assert.equal(parseRainViewerIndex({}), null);
  assert.equal(parseRainViewerIndex(index([])), null, 'empty radar.past');
  assert.equal(parseRainViewerIndex(index(null)), null);
  assert.equal(parseRainViewerIndex(index([{ time: 'x', path: '/v2/radar/a' }])), null, 'bad time');
  assert.equal(parseRainViewerIndex(index([{ time: T0 }])), null, 'no path');
  assert.equal(parseRainViewerIndex({ radar: { past: [{ time: T0, path: '/v2/radar/a' }] } }), null, 'no host');
});

test('untrusted host or path shapes are rejected instead of used to build a URL', () => {
  const past = [{ time: T0, path: '/v2/radar/a' }];
  assert.equal(parseRainViewerIndex(index(past, { host: 'http://tilecache.rainviewer.com' })), null, 'http');
  assert.equal(parseRainViewerIndex(index(past, { host: 'https://evil.example.com' })), null, 'foreign host');
  assert.equal(parseRainViewerIndex(index(past, { host: 'https://rainviewer.com.evil.example' })), null, 'suffix trick');
  assert.equal(parseRainViewerIndex(index(past, { host: 'https://user:pw@tilecache.rainviewer.com' })), null, 'userinfo');
  for (const path of ['/v2/radar/a?x=1', '/v2/../radar', 'v2/radar/a', '/v2/radar/{z}', '/v2/radar/a b', '//evil.com/a']) {
    assert.equal(parseRainViewerIndex(index([{ time: T0, path }])), null, path);
  }
  // A bad entry is skipped, a good one still wins.
  const frame = parseRainViewerIndex(index([
    { time: T0 + 60, path: '/v2/radar/a?x=1' },
    { time: T0, path: '/v2/radar/good' },
  ]));
  assert.equal(frame.path, '/v2/radar/good');
});

test('stale detection at the 30 minute boundary', () => {
  const frame = parseRainViewerIndex(index([{ time: T0, path: '/v2/radar/a' }]));
  const at = (deltaMs) => frame.timeMs + deltaMs;
  assert.equal(radarFrameAgeMs(frame, at(8 * 60_000)), 8 * 60_000);
  assert.equal(isRadarFrameStale(frame, at(RADAR_STALE_MS)), false, 'exactly 30 min is not stale');
  assert.equal(isRadarFrameStale(frame, at(RADAR_STALE_MS + 1)), true);
  assert.equal(isRadarFrameStale(null), true, 'unknown frame counts as stale');
  assert.equal(radarFrameAgeMs(frame, frame.timeMs - 5_000), 0, 'clock skew never goes negative');
});

test('status text covers every state', () => {
  const frame = parseRainViewerIndex(index([{ time: T0, path: '/v2/radar/a' }]));
  assert.equal(radarFrameClock(frame), '14:20Z');
  assert.equal(
    formatRadarStatus({ state: 'ready', frame, nowMs: frame.timeMs + 8 * 60_000 + 5_000 }),
    'RADAR · 14:20Z · 8 min ago',
  );
  assert.equal(formatRadarStatus({ state: 'ready', frame, nowMs: frame.timeMs + 20_000 }), 'RADAR · 14:20Z · just now');
  assert.equal(
    formatRadarStatus({ state: 'ready', frame, nowMs: frame.timeMs + 31 * 60_000 }),
    'RADAR · STALE · 14:20Z',
  );
  assert.equal(formatRadarStatus({ state: 'loading' }), 'RADAR · LOADING');
  assert.equal(formatRadarStatus({ state: 'ready', frame: null }), 'RADAR · LOADING');
  assert.equal(formatRadarStatus({ state: 'unavailable' }), 'RADAR · UNAVAILABLE');
  assert.equal(formatRadarStatus({ state: 'globe-required' }), 'RADAR · GLOBE MODE REQUIRED');
  assert.equal(formatRadarStatus({ state: 'globe-fallback' }), 'RADAR · GLOBE FALLBACK');
});

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('fetchLatestRadarFrame returns the parsed frame from the provider index URL', async () => {
  const calls = [];
  const frame = await fetchLatestRadarFrame({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse(index([{ time: T0, path: '/v2/radar/a' }]));
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.rainviewer.com/public/weather-maps.json');
  assert.ok(calls[0].init.signal, 'every index request is time-boxed');
  assert.equal(frame.path, '/v2/radar/a');
});

test('fetchLatestRadarFrame classifies failures with stable codes', async () => {
  const code = async (fetchImpl) => {
    try {
      await fetchLatestRadarFrame({ fetchImpl });
    } catch (error) {
      assert.ok(error instanceof RadarFrameError, String(error));
      return error.code;
    }
    return null;
  };
  assert.equal(await code(async () => { throw new TypeError('fetch failed'); }), 'network');
  assert.equal(await code(async () => ({ ok: false, status: 503, json: async () => ({}) })), 'http');
  assert.equal(await code(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })), 'malformed');
  assert.equal(await code(async () => okResponse({ host: 'https://tilecache.rainviewer.com' })), 'malformed');
  assert.equal(await code(async () => okResponse(index([]))), 'empty');
});

test('a caller abort is surfaced as an abort, not disguised as a network failure', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchLatestRadarFrame({
      signal: controller.signal,
      fetchImpl: async (_url, { signal }) => {
        signal.throwIfAborted();
        return okResponse({});
      },
    }),
    (error) => error.name === 'AbortError',
  );
});
