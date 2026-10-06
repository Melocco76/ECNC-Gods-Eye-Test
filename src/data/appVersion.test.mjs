// The single centralized app version. No network, no DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { APP_VERSION, APP_VERSION_LABEL } from './appVersion.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('APP_VERSION is a non-empty string', () => {
  assert.equal(typeof APP_VERSION, 'string');
  assert.ok(APP_VERSION.length > 0);
});

test('APP_VERSION_LABEL is built from APP_VERSION, in the documented subtle form', () => {
  assert.equal(APP_VERSION_LABEL, `ECNC God's Eye v${APP_VERSION}`);
});

test('the module reads the version from exactly one place: the Vite-injected env value, with a safe fallback — no other literal version string', () => {
  const source = code('./appVersion.js');
  assert.match(source, /import\.meta\.env\?\.GEV_APP_VERSION/);
  // Only the documented fallback constant may look like a version literal.
  const versionLiterals = [...source.matchAll(/'(\d+\.\d+\.\d+)'/g)].map((m) => m[1]);
  assert.deepEqual(versionLiterals, ['0.0.0'], 'no other hardcoded semver-looking string');
});

test('nothing in this module touches the network or the DOM', () => {
  const source = code('./appVersion.js');
  assert.equal(/fetch\(|document\.|window\./.test(source), false);
});
