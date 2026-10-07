/**
 * @module releaseHistory
 * @description Structured, user-facing release history for the "What's New"
 * dialog. `CHANGELOG.md` remains the authoritative developer/history
 * document — every entry here corresponds to a real `CHANGELOG.md` section
 * and summarizes it in plain language, never inventing a capability that
 * isn't already there. Future release work updates both files together (see
 * the note at the bottom of `CHANGELOG.md`'s newest entry).
 *
 * Version duplication: the CURRENT (newest) release's `version` is read from
 * `APP_VERSION` (`appVersion.js`, itself sourced from `package.json` — see
 * that module for the full chain), not re-typed here. Once a release is
 * superseded it becomes ordinary historical data like any changelog entry
 * and keeps its own fixed version string going forward — only the NEWEST
 * entry ever needs to track the live app version.
 */
import { APP_VERSION } from './appVersion.js';

/**
 * @typedef {{id: string, label: string, items: string[]}} ReleaseSection
 * @typedef {{
 *   version: string,
 *   date: string,
 *   status: string,
 *   isLatest: boolean,
 *   summary: string,
 *   sections: ReleaseSection[],
 * }} Release
 */

/** @type {Release[]} Newest first. */
export const RELEASES = [
  {
    version: APP_VERSION,
    date: '2026-10-07',
    status: 'Production / Live',
    isLatest: true,
    summary: 'Property Details: click a Property Boundaries parcel to select and highlight '
      + 'it, then see its address, acreage, values, and improvements in a new right-rail '
      + 'panel — normalized across Oregon, North Carolina, and Virginia, with official '
      + 'record links where a provider supplies one and owner data kept out entirely.',
    sections: [
      {
        id: 'added',
        label: 'Added',
        items: [
          'Clickable, selectable Property Boundaries — selecting a parcel highlights it in place on the map.',
          'A new Property Details right-rail panel, opened by selecting a parcel.',
          'Normalized property detail display (address, acreage, values, improvements) across Oregon, North Carolina, and Virginia.',
          'Official property-record links in the panel where a provider supplies one (e.g. Deschutes County\'s DIAL record).',
          'Statewide North Carolina parcel provider (NC OneMap).',
          'Statewide Virginia parcel provider (Virginia Geographic Information Network).',
        ],
      },
      {
        id: 'improved',
        label: 'Improved',
        items: [
          'Deterministic parcel geometry identity, so a selected parcel keeps its highlight correctly across a viewport refresh.',
          'North Carolina/Virginia coverage resolution near their shared border, confirmed against the actual parcel data rather than provider order.',
          'Parcel privacy protections, with regression coverage that fails if an owner field ever reaches the property panel.',
          'Provider-neutral property detail normalization, so the panel never needs provider-specific display logic.',
          'Property Details panel layout on narrow/mobile screens.',
        ],
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-06',
    status: 'Production / Live',
    isLatest: false,
    summary: "The ECNC fork's first formal, independently-versioned release — "
      + 'Property Intelligence (coverage lookup, bounded viewport search, and a '
      + 'visible map layer), a centralized app version, and a round of '
      + 'confirmed reliability fixes across live flight tracking, CCTV/Street '
      + 'View, traffic, weather, and fire data.',
    sections: [
      {
        id: 'added',
        label: 'Added',
        items: [
          'Property Boundaries map layer — real parcel outlines once you zoom into a supported, covered area.',
          'Property Intelligence coverage lookup and bounded viewport search, backed by an initial Oregon county provider.',
          'Visible application versioning: a release baseline and this "What\'s New" history, both reading one central version source.',
        ],
      },
      {
        id: 'improved',
        label: 'Improved',
        items: [
          'Street View targeting accuracy and a wider, more reliable search fallback.',
          'Live street traffic flow visualization, rendered as its own map layer.',
          'AIS regional and worldwide viewing behavior, including a restored worldwide viewer option.',
          'Weather and radar support, including a static radar overlay and a local conditions card.',
          'NASA FIRMS active-fire data, hardened for production reliability.',
          'Live flight intelligence: an expanded Flight Details panel and selected-aircraft flight history.',
          'Self-hosted deployment workflow, in addition to the existing Cloud Run path.',
        ],
      },
      {
        id: 'fixed',
        label: 'Fixed',
        items: [
          'A rendering crash when the same parcel legitimately appeared on more than one record in a single property-boundary view.',
          'Zoning lookups silently failing against one county GIS service that rejected an unsupported query option.',
        ],
      },
      {
        id: 'known',
        label: 'Known / Deferred',
        items: [
          'Clicking a property boundary to see parcel details is planned for a later Property Intelligence phase — this release is outlines only.',
          'Aircraft photos remain deferred pending clearer provider licensing/attribution terms.',
        ],
      },
    ],
  },
];

/** @returns {Release} the newest release — always `RELEASES[0]`. */
export function getLatestRelease() {
  return RELEASES[0];
}
