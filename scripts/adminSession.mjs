/**
 * @module adminSession
 * @description Server-only owner session for the AIS coverage controls.
 *
 * The owner types the server-side secret (`AIS_REGIONS_ADMIN_TOKEN`) once into a
 * sign-in dialog. The server checks it in constant time, then hands the browser
 * an opaque random session id in an HttpOnly cookie. From then on the browser
 * authenticates with that cookie only: the token is never stored by the page,
 * never put in a URL, and never appears in a response or a cookie.
 *
 * SESSIONS ARE PROCESS-LOCAL. They live in this process's memory: a restart
 * signs everyone out, and a second Cloud Run instance would not know about a
 * session created on the first (the owner would appear signed out at random).
 * The service is deployed with max-instances=1. If it is ever scaled beyond one
 * instance this mechanism needs shared storage or a different authentication
 * system - it must not be assumed to work across instances.
 *
 * Nothing here logs. In particular no request header, cookie or token is ever
 * written to a log line.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'gev_owner';
export const ADMIN_SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours, fixed (not sliding)
export const ADMIN_MAX_SESSIONS = 8;
export const ADMIN_LOGIN_BODY_MAX_BYTES = 1024;
export const ADMIN_TOKEN_MAX_LENGTH = 256;
/** Login attempts (success or failure): per client and across all clients. */
export const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const ADMIN_LOGIN_MAX_PER_CLIENT = 8;
export const ADMIN_LOGIN_MAX_GLOBAL = 40;

const digest = (value) => createHash('sha256').update(String(value)).digest();
const GENERIC_DENIAL = { error: 'Authentication failed.' };

/** Constant-time string comparison (both sides hashed to equal length first). */
export function constantTimeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

