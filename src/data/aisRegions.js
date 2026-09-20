/**
 * @module aisRegions
 * @description Predefined maritime coverage regions for the AISStream
 * subscription, plus the pure logic that turns a chosen region set into one
 * combined subscription and coalesces rapid changes.
 *
 * Coverage is GLOBAL SERVER STATE (one AISStream socket per process), never
 * share-link or browser state. The browser can only name regions from the fixed
 * catalogue below; it can never supply coordinates.
 *
 * Boxes use AISStream's order: `[[lat, lon], [lat, lon]]`.
 */

/** First-rollout limits. */
export const AIS_REGION_LIMITS = Object.freeze({
  minRegions: 1,
  maxRegions: 2,
  /** Hard ceiling on boxes in one subscription (AISStream documents no limit). */
  maxBoxes: 12,
});

/** Regions enabled when nothing else has been chosen. */
export const AIS_DEFAULT_REGIONS = Object.freeze(['gulf']);

/** Trailing debounce before a coverage change is sent upstream. */
export const AIS_COVERAGE_DEBOUNCE_MS = 3_000;
/** Minimum spacing between actual subscription sends (AISStream allows 1/s). */
export const AIS_COVERAGE_MIN_SEND_INTERVAL_MS = 5_000;

const freezeBox = (box) => Object.freeze([Object.freeze([...box[0]]), Object.freeze([...box[1]])]);

/**
 * The immutable region catalogue, in canonical order. Every normalised region
 * set is emitted in this order so equality is a plain array comparison.
 */
export const AIS_REGION_CATALOGUE = Object.freeze([
  Object.freeze({
    id: 'gulf',
    label: 'Gulf of Mexico',
    boxes: Object.freeze([
      [[24.5, -98.0], [30.9, -90.0]],
      [[24.0, -90.0], [30.9, -81.5]],
    ].map(freezeBox)),
  }),
  Object.freeze({
    id: 'east-coast',
    label: 'U.S. East Coast',
    boxes: Object.freeze([
      [[24.3, -82.0], [31.0, -79.0]],
      [[31.0, -81.5], [40.2, -72.0]],
      [[40.2, -74.5], [45.0, -66.0]],
    ].map(freezeBox)),
  }),
  Object.freeze({
    id: 'west-coast',
    label: 'U.S. West Coast',
    boxes: Object.freeze([
      [[32.3, -122.0], [34.8, -117.0]],
      [[34.8, -125.0], [38.6, -121.0]],
      [[38.6, -126.0], [49.0, -122.0]],
    ].map(freezeBox)),
  }),
  Object.freeze({
    id: 'great-lakes',
    label: 'Great Lakes',
    boxes: Object.freeze([
      [[46.3, -92.3], [49.1, -84.3]],
      [[41.5, -88.2], [46.6, -79.6]],
      [[41.3, -83.6], [44.3, -75.8]],
    ].map(freezeBox)),
  }),
]);

const REGION_BY_ID = new Map(AIS_REGION_CATALOGUE.map((region) => [region.id, region]));
const CANONICAL_ORDER = new Map(AIS_REGION_CATALOGUE.map((region, index) => [region.id, index]));

/** True when `id` names a catalogue region. Never true for inherited keys. */
export function isKnownRegionId(id) {
  return typeof id === 'string' && REGION_BY_ID.has(id);
}

/**
 * Public, fixed catalogue metadata: id, label and box count only. The boxes
 * themselves are constants in this file, not something the API needs to echo.
 * @returns {{id: string, label: string, boxCount: number}[]}
 */
export function publicRegionCatalogue() {
  return AIS_REGION_CATALOGUE.map(({ id, label, boxes }) => ({ id, label, boxCount: boxes.length }));
}

/**
 * Validate and normalise a requested region set: array of catalogue IDs,
 * duplicates removed, canonical order, within the min/max limits.
 *
 * @param {unknown} input
 * @param {{minRegions?: number, maxRegions?: number}} [limits]
 * @returns {{ok: true, regions: string[]} | {ok: false, error: string}}
 */
export function normalizeRegionIds(input, limits = AIS_REGION_LIMITS) {
  if (!Array.isArray(input)) return { ok: false, error: 'regions must be an array of region IDs' };
  const seen = new Set();
  for (const id of input) {
    if (typeof id !== 'string') return { ok: false, error: 'region IDs must be strings' };
    if (!REGION_BY_ID.has(id)) return { ok: false, error: `unknown region: ${id.slice(0, 40)}` };
    seen.add(id);
  }
  const regions = [...seen].sort((a, b) => CANONICAL_ORDER.get(a) - CANONICAL_ORDER.get(b));
  if (regions.length < limits.minRegions) {
    return { ok: false, error: `at least ${limits.minRegions} region must be enabled` };
  }
  if (regions.length > limits.maxRegions) {
    return { ok: false, error: `at most ${limits.maxRegions} regions may be enabled` };
  }
  const boxCount = boxesForRegions(regions).length;
  if (boxCount > AIS_REGION_LIMITS.maxBoxes) {
    return { ok: false, error: `subscription would exceed ${AIS_REGION_LIMITS.maxBoxes} boxes` };
  }
  return { ok: true, regions };
}

