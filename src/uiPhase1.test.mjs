// ECNC Phase 1 UI/branding pass: the classified/spy-terminal content is gone,
// the wording is plain, the scope mask defaults OFF, and the branding and
// attribution the fork owes upstream stay visible. Source/markup probes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isScopeMaskEnabled, _resetScopeMaskForTest, setScopeMaskEnabled } from './scopeMask.js';
import { DATA_CREDITS } from './data/dataCredits.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../index.html');
const hud = read('./hud.js');
const css = read('../style.css');
const pkg = JSON.parse(read('../package.json'));

const CREDIT = 'technology demonstration based on God\u2019s Eye View by Bilawal Sidhu';

test('the classified banner and fake sensor content are gone from the HUD', () => {
  for (const banned of [
    'TOP SECRET', 'NOFORN', 'SI-TK', 'KH11', 'OPS-', 'NIIRS', 'ONA:', 'COLL:', 'BAND:', 'BITS:', 'LVL:',
    'hud-rec', 'hud-classification', 'hud-bracket', 'hud-orbital', '_recBlink', 'ORB:', 'PASS:',
  ]) {
    assert.equal(hud.includes(banned), false, `hud.js must not contain ${banned}`);
  }
  assert.equal(/●\s*REC|>REC</.test(hud), false, 'no blinking REC indicator');
});

test('the default HUD keeps only real readouts and the ids other code relies on', () => {
  for (const id of ['hud-mode', 'hud-summary', 'hud-timestamp', 'hud-latlon', 'hud-mgrs', 'hud-alt', 'hud-view', 'hud-ais-vessel']) {
    assert.ok(hud.includes(`id="${id}"`), `HUD must render #${id}`);
  }
  assert.ok(html.includes('id="intel-hud"'));
  assert.ok(hud.includes('hud-top-left') && hud.includes('hud-bottom-right'), 'corner classes referenced by layout code remain');
});

test('first-run wording is plain and the spy vocabulary is retired', () => {
  assert.ok(html.includes('<p id="first-run-description">Live public data on a 3D globe.</p>'));
  for (const old of ['MISSION CONTROL', 'forbidden cockpit', 'LIVE CONTACTS', 'nearby intelligence', 'POWER UP',
    'GROUND STATION', 'SCENE SUMMARY', 'Intelligence HUD', 'first-run-scanline', 'key-setup-scanline']) {
    assert.equal(html.includes(old), false, `index.html must not contain ${old}`);
  }
  for (const fresh of ['Welcome', 'Live tracking', 'Aircraft, vessels and nearby places', 'Space launches',
    'Data sources', 'Provider settings', 'Camera summary']) {
    assert.ok(html.includes(fresh), `index.html must contain ${fresh}`);
  }
  assert.match(html, /<option value="tactical">Detailed<\/option>/);
  assert.match(html, /<option value="operator">Standard<\/option>/);
  assert.match(html, /<option value="minimal">Minimal<\/option>/);
});

test('scope defaults OFF in markup and module, and can still be enabled and restored', () => {
  assert.match(html, /<button class="pp-toggle-btn" id="scope-toggle"[^>]*aria-pressed="false"/);
  assert.equal(/id="scope-slider-row"/.test(html), true);
  assert.equal(/class="[^"]*visible[^"]*" id="scope-slider-row"/.test(html), false, 'feather row ships hidden');
  _resetScopeMaskForTest();
  assert.equal(isScopeMaskEnabled(), false);
  setScopeMaskEnabled(true); // saved-state / share-link restore path
  assert.equal(isScopeMaskEnabled(), true);
  _resetScopeMaskForTest();
  // Missing `sc` is OFF (the product default); explicit sc=0/1 always wins (behavioral
  // proof in sharelink.celestial.test.mjs). Restore and toggle keep the feather row in sync.
  const share = read('./sharelink.js');
  assert.ok(share.includes("this._scopeEnabled = false;"));
  assert.ok(share.includes("params.has('sc') ? params.get('sc') === '1' : false"));
  const ui = read('./ui.js');
  assert.equal((ui.match(/scope-slider-row'\)\?\.classList\.toggle\('visible'/g) || []).length, 3);
});

test('ECNC branding: title, brand slot, credit line, loader footer', () => {
  assert.match(html, /<title>ECNC God's Eye<\/title>/);
  assert.match(html, /<span>ECNC God's Eye<\/span><\/h1>/);
  assert.ok(html.includes('id="ecnc-brand-slot"'), 'header brand slot');
  assert.ok(html.includes('id="ecnc-loader-brand-slot"'), 'loader brand slot');
  assert.ok(html.includes('data-logo-src="/logo.svg"'), 'existing eye mark kept as the secondary mark');
  assert.ok(html.includes('Technology demonstration based on God\'s Eye View by Bilawal Sidhu'));
  assert.ok(html.includes('Tech is Secondary; People are Primary.'));
  assert.ok(html.includes('<p class="loader-credit">Based on God\'s Eye View by Bilawal Sidhu</p>'));
  assert.ok(html.includes('Initializing photorealistic world...'), 'real loader status text kept');
  assert.equal(pkg.description, 'Live data on a 3D globe');
});

test('the creator credit lives in the data-attribution lightbox and other credits are intact', () => {
  const entry = DATA_CREDITS.find((c) => c.key === 'ecnc-god-eye');
  assert.ok(entry, 'project credit registered');
  assert.ok(entry.html.includes(CREDIT));
  assert.ok(entry.html.includes('MIT'));
  for (const key of ['opensky', 'adsblol']) assert.ok(DATA_CREDITS.some((c) => c.key === key), `${key} credit kept`);
});

test('license and upstream attribution are untouched', () => {
  const license = read('../LICENSE');
  assert.match(license, /MIT License/);
  assert.match(license, /Bilawal Sidhu|Halfpixel/i);
});

test('styling: tokens, no scanlines/glow, focus and reduced motion preserved', () => {
  assert.ok(css.includes('--glass-bg: rgba(11, 18, 32, 0.88);'));
  assert.ok(css.includes('--surface: #111a2b;'));
  assert.ok(css.includes('--accent: #22c7e8;'));
  assert.ok(css.includes('--text-primary: #eef2f8;'));
  assert.ok(css.includes('--status-ok: #3ecf8e;') && css.includes('--status-warn: #f5b84b;') && css.includes('--status-bad: #ff6b6b;'));
  assert.equal(css.includes('.first-run-scanline'), false);
  assert.equal(css.includes('.key-setup-scanline'), false);
  assert.equal(/\.title-glow/.test(css), false);
  assert.ok(css.includes(':focus-visible'));
  assert.ok(/prefers-reduced-motion: reduce/.test(css));
});

test('DOM contracts other modules rely on are still present', () => {
  for (const id of ['title-bar', 'intel-hud', 'hud-toggle', 'hud-layout-select', 'scope-toggle', 'scope-slider-row',
    'first-run-launcher', 'first-run-title', 'first-run-description', 'key-setup', 'key-setup-chip', 'loading-screen',
    'cctv-summary', 'active-style-name', 'style-indicator']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must remain`);
  }
});
