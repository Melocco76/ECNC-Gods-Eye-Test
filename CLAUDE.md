# CLAUDE.md

Working rules for Claude sessions in this repository. Read this before making
changes.

## PROJECT

- Repository: ECNC-Gods-Eye-Test
- Origin: https://github.com/Melocco76/ECNC-Gods-Eye-Test.git
- Based on upstream God's Eye View 0.1.1 by Bilawal Sidhu / Halfpixel
- Personal/noncommercial fork
- Eventual target: Google Cloud Run with a custom domain
- Preserve existing architecture unless evidence requires a change

## VERIFIED BASELINE

Established by a full static inspection and gate run before any fork changes:

- Node 24.21.0
- npm 11.19.0
- `npm ci` successful
- `npm run doctor -- --json`: `ready=true`
- `npm run build`: PASS
- `npm test`: PASS — 2688 passing tests, 2 intentional skips
- `npm run test:track`: PASS — 108/108 tracking scenarios pass
- Manual keyless runtime verification passed (localhost-only, no provider keys)
- Baseline Git state was clean before fork changes began

## MANDATORY WORKING STYLE

- Small, reviewable changes
- One logical change at a time
- Do not automatically refactor unrelated code
- Do not upgrade dependencies unless explicitly approved
- Do not run `npm audit fix` automatically
- Do not commit or push unless explicitly approved
- Do not deploy unless explicitly approved
- Do not expose the dev server to LAN/public networks
- Development server should remain localhost-only unless explicitly instructed otherwise
- Read the relevant section of `docs/CURRENT-STATE.md` before changing behavior
- Preserve attribution and licensing
- Preserve server-side secret handling
- Never commit `.env` or real credentials

## CORE REGRESSION CONTRACT

Before a change is considered complete when relevant:

- `npm run doctor -- --json`
- `npm run build`
- `npm test`
- `npm run test:track` with the localhost dev server running

The scope of testing may be reduced during intermediate work only when
explicitly agreed, but the full gate sequence is required before deployment.

## IMPORTANT ARCHITECTURAL INVARIANTS

Critical invariants discovered during the full repository inspection
(`docs/CURRENT-STATE.md` is the authoritative source — this is a summary
index, not a replacement for reading it):

- **Render governor contract** (`src/renderGovernor.js`): any new per-frame
  animation must register a hold; any discrete mutation must call
  `governorRequestRender`. Gate: `scripts/qa-perf.mjs`.
- **World-overlay ownership** (`src/overlays/worldOverlay.js`): one shared
  canvas, one detection blend surface, one `postRender` listener owns all
  card/label rendering. Zero native Cesium `LabelGraphics` remain anywhere in
  the app — do not reintroduce native world labels.
- **`hasContact()` presence contract**: `flights`, `militaryFlights`,
  `aisLiveVessels` presence must be queried via `hasContact(id)`, never
  inferred from `getAllPositions()`, which is cap-limited and will produce
  false "gone" states.
- **One-sided aircraft ground/floor corrections** (`src/data/groundSnap.js`,
  `src/data/flights.js`): corrections only ever raise a floored sprite, never
  lower one below a real measurement. Applies only to `flights.js`, not
  `militaryFlights.js`. Do not make this two-sided.
- **AIS watchdog teardown/generation rules** (`src/data/aisWatchdog.js`,
  `aisStreamAdapter.js`): teardown must use `ws.terminate()`, never
  `.close()`; socket generations are monotonic and never reused; every
  socket-map mutation is identity-checked.
- **Route-cinematic heading/roll rules** (`src/cameraVerbs.js` and related):
  heading must interpolate as an angle about local up, never a Cartesian
  lerp; every camera-motion release must level the roll.
- **Split-flap DOM-node identity rule** (`src/splitFlap.js`): the text node
  backing a status chip must never be replaced or reparented — only
  `node.data` may change, for the life of the chip.
- **Detection is owned by the Contacts session, not Cockpit**: Cockpit
  entry/exit never touches detection state; only Contacts activation/
  deactivation does.
- **First-run mission persistence restrictions** (`src/firstRunExperience.js`):
  a first-run mission tile may durably enable its own layers, but detection
  mode/density, 3D models, feather, and `_detectionUserOverridden` are
  explicitly off-limits for a mission to touch.
- **Required attribution must remain visible**: the Google/Cesium credit line
  must never be covered by any surface, in any state
  (`src/creditAttribution.test.mjs` is a fail-closed model for this).
- **Accepted residuals documented in `docs/CURRENT-STATE.md` should not be
  casually "fixed"** — several behaviors (e.g. downhill-taxi float, cold-start
  floor latency, one-tick airborne flap transitions) are deliberate, accepted
  tradeoffs with their own regression gates. Read the surrounding context
  before "improving" one.

## DEPLOYMENT DIRECTION

- Future personal/noncommercial Cloud Run deployment
- Custom domain later
- Keep private/provider secrets server-side
- Cloud Run likely `max-instances=1` initially
- Do not assume local filesystem persistence in Cloud Run
- `.gev-cache` and `.gev-logs` are ephemeral in Cloud Run
- TomTom daily-budget persistence needs special review before keyed production
  deployment
- AISStream's long-lived outbound WebSocket needs empirical Cloud Run
  verification
- Provider Settings / POWER UP is local-development-only and should not be
  redesigned merely for Cloud Run
- Do not refactor `vite.config.js` proxy architecture until local container
  evidence shows it is necessary
- Initial production-path experiment will be containerized built app +
  existing preview proxy behavior

## KNOWN DOCUMENTATION ISSUES

Recorded, not fixed:

- `docs/superpowers/reports/2026-07-08-height-datum-handover.md` is
  referenced (from `docs/KNOWN-ISSUES.md` and `docs/CURRENT-STATE.md`) but
  absent from this checkout.
- `CCTV_AUTO_CALIBRATE` and `CCTV_DRAPE_MESH` references in `.env.example`
  appear stale — `docs/CURRENT-STATE.md` states the auto-calibration and
  drape-mesh pipeline they describe was deleted in the CCTV v2 rewrite, and
  neither flag is referenced anywhere in `src/` or `vite.config.js`.
- A historical "PR #10/#11" Radio delivery-constraint note in
  `docs/CURRENT-STATE.md` may be an artifact of upstream's own PR workflow
  and may not apply to this single-commit imported snapshot.
