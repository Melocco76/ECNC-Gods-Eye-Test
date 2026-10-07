/**
 * @module parcelProviders/oregonStatewide
 * @description Property Intelligence — Oregon coverage beyond Deschutes
 * County. The task's own named primary source — ODF's public
 * `TaxlotsDisplay` MapServer (`gis.odf.oregon.gov`) — was verified LIVE
 * this phase to exist exactly as described (36 layers, ids 0-35, one per
 * county, `maxRecordCount` 2000, Web Mercator public / Oregon Lambert
 * source) BUT its REST `capabilities` field reports `"Map"` only, and
 * every `/query` and `/identify` call against it (tested on Multnomah,
 * Deschutes, and Baker layers, and against the service root/FeatureServer
 * variant) returns a hard ArcGIS error: `"Requested operation is not
 * supported by this service" / "The requested capability is not
 * supported."`. This service can serve map TILES/IMAGES for display but
 * cannot be queried for parcel geometry or attributes at all — confirmed
 * dead end, not a code issue.
 *
 * Oregon coverage is therefore built the same way as South Carolina's and
 * Georgia's: county-by-county, from each supported county's OWN public,
 * genuinely query-capable ArcGIS REST service — behind this single
 * config-driven provider, same architecture as
 * `southCarolinaCountyParcels.js` / `georgiaCountyParcels.js`.
 *
 * SUPPORTED COUNTIES (`config.counties`), confirmed live this phase:
 *  - MULTNOMAH, WASHINGTON, CLACKAMAS — Oregon Metro's own regional
 *    "RLIS Taxlots (Public)" FeatureServer, ONE service covering all
 *    three Portland-metro counties with an explicit `COUNTY` field
 *    (`'M'`/`'W'`/`'C'`); each gets its own `config.counties` entry
 *    pointing at the SAME `featureServerUrl`/layer but with a
 *    `countyFilterField`/`countyFilterValue` added to every query's
 *    `where` clause so the three never cross-contaminate.
 *  - MARION — county-run ArcGIS FeatureServer; same ODF-style schema
 *    family as the (non-queryable) statewide display layer, minus its
 *    owner/mailing block entirely; includes a genuine per-parcel official
 *    record link (`REFLink`).
 *  - LANE — county-run ArcGIS Server (MapServer); rich values/zoning, no
 *    safe address field (its only address-shaped fields sit in the
 *    OWNER mailing block — never read).
 *  - JACKSON — Medford/Jackson County's own ArcGIS Server; rich schema
 *    with a clearly-separated safe situs address field (`SITEADD`,
 *    distinct from the `FEEOWNER`/`INCAREOF`/mailing block).
 *  - UMATILLA — county-run ArcGIS Online FeatureServer; situs address
 *    fields are clearly prefixed `SITUS_*`, distinct from the
 *    `MAILING_NA`/`IN_CARE_OF`/`AGENT`/`M_*` mailing block.
 *  - BAKER — the Baker County Assessor's own ArcGIS Online mirror; same
 *    ODF-style schema family as Marion, minus the owner/mailing block
 *    entirely.
 * Every county's safe-field semantics were verified live (not just by
 * field name) before being mapped — see PRIVACY below.
 *
 * NOT SUPPORTED this phase, searched and rejected/not found within
 * reasonable effort: Union (La Grande), Malheur (Ontario), Lincoln
 * (Newport — only a city-limited "Newport UGB" taxlot excerpt found, not
 * countywide), Coos, Curry, and every other of Oregon's 36 counties not
 * listed above. A county absent from `config.counties` resolves to NO
 * provider — never a fake "zero parcels" response.
 *
 * `OREGON_ODF_LAYER_IDS` below is the FULL 36-county reference map from
 * the (non-queryable) ODF service's own metadata, kept for documentation
 * and any future phase that finds a genuinely queryable per-county
 * mirror — it is never used to decide what this provider can actually
 * serve; `config.counties` (the much smaller, live-verified subset) is
 * the only thing that does that.
 *
 * DESCHUTES PRECEDENCE: Deschutes County already has a richer, dedicated
 * provider (`oregonDeschutes.js`, region `'or-deschutes'`) with DIAL
 * detail links. `OREGON_ODF_LAYER_IDS.DESCHUTES` (`8`) is listed for
 * completeness, but Deschutes is DELIBERATELY absent from
 * `config.counties` here — this provider's `identifyParcel` therefore
 * always returns `null` for any point the county-boundary service
 * resolves to Deschutes, ceding it unconditionally to the existing
 * provider rather than racing it through the generic multi-candidate
 * bbox disambiguation. See `oregonStatewide.test.mjs` for the test
 * proving this.
 *
 * COUNTY RESOLUTION: a point is resolved to a county via a real,
 * live-verified statewide Oregon county-boundary polygon service
 * (`config.countyBoundaryUrl`, field `COUNTY` — confirmed live to return
 * e.g. `"Multnomah"` for a known Multnomah point), never by treating a
 * coarse bounding rectangle as the actual county decision. `coverageBbox`
 * plays the same deliberately-coarse pre-filter role every other
 * provider's bbox plays.
 *
 * PARCEL ID NAMESPACING: same reasoning as South Carolina/Georgia — every
 * parcel id this module returns is prefixed with its county key
 * (`"MARION:0106.00S38.00E..."`), and `getParcelById`/`getParcelGeometry`
 * parse that prefix to know which single county (and, for the three RLIS
 * counties, which `countyFilterValue`) to query.
 *
 * PRIVACY: every county's own `DETAIL_OUT_FIELDS` list is assembled
 * purely from that county's `layers.parcels` field config — never
 * `outFields: '*'`. Fields verified LIVE (not just by name) before use:
 * Lane's and Jackson's and Umatilla's schemas each publish an
 * owner/mailing block immediately adjacent to an address-shaped field
 * (Lane: `OWNNAME`/`ADDR1-3`/`OWNERCITY`/`OWNERPRVST`/`OWNERZIP` — Lane
 * has NO separate safe site-address field at all, so no address is ever
 * read for Lane; Jackson: `FEEOWNER`/`INCAREOF`/`ADDRESS1-2`/`CITY`/
 * `STATE`/`ZIPCODE` vs the separate, verified-safe `SITEADD`; Umatilla:
 * `MAILING_NA`/`IN_CARE_OF`/`AGENT`/`M_ADDRESS`/`M_CITY`/`M_STATE`/`zip`
 * vs the separate, verified-safe `SITUS_*` block). None of the
 * owner/mailing field names are referenced anywhere in this module's
 * config or code.
 */
