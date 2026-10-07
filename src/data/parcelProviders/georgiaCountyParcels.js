/**
 * @module parcelProviders/georgiaCountyParcels
 * @description Property Intelligence — Georgia coverage. Like South
 * Carolina, there is no free/public statewide GA parcel polygon service:
 * no state agency (Georgia Geospatial Information Office, Georgia DOR,
 * or any state ArcGIS infrastructure) publishes one, and ArcGIS Online
 * items named "Georgia Parcels"/"Statewide Parcels" confirmed live this
 * phase turned out to be unrelated datasets (parks, land ownership,
 * conservation lands) — never an actual statewide parcel-polygon layer.
 * GA coverage is therefore built county-by-county, from each supported
 * county's OWN public ArcGIS REST service, behind this single
 * config-driven provider — same architecture as
 * `southCarolinaCountyParcels.js`.
 *
 * SUPPORTED COUNTIES (`config.counties`), confirmed live this phase:
 *  - FULTON — county-run ArcGIS FeatureServer; identity/address/acreage/
 *    land-use only, no value fields in this schema.
 *  - DEKALB — county-run ArcGIS FeatureServer; rich values (assessed/
 *    appraised/land/building), zoning, land use; no address field.
 *  - GWINNETT — county-run ArcGIS FeatureServer; identity/address(house
 *    number only)/acreage only (a richer, owner-containing related Tax
 *    Master table exists upstream but is deliberately never joined — see
 *    PRIVACY below).
 *  - FORSYTH — county-run ArcGIS FeatureServer; rich schema (address,
 *    acreage, zoning, land use, assessed/taxable/land value, year built,
 *    building area).
 *  - CLARKE (Athens-Clarke) — county-run ArcGIS FeatureServer; identity/
 *    address/acreage only.
 *  - RICHMOND (Augusta) — county-run ArcGIS Server (MapServer); identity/
 *    acreage only, no address field.
 * Every other county on the task's priority list was searched (ArcGIS
 * Online content-search plus direct domain inspection) and REJECTED for
 * this phase — see the GA coverage report for the full list and each
 * rejection reason (host unreachable from this research environment —
 * Hall, Muscogee/Columbus; no discoverable public ArcGIS REST service —
 * Chatham, Cobb, Rabun, Towns, Union, and the rest of the priority list;
 * a split multi-field address schema deferred rather than special-cased —
 * Whitfield). A county absent from `config.counties` resolves to NO
 * provider for that county — never a fake "zero parcels" response.
 *
 * COUNTY RESOLUTION (Part 5): a point is resolved to a county via a real,
 * live-verified county-BOUNDARY polygon service (`config.countyBoundaryUrl`
 * — a Census-derived statewide "GA Counties" layer, confirmed live to
 * return e.g. `"Fulton County"` for a known Fulton point), never by
 * treating a coarse bounding rectangle as the actual county decision.
 * `coverageBbox` on the registry entry plays the same, deliberately
 * coarse "is this plausibly within reach at all" pre-filter role every
 * other provider's bbox plays — the REAL per-point decision is this
 * boundary-service query, and the real per-viewport decision is each
 * supported county's own tighter `bbox` (see `getParcelsInViewport`).
 *
 * PARCEL ID NAMESPACING: same reasoning as South Carolina — every parcel
 * id this module returns is prefixed with its county key
 * (`"FULTON:07 410001590187"`, `"DEKALB:12 228 01 007"`), and
 * `getParcelById`/`getParcelGeometry` parse that prefix to know which
 * single county layer to query.
 *
 * PRIVACY: every county's own `DETAIL_OUT_FIELDS` list is assembled
 * purely from that county's `layers.parcels` field config — never
 * `outFields: '*'`. Several candidate/rejected services this phase
 * published owner fields immediately adjacent to an address-shaped field
 * (Whitfield's `lastname`/`address1-3`/`city`/`state`/`zip` block;
 * Clarke's own `OWNER_NAME`/`OWNER_ADD`/`CITY`/`STATE`/`ZIP` block, where
 * only the separate `PAR_ADD` field — proven safe — is actually used
 * here) — none of those fields are referenced anywhere in this module's
 * config or code. Gwinnett's upstream `Property_and_Tax` FeatureServer
 * also publishes a related "Tax Owner Address Table" (table id 4,
 * `OWNER1`/`OWNER2`/`MAILADDR`/`MAILCITY`/`MAILSTAT`/`MAILZIP`) and a "Tax
 * Master Table" (table id 3) that mixes site-location fields with that
 * same owner/mailing block — this provider deliberately never joins
 * either table and uses ONLY the base `Parcels` layer (id 0), which has
 * no owner field at all.
 */
