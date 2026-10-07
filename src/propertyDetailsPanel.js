/**
 * @module propertyDetailsPanel
 * @description Property Intelligence A3 — the "Property Details" right-rail
 * panel. Reuses the existing shared selection bus (`contextStore.js`'s
 * `gev:entity-selected`/`gev:entity-selection-cleared` window events, the
 * same ones `trackedReadout.js` already consumes) rather than inventing a
 * second one. Fetches `/api/parcels/detail` for whichever parcel A2.3's
 * click/select/highlight flow has selected, never `/api/parcels/identify`
 * (the rendered dataset already carries parcel identity — see
 * `src/data/parcels.js`).
 *
 * Split in three layers, each independently testable:
 *  - pure formatters + `buildPropertyDetailModel` (provider-neutral; takes
 *    only the ALREADY owner-stripped public parcel shape `toPublicParcel`
 *    produces server-side, and never reads an `owner` field even if one
 *    were present — defense in depth on top of the server boundary);
 *  - `createPropertyDetailsController` (pure state machine: fetch, abort,
 *    generation-guard, same-selection dedupe — no DOM);
 *  - `renderPropertyDetailsState` + `initPropertyDetailsPanel`/
 *    `destroyPropertyDetailsPanel` (the thin DOM/event-wiring glue).
 *
 * PRIVACY: nothing in this module ever reads, formats, or renders an owner
 * name, owner mailing address, or owner account field. There is no owner
 * search and no owner query parameter anywhere in this file.
 */

// -- formatters (pure) --------------------------------------------------------------------------------

