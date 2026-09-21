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
