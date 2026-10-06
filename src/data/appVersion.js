/**
 * @module appVersion
 * @description The single, centralized ECNC God's Eye application version.
 *
 * `package.json`'s own `version` field is the source of truth — this module
 * never hardcodes a second copy of the number. `vite.config.js` reads
 * `package.json` at build time and injects it as
 * `import.meta.env.GEV_APP_VERSION` (the same `define:` mechanism already
 * used for the Google Maps/Cesium ion keys); this module only reads that one
 * injected value and exposes it as a plain import, so every place that wants
 * to show the version — today's About dialog, and any future Help/About
 * screen — reads the same value instead of hardcoding its own string.
 *
 * This is the ECNC fork's own release number, numbered independently of the
 * upstream God's Eye View project this fork started from (see `FORK.md`).
 */

const FALLBACK_VERSION = '0.0.0';

/** @type {string} e.g. "0.2.0" — from package.json via the Vite define above. */
export const APP_VERSION = (() => {
  const injected = typeof import.meta.env?.GEV_APP_VERSION === 'string' ? import.meta.env.GEV_APP_VERSION.trim() : '';
  return injected || FALLBACK_VERSION;
})();

/** Short, subtle label for in-UI display — e.g. "ECNC God's Eye v0.2.0". */
export const APP_VERSION_LABEL = `ECNC God's Eye v${APP_VERSION}`;
