// Server-side owner session (POST/GET/DELETE /api/admin/session) and its use to
// authorise POST /api/ais-regions. Fake token only; no network, no real socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, beforeEach, afterEach } from 'node:test';
import {
  ADMIN_LOGIN_MAX_GLOBAL,
  ADMIN_LOGIN_MAX_PER_CLIENT,
  ADMIN_LOGIN_BODY_MAX_BYTES,
  ADMIN_MAX_SESSIONS,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  constantTimeEqual,
  createAdminSessions,
  processAdminSession,
  readCookie,
} from '../scripts/adminSession.mjs';
import {
  aisCoverageController,
  aisRegionsStatusPayload,
  processAdminSessionRequest,
  processAisRegionsWrite,
  resetAdminSessionsForTest,
  resetAisCoverageForTest,
  resetAisRegionsWriteLimiterForTest,
  resetAisStreamCacheForTest,
  resetAisWatchdogPolicyForTest,
} from '../vite.config.js';

const TOKEN = 'fake-owner-token-do-not-leak-789';
const HOST = 'godseye.example.com';
const SAVED = {};
const ENV_KEYS = ['AISSTREAM_API_KEY', 'AISSTREAM_REGIONS_ENABLED', 'AIS_REGIONS_ADMIN_TOKEN', 'AISSTREAM_BOUNDING_BOXES', 'AISSTREAM_DEFAULT_REGIONS', 'NODE_ENV'];

let clients = 0;
const freshClient = () => `admin-client-${++clients}`;
const JSON_HEADERS = { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}` };

const login = (token = TOKEN, extra = {}, client = freshClient()) => processAdminSessionRequest({
  method: 'POST',
  headers: { ...JSON_HEADERS, ...extra },
  bodyText: typeof token === 'string' && token.startsWith('{') ? token : JSON.stringify({ token }),
  clientKey: client,
});
const loginRaw = (bodyText, extra = {}) => processAdminSessionRequest({
  method: 'POST', headers: { ...JSON_HEADERS, ...extra }, bodyText, clientKey: freshClient(),
});
const cookieOf = (result) => String(result.setCookie || '').split(';')[0];
const sessionHeaders = (result, extra = {}) => ({ ...JSON_HEADERS, cookie: cookieOf(result), ...extra });
const postRegions = (regions, headers, client = freshClient()) => processAisRegionsWrite({
  headers: { 'content-type': 'application/json', ...headers },
  bodyText: JSON.stringify({ regions }),
  clientKey: client,
});

beforeEach(() => {
  for (const key of ENV_KEYS) SAVED[key] = process.env[key];
  process.env.AISSTREAM_API_KEY = 'FAKE-AIS-KEY';
  process.env.AISSTREAM_REGIONS_ENABLED = '1';
  process.env.AIS_REGIONS_ADMIN_TOKEN = TOKEN;
  delete process.env.AISSTREAM_BOUNDING_BOXES;
  delete process.env.AISSTREAM_DEFAULT_REGIONS;
  delete process.env.NODE_ENV;
  resetAdminSessionsForTest();
  resetAisCoverageForTest();
  resetAisRegionsWriteLimiterForTest();
  resetAisStreamCacheForTest();
  resetAisWatchdogPolicyForTest();
});

afterEach(() => {
  resetAdminSessionsForTest();
  resetAisCoverageForTest();
  resetAisStreamCacheForTest();
  resetAisWatchdogPolicyForTest();
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

// -- login / cookie ----------------------------------------------------------------------

test('a valid token creates a session and answers with safe status only', () => {
  const result = login();
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.payload).sort(), ['authenticated', 'expiresAt']);
  assert.equal(result.payload.authenticated, true);
  const ttl = Date.parse(result.payload.expiresAt) - Date.now();
  assert.ok(ttl > 2 * 3600_000 && ttl <= 4 * 3600_000, `lifetime ${ttl}ms is about 2-4 hours`);
  assert.equal(processAdminSessionRequest({ method: 'GET', headers: sessionHeaders(result) }).payload.authenticated, true);
});

test('the token appears in neither the response body nor the cookie', () => {
  const result = login();
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(String(result.setCookie).includes(TOKEN), false);
  assert.equal(String(result.setCookie).includes(encodeURIComponent(TOKEN)), false);
  const failed = login('wrong-token');
  assert.equal(JSON.stringify(failed).includes(TOKEN), false);
  assert.equal(JSON.stringify(failed).includes('wrong-token'), false, 'even a wrong guess is not echoed');
});

test('the cookie is HttpOnly, SameSite=Strict, Path=/ with a 2-4 hour Max-Age', () => {
  const cookie = login().setCookie;
  assert.match(cookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=[A-Za-z0-9_-]{40,}`));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\//);
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
  assert.ok(maxAge >= 2 * 3600 && maxAge <= 4 * 3600);
  assert.equal(/Domain=/i.test(cookie), false, 'host-only cookie');
});

