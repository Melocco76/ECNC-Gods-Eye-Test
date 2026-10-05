/**
 * @module arcgisParcelQuery
 * @description Property Intelligence Phase A1 — pure ArcGIS REST `/query` URL
 * construction. No fetching, no provider-specific field knowledge; this module
 * only knows the generic ArcGIS Feature/Map Service query contract and always
 * requests WGS84 output (`outSR=4326`) so callers never reproject client-side.
 *
 * Every `where` clause is built from EITHER a compiled-in field name (never
 * user input) and a value that has already passed through
 * `escapeArcgisTextLiteral`/a strict-format validator in
 * `parcelProviderData.js` — this module does not itself decide what is safe to
 * embed, it only assembles already-safe pieces. Nothing here reads a hostname
 * from a request; every base URL is passed in by the caller from the fixed
 * provider registry.
 */

/**
 * Build one ArcGIS `/query` URL. `f` and `outSR` are always set; any
 * `undefined`/`null` param is omitted rather than sent as the literal string
 * "undefined".
 * @param {string} layerBaseUrl - e.g. `${FeatureServer}/0` (already fixed/trusted)
 * @param {Record<string, string|number|boolean|undefined|null>} params
 * @returns {string}
 */
export function buildQueryUrl(layerBaseUrl, params) {
  const url = new URL(`${layerBaseUrl}/query`);
  const merged = { f: 'json', outSR: '4326', ...params };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Point-identify: "which feature(s) intersect this WGS84 point".
 * @param {string} layerBaseUrl
 * @param {number} lat - already validated by the caller
 * @param {number} lon - already validated by the caller
 * @param {{outFields?: string, resultRecordCount?: number, returnGeometry?: boolean, returnCentroid?: boolean}} [opts]
 * @returns {string}
 */
export function buildPointIdentifyUrl(layerBaseUrl, lat, lon, opts = {}) {
  const { outFields = '*', resultRecordCount = 1, returnGeometry = true, returnCentroid = false } = opts;
  return buildQueryUrl(layerBaseUrl, {
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry,
    returnCentroid,
    resultRecordCount,
  });
}

/**
 * Envelope ("viewport") spatial query: "which features intersect this WGS84
 * bounding box". Property Intelligence A2.1 — the viewport counterpart to
 * `buildPointIdentifyUrl` above, same conventions (fixed `outSR=4326`,
 * `spatialRel=esriSpatialRelIntersects`).
 *
 * Returns `null` for a malformed bbox (non-finite, out of WGS84 range, or
 * inverted) rather than emitting a URL with garbage coordinates — this is a
 * basic shape sanity check only. The caller (the route) still owns its own
 * business-rule viewport-SIZE cap and `resultRecordCount` cap; this function
 * does not decide how large a viewport is reasonable, only whether the four
 * numbers describe a valid box at all.
 *
 * @param {string} layerBaseUrl
 * @param {{south:number, west:number, north:number, east:number}} bbox - WGS84 degrees
 * @param {{outFields?: string, resultRecordCount?: number, returnGeometry?: boolean}} [opts]
 * @returns {string|null}
 */
export function buildEnvelopeQueryUrl(layerBaseUrl, bbox, opts = {}) {
  const { south, west, north, east } = bbox || {};
  if (![south, west, north, east].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  if (south < -90 || south > 90 || north < -90 || north > 90 || south >= north) return null;
  if (west < -180 || west > 180 || east < -180 || east > 180 || west >= east) return null;

  const { outFields = '*', resultRecordCount, returnGeometry = true } = opts;
  return buildQueryUrl(layerBaseUrl, {
    geometry: `${west},${south},${east},${north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry,
    resultRecordCount,
  });
}

/**
 * Attribute (`where`-clause) query. `whereClause` must already be built from
 * a fixed field name plus an escaped/validated literal — see
 * `buildExactMatchWhere` / `buildContainsAnyWhere` below.
 * @param {string} layerBaseUrl
 * @param {string} whereClause
 * @param {{outFields?: string, resultRecordCount?: number, returnGeometry?: boolean, returnCentroid?: boolean, orderByFields?: string}} [opts]
 * @returns {string}
 */
export function buildWhereQueryUrl(layerBaseUrl, whereClause, opts = {}) {
  const { outFields = '*', resultRecordCount, returnGeometry = false, returnCentroid = false, orderByFields } = opts;
  return buildQueryUrl(layerBaseUrl, {
    where: whereClause,
    outFields,
    returnGeometry,
    returnCentroid,
    resultRecordCount,
    orderByFields,
  });
}

/**
 * `<field> = '<value>'` — for exact-match lookups (parcel/taxlot id joins).
 * `field` is always a compiled-in constant from the provider registry, never
 * request input. `value` must already be validated (e.g.
 * `isValidParcelId`); the quote is still escaped here unconditionally as a
 * second, unconditional layer.
 * @param {string} field
 * @param {string} value
 * @returns {string}
 */
export function buildExactMatchWhere(field, value) {
  return `${field} = '${String(value).replace(/'/g, "''")}'`;
}

/**
 * `(UPPER(<field>) LIKE UPPER('%<value>%')) OR ...` across one or more fixed
 * fields, for free-text address search. `value` must already be
 * validated/escaped (`validateAddressQuery` + `escapeArcgisTextLiteral`) —
 * this function does not re-derive safety, it only assembles the clause.
 * @param {string[]} fields - compiled-in constants, never request input
 * @param {string} escapedValue - already escaped via `escapeArcgisTextLiteral`
 * @returns {string}
 */
export function buildContainsAnyWhere(fields, escapedValue) {
  return fields.map((field) => `(UPPER(${field}) LIKE UPPER('%${escapedValue}%'))`).join(' OR ');
}
