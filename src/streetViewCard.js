import { viewCenterPoint } from './mapWeatherCard.js';

// Map-mode Street View card. Shows the same-origin /api/streetview (Google
// Street View Static passthrough) for the view centre, or the exact searched
// address/place when one is current. No Maps JavaScript API, no interactive
// panorama, no periodic refresh: open/left/right/close are the only state
// transitions. The backend resolves the nearest outdoor panorama and the
// initial heading that faces it toward the requested point; this controller
// just adopts whatever it returns and steps ±45° from there.

export const STREET_VIEW_HEADING_STEP = 45;

/** Panoramas farther than this from the requested point are still shown, but
 * flagged as the nearest available rather than the exact property frontage. */
export const STREET_VIEW_NEAREST_SNAP_M = 75;

function wrapHeading(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Normalizes a {lat,lng}/{lat,lon}/{latitude,longitude}-shaped point to {latitude, longitude}. */
function toLatitudeLongitude(point) {
  if (!point) return null;
  const latitude = point.latitude ?? point.lat;
  const longitude = point.longitude ?? point.lng ?? point.lon;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function headerNumber(response, name) {
  const raw = response?.headers?.get?.(name);
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Card behaviour, free of DOM so it is testable with fakes. There is no
 * timer of any kind: a fetch happens only on open and on each heading change.
 */
export class StreetViewCardController {
  constructor({
    getCenter,
    getSearchedTarget = () => null,
    fetchImpl,
    render = () => {},
    createUrl = (blob) => URL.createObjectURL(blob),
    revokeUrl = (url) => { try { URL.revokeObjectURL(url); } catch { /* best effort */ } },
  }) {
    this.getCenter = getCenter;
    this.getSearchedTarget = getSearchedTarget;
    this.fetchImpl = fetchImpl;
    this.renderFn = render;
    this.createUrl = createUrl;
    this.revokeUrl = revokeUrl;
    this.open = false;
    this.point = null;
    this.heading = 0;
    this.pano = null;
    this.snapDistanceM = null;
    this.status = 'idle'; // idle | loading | ready | unavailable
    this.imageUrl = null;
    this.requestId = 0;
  }

  emit() {
    const tier = this.status === 'ready' && Number.isFinite(this.snapDistanceM)
      && this.snapDistanceM > STREET_VIEW_NEAREST_SNAP_M ? 'nearest' : 'normal';
    this.renderFn({
      open: this.open,
      status: this.status,
      heading: this.heading,
      imageUrl: this.imageUrl,
      snapDistanceM: this.snapDistanceM,
      tier,
    });
  }

  clearImage() {
    if (this.imageUrl) this.revokeUrl(this.imageUrl);
    this.imageUrl = null;
  }

  setOpen(open) {
    const next = Boolean(open);
    if (next === this.open) return;
    this.open = next;
    if (next) {
      // A new location: forget any previously resolved panorama so the next
      // request always does a fresh metadata lookup, never reuses a stale one.
      this.pano = null;
      this.snapDistanceM = null;
      this.point = toLatitudeLongitude(this.getSearchedTarget()) || this.getCenter();
      this.load();
    } else {
      this.requestId += 1;
      this.clearImage();
      this.status = 'idle';
      this.pano = null;
      this.snapDistanceM = null;
      this.emit();
    }
  }

  toggle() {
    this.setOpen(!this.open);
  }

  turn(deltaDeg) {
    if (!this.open) return;
    this.heading = wrapHeading(this.heading + deltaDeg);
    this.load({ includeHeading: true });
  }

  left() {
    this.turn(-STREET_VIEW_HEADING_STEP);
  }

  right() {
    this.turn(STREET_VIEW_HEADING_STEP);
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.includeHeading] True for LEFT/RIGHT: sends the
   *   locally-stepped heading and the already-resolved pano so the backend
   *   addresses that exact panorama instead of re-running metadata. False
   *   (open/new location): omits both so the backend resolves the nearest
   *   panorama and computes the initial heading toward the requested point.
   */
  load({ includeHeading = false } = {}) {
    const requestId = (this.requestId += 1);
    if (!this.point || !Number.isFinite(this.point.latitude) || !Number.isFinite(this.point.longitude)) {
      this.status = 'unavailable';
      this.emit();
      return null;
    }
    this.status = 'loading';
    this.emit();
    const params = new URLSearchParams({
      lat: this.point.latitude.toFixed(5),
      lon: this.point.longitude.toFixed(5),
    });
    if (includeHeading) params.set('heading', String(this.heading));
    if (this.pano) params.set('pano', this.pano);
    return Promise.resolve()
      .then(() => this.fetchImpl(`/api/streetview?${params}`))
      .then(async (response) => {
        if (requestId !== this.requestId) return;
        if (!response?.ok) throw new Error(`Street View unavailable (${response?.status})`);
        const headingFromServer = headerNumber(response, 'X-Street-View-Heading');
        const panoFromServer = response?.headers?.get?.('X-Street-View-Pano-Id') || null;
        const snapFromServer = headerNumber(response, 'X-Street-View-Snap-Distance-M');
        const blob = await response.blob();
        if (requestId !== this.requestId) return;
        this.clearImage();
        this.imageUrl = this.createUrl(blob);
        if (headingFromServer !== null) this.heading = wrapHeading(headingFromServer);
        if (panoFromServer) this.pano = panoFromServer;
        if (snapFromServer !== null) this.snapDistanceM = snapFromServer;
        this.status = 'ready';
        this.emit();
      })
      .catch(() => {
        if (requestId !== this.requestId) return;
        this.clearImage();
        this.status = 'unavailable';
        this.emit();
      });
  }

  destroy() {
    this.requestId += 1;
    this.clearImage();
  }
}

/**
 * Wire the static #street-view-* markup in index.html to a controller.
 * @param {object} viewer Cesium viewer.
 * @param {object} [options]
 * @param {() => ({lat:number,lng:number}|null)} [options.getSearchedTarget]
 *   Returns the exact coordinate of the most recent address/place search, or
 *   null when none is current. Preferred over the camera-center point when
 *   present; free-map Street View is unaffected.
 */
export function initStreetViewCard(viewer, { getSearchedTarget = () => null } = {}) {
  const card = document.getElementById('street-view-card');
  const toggle = document.getElementById('street-view-toggle');
  if (!card || !toggle) return null;

  const image = document.getElementById('street-view-image');
  const status = document.getElementById('street-view-status');
  const error = document.getElementById('street-view-error');
  const leftBtn = document.getElementById('street-view-left');
  const rightBtn = document.getElementById('street-view-right');
  const closeBtn = card.querySelector('[data-street-view-close]');

  const controller = new StreetViewCardController({
    getCenter: () => viewCenterPoint(viewer),
    getSearchedTarget,
    fetchImpl: (url, init) => fetch(url, init),
    render: ({ open, status: cardStatus, heading, imageUrl, tier }) => {
      card.hidden = !open;
      toggle.setAttribute('aria-pressed', String(open));
      toggle.title = open ? 'Hide Street View' : 'Show Street View';
      card.dataset.status = cardStatus;
      card.dataset.snapTier = tier;
      if (status) {
        const nearestSuffix = cardStatus === 'ready' && tier === 'nearest' ? ' · NEAREST STREET VIEW' : '';
        status.textContent = cardStatus === 'loading' ? 'LOADING'
          : cardStatus === 'unavailable' ? 'UNAVAILABLE'
            : `${String(Math.round(heading)).padStart(3, '0')}°${nearestSuffix}`;
      }
      if (error) error.hidden = cardStatus !== 'unavailable';
      if (image) {
        if (cardStatus === 'ready' && imageUrl) {
          image.src = imageUrl;
          image.hidden = false;
          image.alt = `Street View looking ${Math.round(heading)} degrees`;
        } else {
          image.hidden = true;
          image.removeAttribute('src');
        }
      }
      if (leftBtn) leftBtn.disabled = cardStatus === 'loading';
      if (rightBtn) rightBtn.disabled = cardStatus === 'loading';
    },
  });

  toggle.addEventListener('click', () => controller.toggle());
  leftBtn?.addEventListener('click', () => controller.left());
  rightBtn?.addEventListener('click', () => controller.right());
  closeBtn?.addEventListener('click', () => controller.setOpen(false));
  controller.emit();

  return {
    controller,
    destroy() {
      controller.destroy();
    },
  };
}
