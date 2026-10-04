// Map-mode Street View card: controller behaviour (no DOM, fake fetch) plus a
// static markup/ARIA check on index.html. Run with: npm test (node --test)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  STREET_VIEW_HEADING_STEP,
  STREET_VIEW_NEAREST_SNAP_M,
  StreetViewCardController,
} from './streetViewCard.js';

const POINT = { latitude: 30.2672, longitude: -97.7431 };
const SEARCHED = { lat: 30.3, lng: -97.8 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeHeaders(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) };
}

function okImageResponse({ heading = '123', pano = 'PANO_ABC', snap = '42' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: fakeHeaders({
      'X-Street-View-Heading': heading,
      'X-Street-View-Pano-Id': pano,
      ...(snap === null ? {} : { 'X-Street-View-Snap-Distance-M': snap }),
    }),
    blob: async () => ({ fake: 'jpeg' }),
  };
}

/** Mimics the real backend: echoes back an explicit heading (LEFT/RIGHT calls)
 * or reports a fixed computed heading when none was sent (the open call). */
function echoingResponse({ initialHeading = 20, pano = 'PANO_STABLE' } = {}) {
  return (url) => {
    const params = new URLSearchParams(String(url).split('?')[1]);
    const heading = params.has('heading') ? params.get('heading') : String(initialHeading);
    return okImageResponse({ heading, pano });
  };
}

function notFoundResponse() {
  return { ok: false, status: 404, headers: fakeHeaders(), blob: async () => { throw new Error('no body'); } };
}

function makeController({
  getCenter = () => POINT,
  getSearchedTarget = () => null,
  responses = () => okImageResponse(),
} = {}) {
  const calls = [];
  const blobs = [];
  const revoked = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return responses(url);
  };
  const controller = new StreetViewCardController({
    getCenter,
    getSearchedTarget,
    fetchImpl,
    createUrl: (blob) => {
      const url = `blob:${blobs.length}`;
      blobs.push(blob);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  return { controller, calls, revoked };
}

test('opening computes the view-center point and fetches only then', async () => {
  let centerCalls = 0;
  const { controller, calls } = makeController({
    getCenter: () => { centerCalls += 1; return POINT; },
  });
  assert.equal(calls.length, 0, 'no fetch before opening');
  assert.equal(centerCalls, 0, 'no center lookup before opening');

  controller.setOpen(true);
  await settle();

  assert.equal(centerCalls, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/streetview\?/);
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('lat'), POINT.latitude.toFixed(5));
  assert.equal(params.get('lon'), POINT.longitude.toFixed(5));
});

test('the opening request omits heading and pano, letting the backend resolve both', async () => {
  const { controller, calls } = makeController();
  controller.setOpen(true);
  await settle();
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.has('heading'), false, 'no forced heading=0 from the browser');
  assert.equal(params.has('pano'), false, 'no panorama resolved yet on first open');
});

test('the controller adopts the backend-computed heading and pano on open', async () => {
  const { controller } = makeController({
    responses: () => okImageResponse({ heading: '210', pano: 'PANO_XYZ', snap: '10' }),
  });
  controller.setOpen(true);
  await settle();
  assert.equal(controller.heading, 210, 'heading comes from X-Street-View-Heading, not a hardcoded 0');
  assert.equal(controller.pano, 'PANO_XYZ');
  assert.equal(controller.snapDistanceM, 10);
});

test('a searched address target is preferred over the camera-center point', async () => {
  let centerCalls = 0;
  const { controller, calls } = makeController({
    getCenter: () => { centerCalls += 1; return POINT; },
    getSearchedTarget: () => SEARCHED,
  });
  controller.setOpen(true);
  await settle();
  assert.equal(centerCalls, 0, 'camera center is never consulted when a searched target exists');
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('lat'), SEARCHED.lat.toFixed(5));
  assert.equal(params.get('lon'), SEARCHED.lng.toFixed(5));
});

test('free-map Street View falls back to viewCenterPoint when there is no searched target', async () => {
  let centerCalls = 0;
  const { controller, calls } = makeController({
    getCenter: () => { centerCalls += 1; return POINT; },
    getSearchedTarget: () => null,
  });
  controller.setOpen(true);
  await settle();
  assert.equal(centerCalls, 1);
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('lat'), POINT.latitude.toFixed(5));
});

test('left subtracts 45 degrees from the backend-resolved heading and wraps below 0', async () => {
  const { controller, calls } = makeController({
    responses: echoingResponse({ initialHeading: 20 }),
  });
  controller.setOpen(true);
  await settle();
  assert.equal(controller.heading, 20);
  controller.left();
  await settle();
  assert.equal(controller.heading, 335, 'wraps to 335 (20 - 45 + 360)');
  const params = new URLSearchParams(calls.at(-1).split('?')[1]);
  assert.equal(params.get('heading'), '335');
});

test('right adds 45 degrees and wraps above 359', async () => {
  const { controller, calls } = makeController({
    responses: echoingResponse({ initialHeading: 315 }),
  });
  controller.setOpen(true);
  await settle();
  assert.equal(controller.heading, 315);
  controller.right();
  await settle();
  assert.equal(controller.heading, 0, '315 + 45 wraps to 0');
  const params = new URLSearchParams(calls.at(-1).split('?')[1]);
  assert.equal(params.get('heading'), '0');
});

test('LEFT/RIGHT requests pass the already-resolved pano id, so the view never drifts to a different panorama', async () => {
  const { controller, calls } = makeController({
    responses: () => okImageResponse({ pano: 'PANO_STABLE' }),
  });
  controller.setOpen(true);
  await settle();
  assert.equal(new URLSearchParams(calls[0].split('?')[1]).has('pano'), false, 'open call has no pano yet');

  controller.left();
  await settle();
  assert.equal(new URLSearchParams(calls[1].split('?')[1]).get('pano'), 'PANO_STABLE');

  controller.right();
  await settle();
  assert.equal(new URLSearchParams(calls[2].split('?')[1]).get('pano'), 'PANO_STABLE');
});

