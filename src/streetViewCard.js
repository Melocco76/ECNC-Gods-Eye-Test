import { viewCenterPoint } from './mapWeatherCard.js';

// Map-mode Street View card. Shows the same-origin /api/streetview (Google
// Street View Static passthrough) for the view centre. No Maps JavaScript
// API, no interactive panorama, no periodic refresh: open/left/right/close
// are the only state transitions.

export const STREET_VIEW_HEADING_STEP = 45;

function wrapHeading(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Card behaviour, free of DOM so it is testable with fakes. There is no
 * timer of any kind: a fetch happens only on open and on each heading change.
 */
export class StreetViewCardController {
  constructor({
    getCenter,
    fetchImpl,
    render = () => {},
    createUrl = (blob) => URL.createObjectURL(blob),
    revokeUrl = (url) => { try { URL.revokeObjectURL(url); } catch { /* best effort */ } },
  }) {
    this.getCenter = getCenter;
    this.fetchImpl = fetchImpl;
    this.renderFn = render;
    this.createUrl = createUrl;
    this.revokeUrl = revokeUrl;
    this.open = false;
    this.point = null;
    this.heading = 0;
    this.status = 'idle'; // idle | loading | ready | unavailable
    this.imageUrl = null;
    this.requestId = 0;
  }

  emit() {
    this.renderFn({
      open: this.open,
      status: this.status,
      heading: this.heading,
      imageUrl: this.imageUrl,
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
      this.heading = 0;
      this.point = this.getCenter();
      this.load();
    } else {
      this.requestId += 1;
      this.clearImage();
      this.status = 'idle';
      this.emit();
    }
  }

  toggle() {
    this.setOpen(!this.open);
  }

  turn(deltaDeg) {
    if (!this.open) return;
    this.heading = wrapHeading(this.heading + deltaDeg);
    this.load();
  }

  left() {
    this.turn(-STREET_VIEW_HEADING_STEP);
  }

  right() {
    this.turn(STREET_VIEW_HEADING_STEP);
  }

  load() {
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
      heading: String(this.heading),
    });
    return Promise.resolve()
      .then(() => this.fetchImpl(`/api/streetview?${params}`))
      .then(async (response) => {
        if (requestId !== this.requestId) return;
        if (!response?.ok) throw new Error(`Street View unavailable (${response?.status})`);
        const blob = await response.blob();
        if (requestId !== this.requestId) return;
        this.clearImage();
        this.imageUrl = this.createUrl(blob);
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

/** Wire the static #street-view-* markup in index.html to a controller. */
export function initStreetViewCard(viewer) {
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
    fetchImpl: (url, init) => fetch(url, init),
    render: ({ open, status: cardStatus, heading, imageUrl }) => {
      card.hidden = !open;
      toggle.setAttribute('aria-pressed', String(open));
      toggle.title = open ? 'Hide Street View' : 'Show Street View';
      card.dataset.status = cardStatus;
      if (status) {
        status.textContent = cardStatus === 'loading' ? 'LOADING'
          : cardStatus === 'unavailable' ? 'UNAVAILABLE'
            : `${String(Math.round(heading)).padStart(3, '0')}°`;
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
