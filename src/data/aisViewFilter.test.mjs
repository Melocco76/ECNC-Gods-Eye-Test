// PERSONAL per-viewer AIS region filters: the pure rules (aisViewFilter.js), the layer
// integration (real reconcile/visibility code with a fake billboard collection), and the
// row rendering (real DataLayerManager with a tiny fake DOM). Nothing here touches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AIS_VIEW_DEFAULT_REGIONS,
  AIS_VIEW_REGIONS_KEY,
  AIS_VIEW_WORLDWIDE,
  effectiveViewRegions,
  loadViewRegions,
  planViewChange,
  sanitizeRegionIds,
  saveViewRegions,
  saveWorldwidePreference,
  vesselPassesViewFilter,
} from './aisViewFilter.js';
import { buildAisCoverageModel } from './aisCoverageStatus.js';
import aisLiveVesselsLayer, {
  _applyAisFeedSnapshotForTest,
  _beginAisSessionForTest,
  _getViewFilterForTest,
  _resetViewFilterForTest,
  _selectWorldwideForTest,
  _setVesselOverlayHostForTest,
  _setVesselStateForTest,
  _toggleViewRegionForTest,
  _viewerRowModelForTest,
} from './aisLiveVessels.js';
import { DataLayerManager } from './manager.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const ALL = ['gulf', 'east-coast', 'west-coast', 'great-lakes'];

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

// -- pure rules ---------------------------------------------------------------------------------

test('the default viewer preference is Worldwide / All Vessels, not a region list', () => {
  assert.equal(AIS_VIEW_WORLDWIDE, 'worldwide');
  assert.deepEqual([...AIS_VIEW_DEFAULT_REGIONS], ['gulf', 'east-coast'], 'the historical region-only default is kept as a named constant');
  assert.equal(AIS_VIEW_REGIONS_KEY, 'gev.ais.viewRegions');
  assert.equal(loadViewRegions(fakeStorage()), AIS_VIEW_WORLDWIDE);
  assert.equal(loadViewRegions(null), AIS_VIEW_WORLDWIDE, 'no storage at all');
});

test('a saved region choice round-trips as a plain JSON array of region IDs and nothing else', () => {
  const storage = fakeStorage();
  assert.equal(saveViewRegions(['west-coast'], storage), true);
  assert.deepEqual([...storage.map.keys()], ['gev.ais.viewRegions']);
  assert.equal(storage.map.get('gev.ais.viewRegions'), '["west-coast"]');
  assert.deepEqual(loadViewRegions(storage), ['west-coast']);
  saveViewRegions(['great-lakes', 'gulf', 'gulf', 'east-coast', 'west-coast'], storage);
  assert.deepEqual(loadViewRegions(storage), ALL, 'all four may be chosen, stored in catalogue order');
});

test('Worldwide round-trips through the same storage key as the sentinel string, and old saved arrays keep loading unchanged', () => {
  const storage = fakeStorage();
  assert.equal(saveWorldwidePreference(storage), true);
  assert.deepEqual([...storage.map.keys()], ['gev.ais.viewRegions'], 'same key as a regional preference');
  assert.equal(storage.map.get('gev.ais.viewRegions'), '"worldwide"');
  assert.equal(loadViewRegions(storage), AIS_VIEW_WORLDWIDE);
  // Backward compatibility: a plain region-array value saved before this feature existed
  // (or by an older build) still loads exactly as it always did.
  const legacy = fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["west-coast","gulf"]' });
  assert.deepEqual(loadViewRegions(legacy), ['gulf', 'west-coast']);
  // And going the other way: selecting a region after Worldwide overwrites the sentinel
  // with a plain array, exactly like any other regional save.
  saveViewRegions(['gulf'], storage);
  assert.equal(storage.map.get('gev.ais.viewRegions'), '["gulf"]');
  assert.deepEqual(loadViewRegions(storage), ['gulf']);
});

test('invalid, stale or corrupt stored values fall back to Worldwide, never to a silent regional narrowing', () => {
  const cases = ['not json', '{"a":1}', '"gulf"', '[]', '["atlantis"]', '[1,2,3]', 'null', '[["gulf"]]'];
  for (const raw of cases) {
    assert.equal(loadViewRegions(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: raw })), AIS_VIEW_WORLDWIDE, raw);
  }
  assert.deepEqual(loadViewRegions(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["atlantis","west-coast",7]' })), ['west-coast'], 'unknown IDs dropped, valid kept');
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadViewRegions(throwing), AIS_VIEW_WORLDWIDE);
  assert.equal(saveViewRegions(['gulf'], throwing), false, 'a blocked write never throws');
  assert.equal(saveWorldwidePreference(throwing), false, 'a blocked write never throws');
  assert.equal(saveViewRegions([], fakeStorage()), false, 'nothing is saved for an empty choice');
  assert.equal(saveViewRegions(['atlantis'], fakeStorage()), false);
  assert.deepEqual(sanitizeRegionIds(['east-coast', 'east-coast', 'x', 'gulf']), ['gulf', 'east-coast']);
});

