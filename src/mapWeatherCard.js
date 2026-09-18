import * as Cesium from 'cesium';
import { weatherCodeLabel } from './data/regionalBrief.js';

// Map-mode weather card. Shows the existing same-origin /api/weather-effects
// (Open-Meteo current conditions) for the view centre. Cockpit keeps its own,
// separate weather path and is never touched from here.

export const MAP_WEATHER_OPEN_STORAGE_KEY = 'gev:map-weather-card:open:v1';
export const MAP_WEATHER_REFRESH_MS = 5 * 60_000;
export const MAP_WEATHER_MOVE_REFRESH_M = 25_000;
export const MAP_WEATHER_SETTLE_MS = 1_200;
export const MAP_WEATHER_MIN_FETCH_GAP_MS = 15_000;
export const MAP_WEATHER_STALE_MS = 30 * 60_000;
export const MAP_WEATHER_RETRY_BASE_MS = 30_000;

// The backend payload stays metric; U.S. customary conversion is display-only.
const MPH_PER_KPH = 0.621371;
const MM_PER_INCH = 25.4;
const METERS_PER_MILE = 1609.344;
const celsiusToFahrenheit = (c) => (c * 9) / 5 + 32;

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DASH = '—';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function greatCircleM(a, b) {
  if (!a || !b || ![a.latitude, a.longitude, b.latitude, b.longitude].every(finite)) return Infinity;
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Whether a new fetch is warranted. Pure so the debounce policy is testable. */
export function mapWeatherRefreshDue({
  nowMs, fetchedAt, lastAttemptAt = 0, anchor, point, hasWeather,
}) {
  if (!point) return false;
  const moved = greatCircleM(anchor, point) >= MAP_WEATHER_MOVE_REFRESH_M;
  if (Number.isFinite(nowMs) && Number.isFinite(lastAttemptAt)
    && nowMs - lastAttemptAt < MAP_WEATHER_MIN_FETCH_GAP_MS) return false;
  if (!hasWeather) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(fetchedAt)) return true;
  return nowMs - fetchedAt >= MAP_WEATHER_REFRESH_MS || moved;
}

function windLabel(deg) {
  if (!finite(deg)) return DASH;
  const normalized = ((deg % 360) + 360) % 360;
  return `${COMPASS[Math.round(normalized / 45) % COMPASS.length]} ${Math.round(normalized)}°`;
}