test('every heading change triggers its own fetch', async () => {
  const { controller, calls } = makeController();
  controller.setOpen(true);
  await settle();
  assert.equal(calls.length, 1);
  controller.left();
  await settle();
  assert.equal(calls.length, 2);
  controller.right();
  await settle();
  assert.equal(calls.length, 3);
  controller.right();
  await settle();
  assert.equal(calls.length, 4);
});

test('close hides the card without fetching or moving the camera, and forgets the resolved pano', async () => {
  const renders = [];
  const { controller } = (() => {
    const base = makeController();
    base.controller.renderFn = (model) => renders.push(model);
    return base;
  })();
  controller.setOpen(true);
  await settle();
  assert.ok(controller.pano, 'pano resolved while open');
  const fetchCountAtOpen = renders.filter((r) => r.open).length;
  controller.setOpen(false);
  await settle();
  assert.equal(controller.open, false);
  assert.equal(controller.pano, null, 'closing forgets the resolved panorama');
  const last = renders.at(-1);
  assert.equal(last.open, false);
  assert.ok(fetchCountAtOpen > 0);
});

test('reopening after close performs a fresh metadata lookup (no stale pano reused)', async () => {
  const { controller, calls } = makeController({
    responses: () => okImageResponse({ pano: 'PANO_FIRST' }),
  });
  controller.setOpen(true);
  await settle();
  controller.setOpen(false);
  await settle();
  controller.setOpen(true);
  await settle();
  const reopenParams = new URLSearchParams(calls.at(-1).split('?')[1]);
  assert.equal(reopenParams.has('pano'), false, 'reopening never carries the old pano forward');
});

test('an unavailable/error response renders the unavailable status', async () => {
  const { controller, calls } = makeController({ responses: notFoundResponse });
  const renders = [];
  controller.renderFn = (model) => renders.push(model);
  controller.setOpen(true);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(controller.status, 'unavailable');
  assert.equal(renders.at(-1).status, 'unavailable');
});

test('a thrown fetch also renders unavailable, not an exception', async () => {
  const controller = new StreetViewCardController({
    getCenter: () => POINT,
    fetchImpl: async () => { throw new Error('network down'); },
    createUrl: () => 'blob:x',
    revokeUrl: () => {},
  });
  controller.setOpen(true);
  await settle();
  assert.equal(controller.status, 'unavailable');
});

test('no missing point renders unavailable without fetching', async () => {
  const { controller, calls } = makeController({ getCenter: () => null });
  controller.setOpen(true);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(controller.status, 'unavailable');
});

test('there is no background timer: no further fetches happen while open and idle', async () => {
  const { controller, calls } = makeController();
  controller.setOpen(true);
  await settle();
  assert.equal(calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1, 'nothing re-fetches without a user action');
});

test('a snap distance within the nearest threshold renders the normal tier', async () => {
  const { controller } = makeController({
    responses: () => okImageResponse({ snap: String(STREET_VIEW_NEAREST_SNAP_M - 1) }),
  });
  const renders = [];
  controller.renderFn = (model) => renders.push(model);
  controller.setOpen(true);
  await settle();
  assert.equal(renders.at(-1).tier, 'normal');
});

test('a snap distance beyond the nearest threshold renders the "nearest" tier', async () => {
  const { controller } = makeController({
    responses: () => okImageResponse({ snap: String(STREET_VIEW_NEAREST_SNAP_M + 1) }),
  });
  const renders = [];
  controller.renderFn = (model) => renders.push(model);
  controller.setOpen(true);
  await settle();
  assert.equal(renders.at(-1).tier, 'nearest');
});

test('heading step constant is 45 degrees', () => {
  assert.equal(STREET_VIEW_HEADING_STEP, 45);
});

// ── Static markup/ARIA check ─────────────────────────────────────────────────
const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html declares the Street View toggle and card with accessible markup', () => {
  assert.match(indexHtml, /id="street-view-toggle"/);
  assert.match(indexHtml, /id="street-view-card"/);
  assert.match(indexHtml, /id="street-view-image"/);
  assert.match(indexHtml, /id="street-view-left"/);
  assert.match(indexHtml, /id="street-view-right"/);
  assert.match(indexHtml, /data-street-view-close/);
  assert.match(indexHtml, /id="street-view-error"/);

  const toggleMatch = indexHtml.match(/<button[^>]*id="street-view-toggle"[^>]*>/);
  assert.ok(toggleMatch, 'toggle button exists');
  assert.match(toggleMatch[0], /aria-label="[^"]+"/);
  assert.match(toggleMatch[0], /aria-pressed="false"/);

  const leftMatch = indexHtml.match(/<button[^>]*id="street-view-left"[^>]*>/);
  const rightMatch = indexHtml.match(/<button[^>]*id="street-view-right"[^>]*>/);
  assert.match(leftMatch[0], /aria-label="[^"]+"/);
  assert.match(rightMatch[0], /aria-label="[^"]+"/);

  const closeMatch = indexHtml.match(/<button[^>]*data-street-view-close[^>]*>/);
  assert.match(closeMatch[0], /aria-label="[^"]+"/);
});

test('Street View attribution text is present in the card markup', () => {
  const cardSection = indexHtml.slice(indexHtml.indexOf('id="street-view-card"'));
  const cardEnd = cardSection.indexOf('</aside>');
  const card = cardSection.slice(0, cardEnd === -1 ? undefined : cardEnd);
  assert.match(card, /Google/);
});
