/**
 * @module adsbLolTrace
 * @description Slim, bounded flight HISTORY built from the adsb.lol readsb full
 * trace the app already proxies (`/api/adsblol/trace`, used by the military
 * layer). Pure logic plus a small service (validation, timeout, size cap,
 * bounded cache, in-flight coalescing) that the `/api/adsblol/history` route
 * wraps. It never enables or falls back to OpenSky and never talks to AIS.
 *
 * A raw full-day trace is ~875 KB and holds every leg the aircraft flew. The
 * browser only needs the CURRENT leg, so this module:
 *  1. parses the readsb points (verified shape:
 *     `[secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, gs_kt, track,
 *       flags, baro_rate, extra, type, alt_geom, geom_rate, ias, roll]`),
 *  2. keeps the most recent leg (last departure from the ground onward),
 *  3. downsamples it to a bounded point count that keeps the first point, the
 *     last point and the shape of the route,
 *  4. calculates distance and elapsed time from the trace itself.
 * Nothing here is a schedule: times are the first/last trace timestamps, and
 * no departure, arrival or flight-time value is ever produced.
 */
import { greatCircleKm } from './routePlausible.js';

/** Points kept for the map polyline (one Cesium entity, so this is cheap). */
export const TRACE_MAX_POINTS = 300;
export const TRACE_HISTORY_CACHE_MS = 10 * 60 * 1000;
/** No trace for this aircraft: remember briefly so a re-open does not re-download. */
export const TRACE_NEGATIVE_CACHE_MS = 2 * 60 * 1000;
/** Upstream trouble: remember very briefly so nothing loops on a failing source. */
export const TRACE_FAILURE_CACHE_MS = 30 * 1000;
export const TRACE_CACHE_MAX = 60;
export const TRACE_RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
export const TRACE_TIMEOUT_MS = 12_000;

/** ICAO24 only: exactly six hex characters, lower-case. */
export function isValidTraceHex(hex) {
  return typeof hex === 'string' && /^[0-9a-f]{6}$/.test(hex);
}

