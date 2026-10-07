/**
 * @module parcelProviders/tennesseeStatewide
 * @description Property Intelligence — the Tennessee statewide parcel
 * provider (Tennessee Comptroller of the Treasury, Division of Property
 * Assessments / Geographic Services — "GeoViewer" public parcel services).
 * Same one-flat-layer architecture as `northCarolinaOneMap.js`/
 * `virginiaStatewide.js` (no related-table joins).
 *
 * ENDPOINT SELECTION (confirmed live during research for this phase): three
 * candidate services were inspected —
 *  - `GeoViewer_Parcels_R/MapServer/0` ("Statewide_Parcels") — rich fields,
 *    higher `maxRecordCount` (1000), but a live `returnDistinctValues` query
 *    on `COUNTY` showed data for only ~20 counties.
 *  - `GeoViewer_Parcels/MapServer/0` ("Statewide_Parcels", THIS module's
 *    choice) — the SAME rich field schema, `maxRecordCount` 200, and a live
 *    distinct-county query showed 86 of Tennessee's 95 counties present —
 *    by far the broadest real coverage of the three, despite the "_R"
 *    variant's naming suggesting it was the richer/primary one.
 *  - `IMPACT/Parcels` (FeatureServer, a different host) — geometry +
 *    minimal identity only (no address/value/improvement fields at all),
 *    and its own `/query` endpoint timed out repeatedly in live testing,
 *    including for a county this module's chosen service answers quickly.
 * Coverage breadth and reliability are what "statewide" promises to a
 * user, so `GeoViewer_Parcels` was chosen over the nominally-richer "_R"
 * service. See `TN_KNOWN_MISSING_COUNTIES` below for the real, confirmed
 * gap: Tennessee's largest metro counties (and a few others) maintain
 * their own independent GIS/CAMA systems outside this statewide service.
 *
 * Network access is dependency-injected (`fetchImpl`/`readCapped`), same
 * convention as every other provider; this module is unit-testable with a
 * fake fetch and never reaches the network in a test run.
 *
 * PRIVACY: the upstream layer publishes owner/mailing fields (`OWNER`,
 * `OWNER2`, `OWNJAN1`, `OWNJAN1_2`, `MAILADDR`, `MAILCITY`, `MAILLINE1-3`,
 * `UNLISTOWN`, `UNLISTJAN1`). None of them are named in
 * `parcelProviderRegistry.js`'s `layers` config for this provider, and
 * `outFields` below is always built from that config's field list — so
 * there is no code path in this module that can request an owner/mailing
 * field from the upstream service, let alone expose one. The schema's own
 * `STATE`/`ZIP` fields sit directly inside that same mailing block
 * (`MAILADDR, MAILCITY, STATE, ZIP`) with no distinct "site state/zip"
 * fields available, so — rather than risk reading an owner-mailing field
 * under an innocuous-looking name — this provider never reads `STATE` or
 * `ZIP` at all; `state` is set to the fixed literal `'TN'` (this provider
 * only ever covers Tennessee) and `zip` stays null.
 */
import {
  buildContainsAnyWhere,
  buildEnvelopeQueryUrl,
  buildExactMatchWhere,
  buildPointIdentifyUrl,
  buildWhereQueryUrl,
} from '../arcgisParcelQuery.js';
import {
  buildNormalizedParcel,
  buildSearchResult,
  escapeArcgisTextLiteral,
  esriPolygonToGeoJsonGeometry,
  isValidParcelId,
  isWithinCoverageBbox,
  validateAddressQuery,
} from '../parcelProviderData.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RESPONSE_CAP_BYTES = 512 * 1024;

/**
 * Confirmed live (via a `returnDistinctValues` query against `COUNTY`) to
 * be ABSENT from `GeoViewer_Parcels` — each maintains its own independent
 * parcel/GIS system outside the Comptroller's statewide aggregation.
 * Exported only for test/documentation use; never used to special-case a
 * request — `coverageBbox` stays a single coarse rectangle like every
 * other provider, and a query over one of these counties simply returns no
 * parcels (or times out upstream, caught the same as any other upstream
 * failure) rather than being rejected differently.
 */
export const TN_KNOWN_MISSING_COUNTIES = Object.freeze([
  'CHESTER', 'DAVIDSON', 'HAMILTON', 'HICKMAN', 'KNOX',
  'MONTGOMERY', 'RUTHERFORD', 'SHELBY', 'WILLIAMSON',
]);

function layerUrl(config) {
  return `${config.featureServerUrl}/${config.layers.parcels.id}`;
}

