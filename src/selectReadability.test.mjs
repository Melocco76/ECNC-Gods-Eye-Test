// Native <select> menus must be readable on the dark theme (no white-on-white popup),
// for every select in the app, and must hand colours back to the system in
// forced-colors (high-contrast) mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const block = css.slice(css.indexOf('/* ══ Readable native selects'));
const forcedAt = block.indexOf('@media (forced-colors: active)');
const forced = block.slice(forcedAt);
const base = block.slice(0, forcedAt);

const rule = (source, selectorStart) => {
  const at = source.indexOf(selectorStart);
  assert.ok(at >= 0, `rule starting ${selectorStart}`);
  return source.slice(at, source.indexOf('}', at));
};

test('every select in the page is covered by the readable-select rules', () => {
  const ids = [...html.matchAll(/<select[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), ['cctv-camera-select', 'hud-layout-select', 'radio-filter', 'scene-select']);
  assert.match(base, /^select,/m, 'a bare select selector covers any select, including future ones');
  for (const id of ids) assert.ok(base.includes(`#${id}`), `#${id} named explicitly`);
});

test('selects opt into the dark colour scheme with an opaque surface and light text', () => {
  const r = rule(base, 'select,\n.pp-select');
  assert.match(r, /color-scheme: dark;/);
  assert.match(r, /background-color: #[0-9a-f]{6};/i, 'opaque hex, never rgba (translucent = white popup)');
  assert.match(r, /color: #e8eefb;/);
});

test('options and optgroups get explicit dark backgrounds and light text (Scenes, CCTV, layout, radio)', () => {
  const r = rule(base, 'select option,\nselect optgroup,');
  for (const id of ['.pp-select option', '#scene-select option', '#cctv-camera-select option', '#hud-layout-select option', '#radio-filter option']) {
    assert.ok(r.includes(id), id);
  }
  assert.match(r, /background-color: #111a2b;/);
  assert.match(r, /color: #e8eefb;/);
  assert.match(rule(base, 'select option:checked'), /background-color: #1f3556;[\s\S]*color: #ffffff;/);
});

test('contrast: option text on option background is legible', () => {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  assert.ok(ratio('#e8eefb', '#111a2b') >= 7, 'normal option');
  assert.ok(ratio('#ffffff', '#1f3556') >= 7, 'highlighted option');
  assert.ok(ratio('#8b97ad', '#0e1524') >= 4.5, 'disabled select text still legible');
});

test('disabled and focus states stay readable and visible', () => {
  const d = rule(base, 'select:disabled,');
  assert.match(d, /background-color: #0e1524;/);
  assert.match(d, /color: #8b97ad;/);
  assert.match(base, /select:focus-visible \{\s*outline: 2px solid/);
});

test('forced-colors mode gets system colours, never our dark palette', () => {
  assert.ok(forced.length > 0, 'forced-colors block exists');
  assert.match(forced, /background-color: Field;/);
  assert.match(forced, /color: FieldText;/);
  assert.match(forced, /color-scheme: normal;/);
  assert.match(forced, /GrayText/);
  assert.equal(/#[0-9a-f]{6}/i.test(forced), false, 'no hard-coded colours in the forced-colors block');
});

test('the native popup is untouched: no custom dropdown, no appearance override', () => {
  assert.equal(/appearance:\s*none/.test(block), false);
  assert.equal(/<select[^>]*\bsize=/.test(html), false);
});
