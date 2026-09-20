/**
 * @module ownerCoverage
 * @description Browser side of the owner-only AIS region controls.
 *
 * SECURITY MODEL. The browser never holds a credential that can change coverage.
 * The owner types the server-side secret once into the sign-in dialog; it is sent
 * in ONE request body to POST /api/admin/session and is not kept anywhere: not in
 * this module, not in localStorage/sessionStorage, not in a cookie the page can
 * read, not in a URL. The server answers with an HttpOnly cookie the page cannot
 * read either; every later request just carries it (`credentials: 'same-origin'`).
 * Public visitors have no session, so the server refuses their writes - this UI
 * is a convenience for the owner, not the security boundary.
 *
 * The region list shown as checked is ALWAYS what the server reported (desired
 * regions); a click never flips a box before the server has answered.
 */
import { AIS_REGION_LIMITS, isKnownRegionId } from './aisRegions.js';
import { fetchAisRegionsStatus } from './aisCoverageStatus.js';

export const OWNER_SESSION_URL = '/api/admin/session';
export const OWNER_REGIONS_URL = '/api/ais-regions';
export const OWNER_LEGACY_MESSAGE = 'Regional coverage controls are not enabled on this server.';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request(fetchImpl, url, init) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, body: null };
  try {
    const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...init });
    let body = null;
    try { body = await response.json(); } catch { /* an empty or non-JSON body is fine */ }
    return { ok: Boolean(response.ok), status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** @returns {Promise<boolean|null>} true/false, or null when the server cannot be reached. */
export async function fetchOwnerSession(fetchImpl = globalThis.fetch) {
  const result = await request(fetchImpl, OWNER_SESSION_URL, { method: 'GET' });
  if (!result.ok) return null;
  return result.body?.authenticated === true;
}

/**
 * The token is used for this single request and not retained. Only the outcome
 * comes back; the response never contains the token.
 * @returns {Promise<{ok: boolean, status: number}>}
 */
export async function ownerSignIn(token, fetchImpl = globalThis.fetch) {
  const result = await request(fetchImpl, OWNER_SESSION_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: String(token ?? '') }),
  });
  return { ok: result.ok && result.body?.authenticated === true, status: result.status };
}

export async function ownerSignOut(fetchImpl = globalThis.fetch) {
  const result = await request(fetchImpl, OWNER_SESSION_URL, { method: 'DELETE' });
  return { ok: result.ok, status: result.status };
}

/** The one write the browser can make. It carries only region ids, never boxes. */
export async function postRegions(regions, fetchImpl = globalThis.fetch) {
  return request(fetchImpl, OWNER_REGIONS_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ regions }),
  });
}

/**
 * The region set a click would ask for, or why it may not.
 * At least `minRegions`, at most `maxRegions`; unknown ids never pass.
 *
 * @param {string[]} current Regions the server currently wants.
 * @returns {{ok: true, regions: string[]} | {ok: false, error: string}}
 */
export function planRegionChange(current, id, wantOn, limits = AIS_REGION_LIMITS) {
  if (!isKnownRegionId(id)) return { ok: false, error: 'Unknown region.' };
  const set = new Set((current || []).filter(isKnownRegionId));
  if (wantOn) {
    if (!set.has(id) && set.size >= limits.maxRegions) {
      return { ok: false, error: `At most ${limits.maxRegions} regions can be on at once.` };
    }
    set.add(id);
  } else {
    if (set.has(id) && set.size <= limits.minRegions) {
      return { ok: false, error: 'At least one region must stay on.' };
    }
    set.delete(id);
  }
  return { ok: true, regions: [...set] };
}

function messageForFailure(result) {
  if (result.status === 401 || result.status === 403) return 'Owner session ended. Sign in again.';
  if (result.status === 409) return OWNER_LEGACY_MESSAGE;
  if (result.status === 429) return 'Too many changes. Try again shortly.';
  return 'Coverage update failed. Nothing was changed.';
}

/**
 * Owner state for the Vessels row. `onChange` fires whenever the view changes.
 * `fetchImpl` and `readStatus` are injectable for tests.
 */
