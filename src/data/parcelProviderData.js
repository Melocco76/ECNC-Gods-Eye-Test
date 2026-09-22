/**
 * @module parcelProviderData
 * @description Property Intelligence Phase A1 — pure, provider-agnostic pieces:
 * the normalized parcel shape, input validators, ArcGIS-safe text escaping, and
 * esri-geometry -> GeoJSON conversion. Nothing here talks to a network.
 *
 * Design intent carried from the Phase A planning report:
 *  - a field the provider does not supply is `null`, never fabricated or guessed;
 *  - `retrievedAt` is OUR fetch time; `effectiveDate` stays `null` unless a
 *    provider genuinely supplies a per-record update/effective date;
 *  - `acreage` is reported with an explicit `acreageSource` ('assessor' |
 *    'computed' | null) so a geometry-derived estimate is never mistaken for an
 *    assessor-supplied figure;
 *  - owner name may be normalized here (it is a plain data field, like any
 *    other), but nothing in this module makes owner data searchable — there is
 *    no owner-indexed lookup anywhere in this file.
 */

const SQ_M_PER_ACRE = 4046.8564224;

const text = (value) => {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return cleaned || null;
};

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Non-negative integer (bedrooms/bathrooms/sqft are never negative). */
const nonNegNum = (value) => {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
};

/** Assessor "Year_Built"/"Year_Appr" fields are returned as strings (sometimes blank/"0"). */
const yearText = (value) => {
  const t = text(typeof value === 'number' ? String(value) : value);
  if (!t) return null;
  const year = Number(t);
  return Number.isInteger(year) && year > 1500 && year < 2200 ? year : null;
};

// -- validators -------------------------------------------------------------------------------------

