// Map-mode weather card: data mapping, refresh policy, and "no loop" contract.
// Pure fixtures with fake timers/fetch — no network, no browser.
//
// Run with: npm test   (node --test)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  MAP_WEATHER_MIN_FETCH_GAP_MS,
  MAP_WEATHER_MOVE_REFRESH_M,
  MAP_WEATHER_REFRESH_MS,
  MAP_WEATHER_SETTLE_MS,
  MAP_WEATHER_STALE_MS,
  MapWeatherCardController,
  mapWeatherCardModel,
  mapWeatherRefreshDue,
  viewCenterPoint,
} from './mapWeatherCard.js';

const PARIS_WEATHER = {
  observedAt: '2026-09-18T16:00:00.000Z',
  temperatureC: 21.8,
  apparentTemperatureC: 19.2,
  precipitationMm: 0,
  cloudCoverPct: 100,
  windKph: 12.2,
  windDirectionDeg: 272,
  visibilityM: 43180,
  weatherCode: 3,
};
const PARIS = { latitude: 48.8566, longitude: 2.3522 };

const okResponse = (status = 'ready', weather = PARIS_WEATHER) => ({
  ok: true,
  json: async () => ({ status, weather }),
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('maps a full Open-Meteo observation onto card fields', () => {
  const model = mapWeatherCardModel({
    status: 'ready', weather: PARIS_WEATHER, fetchedAt: 1000, anchor: PARIS,
  }, 2000);
  assert.deepEqual(model, {
    status: 'ready',
    statusLabel: 'LIVE',
    place: '48.86°N 2.35°E',
    condition: 'OVERCAST',
    temperature: '22°C',
    feelsLike: '19°C',
    cloud: '100%',
    precipitation: '0.0 mm',
    wind: '12 km/h',
    windDirection: 'W 272°',
    visibility: '43 km',
    observed: '16:00Z',
  });
});

test('short visibility keeps one decimal and southern/western coordinates are labelled', () => {
  const model = mapWeatherCardModel({
    status: 'ready',
    weather: { ...PARIS_WEATHER, visibilityM: 800 },
    fetchedAt: 1,
    anchor: { latitude: -33.87, longitude: -70.5 },
  }, 2);
  assert.equal(model.visibility, '0.8 km');
  assert.equal(model.place, '33.87°S 70.50°W');
});

test('missing fields render as dashes and are never invented', () => {
  const model = mapWeatherCardModel({
    status: 'ready',
    weather: { temperatureC: 10, observedAt: 'not-a-date' },
    fetchedAt: 1,
    anchor: PARIS,
  }, 2);
  assert.equal(model.temperature, '10°C');
  for (const key of ['feelsLike', 'cloud', 'precipitation', 'wind', 'windDirection', 'visibility', 'observed', 'condition']) {
    assert.equal(model[key], '—', `${key} must be a dash when the source omits it`);
  }
});

test('no observation means unavailable with every field blank (no synthetic weather)', () => {
  const model = mapWeatherCardModel({ status: 'ready', weather: null }, 5);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.statusLabel, 'UNAVAILABLE');
  for (const key of ['place', 'condition', 'temperature', 'feelsLike', 'cloud', 'precipitation', 'wind', 'windDirection', 'visibility', 'observed']) {
    assert.equal(model[key], '—');
  }
  assert.equal(mapWeatherCardModel({ status: 'loading', weather: null }).statusLabel, 'LOADING');
});

test('stale is reported for server-stale payloads and for old held observations', () => {
  assert.equal(mapWeatherCardModel({ status: 'stale', weather: PARIS_WEATHER, fetchedAt: 100 }, 200).status, 'stale');
  const held = { status: 'ready', weather: PARIS_WEATHER, fetchedAt: 1_000 };
  assert.equal(mapWeatherCardModel(held, 1_000 + MAP_WEATHER_STALE_MS).status, 'ready');
  assert.equal(mapWeatherCardModel(held, 1_001 + MAP_WEATHER_STALE_MS).status, 'stale');
});

test('refresh policy: first fetch, 5-minute expiry, 25 km move, and the minimum gap', () => {
  const base = {
    nowMs: 1_000_000, fetchedAt: 900_000, lastAttemptAt: 900_000, anchor: PARIS, point: PARIS, hasWeather: true,
  };
  assert.equal(mapWeatherRefreshDue({ ...base, hasWeather: false, fetchedAt: 0, lastAttemptAt: 0 }), true);
  assert.equal(mapWeatherRefreshDue(base), false, 'fresh data at the same place needs no fetch');
  assert.equal(mapWeatherRefreshDue({ ...base, nowMs: 900_000 + MAP_WEATHER_REFRESH_MS }), true);
  const near = { latitude: PARIS.latitude + 0.1, longitude: PARIS.longitude };
  const far = { latitude: PARIS.latitude + 0.3, longitude: PARIS.longitude };
  assert.equal(mapWeatherRefreshDue({ ...base, point: near }), false, '~11 km is not a meaningful move');
  assert.equal(mapWeatherRefreshDue({ ...base, point: far }), true, '~33 km refreshes');
  assert.ok(MAP_WEATHER_MOVE_REFRESH_M >= 25_000);
  assert.equal(
    mapWeatherRefreshDue({ ...base, point: far, nowMs: 900_000 + MAP_WEATHER_MIN_FETCH_GAP_MS - 1 }),
    false,
    'a fetch attempt inside the minimum gap is refused even after a big move',
  );
  assert.equal(mapWeatherRefreshDue({ ...base, point: null }), false);
});

test('view centre uses the ground under the canvas centre, then the camera nadir', () => {
  const picked = [];
  const viewer = {
    scene: { canvas: { clientWidth: 1000, clientHeight: 600 }, globe: null },
    camera: {
      pickEllipsoid(point) {
        picked.push([point.x, point.y]);
        return Cesium.Cartesian3.fromDegrees(2.35, 48.85, 0);
      },
      positionCartographic: Cesium.Cartographic.fromDegrees(10, 10, 5000),
    },
  };
  const point = viewCenterPoint(viewer);
  assert.deepEqual(picked, [[500, 300]]);
  assert.ok(Math.abs(point.latitude - 48.85) < 1e-6 && Math.abs(point.longitude - 2.35) < 1e-6);

  viewer.camera.pickEllipsoid = () => undefined;
  const nadir = viewCenterPoint(viewer);
  assert.ok(Math.abs(nadir.latitude - 10) < 1e-6 && Math.abs(nadir.longitude - 10) < 1e-6);

  assert.equal(viewCenterPoint({ camera: {} }), null);
  assert.equal(viewCenterPoint(null), null);
});

function harness({
  open = true, hidden = false, suppressed = false, respond = async () => okResponse(),
} = {}) {
  const h = {
    now: 10_000_000,
    center: PARIS,
    hidden,
    suppressed,
    timers: new Map(),
    nextTimer: 1,
    fetches: [],
    renders: [],
    saved: [],
  };
  h.controller = new MapWeatherCardController({
    getCenter: () => h.center,
    fetchImpl: async (url, init) => {
      h.fetches.push(url);
      return respond(url, init);
    },
    now: () => h.now,
    setTimer: (fn, ms) => {
      const id = h.nextTimer++;
      h.timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => h.timers.delete(id),
    isHidden: () => h.hidden,
    isSuppressed: () => h.suppressed,
    render: (model, view) => h.renders.push({ model, view }),
    loadOpen: () => open,
    saveOpen: (value) => h.saved.push(value),
  });
  h.check = async () => {
    await h.controller.check();
    await settle();
  };
  h.fireTimers = async () => {
    for (const [id, timer] of [...h.timers]) {
      h.timers.delete(id);
      timer.fn();
    }
    await h.controller.pending;
    await settle();
  };
  return h;
}

test('closed by default: camera settles never fetch or arm timers', async () => {
  const h = harness({ open: false });
  h.controller.onCameraSettled();
  h.controller.onVisibilityChange();
  await h.fireTimers();
  assert.equal(h.fetches.length, 0);
  assert.equal(h.timers.size, 0);
});

test('opening fetches /api/weather-effects once for the view centre and renders LIVE', async () => {
  const h = harness({ open: false });
  h.controller.setOpen(true);
  await h.controller.pending;
  await settle();
  assert.deepEqual(h.saved, [true]);
  assert.deepEqual(h.fetches, ['/api/weather-effects?latitude=48.85660&longitude=2.35220']);
  const last = h.renders.at(-1);
  assert.equal(last.view.open, true);
  assert.equal(last.model.status, 'ready');
  assert.equal(last.model.temperature, '22°C');
});

test('a burst of camera-settled events collapses to one debounced check and no extra fetch', async () => {
  const h = harness();
  await h.check();
  assert.equal(h.fetches.length, 1);
  h.timers.clear();

  for (let i = 0; i < 25; i += 1) h.controller.onCameraSettled();
  assert.equal(h.timers.size, 1, 'repeated settles replace the pending debounce timer');
  assert.equal([...h.timers.values()][0].ms, MAP_WEATHER_SETTLE_MS);
  await h.fireTimers();
  assert.equal(h.fetches.length, 1, 'same place, fresh data: the debounced check does not fetch');
});

test('a meaningful move refetches after the settle debounce, not during motion', async () => {
  const h = harness();
  await h.check();
  h.now += MAP_WEATHER_MIN_FETCH_GAP_MS + 1;
  h.center = { latitude: PARIS.latitude + 0.4, longitude: PARIS.longitude };
  h.controller.onCameraSettled();
  assert.equal(h.fetches.length, 1, 'nothing fetches until the debounce fires');
  await h.fireTimers();
  assert.equal(h.fetches.length, 2);
  assert.match(h.fetches[1], /latitude=49\.25660/);
});

test('failure keeps held data as STALE, fails quietly, and retries via one backed-off timer', async () => {
  let fail = false;
  const h = harness({
    respond: async () => {
      if (fail) throw new Error('offline');
      return okResponse();
    },
  });
  await h.check();
  assert.equal(h.renders.at(-1).model.status, 'ready');

  fail = true;
  h.timers.clear();
  h.now += MAP_WEATHER_REFRESH_MS + 1;
  await h.check();
  const model = h.renders.at(-1).model;
  assert.equal(model.status, 'stale');
  assert.equal(model.temperature, '22°C', 'held real data stays; nothing synthetic replaces it');
  assert.equal(h.timers.size, 1, 'exactly one retry timer, not a loop');
  const [retry] = [...h.timers.values()];
  assert.ok(retry.ms > 0 && retry.ms <= MAP_WEATHER_REFRESH_MS);
});

test('failure with no prior data is UNAVAILABLE and blank', async () => {
  const h = harness({ respond: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await h.check();
  const model = h.renders.at(-1).model;
  assert.equal(model.status, 'unavailable');
  assert.equal(model.temperature, '—');
});

test('a payload without weather is treated as unavailable', async () => {
  const h = harness({ respond: async () => ({ ok: true, json: async () => ({ status: 'ready' }) }) });
  await h.check();
  assert.equal(h.renders.at(-1).model.status, 'unavailable');
});

test('server-stale payloads surface as STALE', async () => {
  const h = harness({ respond: async () => okResponse('stale') });
  await h.check();
  assert.equal(h.renders.at(-1).model.status, 'stale');
});

test('hidden tab and cockpit mode suppress fetching', async () => {
  const hidden = harness({ hidden: true });
  await hidden.check();
  assert.equal(hidden.fetches.length, 0);
  const cockpit = harness({ suppressed: true });
  await cockpit.check();
  assert.equal(cockpit.fetches.length, 0);
});

test('closing cancels the debounce and expiry timers', async () => {
  const h = harness();
  await h.check();
  h.controller.onCameraSettled();
  assert.ok(h.timers.size >= 1);
  h.controller.setOpen(false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.renders.at(-1).view.open, false);
});

test('a steady open card arms one 5-minute expiry timer and never a loop', async () => {
  const h = harness();
  await h.check();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, MAP_WEATHER_REFRESH_MS);
  assert.equal(h.fetches.length, 1, 'no polling beyond the single initial request');
});

test('the module has no per-frame or interval loop and only uses the same-origin route', () => {
  const source = fs.readFileSync(new URL('./mapWeatherCard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /requestAnimationFrame|setInterval|useDefaultRenderLoop|requestRender|holdContinuousRender/);
  assert.match(source, /\/api\/weather-effects\?/);
  assert.doesNotMatch(source, /api\.open-meteo\.com/);
});

test('markup: opt-in button, hidden card, Open-Meteo credit, cockpit isolation', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(html, /<aside id="map-weather-card"[^>]*\shidden>/);
  assert.match(html, /id="map-weather-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="map-weather-card"[\s\S]*?href="https:\/\/open-meteo\.com\/"[\s\S]*?Weather data by Open-Meteo\.com/);
  assert.match(css, /body:is\(\.cockpit-mode[^)]*\) :is\(#map-weather-card, #map-weather-toggle\)/);
  assert.match(main, /initMapWeatherCard\(viewer\)/);
  const cockpit = fs.readFileSync(new URL('./cockpitCloudEffects.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cockpit, /mapWeather/);
});