test('the cookie is Secure in production and behind TLS, and not on plain local http', () => {
  assert.equal(/; Secure/.test(login().setCookie), false, 'plain http dev');
  process.env.NODE_ENV = 'production';
  assert.match(login().setCookie, /; Secure/);
  delete process.env.NODE_ENV;
  assert.match(login(TOKEN, { 'x-forwarded-proto': 'https' }).setCookie, /; Secure/);
  process.env.NODE_ENV = 'production';
  assert.match(login(TOKEN, {}).setCookie, /HttpOnly/);
  assert.match(processAdminSessionRequest({ method: 'DELETE', headers: JSON_HEADERS }).setCookie, /; Secure/, 'the clearing cookie matches');
});

test('every login mints a different random opaque session id', () => {
  const ids = new Set();
  for (let i = 0; i < 6; i += 1) ids.add(cookieOf(login()));
  assert.equal(ids.size, 6);
  for (const id of ids) assert.equal(id.includes('token'), false);
});

test('an invalid token is a generic 401 with no cookie; the reason is never revealed', () => {
  const generic = login('nope');
  assert.equal(generic.status, 401);
  assert.equal(generic.setCookie, undefined);
  const variants = [login(''), login('{}'), login('{"token":42}'), login('{"token":null}'), login('x'.repeat(300)), login(`${TOKEN}x`), login(TOKEN.slice(1))];
  for (const v of variants) {
    assert.equal(v.status, 401);
    assert.deepEqual(v.payload, generic.payload, 'identical body for every failure');
    assert.equal(v.setCookie, undefined);
  }
  delete process.env.AIS_REGIONS_ADMIN_TOKEN;
  const unconfigured = login(TOKEN);
  assert.equal(unconfigured.status, 401);
  assert.deepEqual(unconfigured.payload, generic.payload, 'an unconfigured server looks the same as a wrong token');
});

test('the token comparison is constant-time (hashed, timingSafeEqual) and exact', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false, 'different lengths do not throw or short-circuit');
  const source = fs.readFileSync(new URL('../scripts/adminSession.mjs', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual\(digest\(a\), digest\(b\)\)/);
});

// -- rate limit, size, format, origin ----------------------------------------------------------

test('login attempts are rate limited per client and globally', () => {
  const client = freshClient();
  const codes = [];
  for (let i = 0; i < ADMIN_LOGIN_MAX_PER_CLIENT + 3; i += 1) codes.push(login('wrong', {}, client).status);
  assert.equal(codes.filter((c) => c === 401).length, ADMIN_LOGIN_MAX_PER_CLIENT);
  assert.ok(codes.slice(ADMIN_LOGIN_MAX_PER_CLIENT).every((c) => c === 429));
  assert.equal(login(TOKEN, {}, client).status, 429, 'even the right token waits once limited');
  assert.equal(login(TOKEN, {}, freshClient()).status, 200, 'other clients are unaffected');
  resetAdminSessionsForTest();
  let limited = 0;
  for (let i = 0; i < ADMIN_LOGIN_MAX_GLOBAL + 5; i += 1) if (login('wrong', {}, freshClient()).status === 429) limited += 1;
  assert.ok(limited > 0, 'rotating client keys cannot dodge the global cap');
});