/** Read one cookie value from a `Cookie` header, or null. */
export function readCookie(headers, name = ADMIN_SESSION_COOKIE) {
  const raw = headers?.cookie;
  const header = Array.isArray(raw) ? raw.join(';') : raw;
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/** Same-origin check. `required` refuses a request that carries no Origin at all. */
export function originMatchesHost(headers, { required = false } = {}) {
  const origin = headers?.origin;
  if (!origin) return !required;
  try {
    return new URL(String(origin)).host === String(headers.host || '');
  } catch {
    return false;
  }
}

/** Should the cookie carry `Secure`? Always in production or behind TLS. */
export function cookieShouldBeSecure(headers, env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  const proto = headers?.['x-forwarded-proto'];
  return String(Array.isArray(proto) ? proto[0] : proto || '').split(',')[0].trim().toLowerCase() === 'https';
}

export function buildSessionCookie(id, { secure, maxAgeSeconds }) {
  const parts = [`${ADMIN_SESSION_COOKIE}=${id}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedCookie({ secure }) {
  return buildSessionCookie('', { secure, maxAgeSeconds: 0 });
}

/**
 * @param {{ now?: () => number, ttlMs?: number, getToken?: () => string|undefined }} [options]
 */
export function createAdminSessions({ now = () => Date.now(), ttlMs = ADMIN_SESSION_TTL_MS, getToken = () => process.env.AIS_REGIONS_ADMIN_TOKEN } = {}) {
  // sha256(session id) -> expiry (ms). The raw id only ever exists in the cookie;
  // the token is never stored anywhere in this object.
  const sessions = new Map();
  const attempts = new Map(); // clientKey -> number[]
  let globalAttempts = [];

  const keyOf = (id) => digest(id).toString('hex');

  function prune() {
    const t = now();
    for (const [key, expiry] of sessions) if (expiry <= t) sessions.delete(key);
  }

  function allowAttempt(client) {
    const t = now();
    globalAttempts = globalAttempts.filter((at) => t - at < ADMIN_LOGIN_WINDOW_MS);
    const recent = (attempts.get(client) || []).filter((at) => t - at < ADMIN_LOGIN_WINDOW_MS);
    if (recent.length >= ADMIN_LOGIN_MAX_PER_CLIENT || globalAttempts.length >= ADMIN_LOGIN_MAX_GLOBAL) {
      attempts.set(client, recent);
      return false;
    }
    recent.push(t);
    globalAttempts.push(t);
    attempts.set(client, recent);
    if (attempts.size > 500) {
      for (const [key, times] of attempts) if (!times.some((at) => t - at < ADMIN_LOGIN_WINDOW_MS)) attempts.delete(key);
    }
    return true;
  }

  function issue() {
    prune();
    while (sessions.size >= ADMIN_MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = now() + ttlMs;
    sessions.set(keyOf(id), expiresAt);
    return { id, expiresAt };
  }

  return {
    /** The session behind a raw id, or null (unknown or expired). */
    validate(id) {
      if (typeof id !== 'string' || !id) return null;
      const expiry = sessions.get(keyOf(id));
      if (expiry === undefined) return null;
      if (expiry <= now()) {
        sessions.delete(keyOf(id));
        return null;
      }
      return { expiresAt: expiry };
    },
    destroy(id) {
      if (typeof id === 'string' && id) sessions.delete(keyOf(id));
    },
    /**
     * @returns {{ok: true, id: string, expiresAt: number} | {ok: false, status: 401|429}}
     */
    login(suppliedToken, client, previousId = null) {
      if (!allowAttempt(client)) return { ok: false, status: 429 };
      const expected = getToken();
      const supplied = typeof suppliedToken === 'string' ? suppliedToken : '';
      const valid = Boolean(expected) && supplied.length > 0 && supplied.length <= ADMIN_TOKEN_MAX_LENGTH
        && constantTimeEqual(supplied, expected);
      if (!valid) return { ok: false, status: 401 };
      // Session fixation: never adopt a caller-supplied id; retire any old one.
      this.destroy(previousId);
      return { ok: true, ...issue() };
    },
    ttlMs,
    prune,
    size() {
      prune();
      return sessions.size;
    },
    reset() {
      sessions.clear();
      attempts.clear();
      globalAttempts = [];
    },
  };
}

/**
 * One request against /api/admin/session, HTTP-free: returns
 * `{status, payload, setCookie?}`.
 *
 * @param {ReturnType<typeof createAdminSessions>} sessions
 * @param {{method: string, headers: object, bodyText?: string, clientKey?: string}} request
 */
export function processAdminSession(sessions, { method, headers = {}, bodyText = '', clientKey = 'local' }) {
  const secure = cookieShouldBeSecure(headers);
  const presented = readCookie(headers);

  if (method === 'GET') {
    const session = sessions.validate(presented);
    return {
      status: 200,
      payload: session
        ? { authenticated: true, expiresAt: new Date(session.expiresAt).toISOString() }
        : { authenticated: false, expiresAt: null },
    };
  }

  if (method !== 'POST' && method !== 'DELETE') {
    return { status: 405, payload: { error: 'Method not allowed' } };
  }
  if (!originMatchesHost(headers)) return { status: 403, payload: { error: 'Cross-origin request refused.' } };

  if (method === 'DELETE') {
    sessions.destroy(presented);
    return { status: 200, payload: { authenticated: false, expiresAt: null }, setCookie: buildClearedCookie({ secure }) };
  }

  if (!/^application\/json\b/i.test(String(headers['content-type'] || ''))) {
    return { status: 415, payload: { error: 'Content-Type must be application/json.' } };
  }
  if (Buffer.byteLength(bodyText, 'utf8') > ADMIN_LOGIN_BODY_MAX_BYTES) {
    return { status: 413, payload: { error: 'Request body too large.' } };
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, payload: { error: 'Body must be valid JSON.' } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: { error: 'Body must be a JSON object.' } };
  }
  const result = sessions.login(body.token, clientKey, presented);
  if (!result.ok) {
    return result.status === 429
      ? { status: 429, payload: { error: 'Too many attempts. Try again later.' } }
      : { status: 401, payload: GENERIC_DENIAL };
  }
  return {
    status: 200,
    payload: { authenticated: true, expiresAt: new Date(result.expiresAt).toISOString() },
    setCookie: buildSessionCookie(result.id, { secure, maxAgeSeconds: Math.floor(sessions.ttlMs / 1000) }),
  };
}