test('the effective selection is saved choice AND server-available regions; Worldwide is always null (no filter)', () => {
  assert.deepEqual(effectiveViewRegions(['gulf', 'east-coast'], ALL), ['gulf', 'east-coast']);
  assert.deepEqual(effectiveViewRegions(['gulf', 'east-coast'], ['gulf']), ['gulf'], 'East is not covered: intersection');
  assert.deepEqual(effectiveViewRegions(['west-coast'], ['gulf']), ['gulf'], 'empty intersection falls back to what is available');
  assert.deepEqual(effectiveViewRegions(['west-coast'], ALL), ['west-coast']);
  assert.deepEqual(effectiveViewRegions(ALL, ALL), ALL);
  assert.deepEqual(effectiveViewRegions(['gulf'], []), []);
  assert.equal(effectiveViewRegions(AIS_VIEW_WORLDWIDE, ALL), null, 'no filter, even when every region is available');
  assert.equal(effectiveViewRegions(AIS_VIEW_WORLDWIDE, []), null, 'no filter, even when the server reports nothing available');
});

test('at least one region is required; unavailable regions cannot be switched on; no max-2 rule locally', () => {
  assert.deepEqual(planViewChange(['gulf', 'east-coast'], 'east-coast', false, ALL), { ok: true, saved: ['gulf'] });
  assert.deepEqual(planViewChange(['gulf'], 'gulf', false, ALL), { ok: false, reason: 'last-region' });
  assert.deepEqual(planViewChange(['gulf'], 'east-coast', true, ['gulf']), { ok: false, reason: 'unavailable' });
  assert.deepEqual(planViewChange(['gulf'], 'atlantis', true, ALL), { ok: false, reason: 'unknown' });
  let saved = ['gulf'];
  for (const id of ['east-coast', 'west-coast', 'great-lakes']) saved = planViewChange(saved, id, true, ALL).saved;
  assert.deepEqual(saved, ALL, 'no max-2 rule for a local view');
  // A saved preference for an unavailable region survives an unrelated change.
  assert.deepEqual(planViewChange(['gulf', 'west-coast'], 'gulf', true, ['gulf']), { ok: true, saved: ['gulf', 'west-coast'] });
});

test('checking a region while Worldwide is saved exits Worldwide into a fresh single-region selection', () => {
  assert.deepEqual(planViewChange(AIS_VIEW_WORLDWIDE, 'west-coast', true, ALL), { ok: true, saved: ['west-coast'] });
  assert.deepEqual(planViewChange(AIS_VIEW_WORLDWIDE, 'gulf', true, ['gulf']), { ok: true, saved: ['gulf'] });
  assert.deepEqual(planViewChange(AIS_VIEW_WORLDWIDE, 'west-coast', true, ['gulf']), { ok: false, reason: 'unavailable' });
});

test('of the 16 subsets of four regions exactly the 15 non-empty ones are reachable; the empty one is refused', () => {
  const reachable = new Set();
  const seen = new Set(['gulf']);
  const queue = [['gulf']];
  reachable.add('gulf');
  while (queue.length) {
    const current = queue.pop();
    for (const id of ALL) {
      for (const wantOn of [true, false]) {
        const plan = planViewChange(current, id, wantOn, ALL);
        if (!plan.ok) {
          if (!wantOn && current.length === 1 && current[0] === id) assert.equal(plan.reason, 'last-region');
          continue;
        }
        assert.ok(plan.saved.length >= 1, 'a plan never yields the empty selection');
        const key = plan.saved.join(',');
        if (!seen.has(key)) { seen.add(key); reachable.add(key); queue.push(plan.saved); }
      }
    }
  }
  assert.equal(reachable.size, 15, '2^4 - 1 non-empty combinations');
  assert.equal(reachable.has(''), false);
  assert.ok(ALL.every((id) => planViewChange([id], id, false, ALL).ok === false), 'the last region can never be removed');
});