/**
 * `Number(null) === 0` and `Number('') === 0` — both would otherwise read as
 * "the provider reported zero" rather than "the provider reported nothing".
 * Every formatter below goes through this guard first.
 * @param {unknown} value
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} value @returns {string|null} e.g. "$245,800", or null when not a real number. */
export function formatCurrencyValue(value) {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * @param {unknown} acreage @param {'assessor'|'computed'|null} [acreageSource]
 * @returns {string|null} e.g. "2.37 acres", or "... (estimated)" when geometry-derived, never an assessor figure misrepresented as computed or vice versa.
 */
export function formatAcreageValue(acreage, acreageSource = null) {
  const n = toFiniteNumber(acreage);
  if (n === null) return null;
  const base = `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} acres`;
  return acreageSource === 'computed' ? `${base} (estimated)` : base;
}

/** @param {unknown} value @returns {string|null} e.g. "1,842 sq ft". */
export function formatAreaValue(value) {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return `${Math.round(n).toLocaleString('en-US')} sq ft`;
}

/** @param {unknown} value @returns {string|null} e.g. "1998". */
export function formatYearValue(value) {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return String(Math.round(n));
}

/** @param {unknown} value @returns {string|null} e.g. "3" or "2.5" (bathrooms) — 0 is shown, since the normalized model only ever carries 0 when a provider genuinely reported it. */
export function formatCountValue(value) {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return String(n);
}

/** @param {unknown} isoString @returns {string|null} a readable local date/time, or null for a missing/invalid timestamp. */
export function formatRetrievedTimestamp(isoString) {
  if (typeof isoString !== 'string' || !isoString.trim()) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Join whatever address pieces are actually present. Never pads a sparse
 * record with placeholder text (Virginia's statewide dataset routinely
 * lacks street-level address fields — see `virginiaStatewide.js`).
 * @param {{full?:string|null, city?:string|null, state?:string|null, zip?:string|null}|null} address
 * @returns {string|null}
 */
export function formatAddressLine(address) {
  if (!address) return null;
  const cityStateZip = [address.city, [address.state, address.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  if (address.full && cityStateZip) return `${address.full}, ${cityStateZip}`;
  if (address.full) return address.full;
  if (cityStateZip) return cityStateZip;
  return null;
}

// -- normalized panel model (pure, provider-neutral) ----------------------------------------------------

function row(label, value) {
  return value === null || value === undefined ? null : { label, value };
}

/**
 * Build the panel's view model from a PUBLIC parcel (the exact shape
 * `/api/parcels/detail` returns — already owner-stripped server-side by
 * `toPublicParcel`). One generic section/row builder for every provider;
 * no `if (providerId === ...)` branching anywhere in this function — a
 * provider's own normalization (`parcelProviderData.js` + each provider
 * module) is the only place field differences are handled (A3 Part 6).
 *
 * This function itself never reads an `owner`/`ownerName`/mailing field —
 * not because the input lacks one (defense in depth if it ever did), but
 * because nothing below ever accesses `parcel.owner`.
 * @param {object|null} parcel
 * @returns {{sections: Array<{id:string,title:string,rows:Array<{label:string,value:string}>}>, officialLinks: Array<{label:string,url:string}>, parcelId: string|null}|null}
 */
export function buildPropertyDetailModel(parcel) {
  if (!parcel || typeof parcel !== 'object') return null;

  const overview = [
    row('Parcel ID', parcel.parcelId || null),
    row('Address', formatAddressLine(parcel.address)),
    row('Acreage', formatAcreageValue(parcel.acreage, parcel.acreageSource)),
  ].filter(Boolean);

  const property = [
    row('Zoning', parcel.zoning || null),
    row('Land Use', parcel.landUse || null),
  ].filter(Boolean);

  // "Market / Parcel Value" is deliberately not labeled "Market Value" — a
  // provider's own figure (e.g. NC OneMap's `parval`, "Parcel Value") is
  // not always a true appraised market value, and this label must never
  // overstate that semantic (A3 Part 6).
  const values = [
    row('Assessed Value', formatCurrencyValue(parcel.values?.assessed)),
    row('Taxable Value', formatCurrencyValue(parcel.values?.taxable)),
    row('Market / Parcel Value', formatCurrencyValue(parcel.values?.market)),
    row('Land Value', formatCurrencyValue(parcel.values?.land)),
    row('Improvement Value', formatCurrencyValue(parcel.values?.improvements)),
  ].filter(Boolean);

  const improvements = [
    row('Year Built', formatYearValue(parcel.improvements?.yearBuilt)),
    row('Building Area', formatAreaValue(parcel.improvements?.buildingArea)),
    row('Garage Area', formatAreaValue(parcel.improvements?.garageArea)),
    row('Bedrooms', formatCountValue(parcel.improvements?.bedrooms)),
    row('Bathrooms', formatCountValue(parcel.improvements?.bathrooms)),
  ].filter(Boolean);

  const source = [
    row('Source Agency', parcel.sourceAgency || null),
    row('Retrieved', formatRetrievedTimestamp(parcel.retrievedAt)),
  ].filter(Boolean);

  const sections = [
    { id: 'overview', title: 'Overview', rows: overview },
    { id: 'property', title: 'Property', rows: property },
    { id: 'values', title: 'Values', rows: values },
    { id: 'improvements', title: 'Improvements', rows: improvements },
    { id: 'source', title: 'Source', rows: source },
  ].filter((section) => section.rows.length > 0);

  const officialLinks = Array.isArray(parcel.officialLinks)
    ? parcel.officialLinks.filter((link) => link && typeof link.url === 'string' && link.url.trim())
    : [];

  return { sections, officialLinks, parcelId: parcel.parcelId || null };
}

// -- fetch/abort/generation controller (pure state machine, no DOM) --------------------------------------

const IDLE_STATE = Object.freeze({ status: 'idle', selectionKey: null, region: null, parcelId: null, model: null });

/**
 * @param {object} [params]
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(state: object) => void} [params.onStateChange]
 */
export function createPropertyDetailsController({
  fetchImpl = (...args) => globalThis.fetch(...args),
  onStateChange = () => {},
} = {}) {
  let generation = 0;
  let abortController = null;
  let currentKey = null;
  let state = IDLE_STATE;

  function setState(patch) {
    state = { ...state, ...patch };
    onStateChange(state);
  }

  /**
   * @param {string} region @param {string} parcelId
   */
  async function loadDetail(region, parcelId) {
    const key = `${region}:${parcelId}`;
    // Part 3: the same selection already loaded (or loading) — no duplicate
    // fetch. A2.3/A2.4's "restore selection across a viewport rebuild" path
    // re-dispatches `gev:entity-selected` for the SAME logical parcel under
    // a new render/entity identity; region+parcelId are what actually
    // identify the upstream record, so that case is a correct no-op here.
    if (key === currentKey && (state.status === 'loading' || state.status === 'ready')) return;
    currentKey = key;
    abortController?.abort();
    abortController = new AbortController();
    const myGeneration = ++generation;
    setState({ status: 'loading', selectionKey: key, region, parcelId, model: null });
    try {
      const url = `/api/parcels/detail?${new URLSearchParams({ region, parcelId })}`;
      const response = await fetchImpl(url, { signal: abortController.signal });
      if (myGeneration !== generation) return; // superseded by a newer selection
      if (response.status === 404) { setState({ status: 'empty' }); return; }
      if (!response.ok) { setState({ status: 'error' }); return; }
      const body = await response.json();
      if (myGeneration !== generation) return;
      const parcel = body?.parcel || null;
      if (!parcel) { setState({ status: 'empty' }); return; }
      setState({ status: 'ready', model: buildPropertyDetailModel(parcel) });
    } catch (error) {
      if (error?.name === 'AbortError') return; // this request was superseded, not a failure
      if (myGeneration !== generation) return;
      setState({ status: 'error' });
    }
  }

  return {
    /** Select a new parcel (region/parcelId straight from the A2.3 selection-context record). */
    selectParcel(region, parcelId) {
      if (!region || !parcelId) return;
      void loadDetail(region, parcelId);
    },
    /** Selection cleared/evicted/layer disabled — reset to idle and cancel any in-flight request. */
    clear() {
      abortController?.abort();
      abortController = null;
      generation += 1; // orphan any in-flight response immediately
      currentKey = null;
      setState(IDLE_STATE);
    },
    getState() { return state; },
  };
}

// -- DOM rendering (thin; all real logic already happened above) ----------------------------------------

const STATUS_MESSAGE = Object.freeze({
  loading: 'Loading property details…',
  empty: 'Property details unavailable',
  error: 'Property data temporarily unavailable',
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Paint the panel's body from a controller state snapshot. `panelEl` is the
 * top-level `.panel-collapsible` (toggled via `hidden`, the same lever the
 * existing adaptive right-rail layout already watches for — see
 * `_initRightPanelAdaptiveLayout`'s `attributeFilter: ['class','hidden',...]`
 * in `ui.js`). A new selection also expands it (removes `.collapsed`),
 * matching `_renderCctvState`'s own auto-expand-on-new-selection
 * convention in `ui.js` — otherwise the panel would appear in the rail but
 * stay visually collapsed to just its header. `bodyEl` is the inner content
 * container this module owns exclusively.
 * @param {object} state Controller state (see `createPropertyDetailsController`).
 * @param {{panelEl: {hidden:boolean, classList:{remove:Function}}|null, bodyEl: {innerHTML:string}|null}} refs
 */
export function renderPropertyDetailsState(state, { panelEl, bodyEl } = {}) {
  if (!panelEl || !bodyEl) return;
  if (state.status === 'idle') {
    panelEl.hidden = true;
    bodyEl.innerHTML = '';
    return;
  }
  panelEl.hidden = false;
  panelEl.classList?.remove('collapsed');
  if (state.status === 'loading' || state.status === 'empty' || state.status === 'error') {
    bodyEl.innerHTML = `<p class="property-details-status">${escapeHtml(STATUS_MESSAGE[state.status])}</p>`;
    return;
  }
  const model = state.model;
  if (!model || (model.sections.length === 0 && model.officialLinks.length === 0)) {
    bodyEl.innerHTML = `<p class="property-details-status">${escapeHtml(STATUS_MESSAGE.empty)}</p>`;
    return;
  }
  const sectionsHtml = model.sections.map((section) => `
    <section class="property-details-section">
      <h3 class="property-details-section-title">${escapeHtml(section.title)}</h3>
      ${section.rows.map((r) => `
        <div class="property-details-row">
          <span class="property-details-label">${escapeHtml(r.label)}</span>
          <span class="property-details-value">${escapeHtml(r.value)}</span>
        </div>
      `).join('')}
    </section>
  `).join('');
  const linksHtml = model.officialLinks.map((link) => `
    <a class="property-details-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label || 'View Official Property Record')}</a>
  `).join('');
  bodyEl.innerHTML = sectionsHtml + linksHtml;
}

// -- selection-bus wiring (mirrors trackedReadout.js's init/destroy pattern) -----------------------------

const PARCELS_LAYER_ID = 'property-parcels';

let _controller = null;
let _panelEl = null;
let _bodyEl = null;
let _selectedHandler = null;
let _clearedHandler = null;

/**
 * Wire the panel to the shared selection bus. No Cesium viewer dependency —
 * this panel is pure DOM + fetch, unlike `trackedReadout.js`'s 3D overlay.
 * @param {{fetchImpl?: Function}} [options]
 */
export function initPropertyDetailsPanel({ fetchImpl } = {}) {
  if (_selectedHandler) return; // already initialized
  _panelEl = document.getElementById('property-details-panel');
  _bodyEl = document.getElementById('property-details-body');
  if (!_panelEl || !_bodyEl) return; // panel markup not present (e.g. a test harness page) — nothing to wire
  _controller = createPropertyDetailsController({
    fetchImpl,
    onStateChange: (state) => renderPropertyDetailsState(state, { panelEl: _panelEl, bodyEl: _bodyEl }),
  });
  _selectedHandler = (event) => {
    const record = event.detail;
    if (record?.layerId !== PARCELS_LAYER_ID) {
      // The shared single-slot selection moved to a different kind of
      // entity (an aircraft, a vessel, an installation…) — contextStore
      // does not dispatch a separate "cleared" event for the parcel that
      // lost the slot (see `contextStore.js`'s `selectEntityContext`), so
      // this panel must treat a NON-parcel selection as its own clear.
      _controller?.clear();
      return;
    }
    const region = record?.properties?.region;
    const parcelId = record?.properties?.parcelId;
    _controller?.selectParcel(region, parcelId);
  };
  _clearedHandler = (event) => {
    if (event.detail?.layerId !== PARCELS_LAYER_ID) return;
    // Covers every A2.3/A2.4 clear path through one event: deliberate
    // deselect, the layer being disabled, and a selected parcel evicted by
    // a viewport refresh — contextStore dispatches the same event for all
    // three (see `clearSelectedEntityContextForLayer`/`removeEntityContextsForLayer`).
    _controller?.clear();
  };
  window.addEventListener('gev:entity-selected', _selectedHandler);
  window.addEventListener('gev:entity-selection-cleared', _clearedHandler);
}

/** Tear down selection listeners and reset the panel to idle/hidden. */
export function destroyPropertyDetailsPanel() {
  if (_selectedHandler) window.removeEventListener('gev:entity-selected', _selectedHandler);
  if (_clearedHandler) window.removeEventListener('gev:entity-selection-cleared', _clearedHandler);
  _selectedHandler = null;
  _clearedHandler = null;
  _controller?.clear();
  _controller = null;
  _panelEl = null;
  _bodyEl = null;
}

/** Test-only accessor for the live controller instance; null outside a test-driven init. */
export function _getControllerForTest() {
  return _controller;
}
