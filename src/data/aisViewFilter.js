/**
 * @module aisViewFilter
 * @description PERSONAL, per-browser choice of which maritime regions to SEE.
 *
 * Two different things, kept apart on purpose:
 *
 *  - SERVER COVERAGE: which regions the Cloud Run process subscribes to. One
 *    fixed, trusted configuration for everybody. Nothing in this module reads or
 *    changes it, and no visitor ever POSTs to /api/ais-regions.
 *  - VIEWER FILTER (this module): which of the regions the server already covers
 *    THIS browser draws. Pure client state saved in localStorage. One visitor's
 *    choice cannot affect another's, or the server's.
 *
 * Effective selection = saved choice ∩ regions the server reports as available.
 * If that intersection is empty (say the saved choice was West Coast but the
 * server only covers the Gulf) the viewer sees every available region rather
 * than an empty map; the saved choice is kept, so the West Coast comes back the
 * day the server covers it.
 *
 * WORLDWIDE / ALL VESSELS: the saved preference can also be the sentinel below
 * instead of a region list, meaning "no viewer-side filter at all" - draw every
 * vessel this server's (already fixed, trusted) backend subscription delivers.
 * It is a VIEWER-ONLY concept: never a catalogue region ID, never passed to
 * normalizeRegionIds/boxesForRegions, and it changes nothing about what the
 * server subscribes to. It is the default when nothing valid is saved.
 *
 * SHARE LINKS: the viewer's regions are deliberately NOT part of share links.
 * Opening someone else's map link must not overwrite the maritime view that the
 * person opening it chose for themselves, so this preference stays browser-local.
 */
import { AIS_REGION_CATALOGUE, isKnownRegionId } from './aisRegions.js';

/** Namespaced localStorage key. Holds either the Worldwide sentinel (JSON string) or a
 * JSON array of region IDs - nothing else. */
export const AIS_VIEW_REGIONS_KEY = 'gev.ais.viewRegions';

/** Sentinel saved preference: no viewer-side region filter, every vessel is drawn. */
export const AIS_VIEW_WORLDWIDE = 'worldwide';

/** Historical region-only default, kept for callers that want a concrete starting
 * regional selection. A stale/corrupt/empty saved value now falls back to
 * AIS_VIEW_WORLDWIDE instead - see loadViewRegions(). */
export const AIS_VIEW_DEFAULT_REGIONS = Object.freeze(['gulf', 'east-coast']);

const ORDER = new Map(AIS_REGION_CATALOGUE.map((region, index) => [region.id, index]));
const byCatalogueOrder = (a, b) => ORDER.get(a) - ORDER.get(b);

/** Known, unique region IDs in catalogue order; everything else is dropped. */
export function sanitizeRegionIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(isKnownRegionId))].sort(byCatalogueOrder);
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // storage access can throw (blocked or private browsing)
  }
}

/**
 * Saved viewer preference, validated: either AIS_VIEW_WORLDWIDE, or a non-empty
 * array of catalogue region IDs with unknown/stale IDs discarded. When nothing
 * valid remains - nothing saved, corrupt JSON, or a stored list with no known
 * IDs left - the result is Worldwide, never a silent regional narrowing of
 * whatever the backend already sends.
 * @param {Storage|null} [storage]
 * @returns {typeof AIS_VIEW_WORLDWIDE | string[]}
 */
export function loadViewRegions(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(AIS_VIEW_REGIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed === AIS_VIEW_WORLDWIDE) return AIS_VIEW_WORLDWIDE;
      const ids = sanitizeRegionIds(parsed);
      if (ids.length) return ids;
    }
  } catch {
    /* corrupt or unreadable: fall through to the default */
  }
  return AIS_VIEW_WORLDWIDE;
}

/**
 * Save the viewer's regions. Only region IDs are written - never anything else.
 * Use `saveWorldwidePreference` for the Worldwide sentinel instead; this
 * function only ever accepts real catalogue region IDs.
 * @returns {boolean} whether it was stored
 */
export function saveViewRegions(ids, storage = defaultStorage()) {
  const clean = sanitizeRegionIds(ids);
  if (!clean.length) return false;
  try {
    storage?.setItem(AIS_VIEW_REGIONS_KEY, JSON.stringify(clean));
    return Boolean(storage);
  } catch {
    return false;
  }
}

/**
 * Save the Worldwide / All Vessels preference: no viewer-side region filter.
 * The explicit counterpart to `saveViewRegions` - Worldwide is never passed to
 * it as if it were a region ID.
 * @returns {boolean} whether it was stored
 */
export function saveWorldwidePreference(storage = defaultStorage()) {
  try {
    storage?.setItem(AIS_VIEW_REGIONS_KEY, JSON.stringify(AIS_VIEW_WORLDWIDE));
    return Boolean(storage);
  } catch {
    return false;
  }
}

/**
 * The regions this browser actually draws, or `null` for Worldwide (no filter:
 * draw everything, regardless of `available`).
 * @param {typeof AIS_VIEW_WORLDWIDE | readonly string[]} saved The viewer's saved choice.
 * @param {readonly string[]} available What the server reports it covers.
 * @returns {string[] | null}
 */
export function effectiveViewRegions(saved, available) {
  if (saved === AIS_VIEW_WORLDWIDE) return null;
  const offered = sanitizeRegionIds(available);
  const chosen = sanitizeRegionIds(saved).filter((id) => offered.includes(id));
  return chosen.length ? chosen : offered;
}

/**
 * Apply one checkbox click to the saved choice.
 *  - a region the server does not cover cannot be switched on;
 *  - the last visible region cannot be switched off;
 *  - preferences for currently-unavailable regions are kept for later;
 *  - switching a region ON while Worldwide is the saved preference is how a
 *    viewer EXITS Worldwide: `effectiveViewRegions` reports no prior regions
 *    (Worldwide has none), so the result is a fresh single-region selection.
 *    Selecting Worldwide itself is a separate, explicit action - see
 *    `saveWorldwidePreference` - never routed through this function.
 *
 * @returns {{ok: true, saved: string[]} | {ok: false, reason: 'unavailable'|'last-region'|'unknown'}}
 */
export function planViewChange(saved, id, wantOn, available) {
  if (!isKnownRegionId(id)) return { ok: false, reason: 'unknown' };
  const offered = sanitizeRegionIds(available);
  const effective = new Set(effectiveViewRegions(saved, offered) || []);
  if (wantOn) {
    if (!offered.includes(id)) return { ok: false, reason: 'unavailable' };
    effective.add(id);
  } else {
    effective.delete(id);
    if (effective.size === 0) return { ok: false, reason: 'last-region' };
  }
  const remembered = sanitizeRegionIds(saved).filter((rid) => !offered.includes(rid));
  return { ok: true, saved: sanitizeRegionIds([...effective, ...remembered]) };
}

/**
 * Should a vessel with these region IDs be drawn? A vessel the server could not
 * classify (no `regionIds`, or an empty list) is always drawn: an older server,
 * or a position outside every catalogue region, must never make ships vanish.
 * @param {readonly string[]|undefined} regionIds
 * @param {ReadonlySet<string>|null} selected null means "no filter".
 */
export function vesselPassesViewFilter(regionIds, selected) {
  if (!selected) return true;
  if (!Array.isArray(regionIds) || regionIds.length === 0) return true;
  for (const id of regionIds) if (selected.has(id)) return true;
  return false;
}
