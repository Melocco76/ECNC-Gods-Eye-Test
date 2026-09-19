// Default startup view (Winston-Salem, NC) and U.S. customary weather display units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { START_VIEW, flyToStartView } from './camera.js';
import {
  celsiusToFahrenheit, formatPrecipInches, formatTemperatureF, formatWindMph,
} from './weatherUnits.js';
import { mapWeatherCardModel } from './mapWeatherCard.js';

test('start view is Winston-Salem at a metro-area altitude', () => {
  assert.equal(START_VIEW.latitude, 36.0999);
  assert.equal(START_VIEW.longitude, -80.2442);
  assert.ok(START_VIEW.heightM >= 20_000 && START_VIEW.heightM <= 100_000, 'metro scale, not street level or regional');
  assert.ok(START_VIEW.approachHeightM > START_VIEW.heightM, 'fly-in descends');
});

test('flyToStartView positions then flies the camera to Winston-Salem', () => {
  const calls = { setView: null, flyTo: null };
  const viewer = { camera: { setView: (o) => { calls.setView = o; }, flyTo: (o) => { calls.flyTo = o; } } };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  try {
    flyToStartView(viewer);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const at = (destination) => {
    const c = Cesium.Cartographic.fromCartesian(destination);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      h: c.height,
    };
  };
  const start = at(calls.setView.destination);
  const end = at(calls.flyTo.destination);
  for (const p of [start, end]) {
    assert.ok(Math.abs(p.lat - 36.0999) < 1e-6);
    assert.ok(Math.abs(p.lon - -80.2442) < 1e-6);
  }
  assert.ok(Math.abs(start.h - START_VIEW.approachHeightM) < 1);
  assert.ok(Math.abs(end.h - START_VIEW.heightM) < 1);
  assert.ok(Math.abs(calls.flyTo.orientation.pitch - Cesium.Math.toRadians(-90)) < 1e-9);
});

test('temperature, wind and precipitation format as U.S. customary', () => {
  assert.equal(celsiusToFahrenheit(0), 32);
  assert.equal(celsiusToFahrenheit(100), 212);
  assert.equal(formatTemperatureF(20.4), '69°F');
  assert.equal(formatTemperatureF(-40), '-40°F');
  assert.equal(formatWindMph(16.09344), '10 mph');
  assert.equal(formatPrecipInches(25.4), '1.00');
  assert.equal(formatPrecipInches(0), '0.00');
});

test('map weather card model uses the shared U.S. customary formatters', () => {
  const model = mapWeatherCardModel({
    status: 'ready',
    fetchedAt: 1_000,
    weather: {
      temperatureC: 20, apparentTemperatureC: 25, windKph: 16.09344, precipitationMm: 2.54, visibilityM: 16093.44, weatherCode: 0,
    },
  }, 2_000);
  assert.equal(model.temperature, '68°F');
  assert.equal(model.feelsLike, '77°F');
  assert.equal(model.wind, '10 mph');
  assert.equal(model.precipitation, '0.10 in');
  assert.equal(model.visibility, '10 mi');
});
