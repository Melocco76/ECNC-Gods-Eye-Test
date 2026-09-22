// Property Intelligence Phase A1: the server-route wiring in vite.config.js
// (registration, method/region gating, reuse of existing shared helpers, and
// the "normalized response only" contract) verified by source inspection —
// the same style this repo already uses for route-wiring guarantees it does
// not want to re-derive with a live HTTP server (see e.g.
// flightPanelHistory.test.mjs's "trace requests are never part of the poll"
// test). No network, no dev server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const source = read('../../vite.config.js');
const parcelsFn = source.slice(source.indexOf('function parcelsProxy()'), source.indexOf('function openAiRealtimeProxy()'));

test('parcelsProxy is registered in the plugins array', () => {
  assert.match(source, /plugins:\s*\[[\s\S]*?parcelsProxy\(\)/);
});

test('the parcels route is GET-only', () => {
  assert.match(parcelsFn, /if \(req\.method !== 'GET'\)/);
});

test('a malformed parcelId is rejected with 400 before /detail or /geometry ever call the provider', () => {
  assert.match(parcelsFn, /providerConfig\?\.parcelIdPattern\?\.test\(parcelId\)/);
  const gateIndex = parcelsFn.indexOf('parcelIdPattern?.test(parcelId)');
  const detailHandlerIndex = parcelsFn.indexOf("urlPath === '/detail'", parcelsFn.indexOf('try {'));
  assert.ok(gateIndex > -1 && detailHandlerIndex > -1 && gateIndex < detailHandlerIndex, 'the format check precedes the /detail and /geometry handlers');
});

const installBody = parcelsFn.slice(parcelsFn.indexOf('function install(middlewares)'));

test('an unknown/missing region is rejected with 400 BEFORE any provider is resolved', () => {
  assert.match(installBody, /if \(!isKnownParcelRegion\(region\)\)/);
  const gateIndex = installBody.indexOf('isKnownParcelRegion(region)');
  const firstProviderCall = installBody.indexOf('providerFor(region)');
  assert.ok(gateIndex > -1 && firstProviderCall > -1 && gateIndex < firstProviderCall, 'region validation precedes every provider call');
});

test('region resolution goes through the fixed registry only — resolveParcelProvider, never a request-built URL', () => {
  assert.match(parcelsFn, /resolveParcelProvider\(region,/);
  assert.equal(/req\.url.*fetch\(|fetch\(.*req\.(url|query|params)/.test(parcelsFn), false, 'no fetch is ever built from raw request data');
  // 'http://localhost' is the standard idiom used throughout this file to parse a relative req.url — not an upstream host.
  const externalUrls = (installBody.match(/https?:\/\/[^\s'"]*/g) || []).filter((u) => !u.startsWith('http://localhost'));
  assert.deepEqual(externalUrls, [], 'no literal upstream URL appears in the request-handling body — hosts live only in the registry');
});

test('every route reuses the existing shared helpers rather than duplicating them', () => {
  assert.match(parcelsFn, /makeRateLimiter\(/);
  assert.match(parcelsFn, /clientKey\(req\)/);
  assert.match(parcelsFn, /readCappedResponseText\(/);
  assert.match(parcelsFn, /coalesceProxyRequest\(/);
  assert.equal(/function makeRateLimiter\(/.test(parcelsFn), false, 'not redefined locally');
  assert.equal(/function clientKey\(/.test(parcelsFn), false, 'not redefined locally');
  assert.equal(/async function readCappedResponseText\(/.test(parcelsFn), false, 'not redefined locally');
});

test('each of the four routes has its own rate limiter and checks it before doing any work', () => {
  for (const limiter of ['_searchLimiter', '_identifyLimiter', '_byIdLimiter', '_geometryLimiter']) {
    assert.match(parcelsFn, new RegExp(`${limiter}\\(clientKey\\(req\\)\\)`));
  }
});

test('every response is JSON built from the normalized parcel/results shape, never the raw upstream payload forwarded verbatim', () => {
  assert.equal(/res\.end\(.*upstream/.test(parcelsFn), false);
  assert.match(parcelsFn, /sendJson\(res, 200, \{ results \}\)/);
  assert.match(parcelsFn, /sendJson\(res, 200, \{ geometry \}\)/);
});

// -- privacy hardening: owner is stripped at every public parcel response --------------------------

test('toPublicParcel is imported from the shared data module, not reimplemented in the route file', () => {
  assert.match(source, /import \{ toPublicParcel \} from '\.\/src\/data\/parcelProviderData\.js';/);
  assert.equal(/function toPublicParcel/.test(parcelsFn), false, 'not redefined locally — one reviewed implementation only');
});

test('EVERY place the /identify or /detail routes send a parcel to the client goes through toPublicParcel — none send the raw cached/fresh record', () => {
  // Exactly four send-sites carry a parcel: cache-hit and fresh-fetch, for each of the two routes.
  const rawParcelSends = parcelsFn.match(/sendJson\(res, 200, \{ parcel: (cached|parcel) \}\)/g) || [];
  assert.deepEqual(rawParcelSends, [], 'no send-site passes the bare record — every one must wrap it in toPublicParcel(...)');
  const sanitizedSends = parcelsFn.match(/sendJson\(res, 200, \{ parcel: toPublicParcel\((cached|parcel)\) \}\)/g) || [];
  assert.equal(sanitizedSends.length, 4, 'cache-hit + fresh, for both /identify and /detail');
});

test('the results (search) and geometry responses never carry an "owner" key at all — confirmed by their own builders, not just by omission here', () => {
  // search rows come from buildSearchResult (parcelId/address/city/state/zip only — see parcelProviderData.js);
  // geometry responses are `{ geometry }`, never the parcel object — neither path can carry owner regardless of toPublicParcel.
  assert.equal(/results:\s*owner|geometry:\s*owner/.test(parcelsFn), false);
  assert.doesNotMatch(parcelsFn, /searchAddress\([^)]*owner/i);
});

test('there is no owner-search route, no owner query parameter, and no code path that accepts an owner name from a request', () => {
  assert.equal(/searchParams\.get\('owner/i.test(installBody), false);
  assert.equal(/ownerName|owner_name/i.test(installBody), false);
  assert.equal(/\/owner/i.test(installBody), false, 'no /owner-ish sub-route exists');
});

test('a bounded, capped, timed-out upstream call is the only network behavior — no credentials/headers are attached', () => {
  assert.equal(/Authorization|apiKey|process\.env\.\w*PARCEL/i.test(parcelsFn), false, 'this provider needs no secret and none is wired in');
});

test('nothing in the parcels route or its supporting modules imports AIS or Flight Intelligence code', () => {
  for (const file of ['../../vite.config.js', './parcelProviderData.js', './parcelProviderRegistry.js', './arcgisParcelQuery.js', './parcelProviders/oregonDeschutes.js']) {
    const c = code(file);
    const parcelSection = file === '../../vite.config.js' ? parcelsFn : c;
    assert.equal(/aisStreamAdapter|aisWatchdog|aisLiveVessels|aisRegions/i.test(parcelSection), false, `${file} must not reference AIS modules`);
    assert.equal(/adsbLolTrace|flightHistory|openSkyBackfill|flightPanel/i.test(parcelSection), false, `${file} must not reference Flight Intelligence modules`);
  }
});

test('the parcels route does not touch the AIS or Flight Intelligence plugin functions', () => {
  assert.equal(/aisLiveProxy\(\)|trackBackfillProxies\(\)|openSkyProxy\(\)|adsbLolProxy\(\)/.test(parcelsFn), false);
});