import {
  buildContainsAnyWhere,
  buildExactMatchWhere,
  buildPointIdentifyUrl,
  buildQueryUrl,
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

/**
 * Full 36-county Oregon Department of Forestry `TaxlotsDisplay` layer-id
 * map, confirmed live against the service's own `?f=json` metadata —
 * documentation/reference ONLY (see module docstring). Never used by any
 * function below to decide what is actually queryable.
 */
export const OREGON_ODF_LAYER_IDS = Object.freeze({
  BAKER: 0, BENTON: 1, CLACKAMAS: 2, CLATSOP: 3, COLUMBIA: 4, COOS: 5,
  CROOK: 6, CURRY: 7, DESCHUTES: 8, DOUGLAS: 9, GILLIAM: 10, GRANT: 11,
  HARNEY: 12, HOOD_RIVER: 13, JACKSON: 14, JEFFERSON: 15, JOSEPHINE: 16,
  KLAMATH: 17, LAKE: 18, LANE: 19, LINCOLN: 20, LINN: 21, MALHEUR: 22,
  MARION: 23, MORROW: 24, MULTNOMAH: 25, POLK: 26, SHERMAN: 27,
  TILLAMOOK: 28, UMATILLA: 29, UNION: 30, WALLOWA: 31, WASCO: 32,
  WASHINGTON: 33, WHEELER: 34, YAMHILL: 35,
});

function layerUrl(countyConfig) {
  return `${countyConfig.featureServerUrl}/${countyConfig.layers.parcels.id}`;
}

/** `AND <field> = '<value>'` for a county sharing a FeatureServer with
 *  others (the three RLIS counties) — `null` for a county with its own
 *  dedicated service. Both pieces are always compiled-in config, never
 *  request input. */
function countyFilterWhere(countyConfig) {
  const { countyFilterField, countyFilterValue } = countyConfig;
  return countyFilterField ? buildExactMatchWhere(countyFilterField, countyFilterValue) : null;
}

function combineWhere(...clauses) {
  const nonEmpty = clauses.filter(Boolean);
  if (nonEmpty.length === 0) return '1=1';
  return nonEmpty.map((c) => `(${c})`).join(' AND ');
}

/**
 * `"MARION:0106.00S38.00E..."` -> `{ countyKey, rawId }`, or `null` for
 * anything that does not match this provider's own namespaced format.
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
 * @param {object} params.config - the `'or-statewide'` entry from `PARCEL_PROVIDER_REGISTRY`
 * @param {(url: string, init?: object) => Promise<Response>} [params.fetchImpl]
 * @param {(response: Response, maxBytes: number) => Promise<{tooLarge: boolean, text: string}>} [params.readCapped]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.responseCapBytes]
 * @param {() => number} [params.now]
 */
export function createOregonStatewideProvider({
  config,
  fetchImpl = (...args) => globalThis.fetch(...args),
  readCapped = async (response) => ({ tooLarge: false, text: await response.text() }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseCapBytes = DEFAULT_RESPONSE_CAP_BYTES,
  now = () => Date.now(),
} = {}) {
  const countyKeys = Object.keys(config.counties);

  // One safe, owner-free outFields list per supported county — built
  // purely from that county's own `layers.parcels` field config. Never
  // `'*'`.
  const detailOutFieldsByCounty = {};
  for (const key of countyKeys) {
    const layer = config.counties[key].layers.parcels;
    detailOutFieldsByCounty[key] = [
      layer.idField, layer.altIdField, layer.objectIdField,
      layer.addressField, layer.cityField, layer.zipField, layer.acreageField,
      layer.landUseField, layer.zoningField,
      layer.landValueField, layer.improvementValueField, layer.marketValueField,
      layer.assessedValueField, layer.taxableValueField,
      layer.yearBuiltField, layer.buildingAreaField, layer.referenceLinkField,
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
   * Resolves a point to an Oregon county NAME via the real statewide
   * boundary service, uppercased (e.g. `"MULTNOMAH"`). `null` on any
   * failure/no-match. Callers decide whether that name is SUPPORTED —
   * never this function, and never a bbox guess.
   */
  async function resolveCountyName(lat, lon) {
    const url = buildPointIdentifyUrl(config.countyBoundaryUrl, lat, lon, {
      outFields: config.countyBoundaryNameField,
      resultRecordCount: 1,
      returnGeometry: false,
    });
    const features = await queryFeatures(url);
    const raw = features[0]?.attributes?.[config.countyBoundaryNameField];
    return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : null;
  }

  function rawIdFor(attrs, layer) {
    const value = typeof attrs?.[layer.idField] === 'string' ? attrs[layer.idField].trim() : '';
    if (value) return value;
    const alt = typeof attrs?.[layer.altIdField] === 'string' ? attrs[layer.altIdField].trim() : '';
    if (alt) return alt;
    const oid = attrs?.[layer.objectIdField];
    return Number.isFinite(oid) ? `or-oid-${oid}` : null;
  }

  function assembleFromFeature(countyKey, feature) {
    const countyConfig = config.counties[countyKey];
    const layer = countyConfig.layers.parcels;
    const attrs = feature.attributes || {};
    const rawId = rawIdFor(attrs, layer);
    if (!rawId) return null;
    const parcelId = namespacedId(countyKey, rawId);

    const refLink = layer.referenceLinkField ? attrs[layer.referenceLinkField] : null;
    const officialLinks = typeof refLink === 'string' && /^https?:\/\//i.test(refLink.trim())
      ? [{ label: 'Official record', url: refLink.trim() }]
      : [];

    return buildNormalizedParcel({
      providerId: config.providerId,
      sourceAgency: countyConfig.sourceAgency,
      sourceUrl: countyConfig.featureServerUrl,
      retrievedAt: new Date(now()).toISOString(),

      parcelId,
      taxLot: rawId,
      accountId: null,

      addressFull: layer.addressField ? attrs[layer.addressField] : undefined,
      city: layer.cityField ? attrs[layer.cityField] : undefined,
      state: 'OR', // fixed literal — this provider only ever covers Oregon
      zip: layer.zipField ? attrs[layer.zipField] : undefined,

      acreageAssessor: layer.acreageField ? attrs[layer.acreageField] : undefined,
      shapeAreaSqM: undefined, // every supported county already publishes its own acreage figure — no computed-acreage fallback needed

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

      officialLinks,
    });
  }

  return {
    /**
     * Full resolution flow: coarse bbox pre-filter -> real county-boundary
     * query -> supported-county lookup -> that county's own parcel layer
     * (with a `countyFilterField` AND-ed into the `where` clause for the
     * three RLIS counties). A point the boundary service resolves to
     * DESCHUTES, or to any unsupported county, resolves to `null` here —
     * see module docstring for why Deschutes is deliberately never in
     * `config.counties`.
     */
    async identifyParcel(lat, lon) {
      if (!isWithinCoverageBbox(lat, lon, config.coverageBbox)) return null;
      const countyName = await resolveCountyName(lat, lon);
      if (!countyName || !config.counties[countyName]) return null;
      const countyConfig = config.counties[countyName];
      const layer = countyConfig.layers.parcels;
      const url = buildQueryUrl(layerUrl(countyConfig), {
        geometry: `${lon},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        where: countyFilterWhere(countyConfig) || undefined,
        outFields: detailOutFieldsByCounty[countyName],
        returnGeometry: true,
        resultRecordCount: 1,
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
      const oidMatch = /^or-oid-(\d+)$/.exec(split.rawId);
      const idWhere = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : [layer.idField, layer.altIdField].filter(Boolean)
          .map((field) => `(${buildExactMatchWhere(field, split.rawId)})`).join(' OR ');
      const where = combineWhere(idWhere, countyFilterWhere(countyConfig));
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
        if (!layer.addressField) continue; // this county has no safe address field to search — skip, never substitute another field
        const where = combineWhere(buildContainsAnyWhere([layer.addressField], escaped), countyFilterWhere(countyConfig));
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
            city: layer.cityField ? feature.attributes?.[layer.cityField] : null,
            state: 'OR',
            zip: layer.zipField ? feature.attributes?.[layer.zipField] : null,
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
      const oidMatch = /^or-oid-(\d+)$/.exec(split.rawId);
      const idWhere = oidMatch
        ? buildExactMatchWhere(layer.objectIdField, oidMatch[1])
        : [layer.idField, layer.altIdField].filter(Boolean)
          .map((field) => `(${buildExactMatchWhere(field, split.rawId)})`).join(' OR ');
      const where = combineWhere(idWhere, countyFilterWhere(countyConfig));
      const url = buildWhereQueryUrl(layerUrl(countyConfig), where, {
        outFields: layer.objectIdField, resultRecordCount: 1, returnGeometry: true,
      });
      const features = await queryFeatures(url);
      if (!features.length) return null;
      return esriPolygonToGeoJsonGeometry(features[0].geometry);
    },

    /**
     * Cross-county viewport handling: every SUPPORTED county whose own
     * (tight, per-county) `bbox` intersects the requested viewport is
     * queried safely and the results merged — never a silent
     * wrong-county guess. For the three RLIS counties sharing one
     * FeatureServer, `countyFilterField` keeps their results from
     * cross-contaminating even if their bboxes overlap each other.
     * Metro counties (Multnomah/Washington/Clackamas) additionally pass
     * `maxAllowableOffset` (when `countyConfig.generalizeOffset` is set)
     * to keep a dense-urban viewport's response size bounded, the same
     * geometry-generalization technique `virginiaStatewide.js` uses.
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
        const url = buildQueryUrl(layerUrl(countyConfig), {
          geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
          geometryType: 'esriGeometryEnvelope',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
          where: countyFilterWhere(countyConfig) || undefined,
          outFields: [layer.idField, layer.altIdField, layer.objectIdField].filter(Boolean).join(','),
          returnGeometry: true,
          resultRecordCount: remaining + 1,
          maxAllowableOffset: countyConfig.generalizeOffset || undefined,
        });
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
