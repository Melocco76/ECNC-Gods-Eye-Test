// Structured, user-facing release history for the What's New dialog. Pure
// data module — no network, no DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { APP_VERSION } from './appVersion.js';
import { RELEASES, getLatestRelease } from './releaseHistory.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('RELEASES is a non-empty array, newest first, and getLatestRelease() returns RELEASES[0]', () => {
  assert.ok(Array.isArray(RELEASES) && RELEASES.length > 0);
  assert.equal(getLatestRelease(), RELEASES[0]);
});

test('the current (newest) release reuses APP_VERSION — it is never a second, independent hardcoded version string', () => {
  assert.equal(RELEASES[0].version, APP_VERSION);
  const source = code('./releaseHistory.js');
  assert.match(source, /import \{ APP_VERSION \} from '\.\/appVersion\.js';/);
  assert.equal(/version:\s*'[\d.]+'/.test(source), false, 'the current entry\'s version is never a literal string');
});

test('exactly one release is marked latest, and it is the newest (index 0)', () => {
  const latestFlags = RELEASES.filter((release) => release.isLatest === true);
  assert.equal(latestFlags.length, 1);
  assert.equal(RELEASES[0].isLatest, true);
});

test('the v0.2.0 release has the expected date, status, and a real summary', () => {
  const latest = getLatestRelease();
  assert.equal(latest.date, '2026-10-06');
  assert.equal(latest.status, 'Production / Live');
  assert.equal(typeof latest.summary, 'string');
  assert.ok(latest.summary.length > 40);
});

test('every release carries structured, non-empty sections with real items (nothing is a placeholder)', () => {
  for (const release of RELEASES) {
    assert.ok(Array.isArray(release.sections) && release.sections.length > 0, `${release.version} has sections`);
    for (const section of release.sections) {
      assert.equal(typeof section.id, 'string');
      assert.equal(typeof section.label, 'string');
      assert.ok(Array.isArray(section.items) && section.items.length > 0, `${release.version}/${section.label} has items`);
      for (const item of section.items) assert.ok(item.length > 5, `${release.version}/${section.label} item is real text`);
    }
  }
});

test('the v0.2.0 release names the confirmed Property Boundaries work and the real duplicate-parcel-id fix, nothing invented', () => {
  const latest = getLatestRelease();
  const allItems = latest.sections.flatMap((section) => section.items).join(' \n ');
  assert.match(allItems, /Property Boundaries/i);
  assert.match(allItems, /parcel/i);
  const fixed = latest.sections.find((section) => section.id === 'fixed');
  assert.ok(fixed, 'has a Fixed section');
  assert.match(fixed.items.join(' '), /same parcel|duplicate|collision/i);
});

test('Known/Deferred only repeats an already-documented deferral (parcel click/detail for a later phase) — nothing invented', () => {
  const latest = getLatestRelease();
  const known = latest.sections.find((section) => section.id === 'known');
  assert.ok(known);
  assert.match(known.items.join(' '), /later Property Intelligence phase|click.*parcel|parcel.*click/i);
});

test('this module never references AIS or Flight Intelligence internals — it is release-note text only', () => {
  const source = code('./releaseHistory.js');
  assert.equal(/aisStreamAdapter|aisWatchdog|AISSTREAM_API_KEY/i.test(source), false);
  assert.equal(/adsbLolTrace\.js|flightHistory\.js/i.test(source), false);
});
