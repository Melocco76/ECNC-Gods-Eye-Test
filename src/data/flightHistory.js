/**
 * @module flightHistory
 * @description Client side of the selected-aircraft HISTORY (Flight Intelligence
 * Phase E). One deliberate request per selected aircraft, never one per visible
 * aircraft and never on the map poll:
 *
 *  - `request(icao24)` is only called from the Flight details flow;
 *  - at most one request is active: switching or deselecting aborts it;
 *  - a finished answer is remembered (bounded, 10 minutes) so re-selecting the
 *    same aircraft does not download it again;
 *  - a failure is remembered for 30 s, so a failing source is never retried in a loop;
 *  - an answer can only ever be attached to the aircraft that asked for it.
 *
 * It only talks to the app's own `/api/adsblol/history` route. There is no
 * OpenSky fallback: if the history is unavailable the layer simply has none.
 * The pure terrain-sampling helper used when the path is painted also lives here.
 */

export const HISTORY_URL = '/api/adsblol/history';
export const HISTORY_TTL_MS = 10 * 60 * 1000;
export const HISTORY_FAILURE_TTL_MS = 30 * 1000;
export const HISTORY_CACHE_MAX = 20;
export const HISTORY_TIMEOUT_MS = 10_000;

/**
 * Upper bound on the points sent to terrain-floor resolution when the violet
 * path is painted. The path itself keeps every point (up to 300); only the
 * ground-floor LOOKUP is sampled, because the terrain proxy takes 20-40 s and
 * can 502 on ~300-point requests. Unsampled points fall back to the plain
 * (unfloored) barometric height, the same as any cell that is not warm yet.
 */
export const HISTORY_TERRAIN_MAX = 60;
/** Low points (ground / null altitude / under this) are where a floor matters, so they are sampled first. */
const LOW_ALTITUDE_FT = 3000;

/**
 * Pick a small, bounded, representative subset of a history path for terrain
 * lookup: the first and last points, an even spread along the route (so its
 * shape is covered), and the low/ground points (thinned evenly), where the
 * floor actually changes the drawn height. Order follows the path.
 * @param {Array<Array>} points history rows `[t, lat, lon, altFt|'ground'|null, ...]`
 * @param {number} [max]
 * @returns {Array<{lat: number, lon: number}>} at most `max` positions
 */
export function sampleHistoryForTerrain(points, max = HISTORY_TERRAIN_MAX) {
  const n = Array.isArray(points) ? points.length : 0;
  if (n === 0 || max < 1) return [];
  const toPos = (i) => ({ lat: points[i][1], lon: points[i][2] });
  if (n <= max) return points.map((_, i) => toPos(i));
  const picked = new Set([0, n - 1]);
  const evenly = (indices, count) => {
    if (count <= 0 || indices.length === 0) return;
    const step = indices.length / count;
    for (let k = 0; k < count && picked.size < max; k += 1) picked.add(indices[Math.min(indices.length - 1, Math.floor(k * step))]);
  };
  const low = [];
  for (let i = 1; i < n - 1; i += 1) {
    const alt = points[i][3];
    if (alt === 'ground' || alt == null || (typeof alt === 'number' && alt < LOW_ALTITUDE_FT)) low.push(i);
  }
  evenly(low, Math.min(low.length, Math.floor(max / 3)));
  const all = [];
  for (let i = 1; i < n - 1; i += 1) all.push(i);
  evenly(all, max - picked.size);
  return [...picked].sort((a, b) => a - b).slice(0, max).map(toPos);
}

const validHex = (hex) => typeof hex === 'string' && /^[0-9a-f]{6}$/.test(hex);

/**
 * @param {object} [options]
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(icao24: string) => void} [options.onChange] Called when the history for `icao24` changed state.
 */
export function createFlightHistory({ fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), onChange = () => {} } = {}) {
  /** @type {Map<string, {at: number, status: 'ready'|'unavailable', data: object|null}>} */
  const cache = new Map();
  let current = null;
  let pending = null;
  let controller = null;
  let requests = 0;

  const notify = (hex) => { try { onChange(hex); } catch { /* a listener must never break the layer */ } };

  function fresh(hex) {
    const entry = cache.get(hex);
    if (!entry) return null;
    const ttl = entry.status === 'ready' ? HISTORY_TTL_MS : HISTORY_FAILURE_TTL_MS;
    return now() - entry.at < ttl ? entry : null;
  }

  function store(hex, status, data) {
    cache.delete(hex);
    cache.set(hex, { at: now(), status, data });
    while (cache.size > HISTORY_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function abortActive() {
    if (controller) controller.abort();
    controller = null;
    pending = null;
  }

  async function run(hex) {
    const mine = new AbortController();
    controller = mine;
    pending = hex;
    requests += 1;
    const timer = setTimeout(() => mine.abort(), HISTORY_TIMEOUT_MS);
    timer.unref?.();
    let status = 'unavailable';
    let data = null;
    try {
      const response = await fetchImpl(`${HISTORY_URL}?hex=${encodeURIComponent(hex)}`, { signal: mine.signal, cache: 'no-store' });
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body?.points) && body.points.length >= 2 && body.stats) {
          status = 'ready';
          data = body;
        }
      }
    } catch {
      /* unavailable */
    } finally {
      clearTimeout(timer);
    }
    // Superseded (switched away, deselected): drop the answer on the floor.
    if (controller !== mine) return;
    controller = null;
    pending = null;
    store(hex, status, data);
    if (current === hex) notify(hex);
  }

  return {
    /** Ask for the history of the SELECTED aircraft (idempotent while loading or cached). */
    request(hex) {
      if (!validHex(hex)) return;
      if (current !== hex) abortActive();
      current = hex;
      if (fresh(hex)) { notify(hex); return; }
      if (pending === hex) return; // coalesced onto the request already running
      abortActive();
      notify(hex); // 'loading'
      void run(hex);
    },
    /** The aircraft is no longer selected: stop any request and forget which one was current. */
    select(hex) {
      if (hex === current) return;
      abortActive();
      current = validHex(hex) ? hex : null;
    },
    clear() {
      abortActive();
      current = null;
    },
    /** State for one aircraft. Never returns another aircraft's data. */
    view(hex) {
      if (!validHex(hex)) return { status: 'idle' };
      const entry = fresh(hex);
      if (entry) return entry.status === 'ready' ? { status: 'ready', stats: entry.data.stats, meta: entry.data.meta || {}, points: entry.data.points } : { status: 'unavailable' };
      return pending === hex ? { status: 'loading' } : { status: 'idle' };
    },
    /** Test seams. */
    _requests: () => requests,
    _size: () => cache.size,
  };
}