import {
  buildContainsAnyWhere,
  buildEnvelopeQueryUrl,
  buildExactMatchWhere,
  buildPointIdentifyUrl,
  buildWhereQueryUrl,
} from '../arcgisParcelQuery.js';
import {
  bboxIntersectsBbox,
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
const SQ_FT_PER_SQ_M = 10.76391041671;

function layerUrl(countyConfig) {
  return `${countyConfig.featureServerUrl}/${countyConfig.layers.parcels.id}`;
}

/**
 * `"FULTON:07 410001590187"` -> `{ countyKey: 'FULTON', rawId: '07 410001590187' }`,
 * or `null` for anything that does not match this provider's own
 * namespaced format. Never attempts to guess a county from an
 * un-prefixed id.
 */
function splitNamespacedParcelId(parcelId) {
  const match = /^([A-Z]+):(.+)$/.exec(parcelId || '');
  if (!match) return null;
  return { countyKey: match[1], rawId: match[2] };
}

function namespacedId(countyKey, rawId) {
  return `${countyKey}:${rawId}`;
}

/**
 * @param {object} params
 * @param {object} params.config - the `'ga-counties'` entry from `PARCEL_PROVIDER_REGISTRY`
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} [params.readCapped]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.responseCapBytes]
 * @param {() => number} [params.now]
 */
export function createGeorgiaCountyParcelsProvider({
  config,
  fetchImpl = (...args) => globalThis.fetch(...args),
  readCapped = async (response) => ({ tooLarge: false, text: await response.text() }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseCapBytes = DEFAULT_RESPONSE_CAP_BYTES,
  now = () => Date.now(),
} = {}) {
  const countyKeys = Object.keys(config.counties);

  // One safe, owner-free outFields list per supported county — built purely
  // from that county's own `layers.parcels` field config. Never `'*'`.
  const detailOutFieldsByCounty = {};
  for (const key of countyKeys) {
    const layer = config.counties[key].layers.parcels;
    detailOutFieldsByCounty[key] = [
      layer.idField, layer.altIdField, layer.objectIdField,
      layer.addressField, layer.acreageField, layer.shapeAreaField,
      layer.landUseField, layer.zoningField,
      layer.landValueField, layer.improvementValueField, layer.marketValueField,
      layer.assessedValueField, layer.taxableValueField,
      layer.yearBuiltField, layer.buildingAreaField,
    ].filter(Boolean).join(',');
  }

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

  /**
   * Part 5's county-boundary resolution step: a single point-intersect
   * query against GA's statewide county-boundary layer. Returns the
   * upstream county `NAME` (e.g. `"Fulton County"`) with any trailing
   * `" County"` stripped and uppercased (`"FULTON"`), or `null` on any
   * failure/no-match — callers then decide whether that name is a
   * SUPPORTED county, never this function.
   * @returns {Promise<string|null>}
   */
  async function resolveCountyName(lat, lon) {
    const url = buildPointIdentifyUrl(config.countyBoundaryUrl, lat, lon, {
      outFields: config.countyBoundaryNameField,
      resultRecordCount: 1,
      returnGeometry: false,
    });
    const features = await queryFeatures(url);
    const raw = features[0]?.attributes?.[config.countyBoundaryNameField];
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return raw.trim().replace(/\s+County$/i, '').toUpperCase();
  }

  function rawIdFor(attrs, layer) {
    const value = typeof attrs?.[layer.idField] === 'string' ? attrs[layer.idField].trim() : '';
    if (value) return value;
    const alt = typeof attrs?.[layer.altIdField] === 'string' ? attrs[layer.altIdField].trim() : '';
    if (alt) return alt;
    const oid = attrs?.[layer.objectIdField];
    return Number.isFinite(oid) ? `ga-oid-${oid}` : null;
  }

  function assembleFromFeature(countyKey, feature) {
    const countyConfig = config.counties[countyKey];
    const layer = countyConfig.layers.parcels;
    const attrs = feature.attributes || {};
    const rawId = rawIdFor(attrs, layer);
    if (!rawId) return null;
    const parcelId = namespacedId(countyKey, rawId);

    // DeKalb's only size figure is a geometry-derived Shape__Area in
    // State-Plane *feet* — convert to square meters so the shared
    // computed-acreage fallback (which assumes sq-m) is correct, rather
    // than feeding it a figure in the wrong unit.
    const shapeAreaSqFt = layer.shapeAreaField ? attrs[layer.shapeAreaField] : undefined;
    const shapeAreaSqM = typeof shapeAreaSqFt === 'number' && Number.isFinite(shapeAreaSqFt)
      ? shapeAreaSqFt / SQ_FT_PER_SQ_M
      : undefined;

    return buildNormalizedParcel({
      providerId: config.providerId,
      sourceAgency: countyConfig.sourceAgency,
      sourceUrl: countyConfig.featureServerUrl,
      retrievedAt: new Date(now()).toISOString(),

      parcelId,
      taxLot: rawId,
      accountId: null,

      addressFull: layer.addressField ? attrs[layer.addressField] : undefined,
      city: undefined, // no county config maps a distinct site-city field — see module docstring
      state: 'GA', // fixed literal — this provider only ever covers Georgia
      zip: undefined,

      acreageAssessor: layer.acreageField ? attrs[layer.acreageField] : undefined,
      shapeAreaSqM,

      ownerName: undefined, // never requested upstream — see module docstring

      assessedValue: layer.assessedValueField ? attrs[layer.assessedValueField] : null,
      taxableValue: layer.taxableValueField ? attrs[layer.taxableValueField] : null,
      marketValue: layer.marketValueField ? attrs[layer.marketValueField] : undefined,
      landValue: layer.landValueField ? attrs[layer.landValueField] : null,
      improvementValue: layer.improvementValueField ? attrs[layer.improvementValueField] : null,

      landUse: layer.landUseField ? attrs[layer.landUseField] : null,
      zoning: layer.zoningField ? attrs[layer.zoningField] : undefined,

      yearBuilt: layer.yearBuiltField ? attrs[layer.yearBuiltField] : undefined,
      buildingArea: layer.buildingAreaField ? attrs[layer.buildingAreaField] : undefined,
      garageArea: undefined,
      bedrooms: undefined,
      bathrooms: undefined,

      geometry: esriPolygonToGeoJsonGeometry(feature.geometry),

      officialLinks: [],
    });
  }

  return {
    /**
     * Part 5's full resolution flow: coarse bbox pre-filter -> real
     * county-boundary query -> supported-county lookup -> that county's
     * own parcel layer. A point outside every supported county's
     * boundary resolves to `null` at the "supported-county lookup" step,
     * same as any other provider's clean "no parcel here".
     */
    async identifyParcel(lat, lon) {
      if (!isWithinCoverageBbox(lat, lon, config.coverageBbox)) return null;
      const countyName = await resolveCountyName(lat, lon);
      if (!countyName || !config.counties[countyName]) return null;
      const countyConfig = config.counties[countyName];
      const url = buildPointIdentifyUrl(layerUrl(countyConfig), lat, lon, {
        outFields: detailOutFieldsByCounty[countyName], resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return assembleFromFeature(countyName, features[0]);
    },

    async getParcelById(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const split = splitNamespacedParcelId(parcelId);
      const countyConfig = split && config.counties[split.countyKey];
      if (!countyConfig) return null;
      const layer = countyConfig.layers.parcels;
      const oidMatch = /^ga-oid-(\d+)$/.exec(split.rawId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : [layer.idField, layer.altIdField].filter(Boolean)
          .map((field) => `(${buildExactMatchWhere(field, split.rawId)})`).join(' OR ');
      const url = buildWhereQueryUrl(layerUrl(countyConfig), where, {
        outFields: detailOutFieldsByCounty[split.countyKey], resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return assembleFromFeature(split.countyKey, features[0]);
    },

    async searchAddress(query) {
      const validated = validateAddressQuery(query, config.search);
      if (!validated.ok) return [];
      const escaped = escapeArcgisTextLiteral(validated.value);
      const results = [];
      for (const countyKey of countyKeys) {
        const countyConfig = config.counties[countyKey];
        const layer = countyConfig.layers.parcels;
        if (!layer.addressField) continue; // this county has no address field to search — skip, never substitute another field
        const where = buildContainsAnyWhere([layer.addressField], escaped);
        const url = buildWhereQueryUrl(layerUrl(countyConfig), where, {
          outFields: [layer.idField, layer.altIdField, layer.objectIdField, layer.addressField].filter(Boolean).join(','),
          resultRecordCount: config.search.resultCap,
          returnGeometry: false,
        });
        const features = await queryFeatures(url);
        for (const feature of features) {
          const rawId = rawIdFor(feature.attributes || {}, layer);
          if (!rawId) continue;
          results.push(buildSearchResult({
            parcelId: namespacedId(countyKey, rawId),
            address: feature.attributes?.[layer.addressField],
            city: null,
            state: 'GA',
            zip: null,
          }));
        }
      }
      return results.slice(0, config.search.resultCap);
    },

    async getParcelGeometry(parcelId) {
      if (!isValidParcelId(parcelId, config.parcelIdPattern)) return null;
      const split = splitNamespacedParcelId(parcelId);
      const countyConfig = split && config.counties[split.countyKey];
      if (!countyConfig) return null;
      const layer = countyConfig.layers.parcels;
      const oidMatch = /^ga-oid-(\d+)$/.exec(split.rawId);
      const where = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : [layer.idField, layer.altIdField].filter(Boolean)
          .map((field) => `(${buildExactMatchWhere(field, split.rawId)})`).join(' OR ');
      const url = buildWhereQueryUrl(layerUrl(countyConfig), where, {
        outFields: layer.objectIdField, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return esriPolygonToGeoJsonGeometry(features[0].geometry);
    },

    /**
     * Part 5's viewport-crossing-county-lines handling: every SUPPORTED
     * county whose own (tight, per-county) `bbox` intersects the
     * requested viewport is queried safely and the results merged — never
     * a silent wrong-county guess.
     */
    async getParcelsInViewport(bbox, { maxResults = 400 } = {}) {
      const intersecting = countyKeys.filter((key) => bboxIntersectsBbox(bbox, config.counties[key].bbox));
      if (intersecting.length === 0) return { parcels: [], saturated: false };

      const parcels = [];
      let saturated = false;
      for (const countyKey of intersecting) {
        const countyConfig = config.counties[countyKey];
        const layer = countyConfig.layers.parcels;
        const remaining = maxResults - parcels.length;
        if (remaining <= 0) { saturated = true; break; }
        const url = buildEnvelopeQueryUrl(layerUrl(countyConfig), bbox, {
          outFields: [layer.idField, layer.altIdField, layer.objectIdField].filter(Boolean).join(','),
          resultRecordCount: remaining + 1,
          returnGeometry: true,
        });
        if (!url) continue;
        const { features, exceededTransferLimit } = await queryFeaturesWithMeta(url);
        if (exceededTransferLimit || features.length > remaining) saturated = true;
        const bounded = features.length > remaining ? features.slice(0, remaining) : features;
        for (const feature of bounded) {
          const rawId = rawIdFor(feature.attributes || {}, layer);
          const geometry = esriPolygonToGeoJsonGeometry(feature.geometry);
          if (!rawId || !geometry) continue;
          parcels.push({ parcelId: namespacedId(countyKey, rawId), geometry });
        }
      }
      if (parcels.length > maxResults) { parcels.length = maxResults; saturated = true; }
      return { parcels, saturated };
    },

    getMetadata() {
      return {
        providerId: config.providerId,
        region: config.region,
        state: config.state,
        county: config.county,
        sourceAgency: config.sourceAgency,
        sourceUrl: config.countyBoundaryUrl,
        capabilities: { ...config.capabilities },
      };
    },
  };
}
