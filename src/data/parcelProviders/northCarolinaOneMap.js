/**
 * @module parcelProviders/northCarolinaOneMap
 * @description Property Intelligence A2.4 — the North Carolina statewide
 * parcel provider (NC OneMap / NC Integrated Cadastral Data Exchange).
 * Unlike Deschutes County's multi-table relational model, NC OneMap
 * publishes one flat parcel layer (`NC1Map_Parcels`, layer id 1, "Parcels
 * (polys)") with every field already on the feature's own attributes — no
 * related-table joins are needed or performed here.
 *
 * Network access is dependency-injected (`fetchImpl`/`readCapped`), same
 * convention as `oregonDeschutes.js`; this module is unit-testable with a
 * fake fetch and never reaches the network in a test run.
 *
 * PRIVACY: the upstream layer publishes owner/mailing fields (`ownname`,
 * `ownname2`, `ownfrst`, `ownlast`, `mailadd`, `munit`, `mcity`, `mstate`,
 * `mzip`). None of them are named in `parcelProviderRegistry.js`'s `layers`
 * config for this provider, and `outFields` below is always built from that
 * config's field list — so there is no code path in this module that can
 * request an owner/mailing field from the upstream service, let alone
 * expose one. This is stronger than Deschutes's own privacy stance (which
 * normalizes `ownerName` internally and relies on `toPublicParcel` to strip
 * it at the response boundary): here, owner data is simply never fetched.
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

function layerUrl(config) {
  return `${config.featureServerUrl}/${config.layers.parcels.id}`;
}

/**
 * Normalize NC OneMap's per-county, per-record parcel identity safely. Some
 * counties supply an odd or missing `parno`; this never throws and never
 * invents a value from anything but stable source identity.
 * Precedence: `parno` (the primary published parcel number) -> `altparno`
 * (a real alternate parcel-identity field some counties use instead) ->
 * a deterministic `nc-oid-<objectid>` fallback, namespaced so it can never
 * collide with a real parcel number or another provider's own fallback.
 * @param {object} attrs feature attributes
 * @param {object} layer `config.layers.parcels`
 * @returns {string|null}
 */
export function normalizeNcParcelId(attrs, layer) {
  const parno = typeof attrs?.[layer.idField] === 'string' ? attrs[layer.idField].trim() : '';
  if (parno) return parno;
  const altparno = typeof attrs?.[layer.altIdField] === 'string' ? attrs[layer.altIdField].trim() : '';
  if (altparno) return altparno;
  const oid = attrs?.[layer.objectIdField];
  return Number.isFinite(oid) ? `nc-oid-${oid}` : null;
}

/**
 * @param {object} params
 * @param {object} params.config - the `'nc-statewide'` entry from `PARCEL_PROVIDER_REGISTRY`
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} [params.readCapped]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.responseCapBytes]
 * @param {() => number} [params.now]
 */
export function createNorthCarolinaOneMapProvider({
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
    layer.idField, layer.altIdField, layer.objectIdField, layer.countyField,
    layer.addressField, layer.cityField, layer.stateField, layer.zipField,
    layer.acreageField, layer.improvedValueField, layer.landValueField, layer.marketValueField,
    layer.landUseField, layer.shapeAreaField,
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
    const parcelId = normalizeNcParcelId(attrs, layer);
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
      city: attrs[layer.cityField],
      state: attrs[layer.stateField],
      zip: attrs[layer.zipField],

      acreageAssessor: attrs[layer.acreageField], // "GIS Acres" — provider-published, not client-computed
      shapeAreaSqM: undefined, // NC's Shape__Area is in State Plane feet, not meters — never fed to the sq-m acreage fallback

      ownerName: undefined, // never requested upstream — see module docstring

      assessedValue: null, // not distinguished from market value by this provider
      taxableValue: null,
      marketValue: attrs[layer.marketValueField],

      landUse: attrs[layer.landUseField],
      zoning: undefined, // no zoning layer for this statewide provider

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
      // A synthetic `nc-oid-<n>` id looks up by OBJECTID; a real parcel
      // number looks up by `parno` OR `altparno` (either may hold it).
      const oidMatch = /^nc-oid-(\d+)$/.exec(parcelId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : `(${buildExactMatchWhere(layer.idField, parcelId)}) OR (${buildExactMatchWhere(layer.altIdField, parcelId)})`;
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
        outFields: [layer.idField, layer.altIdField, layer.objectIdField, layer.addressField, layer.cityField, layer.stateField, layer.zipField].join(','),
        resultRecordCount: config.search.resultCap,
        returnGeometry: false,
      });
      const features = await queryFeatures(url);
      return features.slice(0, config.search.resultCap).map((feature) => buildSearchResult({
        parcelId: normalizeNcParcelId(feature.attributes || {}, layer),
        address: feature.attributes?.[layer.addressField],
        city: feature.attributes?.[layer.cityField],
        state: feature.attributes?.[layer.stateField],
        zip: feature.attributes?.[layer.zipField],
      }));
    },

    async getParcelGeometry(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const oidMatch = /^nc-oid-(\d+)$/.exec(parcelId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : `(${buildExactMatchWhere(layer.idField, parcelId)}) OR (${buildExactMatchWhere(layer.altIdField, parcelId)})`;
      const url = buildWhereQueryUrl(layerUrl(config), where, {
        outFields: layer.objectIdField, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return esriPolygonToGeoJsonGeometry(features[0].geometry);
    },

    /**
     * Property Intelligence A2.4 — parcel outlines for a map viewport, same
     * contract as `oregonDeschutes.js`'s: ONE spatial query, `outFields`
     * limited to identity fields only (never the full `DETAIL_OUT_FIELDS`
     * list — a viewport fetch never touches address/value/owner fields at
     * all, not even the safe ones).
     * @param {{south:number, west:number, north:number, east:number}} bbox - WGS84 degrees
     * @param {{maxResults?: number}} [opts]
     * @returns {Promise<{parcels: Array<{parcelId:string, geometry:object}>, saturated: boolean}>}
     */
    async getParcelsInViewport(bbox, { maxResults = 400 } = {}) {
      const url = buildEnvelopeQueryUrl(layerUrl(config), bbox, {
        outFields: [layer.idField, layer.altIdField, layer.objectIdField].join(','),
        resultRecordCount: maxResults + 1,
        returnGeometry: true,
      });
      if (!url) return { parcels: [], saturated: false };
      const features = await queryFeatures(url);
      const saturated = features.length > maxResults;
      const bounded = saturated ? features.slice(0, maxResults) : features;
      const parcels = [];
      for (const feature of bounded) {
        const parcelId = normalizeNcParcelId(feature.attributes || {}, layer);
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