export function isValidLatitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Coarse "is this plausibly inside the provider's coverage" check — rejects nonsense before it reaches upstream. */
export function isWithinCoverageBbox(lat, lon, bbox) {
  if (!isValidLatitude(lat) || !isValidLongitude(lon) || !bbox) return false;
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

/**
 * Strict parcel-id format check against a provider-supplied pattern. The
 * caller (a provider module) owns the actual RegExp; this just applies it
 * uniformly and rejects non-strings up front.
 */
export function isValidParcelId(value, pattern) {
  return typeof value === 'string' && value.length > 0 && pattern instanceof RegExp && pattern.test(value);
}

/** Characters an address/text search may contain. No SQL/LIKE metacharacters (`%`, `_`, `'`… ) reach this far. */
const ADDRESS_QUERY_PATTERN = /^[A-Za-z0-9#.,\- ]+$/;
const HAS_ALPHANUMERIC = /[A-Za-z0-9]/;

/**
 * Validate a free-text address search query.
 * @param {unknown} raw
 * @param {{minLength: number, maxLength: number}} bounds
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateAddressQuery(raw, { minLength, maxLength }) {
  const value = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (value.length < minLength) return { ok: false, error: `Search text must be at least ${minLength} characters.` };
  if (value.length > maxLength) return { ok: false, error: `Search text must be at most ${maxLength} characters.` };
  if (!ADDRESS_QUERY_PATTERN.test(value)) return { ok: false, error: 'Search text contains unsupported characters.' };
  if (!HAS_ALPHANUMERIC.test(value)) return { ok: false, error: 'Search text must contain a letter or digit.' };
  return { ok: true, value };
}

/**
 * Escape a value that will be embedded as a single-quoted SQL string LITERAL
 * in an ArcGIS `where` clause (never as a field/table name — those are always
 * compiled-in constants, never user input). Doubling the quote is the
 * standard SQL-literal escape; `validateAddressQuery`'s character allowlist
 * already excludes `%`/`_`, so LIKE-wildcard injection cannot reach this
 * function's caller in the first place, but the quote-escape here is kept
 * unconditionally as the single reviewed path — never bypassed, never
 * duplicated ad hoc elsewhere.
 * @param {string} value already-validated text
 * @returns {string}
 */
export function escapeArcgisTextLiteral(value) {
  return String(value).replace(/'/g, "''");
}

// -- geometry -----------------------------------------------------------------------------------------

function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/**
 * Convert an Esri JSON polygon (`{rings: [[ [x,y], ... ], ...]}`) to a GeoJSON
 * `Polygon`/`MultiPolygon` geometry. Esri rings are unordered relative to each
 * other but each ring's own winding tells exterior from hole: a ring whose
 * signed area is negative (clockwise) starts a new polygon; a positive
 * (counter-clockwise) ring is a hole in the most recently started polygon.
 * The very first ring always starts a polygon regardless of its own winding
 * (a malformed/degenerate single-ring feature should not vanish).
 * @param {{rings?: Array<Array<[number, number]>>}|null|undefined} esriGeometry
 * @returns {{type: 'Polygon'|'MultiPolygon', coordinates: Array}|null}
 */
export function esriPolygonToGeoJsonGeometry(esriGeometry) {
  const rings = esriGeometry?.rings;
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const polygons = [];
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) continue; // a closed ring needs >= 4 points
    const isHole = polygons.length > 0 && ringSignedArea(ring) > 0;
    if (isHole) polygons[polygons.length - 1].push(ring);
    else polygons.push([ring]);
  }
  if (polygons.length === 0) return null;
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

// -- normalization --------------------------------------------------------------------------------------

/**
 * Assemble the normalized parcel shape from already-extracted, plain values.
 * Every field a provider does not supply is `null` (or, for the nested
 * objects, an object whose leaves are `null`) — nothing here invents a value.
 * @param {object} input
 * @returns {object} the normalized parcel record
 */
export function buildNormalizedParcel({
  providerId, sourceAgency, sourceUrl, retrievedAt, effectiveDate = null,
  parcelId, taxLot, accountId = null,
  addressFull, city, state, zip,
  acreageAssessor, shapeAreaSqM,
  ownerName,
  assessedValue, taxableValue = null, marketValue,
  landUse = null, zoning,
  yearBuilt, buildingArea, garageArea, bedrooms, bathrooms,
  geometry = null,
  officialLinks = [],
}) {
  const assessorAcreage = num(acreageAssessor);
  const computedAcreage = assessorAcreage === null && num(shapeAreaSqM) !== null
    ? Number((shapeAreaSqM / SQ_M_PER_ACRE).toFixed(3))
    : null;

  return {
    providerId: text(providerId),
    sourceAgency: text(sourceAgency),
    sourceUrl: text(sourceUrl),
    retrievedAt: text(retrievedAt),
    effectiveDate: text(effectiveDate), // stays null unless a provider genuinely supplies one

    parcelId: text(parcelId),
    taxLot: text(taxLot),
    accountId: text(accountId),

    address: {
      full: text(addressFull),
      city: text(city),
      state: text(state),
      zip: text(zip),
    },

    acreage: assessorAcreage ?? computedAcreage,
    acreageSource: assessorAcreage !== null ? 'assessor' : (computedAcreage !== null ? 'computed' : null),

    owner: {
      name: text(ownerName), // present in the model; NOT exposed to any UI in Phase A1
    },

    values: {
      assessed: num(assessedValue),
      taxable: num(taxableValue),
      market: num(marketValue),
    },

    landUse: text(landUse),
    zoning: text(zoning),

    improvements: {
      yearBuilt: yearText(yearBuilt),
      buildingArea: nonNegNum(buildingArea),
      garageArea: nonNegNum(garageArea),
      bedrooms: nonNegNum(bedrooms),
      bathrooms: nonNegNum(bathrooms),
    },

    geometry: geometry || null,

    officialLinks: Array.isArray(officialLinks) ? officialLinks.filter((l) => l && text(l.url)) : [],
  };
}

/**
 * Client-safe view of a normalized parcel for every public-facing response.
 * Phase A1 has no owner UI and no owner search, so `owner` (and any future
 * person-specific field added to this list) is removed entirely — not merely
 * nulled — before a parcel ever reaches the browser. Internal callers (the
 * server-side cache, and any future phase that needs it) keep using the full
 * record from `buildNormalizedParcel` directly; this function is applied
 * only at the response boundary, never earlier.
 * @param {object|null} parcel a full normalized parcel, or null/falsy
 * @returns {object|null} the same shape with person-specific fields removed
 */
const PUBLIC_PARCEL_OMIT_FIELDS = ['owner'];

export function toPublicParcel(parcel) {
  if (!parcel || typeof parcel !== 'object') return parcel;
  const publicParcel = { ...parcel };
  for (const field of PUBLIC_PARCEL_OMIT_FIELDS) delete publicParcel[field];
  return publicParcel;
}

/** Compact address-search result row — never the full parcel object. */
export function buildSearchResult({ parcelId, address, city, state, zip }) {
  return {
    parcelId: text(parcelId),
    address: text(address),
    city: text(city),
    state: text(state),
    zip: text(zip),
  };
}