/**
 * Normalize Tennessee parcel identity safely. Field quality confirmed live:
 * `GISLINK` is the stable base identifier; `PARCELID` embeds the tax year
 * (e.g. `"018 113D C 00100 000 2027"`) and so is NOT stable across a
 * parcel's own tax-year history — it is only used as a late fallback.
 * Precedence: `GISLINK` -> `GISLINK2` -> `PARID` -> `PARCELID` ->
 * deterministic `tn-oid-<objectid>` fallback, namespaced so it can never
 * collide with a real parcel id or another provider's own fallback.
 * @param {object} attrs feature attributes
 * @param {object} layer `config.layers.parcels`
 * @returns {string|null}
 */
export function normalizeTnParcelId(attrs, layer) {
  for (const field of [layer.idField, layer.altIdField, layer.secondaryIdField, layer.tertiaryIdField]) {
    const value = typeof attrs?.[field] === 'string' ? attrs[field].trim() : '';
    if (value) return value;
  }
  const oid = attrs?.[layer.objectIdField];
  return Number.isFinite(oid) ? `tn-oid-${oid}` : null;
}

/**
 * @param {object} params
 * @param {object} params.config - the `'tn-statewide'` entry from `PARCEL_PROVIDER_REGISTRY`
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} [params.readCapped]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.responseCapBytes]
 * @param {() => number} [params.now]
 */