test('narrower server coverage never overwrites the saved preference', () => {
  const storage = fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["west-coast"]' });
  withLayer(storage, () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE, ['gulf']));
    assert.deepEqual(_getViewFilterForTest().selected, ['gulf'], 'the map falls back to Gulf so it is not empty');
    assert.deepEqual(_getViewFilterForTest().saved, ['west-coast'], 'but the preference is still West Coast');
    assert.equal(storage.map.get(AIS_VIEW_REGIONS_KEY), '["west-coast"]', 'and the stored value was not touched');
    assert.equal(_toggleViewRegionForTest('gulf', false), false, 'the fallback region cannot be removed either');
    assert.equal(_toggleViewRegionForTest('east-coast', true), false, 'nor an uncovered one added');
    assert.equal(storage.map.get(AIS_VIEW_REGIONS_KEY), '["west-coast"]');
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE, ALL));
    assert.deepEqual(_getViewFilterForTest().selected, ['west-coast'], 'active again the moment West Coast is covered');
    assert.equal(storage.map.get(AIS_VIEW_REGIONS_KEY), '["west-coast"]');
  });
});

test('vessels with no region information always pass (older server, or outside every region)', () => {
  const west = new Set(['west-coast']);
  assert.equal(vesselPassesViewFilter(['gulf'], west), false);
  assert.equal(vesselPassesViewFilter(['gulf', 'east-coast'], new Set(['east-coast'])), true, 'overlap: any match');
  assert.equal(vesselPassesViewFilter([], west), true);
  assert.equal(vesselPassesViewFilter(undefined, west), true);
  assert.equal(vesselPassesViewFilter(['gulf'], null), true, 'no filter known: draw everything');
});

// -- the layer: real reconcile + visibility, fake billboards --------------------------------------

function makeCollection() {
  return {
    items: [],
    add(options) { const item = { ...options }; this.items.push(item); return item; },
    remove(item) { this.items = this.items.filter((i) => i !== item); },
  };
}
const row = (mmsi, lat, lon, regionIds) => ({ mmsi, name: `V${mmsi}`, lat, lon, speed: 5, course: 90, heading: 90, regionIds });
const FIXTURE = [
  row('111000001', 29.3, -94.8, ['gulf']),
  row('111000002', 27.9, -82.6, ['gulf']),
  row('222000001', 40.7, -74.0, ['east-coast']),
  row('222000002', 25.8, -80.2, ['east-coast']),
  row('222000003', 30.9, -81.6, ['gulf', 'east-coast']), // overlap, ONE vessel
  row('333000001', 37.8, -122.4, ['west-coast']),
  row('444000001', 41.5, -81.7, ['great-lakes']),
  row('555000001', 10.0, -40.0, []), // outside every region
];
const payload = (rows, available = ALL) => ({
  status: 'live', lastMessageAt: 5, rows, coverage: { desired: available, subscribed: available, applying: false, available },
});

function withLayer(storage, fn, { available = null } = {}) {
  const collection = makeCollection();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error('the viewer filter must not touch the network'); };
  _setVesselOverlayHostForTest({ setEntries() {}, setVisible() {}, clearSource() {} });
  _setVesselStateForTest({ viewer: {}, records: [], billboardCollection: collection });
  _resetViewFilterForTest({ storage, available });
  try {
    _beginAisSessionForTest();
    return fn({ collection, calls });
  } finally {
    globalThis.fetch = realFetch;
    _setVesselStateForTest({ enabled: false });
    _setVesselOverlayHostForTest();
    _resetViewFilterForTest();
  }
}
const shownIds = (collection) => collection.items.filter((b) => b.show).length;

test('the default viewer is Worldwide: every vessel draws, including the four named-region ones', () => {
  withLayer(fakeStorage(), ({ collection }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    const filter = _getViewFilterForTest();
    assert.equal(filter.saved, AIS_VIEW_WORLDWIDE);
    assert.deepEqual(filter.selected, [], 'no per-region selection while Worldwide is active');
    assert.equal(filter.received, 8, 'every vessel is cached');
    assert.equal(filter.shown, 8, 'nothing is hidden, including the four regioned vessels');
    assert.equal(collection.items.length, 8);
    assert.equal(shownIds(collection), 8, 'all drawn, even though every four-region box is geometrically "available"');
    assert.equal(aisLiveVesselsLayer.getStats().count, 8);
    assert.equal(aisLiveVesselsLayer.getStats().receivedCount, 8);
    assert.equal(aisLiveVesselsLayer.getAllPositions(50).length, 8);
    assert.equal(_viewerRowModelForTest().worldwide, true);
  });
});

