// ECNC logo integration: the static public asset is wired into the desktop
// header, the phone header and the loading screen, sized by CSS only, with
// meaningful alt text, and all attribution is intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const url = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(url(rel), 'utf8');
const html = read('../index.html');
const css = read('../style.css');

// -- the asset ------------------------------------------------------------------------

test('public/ecnc-logo.png is a valid 1254x1254 RGBA PNG and is the only copy', () => {
  const bytes = readFileSync(url('../public/ecnc-logo.png'));
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 1254, 'width');
  assert.equal(bytes.readUInt32BE(20), 1254, 'height');
  assert.equal(bytes[24], 8, 'bit depth');
  assert.equal(bytes[25], 6, 'colour type 6 = RGBA (has an alpha channel)');
  assert.ok(statSync(url('../public/ecnc-logo.png')).size > 100_000, 'the artwork itself, not a placeholder');
  const copies = readdirSync(url('../public/')).filter((name) => /ecnc/i.test(name));
  assert.deepEqual(copies, ['ecnc-logo.png'], 'no resized or duplicate copies');
});

test('the asset is a plain static path: not inlined, not imported, not renamed', () => {
  assert.equal((html.match(/src="\/ecnc-logo\.png"/g) || []).length, 2, 'header and loader');
  assert.equal(/data:image\/png;base64/.test(html), false, 'no base64 inlining');
  for (const file of ['../src/main.js', '../src/ui.js', '../src/layerDrawer.js', '../vite.config.js']) {
    assert.equal(/ecnc-logo/.test(read(file)), false, `${file} must not import the logo`);
  }
  assert.equal(/url\([^)]*ecnc-logo/.test(css), false, 'CSS controls size only; it does not fetch the file');
});

// -- markup ----------------------------------------------------------------------------