/** The one fixed upstream shape; only a validated ICAO24 is ever interpolated. */
export function traceUpstreamUrl(hex) {
  return `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, digits) => (v === null ? null : Number(v.toFixed(digits)));
const text = (v) => { const t = typeof v === 'string' ? v.trim() : ''; return t || null; };

/**
 * Parse a raw readsb trace into chronological points
 * `[epochSec, lat, lon, altFt|'ground'|null, gsKt|null, track|null, vertRateFpm|null]`.
 * Points without a usable position/time are dropped.
 * @returns {{points: Array[], meta: object}|null} null when the body is not a trace.
 */
export function parseTrace(raw) {
  const base = finite(raw?.timestamp);
  if (base === null || !Array.isArray(raw?.trace)) return null;
  const points = [];
  let lastT = -Infinity;
  for (const p of raw.trace) {
    if (!Array.isArray(p)) continue;
    // Real JSON numbers only: Number(null) is 0 and would fabricate a position at (0, 0).
    const dt = finite(p[0]);
    const lat = finite(p[1]);
    const lon = finite(p[2]);
    if (dt === null || lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const t = Math.round(base + dt);
    if (t < lastT) continue; // a trace is chronological; a backwards step is corrupt
    lastT = t;
    const rawAlt = p[3];
    const alt = rawAlt === 'ground' ? 'ground' : finite(typeof rawAlt === 'number' ? rawAlt : NaN);
    const vertical = finite(typeof p[7] === 'number' ? p[7] : (typeof p[11] === 'number' ? p[11] : NaN));
    points.push([
      t,
      round(lat, 5),
      round(lon, 5),
      alt,
      round(finite(typeof p[4] === 'number' ? p[4] : NaN), 1),
      round(finite(typeof p[5] === 'number' ? p[5] : NaN), 0),
      vertical,
    ]);
  }
  // Static facts the file happens to carry; kept for a later metadata phase, unused by the history UI.
  const meta = {};
  for (const [key, value] of [['registration', raw.r], ['description', raw.desc], ['owner', raw.ownOp], ['year', raw.year]]) {
    const cleaned = text(typeof value === 'number' ? String(value) : value);
    if (cleaned) meta[key] = cleaned;
  }
  return { points, meta };
}

const isGround = (p) => p[3] === 'ground';

const PARKED_GAP_SEC = 10 * 60;

/** A leg's start is its last ground point, unless the receiver heard nothing for a long while after it (parked, silent): then it is the first point heard airborne. */
function legStart(points, ground) {
  const next = points[ground + 1];
  return next && next[0] - points[ground][0] > PARKED_GAP_SEC ? ground + 1 : ground;
}

/**
 * The most recent leg: from the last time the aircraft was on the ground before
 * its current airborne stretch (or, when it is on the ground now, the leg it
 * just finished, ending at touchdown so parked time is not counted).
 * @param {Array[]} points chronological
 * @returns {{start: number, end: number, atTraceStart: boolean, onGroundNow: boolean}}
 */
export function extractCurrentLeg(points) {
  const n = points.length;
  if (n === 0) return { start: 0, end: -1, atTraceStart: true, onGroundNow: false };
  if (!isGround(points[n - 1])) {
    for (let i = n - 2; i >= 0; i -= 1) {
      if (isGround(points[i])) return { start: legStart(points, i), end: n - 1, atTraceStart: false, onGroundNow: false };
    }
    return { start: 0, end: n - 1, atTraceStart: true, onGroundNow: false };
  }
  let lastAirborne = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!isGround(points[i])) { lastAirborne = i; break; }
  }
  if (lastAirborne < 0) return { start: 0, end: n - 1, atTraceStart: true, onGroundNow: true };
  const touchdown = lastAirborne + 1; // the first ground point after the last airborne one
  for (let i = lastAirborne - 1; i >= 0; i -= 1) {
    if (isGround(points[i])) return { start: legStart(points, i), end: touchdown, atTraceStart: false, onGroundNow: true };
  }
  return { start: 0, end: touchdown, atTraceStart: true, onGroundNow: true };
}

/** Sum of great-circle segment lengths (km) along the points. */
export function traceDistanceKm(points) {
  let km = 0;
  for (let i = 1; i < points.length; i += 1) {
    km += greatCircleKm(points[i - 1][1], points[i - 1][2], points[i][1], points[i][2]);
  }
  return km;
}

/**
 * Reduce a path to at most `maxPoints` while keeping its shape: repeatedly keep
 * the point that deviates most from the current simplification
 * (Douglas-Peucker, ranked). The first and last points are always kept, and the
 * result stays in chronological order.
 * @param {Array[]} points
 * @param {number} [maxPoints]
 * @returns {Array[]}
 */
export function downsampleTrace(points, maxPoints = TRACE_MAX_POINTS) {
  const n = points.length;
  if (n <= maxPoints) return points.slice();
  if (maxPoints < 2) return [points[0], points[n - 1]];
  let latSum = 0;
  for (const p of points) latSum += p[1];
  const scale = Math.max(0.05, Math.cos(((latSum / n) * Math.PI) / 180));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = points[i][2] * scale * 111_320;
    ys[i] = points[i][1] * 111_320;
  }
  const deviation = (i, a, b) => {
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(xs[i] - xs[a], ys[i] - ys[a]);
    const t = Math.max(0, Math.min(1, ((xs[i] - xs[a]) * dx + (ys[i] - ys[a]) * dy) / len2));
    return Math.hypot(xs[i] - (xs[a] + t * dx), ys[i] - (ys[a] + t * dy));
  };
  const farthest = (a, b) => {
    let best = -1;
    let bestDistance = -1;
    for (let i = a + 1; i < b; i += 1) {
      const d = deviation(i, a, b);
      if (d > bestDistance) { bestDistance = d; best = i; }
    }
    return { a, b, index: best, distance: bestDistance };
  };
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let count = 2;
  const segments = [];
  if (n > 2) segments.push(farthest(0, n - 1));
  while (count < maxPoints && segments.length) {
    let pick = 0;
    for (let s = 1; s < segments.length; s += 1) if (segments[s].distance > segments[pick].distance) pick = s;
    const [segment] = segments.splice(pick, 1);
    if (segment.index < 0 || segment.distance <= 0) break;
    keep[segment.index] = 1;
    count += 1;
    if (segment.index - segment.a > 1) segments.push(farthest(segment.a, segment.index));
    if (segment.b - segment.index > 1) segments.push(farthest(segment.index, segment.b));
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Raw readsb trace -> the slim history payload (or null when there is no usable
 * leg of at least two points).
 * @returns {{points: Array[], stats: object, meta: object}|null}
 */
export function slimAdsbLolTrace(raw, { maxPoints = TRACE_MAX_POINTS } = {}) {
  const parsed = parseTrace(raw);
  if (!parsed || parsed.points.length < 2) return null;
  const leg = extractCurrentLeg(parsed.points);
  const legPoints = parsed.points.slice(leg.start, leg.end + 1);
  if (legPoints.length < 2) return null;
  const kept = downsampleTrace(legPoints, maxPoints);
  const startEpoch = legPoints[0][0];
  const endEpoch = legPoints[legPoints.length - 1][0];
  return {
    points: kept,
    stats: {
      rawPoints: parsed.points.length,
      legPoints: legPoints.length,
      keptPoints: kept.length,
      // First and last trace timestamps of the leg. NOT a departure or arrival time.
      startEpoch,
      endEpoch,
      durationSec: endEpoch - startEpoch,
      distanceKm: Number(traceDistanceKm(legPoints).toFixed(1)),
      startsAtTraceBeginning: leg.atTraceStart,
      onGroundNow: leg.onGroundNow,
    },
    meta: parsed.meta,
  };
}

/**
 * Server-side history service: validate, fetch (fixed URL, timeout, size cap),
 * slim, and remember the SMALL result - never the raw upstream body.
 *
 * @param {object} options
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} options.readCapped
 * @param {() => number} [options.now]
 * @returns {{load: (hex: string) => Promise<{status: number, body: object, cache: string}>, size: () => number}}
 */
export function createAdsbLolHistoryService({ fetchImpl = (...args) => globalThis.fetch(...args), readCapped, now = () => Date.now() } = {}) {
  /** @type {Map<string, {at: number, ttl: number, status: number, body: object}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<{status: number, body: object}>>} */
  const inFlight = new Map();

  function remember(hex, status, body, ttl) {
    cache.delete(hex); // re-insert at the fresh end: eviction is oldest-first
    cache.set(hex, { at: now(), ttl, status, body });
    while (cache.size > TRACE_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function fetchAndSlim(hex) {
    try {
      const upstream = await fetchImpl(traceUpstreamUrl(hex), {
        headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-adsblol-history/1.0' },
        signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
      });
      if (upstream.status === 404) {
        remember(hex, 404, { error: 'No trace available for this aircraft.' }, TRACE_NEGATIVE_CACHE_MS);
        return { status: 404, body: { error: 'No trace available for this aircraft.' } };
      }
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const { tooLarge, text: bodyText } = await readCapped(upstream, TRACE_RESPONSE_CAP_BYTES);
      if (tooLarge) throw new Error('upstream trace too large');
      const slim = slimAdsbLolTrace(JSON.parse(bodyText));
      if (!slim) {
        remember(hex, 404, { error: 'No usable trace for this aircraft.' }, TRACE_NEGATIVE_CACHE_MS);
        return { status: 404, body: { error: 'No usable trace for this aircraft.' } };
      }
      const body = { icao24: hex, ...slim };
      remember(hex, 200, body, TRACE_HISTORY_CACHE_MS);
      return { status: 200, body };
    } catch {
      // Sanitised: no upstream detail leaks, and the failure is remembered briefly.
      const body = { error: 'Flight history is temporarily unavailable.' };
      remember(hex, 502, body, TRACE_FAILURE_CACHE_MS);
      return { status: 502, body };
    }
  }

  return {
    async load(hex) {
      if (!isValidTraceHex(hex)) return { status: 400, body: { error: 'hex must be a 6-character ICAO24.' }, cache: 'NONE' };
      const cached = cache.get(hex);
      if (cached && now() - cached.at < cached.ttl) return { status: cached.status, body: cached.body, cache: 'HIT' };
      const pending = inFlight.get(hex);
      if (pending) return { ...(await pending), cache: 'INFLIGHT' };
      const promise = fetchAndSlim(hex).finally(() => { if (inFlight.get(hex) === promise) inFlight.delete(hex); });
      inFlight.set(hex, promise);
      return { ...(await promise), cache: 'MISS' };
    },
    size: () => cache.size,
  };
}