test('a regional choice (Gulf + East) draws only those vessels, and hidden ones stay cached', () => {
  withLayer(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["gulf","east-coast"]' }), ({ collection }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    const filter = _getViewFilterForTest();
    assert.deepEqual(filter.selected, ['gulf', 'east-coast']);
    assert.equal(filter.received, 8, 'every vessel is cached');
    assert.equal(filter.shown, 6, '2 gulf + 2 east + 1 overlap + 1 unclassified');
    assert.equal(collection.items.length, 8, 'no primitive was destroyed for a hidden region');
    assert.equal(shownIds(collection), 6, 'hidden vessels are not drawn');
    assert.equal(aisLiveVesselsLayer.getStats().count, 6);
    assert.equal(aisLiveVesselsLayer.getStats().receivedCount, 8);
    assert.equal(aisLiveVesselsLayer.getAllPositions(50).length, 6, 'detection/nearby only see drawn vessels');
    assert.equal(aisLiveVesselsLayer.hasContact('333000001'), true, 'a filtered vessel is still present in the feed');
    assert.equal(_viewerRowModelForTest().worldwide, false);
  });
});

test('Worldwide -> one region -> Worldwide: each transition redraws immediately, with no request', () => {
  const storage = fakeStorage();
  withLayer(storage, ({ collection, calls }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.equal(shownIds(collection), 8, 'starts Worldwide');
    assert.equal(_toggleViewRegionForTest('west-coast', true), true, 'checking a region exits Worldwide');
    assert.deepEqual(_getViewFilterForTest().selected, ['west-coast']);
    assert.equal(shownIds(collection), 2, 'only the West Coast vessel + the unclassified one');
    assert.equal(_selectWorldwideForTest(), true);
    assert.equal(_getViewFilterForTest().saved, AIS_VIEW_WORLDWIDE);
    assert.equal(shownIds(collection), 8, 'back to Worldwide: every backend-delivered vessel again');
    assert.equal(storage.map.get(AIS_VIEW_REGIONS_KEY), '"worldwide"');
    assert.equal(calls.length, 0, 'no fetch, no POST, no reconnect for any of it');
  });
});

test('an overlapping vessel is one row and one sprite, drawn for either region', () => {
  withLayer(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["east-coast"]' }), ({ collection }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.equal(collection.items.length, 8);
    assert.equal(_getViewFilterForTest().shown, 4, '2 east + 1 overlap + 1 unclassified');
  });
  withLayer(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["gulf"]' }), () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.equal(_getViewFilterForTest().shown, 4, '2 gulf + 1 overlap + 1 unclassified');
  });
});

test('ticking a region draws its cached vessels immediately, with no request', () => {
  const storage = fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["gulf","east-coast"]' });
  withLayer(storage, ({ collection, calls }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.equal(shownIds(collection), 6);
    assert.equal(_toggleViewRegionForTest('west-coast', true), true);
    assert.equal(shownIds(collection), 7, 'the West Coast vessel appears at once');
    assert.equal(_getViewFilterForTest().received, 8, 'no new rows were needed');
    assert.equal(_toggleViewRegionForTest('west-coast', false), true);
    assert.equal(shownIds(collection), 6, 'and disappears at once');
    assert.equal(_toggleViewRegionForTest('west-coast', true), true);
    assert.equal(shownIds(collection), 7, 're-enabling restores the cached vessel without waiting for the server');
    assert.equal(calls.length, 0, 'no fetch, no POST, no reconnect');
    assert.equal(storage.map.get(AIS_VIEW_REGIONS_KEY), '["gulf","east-coast","west-coast"]');
  });
});

test('all four regions may be shown, and Great Lakes alone works', () => {
  withLayer(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["gulf","east-coast"]' }), ({ collection }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    _toggleViewRegionForTest('west-coast', true);
    _toggleViewRegionForTest('great-lakes', true);
    assert.deepEqual(_getViewFilterForTest().selected, ALL);
    assert.equal(shownIds(collection), 8, 'everything, including the unclassified vessel');
    for (const id of ['gulf', 'east-coast', 'west-coast']) _toggleViewRegionForTest(id, false);
    assert.deepEqual(_getViewFilterForTest().selected, ['great-lakes']);
    assert.equal(shownIds(collection), 2, 'the Great Lakes vessel + the unclassified one');
  });
});

