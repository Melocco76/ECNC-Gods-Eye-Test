# Flight Intelligence — phase status

| Phase | Scope | Status |
| --- | --- | --- |
| A | Expanded Flight Details panel (position, speed, altitude, squawk, freshness, feed source) | Done (`1f9b0292`) |
| B | Aircraft metadata (registration, type, owner, operator) from adsbdb / adsb.lol | Done (`2878c3ac`) |
| C | Aircraft photos | **DEFERRED** |
| D | Not started | — |
| E | Route / history enhancement (selected-aircraft adsb.lol trace, current leg) | Done (`4d5abdf3`) |

## Phase C — DEFERRED pending provider permission / licensing clarification

No photo code exists and none should be added until the points below are resolved.

- **adsbdb photo URLs** carry no attribution or provenance (no photographer, no source page, no licence).
- **Airport-Data API** can return the photographer and a link, but its terms do not make clear that
  third parties may embed, hotlink or rehost its thumbnails.
- Images must **not** be scraped, hotlinked or rehosted without a clearer permission basis.

Reopen Phase C only after a provider grants (or documents) embedding rights and attribution requirements.

## Phase E — history notes

- Trace is fetched only for the selected aircraft, only after Flight Details is opened (or the selection
  changes while it is open). One active request; results cached 10 minutes server- and client-side.
- Source is `adsb.lol` traces via `/api/adsblol/history`; there is no OpenSky fallback and no API key.
- "Tracked since / duration / distance" are calculated from trace points. They are not scheduled or actual
  departure times, flight duration, or an official route time.

## Phase E.1 — cleanup after Cloud Run validation

- **Silent-gap rule.** A gap of at least 2 h between consecutive trace points starts a new current segment when the
  aircraft did not travel like something flying across it (straight-line distance over the gap implies under
  150 km/h). This handles parked-overnight aircraft whose trace never reports `ground`. Real in-flight coverage holes
  were 73-85 min, and an ocean gap that ends hundreds of km away implies flight speed, so neither is split. Real
  before/after: 19.3 h -> 1.1 h and 22.2 h -> 0.7 h tracked duration; ordinary flights unchanged. "Tracked since /
  duration / distance" describe the current trace segment only, never an official departure.
- **Terrain lookup.** Painting the violet path looks up ground floor for at most 60 sampled points (first, last, an even
  spread, and low/ground points), not ~300. Every point is still drawn.
- **OpenSky backfill.** When the live poll reports `x-opensky-auth-reason: opensky_disabled_*` the client no longer asks
  `/api/opensky-track` (it only 502s on Cloud Run). OpenSky support is otherwise unchanged.
- **Operator code.** A 3-4 character value containing a digit (or equal to the aircraft's own type code), e.g. `C680`,
  is not shown as an "Operator code". The raw normalised field is kept.
