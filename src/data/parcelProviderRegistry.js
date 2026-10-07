/**
 * @module parcelProviderRegistry
 * @description Property Intelligence Phase A1 — the ONLY place a parcel
 * provider's upstream host/service names live. A `region` key from a request
 * is looked up here and here alone; there is no code path anywhere in the
 * parcel feature where a request parameter becomes part of an upstream
 * hostname or path. An unknown region resolves to `null` and the caller must
 * reject it (400), never guess or fall back to a user-suppliable URL.
 *
 * Every value below is a compiled-in constant discovered and verified live
 * (Deschutes County for Phase A1; NC OneMap and Virginia statewide parcels
 * added in A2.4). Nothing here is configurable via env var or request
 * input — a provider pack is added by editing this file, not by widening
 * what a client can specify. Each entry names its own provider
 * implementation via a `factory` function reference (see
 * `resolveParcelProvider`) — adding a region never adds a branch anywhere
 * in this module or in the routes that call it.
 */

import { createOregonDeschutesProvider } from './parcelProviders/oregonDeschutes.js';
import { createNorthCarolinaOneMapProvider } from './parcelProviders/northCarolinaOneMap.js';
import { createVirginiaStatewideProvider } from './parcelProviders/virginiaStatewide.js';

/** Deschutes County, Oregon coverage bbox — padded from the service's own
 *  published extent ([-122.00124, 43.61111] to [-119.89659, 44.39349]).
 *  Used only as a coarse "is this point plausibly in this county" gate
 *  before any upstream request is built — not a precise boundary. */
const OR_DESCHUTES_COVERAGE_BBOX = Object.freeze({ west: -122.05, south: 43.55, east: -119.85, north: 44.45 });

/** Deschutes taxlot ids look like "1408000000200" or "181209AC00700" — up to
 *  13 upper-case letters/digits (the field is declared `String(13)` upstream). */
const OR_DESCHUTES_PARCEL_ID_PATTERN = /^[A-Z0-9]{1,13}$/;

const OR_DESCHUTES_FEATURE_SERVER = 'https://services1.arcgis.com/znO8Hz1SuVVohYhZ/arcgis/rest/services/Taxlots/FeatureServer';

/**
 * NC OneMap statewide parcels (NC Integrated Cadastral Data Exchange).
 * Confirmed live during Property Intelligence A2.4 planning research against
 * `https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1?f=json`:
 * layer id 1, name "Parcels (polys)", geometry type polygon, aggregating all
 * 100 NC counties plus Eastern Band of Cherokee Indians lands.
 */
const NC_ONEMAP_FEATURE_SERVER = 'https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/FeatureServer';

/** North Carolina statewide coverage bbox — padded beyond the state's actual
 *  bounds (~33.75–36.59°N, ~-84.32– -75.40°W). Coarse point-gate only. */
const NC_COVERAGE_BBOX = Object.freeze({ west: -84.4, south: 33.7, east: -75.3, north: 36.7 });

/**
 * Parcel identity for NC OneMap: `parno`/`altparno` are free-text per-county
 * fields with no single consistent format statewide (confirmed live —
 * county data producers each supply their own source format), so the
 * pattern is deliberately permissive rather than digits-only. The
 * `nc-oid-<objectid>` synthetic form (`northCarolinaOneMap.js`'s fallback
 * for a county record with neither `parno` nor `altparno`) is namespaced so
 * it can never collide with a real parcel number OR with another provider's
 * own OBJECTID-based fallback.
 */
const NC_PARCEL_ID_PATTERN = /^(?:nc-oid-\d+|[A-Za-z0-9][A-Za-z0-9/.\-]{0,39})$/;

/**
 * Virginia statewide parcels. The canonical steward is the Virginia
 * Geographic Information Network (VGIN); its own hosted copy
 * (`vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0`,
 * layer name "Virginia Parcels") was confirmed live during A2.4 research —
 * metadata loads, but every `/query` call against it timed out from this
 * environment (confirmed repeatedly; a network/egress quirk of that host,
 * not a code issue). The Virginia Dept. of Wildlife Resources hosts a
 * fully query-reachable mirror of the same statewide parcel layer
 * (`VA_Parcels`, layer id 0) with richer, still owner-free-when-unrequested
 * fields; that is the endpoint actually used below so this provider works
 * end to end in this environment. See the A2.4 report for the live
 * verification detail.
 */
const VA_FEATURE_SERVER = 'https://services.dwr.virginia.gov/arcgis/rest/services/Projects/VA_Parcels/FeatureServer';

/** Virginia statewide coverage bbox — padded beyond the state's actual
 *  bounds (~36.54–39.47°N, ~-83.68– -75.16°W). Coarse point-gate only. */
const VA_COVERAGE_BBOX = Object.freeze({ west: -83.75, south: 36.5, east: -75.1, north: 39.5 });

/** Same reasoning as `NC_PARCEL_ID_PATTERN` — `PARCELID` format varies by
 *  locality; the `va-oid-<objectid>` synthetic fallback is namespaced. */
