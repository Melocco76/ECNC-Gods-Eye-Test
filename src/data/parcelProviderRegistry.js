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
import { createTennesseeStatewideProvider } from './parcelProviders/tennesseeStatewide.js';
import { createSouthCarolinaCountyParcelsProvider } from './parcelProviders/southCarolinaCountyParcels.js';

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

/**
 * Tennessee statewide parcels (Tennessee Comptroller of the Treasury,
 * Division of Property Assessments / Geographic Services — "GeoViewer").
 * Confirmed live: `GeoViewer_Parcels/MapServer/0` ("Statewide_Parcels"),
 * `maxRecordCount` 200. See `tennesseeStatewide.js`'s module docstring for
 * why this endpoint was chosen over the nominally-"primary" `_R` variant
 * (narrower real county coverage) and the `IMPACT` FeatureServer (sparse
 * fields, unreliable `/query`).
 */
const TN_GEOVIEWER_FEATURE_SERVER = 'https://geoviewer.cot.tn.gov/arcgis/rest/services/GeoViewer/GeoViewer_Parcels/MapServer';

/** Tennessee statewide coverage bbox — padded beyond the state's actual
 *  bounds (~34.98–36.68°N, ~-90.31– -81.65°W). Coarse point-gate only.
 *  Overlaps NC's and VA's own coverageBbox near their shared borders by
 *  design — the existing multi-candidate coverage disambiguation (see
 *  `vite.config.js`'s `/coverage` route) resolves that, not this bbox. */
const TN_COVERAGE_BBOX = Object.freeze({ west: -90.4, south: 34.9, east: -81.6, north: 36.7 });

/**
 * Parcel identity for TN GeoViewer: `GISLINK` values contain embedded
 * spaces as part of their own format (e.g. `"018113D C 00100"`, confirmed
 * live) — unlike NC/VA's identity fields, so the allowed character set
 * includes a literal space. The `tn-oid-<objectid>` synthetic fallback is
 * namespaced so it can never collide with a real parcel id or another
 * provider's own fallback.
 */
const TN_PARCEL_ID_PATTERN = /^(?:tn-oid-\d+|[A-Za-z0-9][A-Za-z0-9/.\- ]{0,49})$/;

/**
 * South Carolina has no free/public statewide parcel polygon service —
 * SCDOT's `SC_Parcels` MapServer aggregates one layer per county but
 * returns `499 Token Required` on every endpoint (root, layer metadata,
 * `/query`), confirmed live during this phase's research. Coverage is
 * built county-by-county instead; see `southCarolinaCountyParcels.js`'s
 * module docstring for the full discovery/rejection record.
 */

/** SC's own statewide county-BOUNDARY polygon layer (SC Geodetic Survey /
 *  RFA_Administrator) — confirmed live to resolve a point to its county
 *  name (e.g. a York County point returns `"YORK"`, a Horry County point
 *  returns `"HORRY"`). Used by `southCarolinaCountyParcels.js` for Part 4's
 *  real county resolution — never a bbox guess. */
const SC_COUNTY_BOUNDARY_URL = 'https://services7.arcgis.com/jvnMUuMgsYQL9cN6/arcgis/rest/services/SC_County_Boundary/FeatureServer/0';
const SC_COUNTY_BOUNDARY_NAME_FIELD = 'County';

/** Coarse union pre-filter spanning both supported counties (York ~
 *  34.7-35.25°N/-81.4- -80.7°W, Horry ~ 33.3-34.15°N/-79.4- -78.5°W),
 *  padded. Deliberately coarse — the same "is this plausibly within reach"
 *  role every other provider's `coverageBbox` plays. The real per-point and
 *  per-viewport county decisions are made elsewhere (see
 *  `southCarolinaCountyParcels.js`), never by this rectangle. */
const SC_COVERAGE_BBOX = Object.freeze({ west: -81.4, south: 33.3, east: -78.5, north: 35.25 });

/** Every id this provider returns is namespaced `"<COUNTY>:<rawId>"` (see
 *  `southCarolinaCountyParcels.js`) because York's and Horry's own raw id
 *  formats could otherwise collide — this pattern is namespace-aware, not
 *  a plain per-county id format. */