test('the last visible region cannot be switched off', () => {
  withLayer(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["west-coast"]' }), () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.equal(_toggleViewRegionForTest('west-coast', false), false);
    assert.deepEqual(_getViewFilterForTest().selected, ['west-coast']);
    assert.equal(_getViewFilterForTest().saved.includes('west-coast'), true);
  });
});

test('two viewers are independent: choices live only in each browser', () => {
  const sam = fakeStorage();
  const steve = fakeStorage();
  let samShown;
  let steveShown;
  withLayer(sam, () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    samShown = _getViewFilterForTest();
  });
  withLayer(steve, () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    _toggleViewRegionForTest('west-coast', true);
    _toggleViewRegionForTest('gulf', false);
    _toggleViewRegionForTest('east-coast', false);
    steveShown = _getViewFilterForTest();
  });
  assert.equal(samShown.saved, AIS_VIEW_WORLDWIDE, "Sam never touched anything: still Worldwide");
  assert.deepEqual(samShown.selected, []);
  assert.deepEqual(steveShown.selected, ['west-coast']);
  assert.equal(sam.map.size, 0, "Sam's browser stored nothing because Sam changed nothing");
  assert.equal(steve.map.get(AIS_VIEW_REGIONS_KEY), '["west-coast"]');
});

test('the choice is restored on the next visit', () => {
  const storage = fakeStorage();
  withLayer(storage, () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    _toggleViewRegionForTest('great-lakes', true);
  });
  withLayer(storage, () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.deepEqual(_getViewFilterForTest().selected, ['great-lakes'], 'exiting Worldwide started a fresh single-region choice, which is what persisted');
  });
});

test('legacy server: only the Gulf is available, unavailable regions cannot be chosen', () => {
  const storage = fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["gulf","east-coast"]' });
  withLayer(storage, ({ collection }) => {
    const legacyRows = FIXTURE.filter((r) => r.regionIds.includes('gulf') && !r.regionIds.includes('east-coast'));
    _applyAisFeedSnapshotForTest({}, {
      status: 'live', lastMessageAt: 5, rows: legacyRows,
      coverage: { desired: [], subscribed: [], applying: false, available: ['gulf'] },
    });
    const model = _viewerRowModelForTest();
    assert.deepEqual(model.available, ['gulf']);
    assert.deepEqual(model.selected, ['gulf'], 'East is saved but not covered: intersection is Gulf');
    assert.equal(model.worldwide, false);
    assert.equal(model.fixedArea, true);
    assert.equal(shownIds(collection), 2, 'every legacy vessel is still drawn');
    assert.equal(_toggleViewRegionForTest('east-coast', true), false, 'East cannot be turned on');
    assert.equal(_toggleViewRegionForTest('gulf', false), false, 'and the only region cannot be turned off');
    assert.equal(storage.map.get(AIS_VIEW_REGIONS_KEY), '["gulf","east-coast"]', 'refused clicks never rewrite storage');
  });
});

test('Worldwide ignores a legacy single-region server too: nothing is hidden', () => {
  withLayer(fakeStorage(), ({ collection }) => {
    const legacyRows = FIXTURE.filter((r) => r.regionIds.includes('gulf') && !r.regionIds.includes('east-coast'));
    _applyAisFeedSnapshotForTest({}, {
      status: 'live', lastMessageAt: 5, rows: legacyRows,
      coverage: { desired: [], subscribed: [], applying: false, available: ['gulf'] },
    });
    const model = _viewerRowModelForTest();
    assert.deepEqual(model.available, ['gulf']);
    assert.equal(model.worldwide, true);
    assert.deepEqual(model.selected, []);
    assert.equal(shownIds(collection), 2, 'every legacy vessel is drawn, same as before');
  });
});

test('all-four server enables all four filters, and a saved choice returns when the server widens', () => {
  const storage = fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["west-coast","gulf"]' });
  withLayer(storage, ({ collection }) => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE, ['gulf']));
    assert.deepEqual(_viewerRowModelForTest().selected, ['gulf'], 'West is saved but the server does not cover it yet');
    assert.equal(shownIds(collection), 4, 'Gulf vessels + overlap + unclassified');
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE, ALL));
    const model = _viewerRowModelForTest();
    assert.deepEqual(model.available, ALL);
    assert.deepEqual(model.selected, ['gulf', 'west-coast'], 'the saved West Coast choice comes back automatically');
    assert.equal(shownIds(collection), 5);
  });
});

