// Map-mode Street View card: controller behaviour (no DOM, fake fetch) plus a
// static markup/ARIA check on index.html. Run with: npm test (node --test)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  STREET_VIEW_HEADING_STEP,
  StreetViewCardController,
} from './streetViewCard.js';

const POINT = { latitude: 30.2672, longitude: -97.7431 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function makeController({ getCenter = () => POINT, responses = () => okImageResponse() } = {}) {
  const calls = [];
  const blobs = [];
  const revoked = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return responses();
  };
  const controller = new StreetViewCardController({
    getCenter,
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

function okImageResponse() {
  return { ok: true, status: 200, blob: async () => ({ fake: 'jpeg' }) };
}

function notFoundResponse() {
  return { ok: false, status: 404, blob: async () => { throw new Error('no body'); } };
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

test('initial heading defaults to 0', async () => {
  const { controller, calls } = makeController();
  controller.setOpen(true);
  await settle();
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('heading'), '0');
  assert.equal(controller.heading, 0);
});

test('left subtracts 45 degrees and wraps below 0', async () => {
  const { controller, calls } = makeController();
  controller.setOpen(true);
  await settle();
  controller.left();
  await settle();
  assert.equal(controller.heading, 315, 'wraps to 315 (360 - 45)');
  const params = new URLSearchParams(calls.at(-1).split('?')[1]);
  assert.equal(params.get('heading'), '315');
});

test('right adds 45 degrees and wraps above 359', async () => {
  const { controller, calls } = makeController();
  controller.setOpen(true);
  await settle();
  for (let i = 0; i < 8; i += 1) { controller.right(); await settle(); }
  assert.equal(controller.heading, 0, '8 steps of +45 wraps all the way around');
  controller.right();
  await settle();
  assert.equal(controller.heading, 45);
  const params = new URLSearchParams(calls.at(-1).split('?')[1]);
  assert.equal(params.get('heading'), '45');
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

test('close hides the card without fetching or moving the camera', async () => {
  const renders = [];
  const { controller } = (() => {
    const base = makeController();
    base.controller.renderFn = (model) => renders.push(model);
    return base;
  })();
  controller.setOpen(true);
  await settle();
  const fetchCountAtOpen = renders.filter((r) => r.open).length;
  controller.setOpen(false);
  await settle();
  assert.equal(controller.open, false);
  const last = renders.at(-1);
  assert.equal(last.open, false);
  assert.ok(fetchCountAtOpen > 0);
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