/** True when two region lists hold the same IDs (both already normalised). */
export function sameRegionSet(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The combined subscription boxes for a region set, as fresh mutable arrays
 * (safe to serialise and hand to a socket). Unknown IDs contribute nothing.
 * @param {readonly string[]} ids
 * @returns {number[][][]}
 */
export function boxesForRegions(ids) {
  const boxes = [];
  for (const id of ids) {
    const region = REGION_BY_ID.get(id);
    if (!region) continue;
    for (const box of region.boxes) boxes.push([[...box[0]], [...box[1]]]);
  }
  return boxes;
}

/**
 * Build a point-in-coverage test for a region set. Boxes are normalised to
 * min/max so either corner order works. Returns null for an empty set.
 * @param {readonly string[]} ids
 * @returns {((lat: number, lon: number) => boolean)|null}
 */
export function createCoverageMatcher(ids) {
  const rects = boxesForRegions(ids).map(([a, b]) => ({
    south: Math.min(a[0], b[0]),
    north: Math.max(a[0], b[0]),
    west: Math.min(a[1], b[1]),
    east: Math.max(a[1], b[1]),
  }));
  if (!rects.length) return null;
  return (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    for (const r of rects) {
      if (lat >= r.south && lat <= r.north && lon >= r.west && lon <= r.east) return true;
    }
    return false;
  };
}

/** One-shot point-in-regions check (builds the matcher; prefer the matcher in loops). */
export function pointInRegions(ids, lat, lon) {
  const matcher = createCoverageMatcher(ids);
  return matcher ? matcher(lat, lon) : false;
}

/**
 * Parse a comma-separated default-region env value. Invalid input falls back to
 * the built-in default and reports why, so a typo cannot silently widen coverage.
 * @param {string|undefined} raw
 * @returns {{regions: string[], warning: string|null}}
 */
export function parseDefaultRegionsEnv(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) {
    return { regions: [...AIS_DEFAULT_REGIONS], warning: null };
  }
  const ids = String(raw).split(',').map((part) => part.trim()).filter(Boolean);
  const result = normalizeRegionIds(ids);
  if (result.ok) return { regions: result.regions, warning: null };
  return {
    regions: [...AIS_DEFAULT_REGIONS],
    warning: `Ignoring AISSTREAM_DEFAULT_REGIONS (${result.error}); using ${AIS_DEFAULT_REGIONS.join(',')}.`,
  };
}

/**
 * Desired-versus-subscribed coverage with coalesced application.
 *
 *  - `desired`    what the owner asked for (updated immediately).
 *  - `subscribed` what the upstream socket was last told (updated only when a
 *                 subscription was actually sent, on connect or on resubscribe).
 *
 * Changes are debounced (trailing) and spaced: the send happens at
 * `max(lastChange + debounce, lastSend + minInterval)`, always with the NEWEST
 * desired set, so a burst of clicks becomes one send. Setting the current
 * desired set again is a no-op, and flipping back to what is already subscribed
 * cancels the pending send.
 *
 * The controller owns no socket: `applyToSocket()` performs the send and
 * reports whether it happened, and the transport calls `markSubscribed()` for
 * every subscription it puts on the wire (including a fresh connect, which
 * always uses the CURRENT desired set immediately).
 *
 * @param {Object} options
 * @param {readonly string[]} [options.initial] Initial desired regions.
 * @param {() => {sent: boolean}} options.applyToSocket
 * @param {(subscribed: string[], previous: string[]) => void} [options.onSubscribedChange]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 */
export function createAisCoverageController(options) {
  const {
    initial = AIS_DEFAULT_REGIONS,
    applyToSocket,
    onSubscribedChange = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    debounceMs = AIS_COVERAGE_DEBOUNCE_MS,
    minIntervalMs = AIS_COVERAGE_MIN_SEND_INTERVAL_MS,
  } = options;

  const first = normalizeRegionIds(initial);
  let desired = first.ok ? first.regions : [...AIS_DEFAULT_REGIONS];
  let subscribed = [];
  let lastSubscribedAt = null;
  let lastSendAt = null;
  let timer = null;
  let matcher = createCoverageMatcher(desired);

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function fire() {
    timer = null;
    if (sameRegionSet(desired, subscribed)) return;
    // Whether or not a socket accepted it, desired is retained. With no open
    // socket the next connect subscribes with the CURRENT desired set.
    applyToSocket();
  }

  function schedule() {
    cancelTimer();
    const t = now();
    const earliest = lastSendAt === null ? t : lastSendAt + minIntervalMs;
    const dueIn = Math.max(debounceMs, earliest - t);
    timer = setTimer(fire, dueIn);
    timer?.unref?.();
  }

  return {
    /**
     * @param {unknown} ids
     * @returns {{ok: true, changed: boolean, desired: string[]} | {ok: false, error: string}}
     */
    setDesired(ids) {
      const result = normalizeRegionIds(ids);
      if (!result.ok) return result;
      if (sameRegionSet(result.regions, desired)) {
        return { ok: true, changed: false, desired: [...desired] };
      }
      desired = result.regions;
      matcher = createCoverageMatcher(desired);
      if (sameRegionSet(desired, subscribed)) cancelTimer(); // flipped back: nothing to send
      else schedule();
      return { ok: true, changed: true, desired: [...desired] };
    },

    /** Called by the transport after a subscription for the CURRENT desired set hit the wire. */
    markSubscribed() {
      const previous = subscribed;
      subscribed = [...desired];
      lastSubscribedAt = now();
      lastSendAt = lastSubscribedAt;
      cancelTimer();
      if (!sameRegionSet(previous, subscribed)) onSubscribedChange([...subscribed], [...previous]);
    },

    getDesired: () => [...desired],
    getSubscribed: () => [...subscribed],
    isApplying: () => !sameRegionSet(desired, subscribed),
    /** Ingest guard: follows DESIRED coverage (see vite.config.js for why). */
    desiredMatcher: () => matcher,
    snapshot() {
      return {
        desired: [...desired],
        subscribed: [...subscribed],
        applying: !sameRegionSet(desired, subscribed),
        lastSubscribedAt,
        pending: timer !== null,
      };
    },
    dispose() {
      cancelTimer();
    },
  };
}