test('a server that reports no availability leaves everything drawn and shows no filter', () => {
  withLayer(fakeStorage(), ({ collection }) => {
    _applyAisFeedSnapshotForTest({}, { status: 'live', lastMessageAt: 5, rows: FIXTURE, coverage: { desired: [], subscribed: [], applying: false } });
    assert.equal(_viewerRowModelForTest(), null);
    assert.equal(shownIds(collection), 8);
  });
});

test('a hidden vessel cannot be selected; hiding the selected vessel clears its selection', () => {
  withLayer(fakeStorage({ [AIS_VIEW_REGIONS_KEY]: '["gulf","east-coast"]' }), () => {
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    assert.equal(aisLiveVesselsLayer.selectById('333000001'), false, 'West Coast is hidden');
    assert.equal(aisLiveVesselsLayer.findByQuery('333000001'), null);
  });
});

test('labels/overlay entries are only ever built for drawn vessels', () => {
  const published = [];
  const collection = makeCollection();
  _setVesselOverlayHostForTest({ setEntries(_id, entries) { published.push(...entries.map((e) => e.id)); }, setVisible() {}, clearSource() {} });
  _setVesselStateForTest({ viewer: {}, records: [], billboardCollection: collection });
  _resetViewFilterForTest({ storage: fakeStorage(), available: null });
  try {
    _beginAisSessionForTest();
    _applyAisFeedSnapshotForTest({}, payload(FIXTURE));
    _toggleViewRegionForTest('west-coast', true);
    _toggleViewRegionForTest('west-coast', false);
    assert.equal(published.some((id) => id === 'vessel:333000001' || id === 'vessel:444000001'), false, 'hidden regions never get a card');
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setVesselOverlayHostForTest();
    _resetViewFilterForTest();
  }
});

// -- row rendering ----------------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tag, children: [], className: '', dataset: {}, attributes: {}, listeners: {}, parent: null,
    textContent: '', hidden: false, disabled: false, checked: false, title: '', type: '',
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node); },
    addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute: (name) => (name in node.attributes ? node.attributes[name] : null),
    change() { for (const fn of node.listeners.change || []) fn({}); },
    click() { for (const fn of node.listeners.click || []) fn({}); },
  };
  return node;
}
const all = (node, predicate, out = []) => {
  for (const child of node.children) { if (predicate(child)) out.push(child); all(child, predicate, out); }
  return out;
};
const byClass = (node, cls) => all(node, (n) => String(n.className).split(/\s+/).includes(cls));
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ').replace(/\s+/g, ' ').trim();

function renderViewer(view, actions = { toggle() {} }, existing = null) {
  const saved = globalThis.document;
  globalThis.document = { createElement: makeNode };
  try {
    const mgr = new DataLayerManager({});
    const box = existing || makeNode('div');
    const controls = { coverage: buildAisCoverageModel({ mode: 'regions', desired: ALL, subscribed: ALL, available: ALL }), viewer: { view, actions } };
    mgr._syncRowCoverage(box, controls);
    mgr._syncRowViewer(box, controls);
    return { box, mgr, controls };
  } finally {
    globalThis.document = saved;
  }
}
const viewOf = (over = {}) => ({ available: ALL, selected: ['gulf', 'east-coast'], worldwide: false, shown: 1730, received: 2842, fixedArea: false, ...over });
const regionChecks = (box) => all(box, (n) => n.tag === 'input' && n.dataset.regionId !== 'worldwide');
const worldwideCheck = (box) => all(box, (n) => n.tag === 'input').find((c) => c.dataset.regionId === 'worldwide');

test('the row shows Worldwide above four personal checkboxes, with Shown/Hidden text and the shown/received counts', () => {
  const { box } = renderViewer(viewOf());
  const all5 = all(box, (n) => n.tag === 'input');
  assert.deepEqual(all5.map((c) => c.dataset.regionId), ['worldwide', ...ALL], 'Worldwide renders above the four regional rows');
  const checks = regionChecks(box);
  assert.deepEqual(checks.map((c) => c.checked), [true, true, false, false]);
  assert.ok(all5.every((c) => c.type === 'checkbox' && !c.disabled));
  const ww = worldwideCheck(box);
  assert.equal(ww.checked, false, 'a regional choice is active, not Worldwide');
  assert.match(text(box), /Coverage shown/);
  assert.match(text(box), /Worldwide \/ All Vessels Hidden/);
  assert.match(text(box), /Gulf of Mexico Shown/);
  assert.match(text(box), /U\.S\. West Coast Hidden/);
  assert.match(text(box), /1,730 shown · 2,842 received/);
  assert.match(text(box), /saved on this device only/);
  assert.equal(byClass(box, 'data-toggle-coverage').length, 0, 'the old read-only list steps aside');
  assert.equal(/Owner controls|Sign in|token/i.test(text(box)), false, 'no owner login in the ordinary row');
  assert.equal(all(box, (n) => n.type === 'password').length, 0);
});

