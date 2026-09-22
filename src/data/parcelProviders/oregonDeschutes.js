/**
 * @module parcelProviders/oregonDeschutes
 * @description Property Intelligence Phase A1 — the Deschutes County, Oregon
 * parcel provider. Assembles one normalized parcel (`parcelProviderData.js`)
 * from the county's public Taxlots FeatureServer and its own declared table
 * relationships, plus an optional separate zoning layer.
 *
 * Network access is entirely dependency-injected (`fetchImpl`/`readCapped`),
 * exactly like `createAdsbLolHistoryService` in `adsbLolTrace.js` — this
 * module is unit-testable with a fake fetch and never reaches the network in
 * a test run. Every upstream URL is built from the FIXED config this module
 * receives (from `parcelProviderRegistry.js`); nothing here ever reads a
 * hostname from a request.
 *
 * Owner name IS normalized here (Phase A1 explicitly allows this — it is the
 * same official relationship the county's own DIAL portal already discloses)
 * but nothing in this module makes owner data searchable: there is no
 * owner-indexed lookup, no owner-name parameter, and no code path that lets a
 * caller search FOR an owner rather than look up one already-selected parcel.
 */
import {
  buildContainsAnyWhere,
  buildExactMatchWhere,
  buildPointIdentifyUrl,
  buildQueryUrl,
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

function layerUrl(config, layerKey) {
  const layer = config.layers[layerKey];
  return `${config.featureServerUrl}/${layer.id}`;
}

/**
 * @param {object} params
 * @param {object} params.config - one entry from `PARCEL_PROVIDER_REGISTRY`
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} [params.readCapped]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.responseCapBytes]
 * @param {() => number} [params.now]
 */
export function createOregonDeschutesProvider({
  config,
  fetchImpl = (...args) => globalThis.fetch(...args),
  readCapped = async (response) => ({ tooLarge: false, text: await response.text() }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseCapBytes = DEFAULT_RESPONSE_CAP_BYTES,
  now = () => Date.now(),
} = {}) {
  /**
   * Fetch one ArcGIS query URL, bounded by timeout and response size. Returns
   * the parsed `.features` array, or `[]` on ANY failure (network, timeout,
   * oversize, malformed JSON) — a related-table failure must never throw the
   * whole parcel assembly, only omit that table's fields.
   */
  async function queryFeatures(url) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return [];
      const { tooLarge, text } = await readCapped(response, responseCapBytes);
      if (tooLarge) return [];
      const body = JSON.parse(text);
      return Array.isArray(body?.features) ? body.features : [];
    } catch {
      return [];
    }
  }

  /** Fetch exactly one related row by its join field, or `null`. */
  async function fetchRelatedOne(layerKey, taxLot) {
    const layer = config.layers[layerKey];
    if (!layer) return null;
    const where = buildExactMatchWhere(layer.joinField, taxLot);
    const url = buildWhereQueryUrl(layerUrl(config, layerKey), where, { outFields: '*', resultRecordCount: 1, returnGeometry: false });
    const features = await queryFeatures(url);
    return features[0]?.attributes || null;
  }

  /** Optional zoning enrichment by point-intersect. Never throws; absence is `null`. */
  async function fetchZoning(lat, lon) {
    if (!config.zoning?.serviceUrl || lat == null || lon == null) return null;
    try {
      // NOTE: this legacy ArcGIS Server (10.51) MapServer errors on `resultRecordCount`
      // even at 1 ("Failed to execute query.") — confirmed live. `buildQueryUrl` only
      // omits a param when the key is genuinely absent (an explicit `undefined` value
      // still trips its own default), so this call is built directly rather than
      // through `buildPointIdentifyUrl`'s resultRecordCount-defaulting option. A single
      // point query against a zoning layer returns very few features regardless, and
      // only the first is used.
      const url = buildQueryUrl(config.zoning.serviceUrl, {
        geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', outFields: config.zoning.zoneField, returnGeometry: false,
      });
      const features = await queryFeatures(url);
      const zone = features[0]?.attributes?.[config.zoning.zoneField];
      return typeof zone === 'string' && zone.trim() ? zone.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Given one Taxlot feature (attributes + optional geometry/centroid),
   * fetch its related tables in parallel and assemble the normalized parcel.
   */
  async function assembleFromTaxlotFeature(feature) {
    const taxlotLayer = config.layers.taxlot;
    const attrs = feature.attributes || {};
    const taxLot = attrs[taxlotLayer.idField];
    if (!taxLot) return null;

    const centroid = feature.centroid || null;
    const centroidLat = centroid?.y ?? null;
    const centroidLon = centroid?.x ?? null;

    const [assessor, improvements, owner, rollValues, zoning] = await Promise.all([
      fetchRelatedOne('assessorAccount', taxLot),
      fetchRelatedOne('improvements', taxLot),
      fetchRelatedOne('owners', taxLot),
      fetchRelatedOne('rollValues', taxLot),
      fetchZoning(centroidLat, centroidLon),
    ]);

    const officialLinks = [];
    const dialUrl = attrs[taxlotLayer.dialField];
    if (typeof dialUrl === 'string' && dialUrl.trim()) {
      officialLinks.push({ label: 'Official Deschutes County Property Record (DIAL)', url: dialUrl.trim() });
    }

    const improvementsLayer = config.layers.improvements;
    const rollValuesLayer = config.layers.rollValues;
    const assessorLayer = config.layers.assessorAccount;
    const ownersLayer = config.layers.owners;

    return buildNormalizedParcel({
      providerId: config.providerId,
      sourceAgency: config.sourceAgency,
      sourceUrl: config.featureServerUrl,
      retrievedAt: new Date(now()).toISOString(),

      parcelId: taxLot,
      taxLot,
      accountId: null, // this provider exposes no separate account number distinct from the taxlot id

      addressFull: assessor?.[assessorLayer.addressField],
      city: assessor?.[assessorLayer.cityField],
      state: assessor?.[assessorLayer.stateField],
      zip: assessor?.[assessorLayer.zipField],

      acreageAssessor: improvements?.[improvementsLayer.acreageField],
      shapeAreaSqM: attrs[taxlotLayer.shapeAreaField],

      ownerName: owner?.[ownersLayer.nameField],

      assessedValue: rollValues?.[rollValuesLayer.assessedField],
      taxableValue: null, // not distinguished from assessed value by this provider
      marketValue: rollValues?.[rollValuesLayer.marketField],

      landUse: null, // this provider does not expose land use distinct from zoning
      zoning,

      yearBuilt: improvements?.[improvementsLayer.yearBuiltField],
      buildingArea: improvements?.[improvementsLayer.buildingAreaField],
      garageArea: improvements?.[improvementsLayer.garageAreaField],
      bedrooms: improvements?.[improvementsLayer.bedroomsField],
      bathrooms: improvements?.[improvementsLayer.bathroomsField],

      geometry: esriPolygonToGeoJsonGeometry(feature.geometry),

      officialLinks,
    });
  }

  return {
    /**
     * @param {number} lat @param {number} lon
     * @returns {Promise<object|null>} normalized parcel, or `null` (no coverage / no parcel there)
     */
    async identifyParcel(lat, lon) {
      if (!isWithinCoverageBbox(lat, lon, config.coverageBbox)) return null;
      const url = buildPointIdentifyUrl(layerUrl(config, 'taxlot'), lat, lon, {
        outFields: '*', resultRecordCount: 1, returnGeometry: true, returnCentroid: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return assembleFromTaxlotFeature(features[0]);
    },

    /**
     * @param {string} parcelId
     * @returns {Promise<object|null>}
     */
    async getParcelById(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const where = buildExactMatchWhere(config.layers.taxlot.idField, parcelId);
      const url = buildWhereQueryUrl(layerUrl(config, 'taxlot'), where, {
        outFields: '*', resultRecordCount: 1, returnGeometry: true, returnCentroid: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return assembleFromTaxlotFeature(features[0]);
    },

    /**
     * @param {string} query free-text address fragment
     * @returns {Promise<Array<{parcelId, address, city, state, zip}>>} bounded, compact rows only
     */
    async searchAddress(query) {
      const validated = validateAddressQuery(query, config.search);
      if (!validated.ok) return [];
      const escaped = escapeArcgisTextLiteral(validated.value);
      const assessorLayer = config.layers.assessorAccount;
      const where = buildContainsAnyWhere([assessorLayer.streetNameField, assessorLayer.addressField], escaped);
      const url = buildWhereQueryUrl(layerUrl(config, 'assessorAccount'), where, {
        outFields: [assessorLayer.joinField, assessorLayer.addressField, assessorLayer.cityField, assessorLayer.stateField, assessorLayer.zipField].join(','),
        resultRecordCount: config.search.resultCap,
        returnGeometry: false,
      });
      const features = await queryFeatures(url);
      return features.slice(0, config.search.resultCap).map((feature) => buildSearchResult({
        parcelId: feature.attributes?.[assessorLayer.joinField],
        address: feature.attributes?.[assessorLayer.addressField],
        city: feature.attributes?.[assessorLayer.cityField],
        state: feature.attributes?.[assessorLayer.stateField],
        zip: feature.attributes?.[assessorLayer.zipField],
      }));
    },

    /**
     * @param {string} parcelId
     * @returns {Promise<{type: string, coordinates: Array}|null>} geometry only, no attribute fetches
     */
    async getParcelGeometry(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const where = buildExactMatchWhere(config.layers.taxlot.idField, parcelId);
      const url = buildWhereQueryUrl(layerUrl(config, 'taxlot'), where, {
        outFields: config.layers.taxlot.idField, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return esriPolygonToGeoJsonGeometry(features[0].geometry);
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
