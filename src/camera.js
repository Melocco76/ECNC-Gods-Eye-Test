import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 * Startup view: see START_VIEW (Winston-Salem, NC).
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Default startup view: Winston-Salem, NC. The end altitude frames the metro
 * area (~50 km across) looking straight down — not street level, not the region.
 */
export const START_VIEW = Object.freeze({
  latitude: 36.0999,
  longitude: -80.2442,
  approachHeightM: 120000,
  heightM: 45000,
  heading: 0,
  pitchDeg: -90,
});

/**
 * Set the camera to the startup view on load with a cinematic fly-in.
 */
export function flyToStartView(viewer) {
  const { latitude, longitude, approachHeightM, heightM, heading, pitchDeg } = START_VIEW;
  const orientation = {
    heading: Cesium.Math.toRadians(heading),
    pitch: Cesium.Math.toRadians(pitchDeg),
    roll: 0.0,
  };
  // Start from a higher altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, approachHeightM),
    orientation,
  });

  // Cinematic fly-in after a brief pause
  setTimeout(() => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, heightM),
      orientation,
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
}