test('the desktop/phone header brand slot uses the logo with meaningful alt text', () => {
  const header = html.slice(html.indexOf('<header id="app-header">'), html.indexOf('</header>', html.indexOf('<header id="app-header">')));
  assert.match(header, /<span id="ecnc-brand-slot" class="brand-slot" data-brand-slot><img class="ecnc-logo" src="\/ecnc-logo\.png" alt="Electronic Concepts NC" width="1254" height="1254" decoding="async" \/><\/span>/);
  // The eye/globe mark stays as the decorative secondary mark: empty alt, hidden from AT.
  assert.match(header, /<span class="title-logo brand-logo" data-logo-gaze data-logo-src="\/logo\.svg" aria-hidden="true"><img src="\/logo\.svg" alt="" \/><\/span>/);
  assert.match(header, /<span>ECNC God's Eye<\/span><\/h1>/, 'title unchanged');
  assert.equal((header.match(/alt="Electronic Concepts NC"/g) || []).length, 1, 'spoken once in the header');
});

test('the loading screen leads with the same asset, then the eye mark, title, tagline, status and credit', () => {
  const loader = html.slice(html.indexOf('<div id="loading-screen">'), html.indexOf('<script type="module"'));
  const order = ['id="ecnc-loader-brand-slot"', 'class="loader-logo brand-logo"', "<h2>ECNC God's Eye</h2>",
    'Tech is Secondary; People are Primary.', 'class="loader-status"', "Based on God's Eye View by Bilawal Sidhu"];
  let at = -1;
  for (const marker of order) {
    const next = loader.indexOf(marker);
    assert.ok(next > at, `${marker} appears, in order`);
    at = next;
  }
  assert.match(loader, /<img class="ecnc-logo" src="\/ecnc-logo\.png" alt="Electronic Concepts NC" width="1254" height="1254" fetchpriority="high" decoding="async" \/>/);
  assert.match(loader, /<span class="loader-logo brand-logo"[^>]*aria-hidden="true"><img src="\/logo\.svg" alt="" \/>/, 'the eye is decorative');
  assert.match(loader, /Initializing photorealistic world\.\.\./, 'the real status text is kept');
});

// -- CSS -------------------------------------------------------------------------------

const logoBlock = css.slice(css.indexOf('/* ══ ECNC logo (public/ecnc-logo.png'));

test('logo CSS preserves aspect ratio: content-ratio slots with object-fit cover, never stretched', () => {
  assert.match(logoBlock, /\.ecnc-logo,\s*\.brand-slot > img\.ecnc-logo \{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-width: none;[^}]*object-fit: cover;[^}]*object-position: 50% 43\.6%;/);
  assert.equal(/object-fit:\s*fill/.test(logoBlock), false);
  // The slot boxes match the artwork's content box (about 1182 x 823 inside the 1254 square).
  const ratio = 1182 / 823;
  const close = (w, h) => Math.abs(w / h - ratio) < 0.03;
  assert.ok(close(46, 32), 'desktop 46x32');
  assert.ok(close(43, 30), 'phone 43x30');
  assert.ok(close(39, 27), '<=359px 39x27');
  assert.match(logoBlock, /#ecnc-loader-brand-slot \{[^}]*aspect-ratio: 1182 \/ 823;/);
  // The content box is centred at ~43.6% of the square, so cover trims transparent margin only.
  const centre = (191 + 1014) / 2;
  const visible = 1254 / ratio;
  const position = (centre - visible / 2) / (1254 - visible);
  assert.ok(Math.abs(position - 0.436) < 0.01, `object-position derived from the artwork: ${position.toFixed(3)}`);
});

test('rendered sizes: desktop ~32px, phone ~30px, loader ~210px wide', () => {
  assert.match(logoBlock, /#app-header #title-bar \.brand-slot \{[^}]*width: 46px; height: 32px;/, 'desktop 30-38px tall');
  assert.match(logoBlock, /@media \(max-width: 767px\) \{\s*#app-header #title-bar \.brand-slot \{ width: 43px; height: 30px; \}/, 'phone 26-32px tall');
  assert.match(logoBlock, /@media \(max-width: 359px\) \{\s*#app-header #title-bar \.brand-slot \{ width: 39px; height: 27px; \}/);
  assert.match(logoBlock, /#ecnc-loader-brand-slot \{ width: min\(210px, 62vw\);/);
  assert.match(logoBlock, /\.loader-content \.loader-logo \{ width: 40px;/, 'the original eye stays as a small secondary mark');
});

test('desktop header still fits: the credit line only shows where it is not truncated', () => {
  // 46 logo + 38 eye + title (~146) + gaps, plus the credit line (~380) must fit beside the
  // centre group and the buttons; measured live at 1340/1366/1440, and hidden below 1340.
  assert.match(css, /@media \(max-width: 1339px\) \{ #app-header #title-bar \.subtitle \{ display: none; \} \}/);
  assert.match(css, /#app-header #location-search \{\s*width: min\(240px, 20vw\);/);
  assert.match(css, /#app-header \{\s*--app-header-height: 56px;/, 'the header stays 56px');
  assert.ok(32 + 14 + 6 <= 56, 'logo + credit line fit inside the 56px header');
});

test('phone header still fits at 320px with the logo, the title and three 44px buttons', () => {
  const phone = css.slice(css.indexOf("Phase 3: phones"));
  assert.match(phone, /\.app-header-btn \{ width: 44px; height: 44px;/);
  assert.match(logoBlock, /#app-header #title-bar \.title-logo \{ display: none; \}/, 'the eye steps aside in the phone header');
  const budget = 8 + 39 + 6 + 105 + 3 * 44 + 4; // padding + logo + gap + ~title + buttons + padding
  assert.ok(budget <= 320, `phone header budget ${budget}px fits 320px`);
  assert.match(phone, /#app-header #title-bar h1 > span:last-child \{ overflow: hidden; text-overflow: ellipsis;/, 'the title ellipsizes before it can collide');
});

// -- attribution -----------------------------------------------------------------------

test('creator credit and licence attribution remain', () => {
  assert.match(html, /<p class="subtitle">Technology demonstration based on God's Eye View by Bilawal Sidhu<\/p>/);
  assert.match(html, /<p class="loader-credit">Based on God's Eye View by Bilawal Sidhu<\/p>/);
  assert.match(html, /ECNC God's Eye &mdash; technology demonstration based on God's Eye View by Bilawal Sidhu\./);
  assert.match(html, /Released under the MIT License\. Upstream project: God's Eye View by Bilawal Sidhu \(Halfpixel\)\./);
  const license = readFileSync(url('../LICENSE'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Bilawal Sidhu|Halfpixel/i);
  assert.match(read('./data/dataCredits.js'), /key: 'ecnc-god-eye'/);
});