test('the login body is size limited, JSON only and must be an object', () => {
  assert.equal(login(JSON.stringify({ token: 'x'.repeat(ADMIN_LOGIN_BODY_MAX_BYTES) })).status, 413);
  assert.equal(login(TOKEN, { 'content-type': 'text/plain' }).status, 415);
  assert.equal(login(TOKEN, { 'content-type': undefined }).status, 415);
  assert.equal(loginRaw('{not json').status, 400);
  assert.equal(loginRaw('[]').status, 400);
  assert.equal(loginRaw('"string"').status, 400);
  const middleware = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(middleware, /ADMIN_LOGIN_BODY_MAX_BYTES \* 2\) \{\s*overflowed = true;/, 'the HTTP layer stops reading an oversized body');
});

test('login and logout only accept same-origin browser requests', () => {
  assert.equal(login(TOKEN, { origin: 'https://evil.example' }).status, 403);
  assert.equal(login(TOKEN, { origin: 'not a url' }).status, 403);
  assert.equal(login(TOKEN, { origin: `https://${HOST}` }).status, 200);
  const { origin: _o, ...noOrigin } = JSON_HEADERS;
  assert.equal(processAdminSessionRequest({ method: 'POST', headers: noOrigin, bodyText: JSON.stringify({ token: TOKEN }), clientKey: freshClient() }).status, 200, 'non-browser callers send no Origin');
  const session = login();
  assert.equal(processAdminSessionRequest({ method: 'DELETE', headers: sessionHeaders(session, { origin: 'https://evil.example' }) }).status, 403);
  assert.equal(processAdminSessionRequest({ method: 'GET', headers: sessionHeaders(session) }).payload.authenticated, true, 'a cross-origin logout did nothing');
  assert.equal(processAdminSessionRequest({ method: 'PUT', headers: JSON_HEADERS }).status, 405);
});

// -- session lifetime ------------------------------------------------------------------------

test('GET reports only authenticated and expiresAt', () => {
  const anonymous = processAdminSessionRequest({ method: 'GET', headers: JSON_HEADERS });
  assert.deepEqual(anonymous.payload, { authenticated: false, expiresAt: null });
  const forged = processAdminSessionRequest({ method: 'GET', headers: { ...JSON_HEADERS, cookie: `${ADMIN_SESSION_COOKIE}=forged-value` } });
  assert.deepEqual(forged.payload, { authenticated: false, expiresAt: null });
  const signedIn = processAdminSessionRequest({ method: 'GET', headers: sessionHeaders(login()) });
  assert.deepEqual(Object.keys(signedIn.payload).sort(), ['authenticated', 'expiresAt']);
});

test('sessions expire and are pruned; an expired session is rejected', () => {
  let clock = 1_000_000;
  const sessions = createAdminSessions({ now: () => clock, getToken: () => TOKEN });
  const first = sessions.login(TOKEN, 'c1');
  assert.equal(first.ok, true);
  assert.ok(sessions.validate(first.id));
  clock += ADMIN_SESSION_TTL_MS - 1;
  assert.ok(sessions.validate(first.id), 'still valid just before expiry');
  clock += 2;
  assert.equal(sessions.validate(first.id), null, 'rejected once expired');
  assert.equal(sessions.size(), 0, 'and pruned');
  const request = (headers) => processAdminSession(sessions, { method: 'GET', headers });
  const second = sessions.login(TOKEN, 'c2');
  assert.equal(request({ cookie: `${ADMIN_SESSION_COOKIE}=${second.id}` }).payload.authenticated, true);
  clock += ADMIN_SESSION_TTL_MS + 1;
  assert.equal(request({ cookie: `${ADMIN_SESSION_COOKIE}=${second.id}` }).payload.authenticated, false);
});

test('the number of live sessions is capped and expired ones never count', () => {
  let clock = 5_000;
  const sessions = createAdminSessions({ now: () => clock, getToken: () => TOKEN });
  const ids = [];
  for (let i = 0; i < ADMIN_MAX_SESSIONS + 3; i += 1) ids.push(sessions.login(TOKEN, `cap-${i}`).id);
  assert.equal(sessions.size(), ADMIN_MAX_SESSIONS);
  assert.equal(sessions.validate(ids[0]), null, 'the oldest is evicted');
  assert.ok(sessions.validate(ids.at(-1)));
});