export function createTennesseeStatewideProvider({
  config,
  fetchImpl = (...args) => globalThis.fetch(...args),
  readCapped = async (response) => ({ tooLarge: false, text: await response.text() }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseCapBytes = DEFAULT_RESPONSE_CAP_BYTES,
  now = () => Date.now(),
} = {}) {
  const layer = config.layers.parcels;
  // Safe, owner-free field list — the ONLY fields this module ever asks the
  // upstream service for. Never `outFields: '*'` for this provider.
  const DETAIL_OUT_FIELDS = [
    layer.idField, layer.altIdField, layer.secondaryIdField, layer.tertiaryIdField, layer.objectIdField,
    layer.addressField, layer.acreageField, layer.zoningField, layer.landUseField,
    layer.landValueField, layer.improvementValueField, layer.marketValueField,
    layer.yearBuiltField, layer.buildingAreaField,
  ].join(',');

  /**
   * Same `queryFeatures` contract as every other provider EXCEPT it also
   * returns the raw `exceededTransferLimit` flag: this service's server-side
   * `maxRecordCount` (200, confirmed live) sits BELOW `MAX_VIEWPORT_PARCELS`
   * (400), so `features.length > maxResults` can never fire — the server
   * silently truncates at 200 regardless of `resultRecordCount`. This is
   * the adaptation Part 7 asks for, kept entirely inside this provider.
   */
  async function queryFeaturesWithMeta(url) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { features: [], exceededTransferLimit: false };
      const { tooLarge, text } = await readCapped(response, responseCapBytes);
      if (tooLarge) return { features: [], exceededTransferLimit: false };
      const body = JSON.parse(text);
      return {
        features: Array.isArray(body?.features) ? body.features : [],
        exceededTransferLimit: body?.exceededTransferLimit === true,
      };
    } catch {
      return { features: [], exceededTransferLimit: false };
    }
  }
  async function queryFeatures(url) {
    return (await queryFeaturesWithMeta(url)).features;
  }

  function assembleFromFeature(feature) {
    const attrs = feature.attributes || {};
    const parcelId = normalizeTnParcelId(attrs, layer);
    if (!parcelId) return null;

    return buildNormalizedParcel({
      providerId: config.providerId,
      sourceAgency: config.sourceAgency,
      sourceUrl: config.featureServerUrl,
      retrievedAt: new Date(now()).toISOString(),

      parcelId,
      taxLot: parcelId,
      accountId: null,

      addressFull: attrs[layer.addressField],
      city: undefined, // only a numeric CITYNUM code is available — never a human-readable city name
      state: 'TN', // fixed literal — this provider only ever covers Tennessee; see module docstring for why no STATE field is read
      zip: undefined, // the schema's only ZIP field sits inside the mailing-address block — never read, see module docstring

      acreageAssessor: attrs[layer.acreageField],
      shapeAreaSqM: undefined, // source is Web Mercator-projected Shape_Area, not a trustworthy sq-meter figure — never fed to the computed-acreage fallback

      ownerName: undefined, // never requested upstream — see module docstring

      assessedValue: null, // no distinct assessed-value field in this schema
      taxableValue: null,
      marketValue: attrs[layer.marketValueField], // "APPRAISAL" — total appraised value, not necessarily a market sale value
      landValue: attrs[layer.landValueField],
      improvementValue: attrs[layer.improvementValueField],

      landUse: attrs[layer.landUseField],
      zoning: attrs[layer.zoningField],

      yearBuilt: attrs[layer.yearBuiltField],
      buildingArea: attrs[layer.buildingAreaField],
      garageArea: undefined, // no distinct garage-area field in this schema
      bedrooms: undefined, // no bedroom/bathroom fields in this schema
      bathrooms: undefined,

      geometry: esriPolygonToGeoJsonGeometry(feature.geometry),

      officialLinks: [],
    });
  }

  return {
    async identifyParcel(lat, lon) {
      if (!isWithinCoverageBbox(lat, lon, config.coverageBbox)) return null;
      const url = buildPointIdentifyUrl(layerUrl(config), lat, lon, {
        outFields: DETAIL_OUT_FIELDS, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return assembleFromFeature(features[0]);
    },

    async getParcelById(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const oidMatch = /^tn-oid-(\d+)$/.exec(parcelId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : [layer.idField, layer.altIdField, layer.secondaryIdField, layer.tertiaryIdField]
          .map((field) => `(${buildExactMatchWhere(field, parcelId)})`).join(' OR ');
      const url = buildWhereQueryUrl(layerUrl(config), where, {
        outFields: DETAIL_OUT_FIELDS, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return assembleFromFeature(features[0]);
    },

    async searchAddress(query) {
      const validated = validateAddressQuery(query, config.search);
      if (!validated.ok) return [];
      const escaped = escapeArcgisTextLiteral(validated.value);
      const where = buildContainsAnyWhere([layer.addressField], escaped);
      const url = buildWhereQueryUrl(layerUrl(config), where, {
        outFields: [layer.idField, layer.altIdField, layer.objectIdField, layer.addressField].join(','),
        resultRecordCount: config.search.resultCap,
        returnGeometry: false,
      });
      const features = await queryFeatures(url);
      return features.slice(0, config.search.resultCap).map((feature) => buildSearchResult({
        parcelId: normalizeTnParcelId(feature.attributes || {}, layer),
        address: feature.attributes?.[layer.addressField],
        city: null,
        state: 'TN',
        zip: null,
      }));
    },

    async getParcelGeometry(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const oidMatch = /^tn-oid-(\d+)$/.exec(parcelId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : [layer.idField, layer.altIdField, layer.secondaryIdField, layer.tertiaryIdField]
          .map((field) => `(${buildExactMatchWhere(field, parcelId)})`).join(' OR ');
      const url = buildWhereQueryUrl(layerUrl(config), where, {
        outFields: layer.objectIdField, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return esriPolygonToGeoJsonGeometry(features[0].geometry);
    },

    /**
     * Property Intelligence — parcel outlines for a map viewport, same
     * contract as every other provider's: ONE spatial query, `outFields`
     * limited to identity fields only. `saturated` is derived from the
     * upstream `exceededTransferLimit` flag (see `queryFeaturesWithMeta`'s
     * docstring) rather than a count comparison, since this provider's
     * 200-row server cap sits below `maxResults` (400) and so a plain
     * `features.length > maxResults` check could never fire.
     * @param {{south:number, west:number, north:number, east:number}} bbox - WGS84 degrees
     * @param {{maxResults?: number}} [opts]
     * @returns {Promise<{parcels: Array<{parcelId:string, geometry:object}>, saturated: boolean}>}
     */
    async getParcelsInViewport(bbox, { maxResults = 400 } = {}) {
      const url = buildEnvelopeQueryUrl(layerUrl(config), bbox, {
        outFields: [layer.idField, layer.altIdField, layer.secondaryIdField, layer.tertiaryIdField, layer.objectIdField].join(','),
        resultRecordCount: maxResults + 1,
        returnGeometry: true,
      });
      if (!url) return { parcels: [], saturated: false };
      const { features, exceededTransferLimit } = await queryFeaturesWithMeta(url);
      const saturated = exceededTransferLimit || features.length > maxResults;
      const bounded = features.length > maxResults ? features.slice(0, maxResults) : features;
      const parcels = [];
      for (const feature of bounded) {
        const parcelId = normalizeTnParcelId(feature.attributes || {}, layer);
        const geometry = esriPolygonToGeoJsonGeometry(feature.geometry);
        if (!parcelId || !geometry) continue;
        parcels.push({ parcelId, geometry });
      }
      return { parcels, saturated };
    },

    getMetadata() {
      return {
        providerId: config.providerId,
        region: config.region,
        state: config.state,
        county: config.county,
        sourceAgency: config.sourceAgency,
        sourceUrl: config.featureServerUrl,
        capabilities: { ...config.capabilities },
      };
    },
  };
}
