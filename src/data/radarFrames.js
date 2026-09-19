// src/data/radarFrames.js — weather-radar frame metadata (provider-agnostic shape).
//
// Pure helpers only: no Cesium, no DOM, no timers. The overlay module owns
// lifecycle; this file owns "what is the latest radar frame, what is its tile
// URL, and how old is it". Provider details live in RADAR_PROVIDERS so a second
// tile provider (e.g. IEM NEXRAD) can be added later as another entry without
// touching the overlay.
//
// RainViewer (https://www.rainviewer.com/api.html): a keyless, CORS-open index
// at weather-maps.json lists past radar frames; each frame is a content-hashed
// `path`, and tiles are `${host}${path}/{size}/{z}/{x}/{y}/{color}/{options}.png`
// in WebMercator XYZ. Frames are ~10 minutes apart; free-tier tiles stop at z7.

/** A frame older than this reads STALE (RainViewer refreshes about every 10 min). */
export const RADAR_STALE_MS = 30 * 60_000;

/** Index fetch budget; the overlay layers its own backoff on top. */
export const RADAR_INDEX_TIMEOUT_MS = 8_000;

/**
 * Structured provider metadata.
 * @typedef {object} RadarProvider
 * @property {string} id Stable provider id.
 * @property {string} name Display name (attribution/status).
 * @property {string} homepage Attribution link target.
 * @property {string} indexUrl Frame-index endpoint.
 * @property {string} hostSuffix Tile hosts must be https on this domain.
 * @property {number} tileSize Tile edge in pixels.
 * @property {number} maximumLevel Highest native zoom level.
 * @property {string} colorScheme Provider color-scheme id in the tile path.
 * @property {string} options Provider render options segment (smooth_snow).
 */

/** @type {Readonly<Record<string, RadarProvider>>} */
export const RADAR_PROVIDERS = Object.freeze({
  rainviewer: Object.freeze({
    id: 'rainviewer',
    name: 'RainViewer',
    homepage: 'https://www.rainviewer.com/',
    indexUrl: 'https://api.rainviewer.com/public/weather-maps.json',
    hostSuffix: 'rainviewer.com',
    tileSize: 256,
    maximumLevel: 7,
    colorScheme: '2',
    options: '1_1',
  }),
});

export const DEFAULT_RADAR_PROVIDER_ID = 'rainviewer';

/** Error carrying a stable `code` so the overlay can classify failures. */
export class RadarFrameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RadarFrameError';
    this.code = code;
  }
}

/**
 * Build the XYZ tile URL template for one frame from the host and path the
 * API returned. Never hard-codes a frame path.
 * @param {RadarProvider} provider
 * @param {string} host e.g. "https://tilecache.rainviewer.com"
 * @param {string} path e.g. "/v2/radar/abc123"
 * @returns {string} Template with {z}/{x}/{y} placeholders.
 */
export function buildRadarTileTemplate(provider, host, path) {
  const base = String(host).replace(/\/+$/, '');
  return `${base}${path}/${provider.tileSize}/{z}/{x}/{y}/${provider.colorScheme}/${provider.options}.png`;
}

function validHost(provider, host) {
  if (typeof host !== 'string') return false;
  let url;
  try { url = new URL(host); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password || url.port || url.search || url.hash) return false;
  const name = url.hostname.toLowerCase();
  return name === provider.hostSuffix || name.endsWith(`.${provider.hostSuffix}`);
}

// A frame path is a short slash-separated token path. Anything else (query
// strings, dots, braces, traversal) means the provider changed shape — fail
// visibly rather than build a URL from unexpected input.
const FRAME_PATH_PATTERN = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,4}$/;

/**
 * Parse a RainViewer weather-maps.json payload into the latest past frame.
 * @param {unknown} payload Parsed JSON.
 * @param {RadarProvider} [provider]
 * @returns {{provider: string, host: string, path: string, time: number,
 *   timeMs: number, urlTemplate: string, tileSize: number, maximumLevel: number,
 *   generated: number|null}|null} Null when the payload has no usable frame.
 */