test('Worldwide active: its checkbox is checked and disabled, every region reads Hidden but stays choosable', () => {
  const { box } = renderViewer(viewOf({ selected: [], worldwide: true, shown: 2842, received: 2842 }));
  const ww = worldwideCheck(box);
  assert.equal(ww.checked, true);
  assert.equal(ww.disabled, true, 'narrow to a region instead of unticking Worldwide directly');
  const checks = regionChecks(box);
  assert.ok(checks.every((c) => c.checked === false), 'no region reads as selected while Worldwide is active');
  assert.ok(checks.every((c) => c.disabled === false), 'but every available region stays clickable, to exit Worldwide');
  assert.match(text(box), /Worldwide \/ All Vessels Shown/);
  assert.match(text(box), /Gulf of Mexico Hidden/);
});

test('the regional filters are collapsed by default; Worldwide stays visible regardless', () => {
  const { box } = renderViewer(viewOf());
  const disclosure = byClass(box, 'data-toggle-viewer-disclosure')[0];
  const group = byClass(box, 'data-toggle-viewer-regions')[0];
  assert.ok(disclosure, 'a disclosure control exists');
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false', 'collapsed by default');
  assert.equal(group.hidden, true, 'the four regional rows start hidden');
  assert.match(text(box), /Regional filters/);
  assert.equal(worldwideCheck(box).hidden, false, 'Worldwide is never hidden by the disclosure');
  assert.match(text(box), /Worldwide \/ All Vessels/, 'Worldwide text renders regardless of the collapsed section');
});

test('the disclosure toggles visibility only - it never asks the layer for anything', () => {
  const asked = [];
  const { box } = renderViewer(viewOf(), { toggle: (...args) => asked.push(['toggle', ...args]), selectWorldwide: (...args) => asked.push(['selectWorldwide', ...args]) });
  const disclosure = byClass(box, 'data-toggle-viewer-disclosure')[0];
  const group = byClass(box, 'data-toggle-viewer-regions')[0];
  disclosure.click();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true', 'expanded');
  assert.equal(group.hidden, false, 'the four regional rows are now visible');
  disclosure.click();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false', 'collapsed again');
  assert.equal(group.hidden, true);
  assert.deepEqual(asked, [], 'expanding/collapsing never calls toggle() or selectWorldwide()');
});

test('selected regional preferences are unaffected by expanding or collapsing the disclosure', () => {
  const { box, mgr, controls } = renderViewer(viewOf({ selected: ['gulf', 'west-coast'] }));
  const disclosure = byClass(box, 'data-toggle-viewer-disclosure')[0];
  const checkedBefore = regionChecks(box).map((c) => c.checked);
  disclosure.click(); // expand
  assert.deepEqual(regionChecks(box).map((c) => c.checked), checkedBefore, 'expanding changes nothing about the checkboxes');
  // A resync (e.g. the 2s poll) while expanded must not reset the disclosure.
  const saved = globalThis.document;
  globalThis.document = { createElement: makeNode };
  try {
    mgr._syncRowViewer(box, { ...controls, viewer: { ...controls.viewer, view: viewOf({ selected: ['gulf', 'west-coast'], shown: 1234 }) } });
  } finally { globalThis.document = saved; }
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true', 'a resync does not re-collapse an expanded section');
  assert.deepEqual(regionChecks(box).map((c) => c.checked), checkedBefore);
  disclosure.click(); // collapse
  assert.deepEqual(regionChecks(box).map((c) => c.checked), checkedBefore, 'collapsing changes nothing about the checkboxes either');
});

test('legacy server: one available region, the rest visibly "Not covered" and disabled', () => {
  const { box } = renderViewer(viewOf({ available: ['gulf'], selected: ['gulf'], shown: 42, received: 42, fixedArea: true }));
  const ww = worldwideCheck(box);
  assert.equal(ww.checked, false);
  assert.equal(ww.disabled, false, 'Worldwide itself is unaffected by which regions this server covers');
  const checks = regionChecks(box);
  assert.deepEqual(checks.map((c) => c.checked), [true, false, false, false]);
  assert.deepEqual(checks.map((c) => c.disabled), [true, true, true, true], 'the only region cannot be turned off; the others are not covered');
  assert.match(text(box), /Coverage available from server: Gulf of Mexico/);
  assert.match(text(box), /U\.S\. East Coast Not covered/);
  assert.match(text(box), /42 shown/);
  assert.equal(/received/.test(text(box)), false, 'no shown/received split when nothing is hidden');
});