function coordinateLabel(point) {
  if (!point || !finite(point.latitude) || !finite(point.longitude)) return DASH;
  const lat = `${Math.abs(point.latitude).toFixed(2)}°${point.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.longitude).toFixed(2)}°${point.longitude >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

function observedLabel(observedAt) {
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time)) return DASH;
  return `${new Date(time).toISOString().slice(11, 16)}Z`;
}

/**
 * Map the raw card state onto display strings. Missing values render as a dash
 * and nothing is ever invented: no weather object means every field is blank.
 * @param {{status?: string, weather?: object|null, fetchedAt?: number, anchor?: object|null}} state
 * @param {number} [nowMs]
 */
export function mapWeatherCardModel(state = {}, nowMs = Date.now()) {
  const weather = state.weather && typeof state.weather === 'object' ? state.weather : null;
  let status = weather ? (state.status || 'ready') : (state.status === 'loading' ? 'loading' : 'unavailable');
  if (weather && status === 'ready' && finite(state.fetchedAt)
    && nowMs - state.fetchedAt > MAP_WEATHER_STALE_MS) status = 'stale';
  const num = (value, format) => (finite(value) ? format(value) : DASH);
  return {
    status,
    statusLabel: { ready: 'LIVE', loading: 'LOADING', stale: 'STALE', unavailable: 'UNAVAILABLE' }[status] || 'UNAVAILABLE',
    place: coordinateLabel(state.anchor),
    condition: weather && finite(weather.weatherCode) ? weatherCodeLabel(weather.weatherCode) : DASH,
    temperature: num(weather?.temperatureC, (v) => `${Math.round(celsiusToFahrenheit(v))}°F`),
    feelsLike: num(weather?.apparentTemperatureC, (v) => `${Math.round(celsiusToFahrenheit(v))}°F`),
    cloud: num(weather?.cloudCoverPct, (v) => `${Math.round(v)}%`),
    precipitation: num(weather?.precipitationMm, (v) => `${(v / MM_PER_INCH).toFixed(2)} in`),
    wind: num(weather?.windKph, (v) => `${Math.round(v * MPH_PER_KPH)} mph`),
    windDirection: windLabel(weather?.windDirectionDeg),
    visibility: num(weather?.visibilityM, (v) => {
      const miles = v / METERS_PER_MILE;
      return `${miles.toFixed(miles >= 10 ? 0 : 1)} mi`;
    }),
    observed: weather ? observedLabel(weather.observedAt) : DASH,
  };
}

/** View-centre point: ground under the canvas centre, else the camera nadir. */
export function viewCenterPoint(viewer) {
  const camera = viewer?.camera;
  const canvas = viewer?.scene?.canvas;
  if (!camera) return null;
  let cartographic = null;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    try {
      const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const hit = camera.pickEllipsoid(center, viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84);
      if (hit) cartographic = Cesium.Cartographic.fromCartesian(hit);
    } catch { cartographic = null; }
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  const latitude = Cesium.Math.toDegrees(cartographic.latitude);
  const longitude = Cesium.Math.toDegrees(cartographic.longitude);
  if (![latitude, longitude].every(finite)) return null;
  return { latitude, longitude };
}

/**
 * Card behaviour, free of DOM/Cesium so it is testable with fakes. There is no
 * rAF and no interval: work happens on open, on a debounced camera settle, and
 * via one one-shot expiry timer that is re-armed only after a fetch attempt.
 */
export class MapWeatherCardController {
  constructor({
    getCenter,
    fetchImpl,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    isHidden = () => false,
    isSuppressed = () => false,
    render = () => {},
    loadOpen = () => false,
    saveOpen = () => {},
  }) {
    this.getCenter = getCenter;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.isHidden = isHidden;
    this.isSuppressed = isSuppressed;
    this.renderFn = render;
    this.saveOpen = saveOpen;
    this.open = Boolean(loadOpen());
    this.state = { status: 'unavailable', weather: null, fetchedAt: 0, anchor: null };
    this.lastAttemptAt = 0;
    this.failures = 0;
    this.pending = null;
    this.abort = null;
    this.settleTimer = null;
    this.expiryTimer = null;
    this.gapTimer = null;
    this.destroyed = false;
  }

  emit() {
    this.renderFn(mapWeatherCardModel(this.state, this.now()), { open: this.open });
  }

  setOpen(open) {
    const next = Boolean(open);
    if (next === this.open) return;
    this.open = next;
    this.saveOpen(next);
    if (next) {
      this.emit();
      this.check();
    } else {
      this.cancelWork();
      this.emit();
    }
  }

  toggle() {
    this.setOpen(!this.open);
  }

  cancelWork() {
    if (this.settleTimer !== null) this.clearTimer(this.settleTimer);
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer);
    this.settleTimer = null;
    this.expiryTimer = null;
    this.clearGapRetry();
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
  }

  /** Camera settled (moveEnd): debounce, then re-check. */
  onCameraSettled() {
    if (this.destroyed || !this.open) return;
    if (this.settleTimer !== null) this.clearTimer(this.settleTimer);
    this.settleTimer = this.setTimer(() => {
      this.settleTimer = null;
      this.check();
    }, MAP_WEATHER_SETTLE_MS);
  }

  onVisibilityChange() {
    if (!this.destroyed && this.open && !this.isHidden()) this.check();
  }

  armExpiry(delayMs) {
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer);
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.check();
    }, delayMs);
  }

  clearGapRetry() {
    if (this.gapTimer !== null) this.clearTimer(this.gapTimer);
    this.gapTimer = null;
  }

  /**
   * One deferred re-check for a refresh that is due but blocked only by the
   * minimum fetch gap. The timer carries no coordinates: check() recomputes
   * due-ness from the latest view centre when it fires.
   */
  armGapRetry(delayMs) {
    if (this.gapTimer !== null) return;
    this.gapTimer = this.setTimer(() => {
      this.gapTimer = null;
      this.check();
    }, Math.max(0, delayMs));
  }

  check() {
    if (this.destroyed || !this.open || this.pending) return this.pending;
    if (this.isHidden() || this.isSuppressed()) {
      this.clearGapRetry();
      return this.pending;
    }
    const point = this.getCenter();
    const nowMs = this.now();
    const args = {
      nowMs,
      fetchedAt: this.state.fetchedAt,
      lastAttemptAt: this.lastAttemptAt,
      anchor: this.state.anchor,
      point,
      hasWeather: Boolean(this.state.weather),
    };
    if (!mapWeatherRefreshDue(args)) {
      // A failure's own backed-off timer already re-checks with fresh
      // coordinates, so the gap retry only covers the healthy path.
      const gapLeftMs = this.lastAttemptAt + MAP_WEATHER_MIN_FETCH_GAP_MS - nowMs;
      if (gapLeftMs > 0 && this.failures === 0 && mapWeatherRefreshDue({ ...args, lastAttemptAt: 0 })) {
        this.armGapRetry(gapLeftMs);
      }
      this.emit();
      return null;
    }
    this.clearGapRetry();
    return this.fetchWeather(point, nowMs);
  }

  fetchWeather(point, nowMs) {
    this.lastAttemptAt = nowMs;
    this.abort = typeof AbortController === 'function' ? new AbortController() : null;
    if (!this.state.weather) this.state = { ...this.state, status: 'loading' };
    this.emit();
    const params = new URLSearchParams({
      latitude: point.latitude.toFixed(5),
      longitude: point.longitude.toFixed(5),
    });
    this.pending = Promise.resolve()
      .then(() => this.fetchImpl(`/api/weather-effects?${params}`, { signal: this.abort?.signal }))
      .then(async (response) => {
        if (!response?.ok) throw new Error(`Weather unavailable (${response?.status})`);
        const payload = await response.json();
        if (!payload?.weather || typeof payload.weather !== 'object') throw new Error('No weather observation');
        this.failures = 0;
        this.state = {
          status: payload.status === 'stale' ? 'stale' : 'ready',
          weather: payload.weather,
          fetchedAt: this.now(),
          anchor: { latitude: point.latitude, longitude: point.longitude },
        };
        this.armExpiry(MAP_WEATHER_REFRESH_MS);
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        this.failures += 1;
        this.state = { ...this.state, status: this.state.weather ? 'stale' : 'unavailable' };
        this.armExpiry(Math.min(MAP_WEATHER_REFRESH_MS, MAP_WEATHER_RETRY_BASE_MS * 2 ** (this.failures - 1)));
      })
      .finally(() => {
        this.pending = null;
        this.abort = null;
        if (!this.destroyed) this.emit();
      });
    return this.pending;
  }

  destroy() {
    this.destroyed = true;
    this.cancelWork();
  }
}

const FIELD_IDS = {
  status: 'map-weather-status',
  place: 'map-weather-place',
  condition: 'map-weather-condition',
  temperature: 'map-weather-temperature',
  feelsLike: 'map-weather-feels',
  cloud: 'map-weather-cloud',
  precipitation: 'map-weather-precip',
  wind: 'map-weather-wind',
  windDirection: 'map-weather-wind-dir',
  visibility: 'map-weather-visibility',
  observed: 'map-weather-observed',
};

/** Wire the static #map-weather-* markup in index.html to a controller. */
export function initMapWeatherCard(viewer) {
  const card = document.getElementById('map-weather-card');
  const button = document.getElementById('map-weather-toggle');
  if (!card || !button) return null;
  const fields = {};
  for (const [key, id] of Object.entries(FIELD_IDS)) fields[key] = document.getElementById(id);

  const controller = new MapWeatherCardController({
    getCenter: () => viewCenterPoint(viewer),
    fetchImpl: (url, init) => fetch(url, init),
    isHidden: () => document.hidden,
    isSuppressed: () => document.body.classList.contains('cockpit-mode'),
    loadOpen: () => {
      try { return localStorage.getItem(MAP_WEATHER_OPEN_STORAGE_KEY) === '1'; } catch { return false; }
    },
    saveOpen: (open) => {
      try { localStorage.setItem(MAP_WEATHER_OPEN_STORAGE_KEY, open ? '1' : '0'); } catch { /* best effort */ }
    },
    render: (model, { open }) => {
      card.hidden = !open;
      button.setAttribute('aria-pressed', String(open));
      button.title = open ? 'Hide local weather' : 'Show local weather';
      card.dataset.status = model.status;
      for (const [key, element] of Object.entries(fields)) {
        if (!element) continue;
        element.textContent = key === 'status' ? model.statusLabel : model[key];
      }
    },
  });

  button.addEventListener('click', () => controller.toggle());
  card.querySelector('[data-map-weather-close]')?.addEventListener('click', () => controller.setOpen(false));
  const onSettled = () => controller.onCameraSettled();
  const onVisibility = () => controller.onVisibilityChange();
  // Leaving cockpit resumes the (debounced) check that cockpit suppressed.
  const onCockpitMode = (event) => {
    if (event?.detail?.active === false) controller.onCameraSettled();
  };
  viewer.camera.moveEnd.addEventListener(onSettled);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('gev:cockpit-mode-changed', onCockpitMode);
  controller.emit();
  if (controller.open) controller.check();

  return {
    controller,
    destroy() {
      viewer.camera.moveEnd.removeEventListener(onSettled);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('gev:cockpit-mode-changed', onCockpitMode);
      controller.destroy();
    },
  };
}
