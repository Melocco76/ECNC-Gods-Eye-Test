/**
 * @module aisCoverageStatus
 * @description READ-ONLY view of the AIS coverage for the Vessels row.
 *
 * It only ever reads: the public `GET /api/ais-regions` payload and the additive
 * `coverage` block of `/api/ais-live`. Nothing in this module writes. Changing
 * coverage is a separate, owner-only path (src/data/ownerCoverage.js: an HttpOnly
 * server session the page cannot read); to every other visitor each
 * region is a status indicator, never a switch.
 */
import { publicRegionCatalogue } from './aisRegions.js';
import { sanitizeRegionIds } from './aisViewFilter.js';

const CATALOGUE = publicRegionCatalogue();
const LABELS = new Map(CATALOGUE.map((region) => [region.id, region.label]));

/** Shown when regional selection is off: production's fixed subscription area. */
export const AIS_FIXED_COVERAGE_NOTE = 'Fixed area: northern Gulf of Mexico';
/** Shown under an active regional list. Honest about who can change it. */
export const AIS_OWNER_CONTROL_NOTE = 'Coverage is set by the site owner';

/**
 * Turn either payload shape into the row's coverage model, or null when the
 * server did not report coverage at all (an older server): the row then renders
 * exactly as before.
 *
 * Two kinds of model:
 *  - `kind: 'regions'`: regional mode is on. `items` lists EVERY predefined
 *    region with an `active` flag (what the socket was last told), so the row
 *    reads as a status list, plus `applying` while a change is in flight.
 *  - `kind: 'fixed'`: regional mode is off (legacy bounding box). There is no
 *    region list to show, only the fixed area.
 *
 * @param {object|null|undefined} input GET /api/ais-regions body, or the
 *   `coverage` block of /api/ais-live: `{desired, subscribed, applying}`.
 * @returns {{kind: 'regions'|'fixed', label: string, items: {id: string, label: string, active: boolean}[],
 *   note: string, applying: boolean, writable: false, available: string[]|null}|null}
 */
export function buildAisCoverageModel(input) {
  if (!input || typeof input !== 'object') return null;
  // What viewers may choose from (server-reported); null when the server predates the field.
  const available = Array.isArray(input.available) ? sanitizeRegionIds(input.available) : null;
  const desired = Array.isArray(input.desired) ? input.desired : [];
  const subscribed = Array.isArray(input.subscribed) ? input.subscribed : [];
  const regional = input.mode === 'regions' || (input.mode === undefined && (desired.length > 0 || subscribed.length > 0));
  if (!regional) {
    return {
      kind: 'fixed',
      label: 'Coverage',
      items: [],
      note: AIS_FIXED_COVERAGE_NOTE,
      applying: false,
      writable: false,
      available,
    };
  }
  // What the socket was last told is what the user is looking at; before the
  // first subscription lands, show what was asked for.
  const active = new Set((subscribed.length ? subscribed : desired).filter((id) => LABELS.has(id)));
  return {
    kind: 'regions',
    label: 'Coverage',
    items: CATALOGUE.map(({ id, label }) => ({ id, label, active: active.has(id) })),
    note: AIS_OWNER_CONTROL_NOTE,
    applying: Boolean(input.applying),
    writable: false,
    available,
  };
}

/**
 * Fetch the public regional status. Never throws; a failure means "unknown".
 * @param {(url: string, init?: object) => Promise<Response>} [fetchImpl]
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>}
 */
export async function fetchAisRegionsStatus(fetchImpl = globalThis.fetch, signal) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl('/api/ais-regions', { signal, cache: 'no-store' });
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
