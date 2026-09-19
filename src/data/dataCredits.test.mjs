// Conditional (dynamic) credits can now be removed again: a layer that turns
// off must stop claiming its data source in the attribution popover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAINVIEWER_CREDIT,
  TOMTOM_CREDIT,
  registerDynamicCredit,
  unregisterDynamicCredit,
} from './dataCredits.js';

function fakeViewer() {
  const shown = new Set();
  return {
    shown,
    creditDisplay: {
      addStaticCredit: (credit) => shown.add(credit),
      removeStaticCredit: (credit) => shown.delete(credit),
    },
  };
}

test('a dynamic credit registers once, is visible, and unregisters cleanly', () => {
  const viewer = fakeViewer();
  assert.equal(registerDynamicCredit(viewer, RAINVIEWER_CREDIT), true);
  assert.equal(registerDynamicCredit(viewer, RAINVIEWER_CREDIT), true, 'idempotent');
  assert.equal(viewer.shown.size, 1);
  const [credit] = viewer.shown;
  assert.match(credit.html, /RainViewer/);
  assert.match(credit.html, /https:\/\/www\.rainviewer\.com\//);
  assert.equal(credit.showOnScreen, false, 'kept in the attribution popover, apart from the basemap line');

  assert.equal(unregisterDynamicCredit(viewer, RAINVIEWER_CREDIT), true);
  assert.equal(viewer.shown.size, 0, 'nothing left behind');
  assert.equal(unregisterDynamicCredit(viewer, RAINVIEWER_CREDIT), false, 'safe when already gone');

  // Can be registered again afterwards.
  assert.equal(registerDynamicCredit(viewer, RAINVIEWER_CREDIT), true);
  assert.equal(viewer.shown.size, 1);
  unregisterDynamicCredit(viewer, RAINVIEWER_CREDIT);
});

test('unregistering one credit leaves the others (and never-registered keys) alone', () => {
  const viewer = fakeViewer();
  registerDynamicCredit(viewer, TOMTOM_CREDIT);
  registerDynamicCredit(viewer, RAINVIEWER_CREDIT);
  assert.equal(unregisterDynamicCredit(viewer, { key: 'never-registered' }), false);
  assert.equal(unregisterDynamicCredit(viewer, RAINVIEWER_CREDIT), true);
  assert.equal(viewer.shown.size, 1);
  assert.match([...viewer.shown][0].html, /TomTom/);
  unregisterDynamicCredit(viewer, TOMTOM_CREDIT);
  assert.equal(unregisterDynamicCredit(null, RAINVIEWER_CREDIT), false);
});