test('logout invalidates the server-side session and clears the cookie', () => {
  const session = login();
  const headers = sessionHeaders(session);
  const out = processAdminSessionRequest({ method: 'DELETE', headers });
  assert.equal(out.status, 200);
  assert.deepEqual(out.payload, { authenticated: false, expiresAt: null });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.match(out.setCookie, /HttpOnly/);
  assert.equal(processAdminSessionRequest({ method: 'GET', headers }).payload.authenticated, false, 'the old cookie no longer works');
  assert.equal(postRegions(['gulf'], headers).status, 401, 'nor does it authorise region writes');
});

test('a login never adopts a caller-supplied id and retires the previous session', () => {
  const first = login();
  const second = processAdminSessionRequest({
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie: `${ADMIN_SESSION_COOKIE}=attacker-chosen-id` },
    bodyText: JSON.stringify({ token: TOKEN }),
    clientKey: freshClient(),
  });
  assert.equal(cookieOf(second).includes('attacker-chosen-id'), false, 'fixation: a fresh id is always issued');
  const rotated = processAdminSessionRequest({
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie: cookieOf(first) },
    bodyText: JSON.stringify({ token: TOKEN }),
    clientKey: freshClient(),
  });
  assert.notEqual(cookieOf(rotated), cookieOf(first));
  assert.equal(processAdminSessionRequest({ method: 'GET', headers: sessionHeaders(first) }).payload.authenticated, false, 'the old id is dead');
  assert.equal(processAdminSessionRequest({ method: 'GET', headers: sessionHeaders(rotated) }).payload.authenticated, true);
});

test('the store keeps only a digest of the id and an expiry - never the token', () => {
  const source = fs.readFileSync(new URL('../scripts/adminSession.mjs', import.meta.url), 'utf8');
  assert.match(source, /sessions\.set\(keyOf\(id\), expiresAt\)/);
  assert.equal(/sessions\.set\([^)]*(expected|supplied|token)/i.test(source), false);
  assert.match(source, /PROCESS-LOCAL/);
  assert.match(source, /max-instances=1/);
  assert.match(source, /shared storage or a different authentication/);
});

test('cookie parsing finds our cookie among others and rejects look-alikes', () => {
  assert.equal(readCookie({ cookie: `a=1; ${ADMIN_SESSION_COOKIE}=abc; b=2` }), 'abc');
  assert.equal(readCookie({ cookie: `x${ADMIN_SESSION_COOKIE}=abc` }), null);
  assert.equal(readCookie({}), null);
});

test('nothing in the login path is ever logged', () => {
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    const ok = login();
    login('a-wrong-guess-value');
    processAdminSessionRequest({ method: 'GET', headers: sessionHeaders(ok) });
    processAdminSessionRequest({ method: 'DELETE', headers: sessionHeaders(ok) });
    postRegions(['gulf'], sessionHeaders(ok));
  } finally {
    Object.assign(console, originals);
  }
  const all = lines.join('\n');
  assert.equal(all.includes(TOKEN), false);
  assert.equal(all.includes('a-wrong-guess-value'), false);
  assert.equal(all.includes(ADMIN_SESSION_COOKIE), false);
});

// -- POST /api/ais-regions authorisation ------------------------------------------------------

test('a public, unauthenticated POST is refused', () => {
  assert.equal(postRegions(['gulf'], { host: HOST }).status, 401);
  assert.equal(postRegions(['gulf'], { host: HOST, cookie: `${ADMIN_SESSION_COOKIE}=forged` }).status, 401);
  delete process.env.AIS_REGIONS_ADMIN_TOKEN;
  assert.equal(postRegions(['gulf'], { host: HOST }).status, 403, 'and with no token configured writes are off entirely');
  assert.deepEqual(aisCoverageController().getDesired(), ['gulf'], 'nothing changed');
});

