/**
 * @module parcelProviders/virginiaStatewide
 * @description Property Intelligence A2.4 — the Virginia statewide parcel
 * provider. Same one-flat-layer architecture as `northCarolinaOneMap.js`
 * (no related-table joins): the `VA_Parcels` layer already carries
 * identity, address, and locality on each feature's own attributes.
 *
 * Network access is dependency-injected (`fetchImpl`/`readCapped`), same
 * convention as `oregonDeschutes.js`/`northCarolinaOneMap.js`; this module
 * is unit-testable with a fake fetch and never reaches the network in a
 * test run.
 *
 * PRIVACY: the upstream layer publishes owner/mailing fields (`Owner1`,
 * `Owner2`, `M_Address`, `M_City`, `M_State`, `M_Zip`). None of them are
 * named in `parcelProviderRegistry.js`'s `layers` config for this
 * provider, and `outFields` below is always built from that config's field
 * list — so there is no code path in this module that can request an
 * owner/mailing field from the upstream service, let alone expose one.
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
/** ArcGIS `maxAllowableOffset` (degrees) for viewport geometry only — see `getParcelsInViewport`'s docstring. */
export const VIEWPORT_GEOMETRY_GENERALIZATION_DEGREES = 0.00001;

function layerUrl(config) {
  return `${config.featureServerUrl}/${config.layers.parcels.id}`;
}

/**
 * Normalize Virginia parcel identity safely. `PARCELID` format varies by
 * locality and can be blank for some records; this never throws and never
 * invents a value from anything but stable source identity.
 * Precedence: `PARCELID` -> deterministic `va-oid-<objectid>` fallback,
 * namespaced so it can never collide with a real parcel id or another
 * provider's own fallback.
 * @param {object} attrs feature attributes
 * @param {object} layer `config.layers.parcels`
 * @returns {string|null}
 */
export function normalizeVaParcelId(attrs, layer) {
  const parcelId = typeof attrs?.[layer.idField] === 'string' ? attrs[layer.idField].trim() : '';
  if (parcelId) return parcelId;
  const oid = attrs?.[layer.objectIdField];
  return Number.isFinite(oid) ? `va-oid-${oid}` : null;
}

/**
 * @param {object} params
 * @param {object} params.config - the `'va-statewide'` entry from `PARCEL_PROVIDER_REGISTRY`
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} [params.readCapped]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.responseCapBytes]
 * @param {() => number} [params.now]
 */
export function createVirginiaStatewideProvider({
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
    layer.idField, layer.objectIdField, layer.localityField,
    layer.addressField, layer.cityField, layer.stateField, layer.zipField,
    layer.gpinField, layer.pinField, layer.mapNumberField, layer.shapeAreaField,
  ].join(',');

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

  function assembleFromFeature(feature) {
    const attrs = feature.attributes || {};
    const parcelId = normalizeVaParcelId(attrs, layer);
    if (!parcelId) return null;

    return buildNormalizedParcel({
      providerId: config.providerId,
      sourceAgency: config.sourceAgency,
      sourceUrl: config.featureServerUrl,
      retrievedAt: new Date(now()).toISOString(),

      parcelId,
      taxLot: parcelId,
      accountId: attrs[layer.gpinField] ?? attrs[layer.pinField] ?? null,

      addressFull: attrs[layer.addressField],
      city: attrs[layer.cityField],
      state: attrs[layer.stateField],
      zip: attrs[layer.zipField],

      acreageAssessor: undefined, // this statewide dataset publishes no acreage/value fields at all
      shapeAreaSqM: attrs[layer.shapeAreaField], // UTM-projected source area — genuinely square meters, safe for the computed-acreage fallback

      ownerName: undefined, // never requested upstream — see module docstring

      assessedValue: null,
      taxableValue: null,
      marketValue: null,

      landUse: null,
      zoning: undefined,

      yearBuilt: undefined,
      buildingArea: undefined,
      garageArea: undefined,
      bedrooms: undefined,
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
      const oidMatch = /^va-oid-(\d+)$/.exec(parcelId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : buildExactMatchWhere(layer.idField, parcelId);
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
        outFields: [layer.idField, layer.objectIdField, layer.addressField, layer.cityField, layer.stateField, layer.zipField].join(','),
        resultRecordCount: config.search.resultCap,
        returnGeometry: false,
      });
      const features = await queryFeatures(url);
      return features.slice(0, config.search.resultCap).map((feature) => buildSearchResult({
        parcelId: normalizeVaParcelId(feature.attributes || {}, layer),
        address: feature.attributes?.[layer.addressField],
        city: feature.attributes?.[layer.cityField],
        state: feature.attributes?.[layer.stateField],
        zip: feature.attributes?.[layer.zipField],
      }));
    },

    async getParcelGeometry(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const oidMatch = /^va-oid-(\d+)$/.exec(parcelId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : buildExactMatchWhere(layer.idField, parcelId);
      const url = buildWhereQueryUrl(layerUrl(config), where, {
        outFields: layer.objectIdField, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return esriPolygonToGeoJsonGeometry(features[0].geometry);
    },

    /**
     * Property Intelligence A2.4 — parcel outlines for a map viewport, same
     * contract as `oregonDeschutes.js`'s/`northCarolinaOneMap.js`'s: ONE
     * spatial query, `outFields` limited to identity fields only.
     *
     * Upstream quirk confirmed live: Virginia's source parcel boundaries are
     * digitized at a much higher vertex density than Deschutes/NC — a
     * single ~0.02°x0.03° viewport over a dense locality (Richmond City)
     * returned a >1 MB response, well past the shared
     * `PARCEL_RESPONSE_CAP_BYTES` (512 KB) safety cap, and was silently read
     * as zero parcels rather than ever being reported `saturated`. Per the
     * A2.4 spec this is adapted HERE, inside this provider, rather than by
     * raising the shared cap (which would weaken that protection for every
     * provider) or `MAX_VIEWPORT_PARCELS` (unchanged, still 400): ArcGIS's
     * own server-side `maxAllowableOffset` generalizes the returned geometry
     * (fewer, farther-apart vertices) without changing parcel COUNT, CRS, or
     * the response shape — confirmed live to cut the same 311-feature
     * response from >1 MB to ~160 KB. This is server-side ArcGIS
     * generalization, not client-side reprojection math (Part 5).
     * `VIEWPORT_GEOMETRY_GENERALIZATION_DEGREES` (~1 m) is well below
     * anything visible at the zoom level this layer renders at.
     * @param {{south:number, west:number, north:number, east:number}} bbox - WGS84 degrees
     * @param {{maxResults?: number}} [opts]
     * @returns {Promise<{parcels: Array<{parcelId:string, geometry:object}>, saturated: boolean}>}
     */
    async getParcelsInViewport(bbox, { maxResults = 400 } = {}) {
      const baseUrl = buildEnvelopeQueryUrl(layerUrl(config), bbox, {
        outFields: [layer.idField, layer.objectIdField].join(','),
        resultRecordCount: maxResults + 1,
        returnGeometry: true,
      });
      if (!baseUrl) return { parcels: [], saturated: false };
      const url = new URL(baseUrl);
      url.searchParams.set('maxAllowableOffset', String(VIEWPORT_GEOMETRY_GENERALIZATION_DEGREES));
      const features = await queryFeatures(url.toString());
      const saturated = features.length > maxResults;
      const bounded = saturated ? features.slice(0, maxResults) : features;
      const parcels = [];
      for (const feature of bounded) {
        const parcelId = normalizeVaParcelId(feature.attributes || {}, layer);
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
