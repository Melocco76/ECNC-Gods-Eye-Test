/**
 * @module parcelProviderRegistry
 * @description Property Intelligence Phase A1 — the ONLY place a parcel
 * provider's upstream host/service names live. A `region` key from a request
 * is looked up here and here alone; there is no code path anywhere in the
 * parcel feature where a request parameter becomes part of an upstream
 * hostname or path. An unknown region resolves to `null` and the caller must
 * reject it (400), never guess or fall back to a user-suppliable URL.
 *
 * Every value below is a compiled-in constant discovered and verified during
 * the Property Intelligence Phase A planning research (live-queried against
 * the actual Deschutes County service). Nothing here is configurable via env
 * var or request input — a provider pack is added by editing this file, not
 * by widening what a client can specify.
 */

import { createOregonDeschutesProvider } from './parcelProviders/oregonDeschutes.js';

/** Deschutes County, Oregon coverage bbox — padded from the service's own
 *  published extent ([-122.00124, 43.61111] to [-119.89659, 44.39349]).
 *  Used only as a coarse "is this point plausibly in this county" gate
 *  before any upstream request is built — not a precise boundary. */
const OR_DESCHUTES_COVERAGE_BBOX = Object.freeze({ west: -122.05, south: 43.55, east: -119.85, north: 44.45 });

/** Deschutes taxlot ids look like "1408000000200" or "181209AC00700" — up to
 *  13 upper-case letters/digits (the field is declared `String(13)` upstream). */
const OR_DESCHUTES_PARCEL_ID_PATTERN = /^[A-Z0-9]{1,13}$/;

const OR_DESCHUTES_FEATURE_SERVER = 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer';

export const PARCEL_PROVIDER_REGISTRY = Object.freeze({
  'or-deschutes': Object.freeze({
    region: 'or-deschutes',
    providerId: 'oregon-deschutes-county',
    state: 'OR',
    county: 'Deschutes',
    sourceAgency: "Deschutes County Assessor's Office",
    featureServerUrl: OR_DESCHUTES_FEATURE_SERVER,
    coverageBbox: OR_DESCHUTES_COVERAGE_BBOX,
    parcelIdPattern: OR_DESCHUTES_PARCEL_ID_PATTERN,
    // Layer/table ids and the exact (case-sensitive) join-field name each
    // related table uses back to the Taxlot's TAXLOT id — confirmed live
    // against the FeatureServer's own `relationships` metadata.
    layers: Object.freeze({
      taxlot: Object.freeze({ id: 0, idField: 'TAXLOT', mapNumberField: 'MAPNUMBER', dialField: 'DIAL', shapeAreaField: 'Shape__Area' }),
      assessorAccount: Object.freeze({ id: 1, joinField: 'TaxLot', addressField: 'Address', streetNameField: 'Street_Name', cityField: 'City', stateField: 'State', zipField: 'Zip' }),
      improvements: Object.freeze({ id: 3, joinField: 'Taxlot', acreageField: 'Land_Size_Acres', yearBuiltField: 'Year_Built_1', buildingAreaField: 'Total_Sqft_1', garageAreaField: 'Garage_Sqft_1', bedroomsField: 'Bedrooms', bathroomsField: 'Bathrooms' }),
      owners: Object.freeze({ id: 5, joinField: 'MAP_TAXLOT', nameField: 'NAME' }),
      rollValues: Object.freeze({ id: 7, joinField: 'Taxlot', assessedField: 'AV_Total', marketField: 'RMV_Total' }),
    }),
    // Separate MapServer layer (not part of the Taxlots FeatureServer's own
    // relationships) — looked up by a point-intersects query against the
    // parcel's centroid. Optional enrichment: its absence never fails a
    // parcel lookup.
    zoning: Object.freeze({ serviceUrl: 'https://maps.deschutes.org/arcgis/rest/services/OpenData/LandFD/MapServer/3', zoneField: 'ZONE' }),
    capabilities: Object.freeze({
      search: true, identify: true, geometry: true, values: true, improvements: true, zoning: true, owner: true,
      taxable: false, landUse: false, effectiveDate: false,
    }),
    search: Object.freeze({ minLength: 3, maxLength: 80, resultCap: 15 }),
  }),
});

/** @returns {object|null} the compiled-in config for `region`, or `null` for anything not registered. */
export function getParcelProviderConfig(region) {
  if (typeof region !== 'string') return null;
  return PARCEL_PROVIDER_REGISTRY[region] || null;
}

/** @returns {boolean} true only for a region key present in the fixed registry. */
export function isKnownParcelRegion(region) {
  return getParcelProviderConfig(region) !== null;
}

export function listParcelRegions() {
  return Object.keys(PARCEL_PROVIDER_REGISTRY);
}

/**
 * Resolve a region key to a ready-to-use provider instance. This is the ONLY
 * function that turns a request-supplied `region` string into something that
 * makes network calls — an unknown region returns `null` and the caller must
 * respond 400, never fall through to a default provider.
 * @param {string} region
 * @param {{fetchImpl?: Function, readCapped?: Function, timeoutMs?: number, now?: () => number}} deps
 * @returns {object|null}
 */
export function resolveParcelProvider(region, deps = {}) {
  const config = getParcelProviderConfig(region);
  if (!config) return null;
  // Phase A1 has exactly one implementation. A second provider pack adds a
  // branch here (or a `factory` field on the registry entry) — never a
  // request-controlled module path.
  if (config.providerId === 'oregon-deschutes-county') return createOregonDeschutesProvider({ config, ...deps });
  return null;
}