test('an authenticated owner session is accepted and applies the regions', () => {
  aisCoverageController().markSubscribed();
  const session = login();
  const result = postRegions(['gulf', 'east-coast'], sessionHeaders(session));
  assert.equal(result.status, 202);
  assert.deepEqual(result.payload.desired, ['gulf', 'east-coast']);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  aisCoverageController().dispose();
});

test('a cookie-authorised write must come from this site: Origin is required and must match', () => {
  const session = login();
  const { origin: _o, ...noOrigin } = sessionHeaders(session);
  assert.equal(postRegions(['gulf'], noOrigin).status, 403, 'no Origin');
  assert.equal(postRegions(['gulf'], sessionHeaders(session, { origin: 'https://evil.example' })).status, 403);
  assert.equal(postRegions(['gulf'], sessionHeaders(session)).status, 202);
});

test('the CLI header token path still works, and the browser never needs it', () => {
  const headers = { 'x-gev-admin-token': TOKEN, 'content-type': 'application/json' };
  assert.equal(postRegions(['gulf'], headers).status, 202);
  assert.equal(postRegions(['gulf'], { ...headers, 'x-gev-admin-token': 'wrong' }).status, 401);
});

test('a session stops authorising as soon as the server-side token is removed', () => {
  const session = login();
  delete process.env.AIS_REGIONS_ADMIN_TOKEN;
  assert.equal(postRegions(['gulf'], sessionHeaders(session)).status, 403);
});

test('an expired session cookie is rejected for region writes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const session = login();
  assert.equal(postRegions(['gulf'], sessionHeaders(session)).status, 202);
  t.mock.timers.tick(ADMIN_SESSION_TTL_MS + 1000);
  resetAisRegionsWriteLimiterForTest();
  assert.equal(postRegions(['gulf'], sessionHeaders(session)).status, 401);
});

test('all region validation still applies to an owner session', () => {
  const headers = sessionHeaders(login());
  assert.equal(postRegions(['atlantis'], headers).status, 400);
  assert.equal(postRegions([], headers).status, 400, 'minimum 1');
  assert.equal(postRegions(['gulf', 'east-coast', 'west-coast'], headers).status, 400, 'maximum 2');
  assert.equal(postRegions([{ id: 'gulf', boxes: [[[-90, -180], [90, 180]]] }], headers).status, 400, 'no arbitrary boxes');
  const legacy = () => { delete process.env.AISSTREAM_REGIONS_ENABLED; process.env.AISSTREAM_BOUNDING_BOXES = '[[[27.5,-96.5],[30.5,-92.5]]]'; };
  legacy();
  assert.equal(postRegions(['gulf'], headers).status, 409, 'legacy mode refuses writes even for the owner');
});

test('a successful owner update leaves the feed alone: no reconnect, one controller, same socket path', () => {
  const before = aisRegionsStatusPayload().connection.reconnectAttempt;
  const headers = sessionHeaders(login());
  aisCoverageController().markSubscribed();
  assert.equal(postRegions(['gulf', 'east-coast'], headers).status, 202);
  assert.equal(aisRegionsStatusPayload().connection.reconnectAttempt, before, 'no reconnect attempt was started');
  assert.equal(aisCoverageController(), aisCoverageController(), 'a single coverage controller');
  aisCoverageController().dispose();
});

// -- wiring ---------------------------------------------------------------------------------

test('the session route is mounted for dev and preview and never caches', () => {
  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const install = source.indexOf('function aisLiveProxy()');
  const mount = source.indexOf("'/api/admin/session'", install);
  assert.ok(mount > install, 'mounted inside the shared install()');
  const block = source.slice(mount, mount + 1500);
  assert.match(block, /Cache-Control', 'no-store'/);
  assert.match(block, /Set-Cookie/);
});

test('only the server ever reads AIS_REGIONS_ADMIN_TOKEN', () => {
  for (const file of ['../src/data/ownerCoverage.js', '../src/ownerSignInDialog.js', '../src/data/manager.js', '../src/data/aisLiveVessels.js', '../src/ui.js', '../src/main.js', '../index.html']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(/AIS_REGIONS_ADMIN_TOKEN|x-gev-admin-token/i.test(source), false, file);
  }
});