export function parseRainViewerIndex(payload, provider = RADAR_PROVIDERS.rainviewer) {
  if (!payload || typeof payload !== 'object') return null;
  const host = payload.host;
  if (!validHost(provider, host)) return null;
  const past = payload.radar?.past;
  if (!Array.isArray(past) || past.length === 0) return null;

  let latest = null;
  for (const entry of past) {
    const time = Number(entry?.time);
    const path = entry?.path;
    if (!Number.isFinite(time) || time <= 0) continue;
    if (typeof path !== 'string' || !FRAME_PATH_PATTERN.test(path)) continue;
    if (!latest || time > latest.time) latest = { time, path };
  }
  if (!latest) return null;

  const generated = Number(payload.generated);
  return {
    provider: provider.id,
    host: host.replace(/\/+$/, ''),
    path: latest.path,
    time: latest.time,
    timeMs: latest.time * 1000,
    urlTemplate: buildRadarTileTemplate(provider, host, latest.path),
    tileSize: provider.tileSize,
    maximumLevel: provider.maximumLevel,
    generated: Number.isFinite(generated) ? generated : null,
  };
}

/**
 * Fetch and parse the latest radar frame.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {RadarProvider} [options.provider]
 * @returns {Promise<ReturnType<typeof parseRainViewerIndex> & object>}
 * @throws {RadarFrameError} code: 'network' | 'http' | 'malformed' | 'empty'
 */
export async function fetchLatestRadarFrame({
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
  provider = RADAR_PROVIDERS.rainviewer,
} = {}) {
  const timeout = AbortSignal.timeout(RADAR_INDEX_TIMEOUT_MS);
  const composed = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : (signal || timeout);
  let response;
  try {
    response = await fetchImpl(provider.indexUrl, {
      signal: composed,
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RadarFrameError('network', `${provider.name} index unreachable`);
  }
  if (!response?.ok) {
    throw new RadarFrameError('http', `${provider.name} index HTTP ${response?.status ?? '?'}`);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new RadarFrameError('malformed', `${provider.name} index is not JSON`);
  }
  const frame = parseRainViewerIndex(json, provider);
  if (!frame) {
    const hasPast = Array.isArray(json?.radar?.past);
    throw new RadarFrameError(
      hasPast && json.radar.past.length === 0 ? 'empty' : 'malformed',
      `${provider.name} index has no usable radar frame`,
    );
  }
  return frame;
}

/** Milliseconds since the frame's observation time. */
export function radarFrameAgeMs(frame, nowMs = Date.now()) {
  if (!frame || !Number.isFinite(frame.timeMs)) return Infinity;
  return Math.max(0, nowMs - frame.timeMs);
}

/** True when the frame is older than the stale threshold (or unknown). */
export function isRadarFrameStale(frame, nowMs = Date.now(), staleMs = RADAR_STALE_MS) {
  return radarFrameAgeMs(frame, nowMs) > staleMs;
}

/** "14:20Z" from a frame. */
export function radarFrameClock(frame) {
  if (!frame || !Number.isFinite(frame.timeMs)) return '—';
  return `${new Date(frame.timeMs).toISOString().slice(11, 16)}Z`;
}

function ageLabel(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

/**
 * User-facing status line.
 * @param {{state: 'loading'|'ready'|'unavailable'|'globe-required'|'globe-fallback',
 *   frame?: object|null, nowMs?: number}} input
 * @returns {string}
 */
export function formatRadarStatus({ state, frame = null, nowMs = Date.now() }) {
  if (state === 'globe-required') return 'RADAR · GLOBE MODE REQUIRED';
  // The automatic switch already succeeded and radar is showing — nothing for the user to do.
  if (state === 'globe-fallback') return 'RADAR · GLOBE FALLBACK';
  if (state === 'unavailable') return 'RADAR · UNAVAILABLE';
  if (state === 'loading' || !frame) return 'RADAR · LOADING';
  if (isRadarFrameStale(frame, nowMs)) return `RADAR · STALE · ${radarFrameClock(frame)}`;
  return `RADAR · ${radarFrameClock(frame)} · ${ageLabel(radarFrameAgeMs(frame, nowMs))}`;
}
