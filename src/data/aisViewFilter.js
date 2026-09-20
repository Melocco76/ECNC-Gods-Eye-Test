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
 * SHARE LINKS: the viewer's regions are deliberately NOT part of share links.
 * Opening someone else's map link must not overwrite the maritime view that the
 * person opening it chose for themselves, so this preference stays browser-local.
 */
import { AIS_REGION_CATALOGUE, isKnownRegionId } from './aisRegions.js';

/** Namespaced localStorage key. Holds a JSON array of region IDs and nothing else. */
export const AIS_VIEW_REGIONS_KEY = 'gev.ais.viewRegions';

/** Used when nothing valid is saved: the U.S. East perspective plus the Gulf. */
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
 * Saved viewer regions, validated. Unknown or stale IDs are discarded; when
 * nothing valid remains the default is returned.
 * @param {Storage|null} [storage]
 * @returns {string[]}
 */
export function loadViewRegions(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(AIS_VIEW_REGIONS_KEY);
    if (raw) {
      const ids = sanitizeRegionIds(JSON.parse(raw));
      if (ids.length) return ids;
    }
  } catch {
    /* corrupt or unreadable: fall through to the default */
  }
  return [...AIS_VIEW_DEFAULT_REGIONS];
}

/**
 * Save the viewer's regions. Only region IDs are written - never anything else.
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
 * The regions this browser actually draws.
 * @param {readonly string[]} saved The viewer's saved choice.
 * @param {readonly string[]} available What the server reports it covers.
 * @returns {string[]}
 */
export function effectiveViewRegions(saved, available) {
  const offered = sanitizeRegionIds(available);
  const chosen = sanitizeRegionIds(saved).filter((id) => offered.includes(id));
  return chosen.length ? chosen : offered;
}

/**
 * Apply one checkbox click to the saved choice.
 *  - a region the server does not cover cannot be switched on;
 *  - the last visible region cannot be switched off;
 *  - preferences for currently-unavailable regions are kept for later.
 *
 * @returns {{ok: true, saved: string[]} | {ok: false, reason: 'unavailable'|'last-region'|'unknown'}}
 */
export function planViewChange(saved, id, wantOn, available) {
  if (!isKnownRegionId(id)) return { ok: false, reason: 'unknown' };
  const offered = sanitizeRegionIds(available);
  const effective = new Set(effectiveViewRegions(saved, offered));
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