const SC_PARCEL_ID_PATTERN = /^(?:YORK|HORRY):(?:sc-oid-\d+|[A-Za-z0-9][A-Za-z0-9/.\-]{0,39})$/;

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

  'tn-statewide': Object.freeze({
    region: 'tn-statewide',
    providerId: 'tennessee-statewide',
    state: 'TN',
    county: null, // statewide aggregate — individual county is per-record (`COUNTY`), not per-provider
    sourceAgency: 'Tennessee Comptroller of the Treasury — Division of Property Assessments / Geographic Services',
    featureServerUrl: TN_GEOVIEWER_FEATURE_SERVER,
    coverageBbox: TN_COVERAGE_BBOX,
    parcelIdPattern: TN_PARCEL_ID_PATTERN,
    // One flat parcel layer. Owner/mailing fields (`OWNER`, `OWNER2`,
    // `OWNJAN1`, `OWNJAN1_2`, `MAILADDR`, `MAILCITY`, `MAILLINE1-3`,
    // `UNLISTOWN`, `UNLISTJAN1`, and the ambiguous `STATE`/`ZIP` fields that
    // sit inside that same mailing block) are DELIBERATELY not mapped
    // anywhere in this config — see `tennesseeStatewide.js` and its privacy
    // tests.
    layers: Object.freeze({
      parcels: Object.freeze({
        id: 0,
        idField: 'GISLINK',
        altIdField: 'GISLINK2',
        secondaryIdField: 'PARID',
        tertiaryIdField: 'PARCELID', // embeds the tax year — least stable, tried last
        objectIdField: 'OBJECTID',
        addressField: 'ADDRESS',
        acreageField: 'CALC_ACRE',
        zoningField: 'ZONING',
        landUseField: 'LANDUSE',
        landValueField: 'LANDVAL',
        improvementValueField: 'IMPVAL',
        marketValueField: 'APPRAISAL', // total appraised value — not necessarily a market sale value
        yearBuiltField: 'YRBLT',
        buildingAreaField: 'SFLA',
        // No shapeAreaField: the real field is literally named `Shape.STArea()`
        // (confirmed live) and this provider never needs a geometry-derived
        // acreage fallback anyway — `CALC_ACRE` is already a reliable,
        // provider-published figure — so it is not requested at all.
      }),
    }),
    capabilities: Object.freeze({
      search: true, identify: true, geometry: true, values: true, improvements: true, zoning: true, owner: false,
      taxable: false, landUse: true, effectiveDate: false,
    }),
    search: Object.freeze({ minLength: 3, maxLength: 80, resultCap: 15 }),
    factory: createTennesseeStatewideProvider,
  }),

  'sc-counties': Object.freeze({
    region: 'sc-counties',
    providerId: 'south-carolina-county-parcels',
    state: 'SC',
    county: null, // multi-county — resolved per-request via the county-boundary service; see docstring above
    sourceAgency: 'South Carolina county GIS departments (per-county; see each county config)',
    countyBoundaryUrl: SC_COUNTY_BOUNDARY_URL,
    countyBoundaryNameField: SC_COUNTY_BOUNDARY_NAME_FIELD,
    coverageBbox: SC_COVERAGE_BBOX,
    parcelIdPattern: SC_PARCEL_ID_PATTERN,
    // Per-county schemas confirmed live this phase — field names verified
    // against each service's own `?f=json` metadata, then a live `/query`
    // with the exact intended outFields list (never guessed). Owner/mailing
    // fields exist upstream for both counties but are DELIBERATELY not
    // mapped anywhere in this config — see `southCarolinaCountyParcels.js`
    // and its privacy tests.
    counties: Object.freeze({
      YORK: Object.freeze({
        sourceAgency: 'York County, SC GIS/Assessor',
        featureServerUrl: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer',
        bbox: Object.freeze({ west: -81.4, south: 34.7, east: -80.7, north: 35.25 }),
        layers: Object.freeze({
          parcels: Object.freeze({
            id: 0,
            idField: 'ParcelID',
            altIdField: 'TAXMAPID',
            objectIdField: 'OBJECTID',
            addressField: 'PropertyAddress',
            acreageField: 'GISSizeAC',
            shapeAreaField: null, // acreage already comes from GISSizeAC — no computed-acreage fallback needed
            landUseField: 'LandUseDesc',
            zoningField: null, // no zoning field in this schema
            landValueField: 'AprLandVal',
            improvementValueField: 'AprBldgVal',
            marketValueField: 'AprTotVal',
            assessedValueField: 'AsdTotVal',
            taxableValueField: 'TaxTotVal',
            yearBuiltField: 'YearBuilt',
            buildingAreaField: 'FinishedSQFT',
          }),
        }),
      }),
      HORRY: Object.freeze({
        sourceAgency: 'Horry County, SC GIS/Assessor',
        featureServerUrl: 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/HorryCountySCParcels/FeatureServer',
        bbox: Object.freeze({ west: -79.4, south: 33.3, east: -78.5, north: 34.15 }),
        layers: Object.freeze({
          parcels: Object.freeze({
            id: 0,
            idField: 'PARNO',
            altIdField: null,
            objectIdField: 'OBJECTID',
            addressField: null, // this schema has no address field at all — confirmed live
            acreageField: null, // no assessor-supplied acreage field — computed from shapeAreaField instead
            shapeAreaField: 'Shape__Area', // State-Plane SQUARE FEET — converted to sq-m before the shared computed-acreage fallback, see provider module
            landUseField: null,
            zoningField: null,
            landValueField: 'LANDVAL',
            improvementValueField: 'IMPROVVAL',
            marketValueField: 'PARVAL',
            assessedValueField: null,
            taxableValueField: null,
            yearBuiltField: null,
            buildingAreaField: null,
          }),
        }),
      }),
    }),
    // Reflects the UNION of what's possible across supported counties — an
    // individual county may still return null for a field its own schema
    // lacks (e.g. Horry has no address/land-use fields); Part 8's "missing
    // data simply omits the row" rule covers that, not a capabilities flag.
    capabilities: Object.freeze({
      search: true, identify: true, geometry: true, values: true, improvements: true, zoning: false, owner: false,
      taxable: true, landUse: true, effectiveDate: false,
    }),
    search: Object.freeze({ minLength: 3, maxLength: 80, resultCap: 15 }),
    factory: createSouthCarolinaCountyParcelsProvider,
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