const VA_PARCEL_ID_PATTERN = /^(?:va-oid-\d+|[A-Za-z0-9][A-Za-z0-9/.\-]{0,39})$/;

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
      // RMV_Land/RMV_Impr confirmed live on this table during Phase A planning
      // research (same response that supplied RMV_Total/AV_Total) — not
      // mapped into the normalized output until A3's Property Details panel
      // needed a distinct land/improvement value breakdown.
      rollValues: Object.freeze({ id: 7, joinField: 'Taxlot', assessedField: 'AV_Total', marketField: 'RMV_Total', landField: 'RMV_Land', improvementsField: 'RMV_Impr' }),
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
    // Selects the provider implementation for this entry — see
    // `resolveParcelProvider` below. A compiled-in function reference, never
    // a request-controlled module path.
    factory: createOregonDeschutesProvider,
  }),

  'nc-statewide': Object.freeze({
    region: 'nc-statewide',
    providerId: 'north-carolina-onemap',
    state: 'NC',
    county: null, // statewide aggregate — individual county is per-record (`cntyname`), not per-provider
    sourceAgency: 'NC OneMap (NC Integrated Cadastral Data Exchange)',
    featureServerUrl: NC_ONEMAP_FEATURE_SERVER,
    coverageBbox: NC_COVERAGE_BBOX,
    parcelIdPattern: NC_PARCEL_ID_PATTERN,
    // One flat parcel layer — no related-table joins like Deschutes; every
    // field NC OneMap publishes lives on this same layer. Field names
    // confirmed live against the layer's own `fields` metadata. Owner
    // fields (`ownname`, `ownname2`, `ownfrst`, `ownlast`, `mailadd`,
    // `munit`, `mcity`, `mstate`, `mzip`) exist upstream but are
    // DELIBERATELY not mapped anywhere in this config — see
    // `northCarolinaOneMap.js` and its privacy tests.
    layers: Object.freeze({
      parcels: Object.freeze({
        id: 1,
        idField: 'parno',
        altIdField: 'altparno',
        objectIdField: 'objectid',
        countyField: 'cntyname',
        addressField: 'siteadd',
        cityField: 'scity',
        stateField: 'sstate',
        zipField: 'szip',
        acreageField: 'gisacres',
        improvedValueField: 'improvval',
        landValueField: 'landval',
        marketValueField: 'parval',
        landUseField: 'parusedesc',
        shapeAreaField: 'Shape__Area',
      }),
    }),
    capabilities: Object.freeze({
      search: true, identify: true, geometry: true, values: true, improvements: false, zoning: false, owner: false,
      taxable: false, landUse: true, effectiveDate: false,
    }),
    search: Object.freeze({ minLength: 3, maxLength: 80, resultCap: 15 }),
    factory: createNorthCarolinaOneMapProvider,
  }),

  'va-statewide': Object.freeze({
    region: 'va-statewide',
    providerId: 'virginia-statewide',
    state: 'VA',
    county: null, // statewide aggregate — individual locality is per-record (`LOCALITY`), not per-provider
    sourceAgency: 'Virginia Geographic Information Network (VGIN)',
    featureServerUrl: VA_FEATURE_SERVER,
    coverageBbox: VA_COVERAGE_BBOX,
    parcelIdPattern: VA_PARCEL_ID_PATTERN,
    // One flat parcel layer. Owner fields (`Owner1`, `Owner2`) and mailing
    // fields (`M_Address`, `M_City`, `M_State`, `M_Zip`) exist upstream but
    // are DELIBERATELY not mapped anywhere in this config — see
    // `virginiaStatewide.js` and its privacy tests.
    layers: Object.freeze({
      parcels: Object.freeze({
        id: 0,
        idField: 'PARCELID',
        objectIdField: 'OBJECTID',
        localityField: 'LOCALITY',
        addressField: 'Address',
        cityField: 'City',
        stateField: 'State',
        zipField: 'Zip',
        gpinField: 'GPIN',
        pinField: 'PIN',
        mapNumberField: 'MapNumber',
        shapeAreaField: 'Shape__Area',
      }),
    }),
    // No value/improvement fields exist in this statewide dataset (identity,
    // address, and locality only) — unlike Deschutes/NC, there is no
    // assessed/market value or improvement data to request or expose.
    capabilities: Object.freeze({
      search: true, identify: true, geometry: true, values: false, improvements: false, zoning: false, owner: false,
      taxable: false, landUse: false, effectiveDate: false,
    }),
    search: Object.freeze({ minLength: 3, maxLength: 80, resultCap: 15 }),
    factory: createVirginiaStatewideProvider,
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
  if (!config || typeof config.factory !== 'function') return null;
  // Every registry entry names its own provider implementation via a
  // compiled-in `factory` function reference — adding a provider pack is
  // exactly one new registry entry, never a new branch here and never a
  // request-controlled module path.
  return config.factory({ config, ...deps });
}
