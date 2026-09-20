/**
 * @module aisCoverageStatus
 * @description READ-ONLY view of the AIS regional coverage for the Vessels row.
 *
 * It only ever reads: the public `GET /api/ais-regions` payload and the additive
 * `coverage` block of `/api/ais-live`. There is no write path in the browser -
 * changing coverage needs owner authorization, and the browser holds no
 * credential for it. The row reserves an empty slot for future owner-only
 * switches (see DataLayerManager._syncRowCoverage).
 */
import { publicRegionCatalogue } from './aisRegions.js';

const LABELS = new Map(publicRegionCatalogue().map((region) => [region.id, region.label]));

/**
 * Turn either payload shape into the row's coverage model, or null when
 * regional mode is off / unknown (the row then renders exactly as before).
 *
 * @param {object|null|undefined} input GET /api/ais-regions body, or the
 *   `coverage` block of /api/ais-live: `{desired, subscribed, applying}`.
 * @returns {{label: string, items: {id: string, label: string}[], applying: boolean, writable: false}|null}
 */
export function buildAisCoverageModel(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.mode === 'legacy-env') return null;
  const desired = Array.isArray(input.desired) ? input.desired : [];
  const subscribed = Array.isArray(input.subscribed) ? input.subscribed : [];
  // What the socket was last told is what the user is looking at; before the
  // first subscription lands, show what was asked for.
  const ids = subscribed.length ? subscribed : desired;
  const items = ids
    .filter((id) => typeof id === 'string' && LABELS.has(id))
    .map((id) => ({ id, label: LABELS.get(id) }));
  if (!items.length) return null;
  return {
    label: 'Coverage',
    items,
    applying: Boolean(input.applying),
    writable: false,
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