export function createOwnerCoverage({ fetchImpl = (...args) => globalThis.fetch(...args), onChange = () => {}, readStatus = fetchAisRegionsStatus } = {}) {
  const state = { signedIn: false, busy: false, error: null, status: null, sessionKnown: false };
  const notify = () => { try { onChange(); } catch { /* a listener must never break the caller */ } };

  async function refreshStatus() {
    const status = await readStatus(fetchImpl);
    if (status) state.status = status;
  }

  async function refreshSession() {
    const signedIn = await fetchOwnerSession(fetchImpl);
    state.sessionKnown = signedIn !== null;
    state.signedIn = signedIn === true;
    if (state.signedIn) await refreshStatus();
    notify();
    return state.signedIn;
  }

  return {
    refreshSession,

    /** @returns {Promise<boolean>} whether the sign-in succeeded. */
    async signIn(token) {
      const result = await ownerSignIn(token, fetchImpl);
      state.signedIn = result.ok;
      state.sessionKnown = true;
      state.error = null;
      if (result.ok) await refreshStatus();
      notify();
      return result.ok;
    },

    async signOut() {
      await ownerSignOut(fetchImpl);
      state.signedIn = false;
      state.error = null;
      state.busy = false;
      notify();
    },

    /**
     * Ask the server to change coverage. Never posts in legacy mode, never posts
     * a set the limits forbid, and never shows the change as done before the
     * server's own status says so.
     */
    async toggle(id, wantOn) {
      if (state.busy || !state.signedIn) return;
      const regional = state.status?.mode === 'regions';
      if (!regional) {
        state.error = OWNER_LEGACY_MESSAGE;
        notify();
        return;
      }
      const plan = planRegionChange(state.status.desired, id, wantOn, {
        minRegions: state.status.minRegions ?? AIS_REGION_LIMITS.minRegions,
        maxRegions: state.status.maxRegions ?? AIS_REGION_LIMITS.maxRegions,
      });
      if (!plan.ok) {
        state.error = plan.error;
        notify();
        return;
      }
      state.busy = true;
      state.error = null;
      notify();
      const result = await postRegions(plan.regions, fetchImpl);
      if (result.ok) {
        await refreshStatus();
      } else {
        state.error = messageForFailure(result);
        if (result.status === 401 || result.status === 403) state.signedIn = false;
        else await refreshStatus();
      }
      state.busy = false;
      notify();
    },

    /** Keep the checked set in step with the live `/api/ais-live` coverage block. */
    noteLiveCoverage(coverage) {
      if (!state.status || state.status.mode !== 'regions' || !coverage || typeof coverage !== 'object') return;
      const next = {
        ...state.status,
        desired: Array.isArray(coverage.desired) ? coverage.desired : state.status.desired,
        subscribed: Array.isArray(coverage.subscribed) ? coverage.subscribed : state.status.subscribed,
        applying: Boolean(coverage.applying),
      };
      const changed = JSON.stringify([next.desired, next.subscribed, next.applying])
        !== JSON.stringify([state.status.desired, state.status.subscribed, state.status.applying]);
      state.status = next;
      if (changed) notify();
    },

    /** Plain-data view (no functions, no secrets) for the row renderer. */
    view() {
      if (!state.sessionKnown) return { signedIn: false, regionalMode: false, busy: false, error: null, applying: false, selected: [], minRegions: AIS_REGION_LIMITS.minRegions, maxRegions: AIS_REGION_LIMITS.maxRegions };
      const status = state.status;
      const regionalMode = status?.mode === 'regions' && status?.writeEnabled !== false;
      return {
        signedIn: state.signedIn,
        regionalMode,
        busy: state.busy,
        error: state.error,
        applying: Boolean(status?.applying),
        selected: regionalMode ? [...(status.desired || [])] : [],
        minRegions: status?.minRegions ?? AIS_REGION_LIMITS.minRegions,
        maxRegions: status?.maxRegions ?? AIS_REGION_LIMITS.maxRegions,
      };
    },

    /** Test seam. */
    _state: state,
  };
}
