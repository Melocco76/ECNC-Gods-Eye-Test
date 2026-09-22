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
