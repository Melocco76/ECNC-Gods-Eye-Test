/**
 * NASA FIRMS source list and per-source ingestion safety limits — the single
 * place to change either (consumed by the /api/firms proxy in vite.config.js).
 *
 * SNPP RETIREMENT: NASA has announced that Suomi-NPP data delivery ends on
 * 2026-11-01 and recommends NOAA-20 and NOAA-21. Before that date, remove
 * 'VIIRS_SNPP_NRT' from FIRMS_SOURCES and update the docs that name "VIIRS ×3"
 * (DATA_SOURCES.md, docs/CURRENT-STATE.md, the comment in localLayers.js and
 * the proxy header in vite.config.js). Until then a dead SNPP feed already
 * degrades safely: that one source is marked ok:false and the others still
 * serve. Sources are merged WITHOUT cross-source dedup, so dropping SNPP only
 * lowers `count` (roughly a third fewer detections and one fewer overpass
 * time); the client reads `fires`, `stale` and `fetchedAt`, never `sources`.
 */
export const FIRMS_SOURCES = Object.freeze([
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
]);

/**
 * Per-source ceilings. NASA documents 30,000–100,000+ VIIRS detections per
 * world-day per dataset and the proxy pulls two UTC days, so a heavy-season
 * source is on the order of 200,000 raw rows (~25 MB of CSV at ~110–130 B/row).
 *  - maxRows    400,000  raw CSV rows read — ~2x the documented worst case
 *  - maxBytes   64 MiB   streamed bytes — covers maxRows with header/whitespace slack
 *  - maxRecords 150,000  detections kept after the trailing-24 h filter —
 *                        ~1.5x the documented single-day maximum; bounds what
 *                        is retained/serialized (~30 MB of JSON per source)
 *  - timeoutMs  60,000   whole-request timeout (headers + streamed body)
 * Exceeding any limit fails only that source.
 */
export const FIRMS_SOURCE_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxRows: 400_000,
  maxRecords: 150_000,
  timeoutMs: 60_000,
});
