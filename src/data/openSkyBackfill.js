/**
 * @module openSkyBackfill
 * @description Gate for the civil aircraft's OpenSky /tracks trail backfill.
 *
 * When the server runs with OpenSky disabled (GEV_DISABLE_OPENSKY=1) the live
 * poll is answered from the adsb.lol fallback and says so in the
 * `x-opensky-auth-reason` header (`opensky_disabled_*`). In that mode the
 * /api/opensky-track route can only fail (502 on Cloud Run), so the client does
 * not ask. Anywhere OpenSky is genuinely enabled the reason is something else
 * (or absent), and the backfill stays exactly as before.
 */

/** @param {string|null|undefined} authReason lower-cased reason header of the last live poll */
export function isOpenSkyDisabledReason(authReason) {
  return typeof authReason === 'string' && authReason.trim().toLowerCase().startsWith('opensky_disabled');
}

/** Should the OpenSky /tracks backfill be attempted for the tracked civil aircraft? */
export function shouldBackfillFromOpenSky(authReason) {
  return !isOpenSkyDisabledReason(authReason);
}