test('all-four server: every region is selectable', () => {
  const { box } = renderViewer(viewOf({ selected: ALL }));
  assert.ok(regionChecks(box).every((c) => c.checked && !c.disabled));
});

test('one remaining region cannot be unticked (disabled with an explanation)', () => {
  const { box } = renderViewer(viewOf({ selected: ['west-coast'] }));
  const west = all(box, (n) => n.tag === 'input').find((c) => c.dataset.regionId === 'west-coast');
  assert.equal(west.disabled, true);
  assert.equal(west.title, 'At least one region stays on');
});

test('a click is reverted and handed to the layer; the block is patched, not rebuilt', () => {
  const asked = [];
  const { box, mgr, controls } = renderViewer(viewOf(), { toggle: (id, on) => asked.push([id, on]) });
  const node = byClass(box, 'data-toggle-viewer')[0];
  const west = all(box, (n) => n.tag === 'input').find((c) => c.dataset.regionId === 'west-coast');
  west.checked = true;
  west.change();
  assert.equal(west.checked, false, 'the box only changes when the layer says so');
  assert.deepEqual(asked, [['west-coast', true]]);
  const saved = globalThis.document;
  globalThis.document = { createElement: makeNode };
  try {
    mgr._syncRowViewer(box, { ...controls, viewer: { ...controls.viewer, view: viewOf({ selected: ['gulf', 'east-coast', 'west-coast'], shown: 1900 }) } });
  } finally { globalThis.document = saved; }
  assert.equal(byClass(box, 'data-toggle-viewer')[0], node, 'same node: focus survives a refresh');
  assert.equal(west.checked, true);
  assert.match(text(box), /1,900 shown/);
});

// -- security / isolation ----------------------------------------------------------------------------

test('the viewer filter needs no credential, writes nothing but region IDs, and never reaches the server', () => {
  const source = read('./aisViewFilter.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|ais-regions|admin|token|password|cookie/i.test(source), false);
  assert.equal(/sessionStorage|indexedDB/.test(source), false);
  assert.equal((source.match(/setItem\(/g) || []).length, 2, 'two writes to the same key: a region list, or the Worldwide sentinel');
  const layer = read('./aisLiveVessels.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/ownerCoverage|ownerSignInDialog|x-gev-admin-token|AIS_REGIONS_ADMIN_TOKEN/.test(layer), false);
  assert.equal(/ais-regions/.test(layer), false, 'the layer never names the coverage-write endpoint');
  const manager = read('./manager.js');
  assert.equal(/Owner controls|owner-signin|OWNER_LEGACY/.test(manager), false);
});

test('viewer choices are not part of share links', () => {
  for (const file of ['../shareLink.js', '../urlState.js', '../permalink.js']) {
    let source = '';
    try { source = read(file); } catch { continue; }
    assert.equal(/viewRegions|gev\.ais/.test(source), false, `${file} must not carry maritime preferences`);
  }
  const filter = read('./aisViewFilter.js');
  assert.match(filter, /deliberately NOT part of share links/);
});

// -- mobile ----------------------------------------------------------------------------------------------

test('phones: 44px rows, a 24px checkbox, readable text, and nothing that could touch the credit line', () => {
  const css = read('../../style.css');
  const block = css.slice(css.indexOf('/* ══ AIS viewer filter'), css.indexOf('/* ══ Readable native selects'));
  assert.match(block, /@media \(max-width: 767px\) \{\s*\.data-toggle-viewer \{ font-size: 13px; \}\s*\.data-toggle-viewer-region \{ min-height: 44px; \}\s*\.data-toggle-viewer-check \{ width: 24px; height: 24px; \}/);
  assert.match(block, /\.data-toggle-viewer-region \{ display: flex; align-items: center; gap: 8px; min-height: 28px;/);
  assert.equal(/position\s*:\s*(fixed|absolute)|#cesium-credits|#command-dock|!important/.test(block.slice(0, block.indexOf('.owner-dialog {'))), false,
    'the row block is plain in-flow layout inside the drawer');
  assert.match(block, /\.data-toggle-viewer-state \{[^}]*text-transform: uppercase/, 'state is spelled out, not colour-only');
});
