# AIS: server coverage vs. personal viewer filters

Two separate things:

| | Server coverage | Viewer filter |
|---|---|---|
| What | Which maritime regions the Cloud Run process subscribes to on its ONE AISStream socket | Which of those regions this browser draws |
| Who chooses | Whoever deploys the service (`AISSTREAM_DEFAULT_REGIONS`, or legacy `AISSTREAM_BOUNDING_BOXES`) | Each visitor, for themselves |
| Where it lives | Server process | `localStorage` key `gev.ais.viewRegions` (JSON array of region IDs, nothing else) |
| Effect of a change | Reconnect-free resubscribe (admin only) | Instant, local; no request, no reconnect |

Visitors never call `POST /api/ais-regions`. The owner-session endpoints
(`/api/admin/session`, cookie-authorised writes) are retained for maintenance
but no visible UI uses them.

## Server

* `AISSTREAM_REGIONS_ENABLED=1` + `AISSTREAM_DEFAULT_REGIONS=gulf,east-coast,west-coast,great-lakes`
  subscribes to all four regions (11 boxes, under the 12-box ceiling). The trusted
  configuration accepts catalogue IDs only. Interactive/admin writes stay limited
  to 2 regions.
* Every vessel row in `/api/ais-live` gains an additive `regionIds` array (the
  catalogue regions containing the position, canonical order; overlaps list both;
  empty outside every region). One row per MMSI.
* `/api/ais-live` `coverage.available` and `/api/ais-regions` `available` list the
  regions the server can deliver right now (regional: subscribed; legacy: regions
  overlapped by the configured boxes - production's single Gulf box gives `["gulf"]`).

## Browser

* Effective selection = saved choice ∩ server-available. If that is empty the
  viewer sees every available region, but the SAVED choice is never overwritten by
  narrower server coverage: a saved `["west-coast"]` stays saved while the server
  only covers the Gulf and becomes active again when West Coast coverage returns.
* Default when nothing valid is saved: `["gulf","east-coast"]`.
* At least one region must stay on, so the empty selection is impossible. Every one of
  the 15 non-empty combinations of the four regions is allowed (no max-2 rule locally).
* Regions the server does not cover are shown as "Not covered" and cannot be ticked.
* Hidden vessels stay cached (positions keep updating), so re-ticking a region is
  instant. They are not drawn, labelled, searchable, selectable, or offered to
  detection/nearby.
* Vessels the server did not classify (older server, open ocean) are always drawn.

## Share links

Viewer regions are deliberately NOT part of share links. Opening someone else's
map link must not overwrite the maritime view you chose for yourself.
