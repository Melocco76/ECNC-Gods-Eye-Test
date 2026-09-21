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
 */

export const HISTORY_URL = '/api/adsblol/history';
export const HISTORY_TTL_MS = 10 * 60 * 1000;
export const HISTORY_FAILURE_TTL_MS = 30 * 1000;
export const HISTORY_CACHE_MAX = 20;
export const HISTORY_TIMEOUT_MS = 10_000;

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
