// Phase 2 (desktop header + Layers drawer): markup contract, layer grouping,
// grouped row rendering by the DataLayerManager, the read-only AIS coverage
// status, accordion/drawer behaviour on a DOM double, and the guarantees that
// the browser holds no region-write path or credential. No browser, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DataLayerManager } from './data/manager.js';
import { LAYER_GROUPS, groupIdForLayer, orderLayersForDrawer } from './layerGroups.js';
import { buildAisCoverageModel, fetchAisRegionsStatus } from './data/aisCoverageStatus.js';
import { formatHeaderAltitude, formatUtcClock, initLayerDrawer, openOnlyGroup, setGroupOpen } from './layerDrawer.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../index.html');
const css = read('../style.css');

// -- markup ---------------------------------------------------------------------

test('the header carries the ECNC title, credit line and the desktop controls', () => {
  const header = html.slice(html.indexOf('<header id="app-header">'), html.indexOf('</header>', html.indexOf('<header id="app-header">')));
  assert.match(header, /<span>ECNC God's Eye<\/span><\/h1>/);
  assert.ok(header.includes("Technology demonstration based on God's Eye View by Bilawal Sidhu"), 'creator credit stays visible in the header');
  for (const id of ['title-bar', 'ecnc-brand-slot', 'layers-btn', 'look-btn', 'about-btn', 'app-header-search',
    'app-header-map-mode', 'app-header-altitude', 'app-header-clock']) {
    assert.ok(header.includes(`id="${id}"`), `header must contain #${id}`);
  }
  assert.ok(header.includes('data-logo-src="/logo.svg"'), 'the eye mark stays as the temporary secondary mark');
  assert.match(css, /#app-header\s*\{[\s\S]*?--app-header-height:\s*56px;[\s\S]*?height:\s*var\(--app-header-height\);/);
});

test('the old floating desktop chrome is gone from the top of the page', () => {
  const beforeDrawer = html.slice(0, html.indexOf('<aside id="layer-drawer"'));
  assert.equal(beforeDrawer.includes('id="style-indicator"'), false, 'no floating ACTIVE STYLE block');
  assert.equal(beforeDrawer.includes('id="top-center-actions"'), false, 'no floating icon buttons');
  assert.equal(html.includes('ACTIVE STYLE'), false);
});

test('Layers / Look / About buttons are semantic buttons with aria-expanded and aria-controls', () => {
  assert.match(html, /<button type="button" id="layers-btn"[^>]*aria-expanded="false" aria-controls="layer-drawer"/);
  assert.match(html, /<button type="button" id="look-btn"[^>]*aria-expanded="false" aria-controls="layer-drawer"/);
  assert.match(html, /<button type="button" id="about-btn"[^>]*aria-controls="about-dialog"/);
  assert.match(html, /<aside id="layer-drawer" aria-labelledby="layer-drawer-title" hidden>/, 'the drawer ships closed');
  assert.match(html, /id="layer-drawer-close"[^>]*aria-label="Close layers panel"/);
});

test('accordion groups: headings are buttons whose aria-controls point at real bodies', () => {
  const groups = [...html.matchAll(/data-drawer-group="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['live', 'weather', 'infrastructure', 'space', 'map', 'tools', 'look']);
  for (const id of groups) {
    assert.match(html, new RegExp(`id="drawer-toggle-${id}" aria-expanded="(true|false)" aria-controls="drawer-body-${id}"`));
    assert.match(html, new RegExp(`id="drawer-body-${id}"[^>]*role="region" aria-labelledby="drawer-toggle-${id}"`));
  }
  assert.equal((html.match(/aria-expanded="true" aria-controls="drawer-body-/g) || []).length, 1, 'exactly one group opens by default');
});

test('legacy ids and contracts survive the move', () => {
  for (const id of ['data-panel', 'data-toggles', 'pp-toggles', 'control-panel', 'global-context-panel',
    'right-context-rail', 'loading-screen', 'world-overlay-root', 'world-overlay-actions', 'world-overlay-action-list',
    'world-overlay-status', 'map-stack-chips', 'map-stack-status', 'style-buttons', 'style-indicator', 'active-style-name',
    'top-center-actions', 'clear-selected-layers', 'share-btn', 'reset-globe-view', 'map-weather-toggle', 'map-weather-card',
    'location-search', 'search-toggle', 'scope-toggle', 'hud-toggle', 'cctv-panel', 'scene-panel', 'intel-hud',
    'control-panel-toggle', 'style-mini-value']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must remain`);
  }
  assert.equal((html.match(/id="data-toggles"/g) || []).length, 1, 'one #data-toggles');
  // Data rows are rendered INSIDE the drawer's #data-toggles by the manager.
  const drawer = html.slice(html.indexOf('<aside id="layer-drawer"'), html.indexOf('<aside id="about-dialog"'));
  assert.ok(drawer.includes('id="data-toggles"'));
  for (const id of ['map-stack-chips', 'style-buttons', 'top-center-actions', 'drawer-look-display']) {
    assert.ok(drawer.includes(`id="${id}"`), `#${id} lives in the drawer`);
  }
});

test('MAP group holds the map sources; LOOK holds the presets; the old Visual Presets tray is retired', () => {
  const look = html.slice(html.indexOf('data-drawer-group="look"'), html.indexOf('<aside id="about-dialog"'));
  for (const style of ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']) {
    assert.ok(look.includes(`data-style="${style}"`), `look preset ${style}`);
  }
  for (const label of ['Default', 'Retro', 'Night vision', 'Thermal', 'Anime', 'Noir', 'Snow']) {
    assert.ok(look.includes(`<span class="btn-label">${label}</span>`), `label ${label}`);
  }
  const mapSection = html.slice(html.indexOf('data-drawer-group="map"'), html.indexOf('data-drawer-group="tools"'));
  assert.ok(mapSection.includes('id="map-stack-chips"') && mapSection.includes('id="map-stack-status"'));
  assert.match(css, /#data-panel, #control-panel \{ display: none !important; \}/);
});

test('the About dialog and header keep the creator credit, MIT note and data credits', () => {
  const about = html.slice(html.indexOf('<aside id="about-dialog"'), html.indexOf('</aside>', html.indexOf('<aside id="about-dialog"')));
  assert.ok(about.includes("ECNC God's Eye &mdash; technology demonstration based on God's Eye View by Bilawal Sidhu"));
  assert.ok(about.includes('MIT License'));
  assert.ok(about.includes('id="about-credits-list"'));
  const layerDrawerSource = read('./layerDrawer.js');
  assert.ok(layerDrawerSource.includes("import('./data/dataCredits.js')"), 'every DATA_CREDITS entry is listed');
  assert.ok(html.includes('<p class="loader-credit">Based on God\'s Eye View by Bilawal Sidhu</p>'), 'loader credit unchanged');
});

test('the drawer and dialog never sit over the Cesium/Google credit corner', () => {
  const drawerRule = css.match(/#layer-drawer \{[^}]*\}/)[0];
  assert.match(drawerRule, /right:\s*12px;/, 'desktop drawer hugs the RIGHT edge; the credit is bottom-LEFT');
  assert.doesNotMatch(drawerRule, /\bleft:/);
  assert.match(drawerRule, /max-height:\s*calc\(100vh - 64px - 24px\)/);
  const phone = css.slice(css.lastIndexOf('/* Temporary phone behaviour'));
  assert.match(phone, /#layer-drawer \{[^}]*max-height:\s*calc\(100vh - 60px - 76px\)/, 'on phones the drawer stops above the credit line');
  assert.match(css, /#about-dialog \{[\s\S]*?max-height:\s*calc\(100vh - 72px - 80px\)/);
  assert.match(css, /#cesium-credits \{[\s\S]*?font-size: 10px;/, 'credit rule (measured) is untouched');
  const credit = css.match(/#cesium-credits \{[^}]*\}/)[0];
  assert.match(credit, /z-index:\s*90;/);
  assert.match(css, /#app-header \{[\s\S]*?top: 0; left: 0; right: 0;/, 'the header is a top strip only');
});

test('chrome hides in clean view, recording and cockpit; Escape and reduced motion are handled', () => {
  assert.match(css, /body\.ui-clean-view :is\(#app-header, #layer-drawer, #about-dialog\)/);
  assert.match(css, /body\.cockpit-mode :is\(#app-header, #layer-drawer, #about-dialog\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #layer-drawer \{ transition: none; transform: none; \} \}/);
  assert.match(css, /\.app-header-btn\[aria-expanded='true'\]/);
  const ui = read('./ui.js');
  assert.equal((ui.match(/'#app-header',/g) || []).length, 2, 'both obstacle lists know the header');
});

// -- grouping ---------------------------------------------------------------------

test('layer groups map every toggle-panel layer as specified', () => {
  const byGroup = Object.fromEntries(LAYER_GROUPS.map((g) => [g.id, [...g.layers]]));
  assert.deepEqual(byGroup.live, ['flights', 'military', 'ais-live-vessels', 'traffic', 'cctv', 'bikeshare', 'radio']);
  assert.deepEqual(byGroup.weather, ['weather-radar', 'local-firms', 'earthquakes']);
  assert.deepEqual(byGroup.infrastructure, ['telegeography-submarine-cables', 'local-datacenters', 'local-dams', 'military-installations']);
  assert.deepEqual(byGroup.space, ['satellites', 'rocket-launches']);
  assert.equal(groupIdForLayer('does-not-exist'), 'live', 'an unknown layer is never hidden');
  const ids = ['satellites', 'flights', 'weather-radar', 'zzz-new', 'local-dams', 'military'];
  assert.deepEqual(orderLayersForDrawer(ids.map((id) => ({ id }))).map((l) => l.id),
    ['flights', 'military', 'zzz-new', 'weather-radar', 'local-dams', 'satellites']);
});

test('every layer the app registers is in a group (nothing falls through silently)', () => {
  const layerSources = ['./data/flights.js', './data/militaryFlights.js', './data/earthquakes.js', './data/satellites.js',
    './data/rocketLaunches.js', './data/traffic.js', './data/cctv.js', './data/radio.js', './data/bikeshare.js',
    './data/aisLiveVessels.js', './data/radarOverlay.js', './data/localLayers.js', './data/telegeographySubmarineCables.js'];
  const declared = new Set();
  for (const file of layerSources) {
    for (const match of read(file).matchAll(/\n\s{2}id: '([a-z-]+)',/g)) declared.add(match[1]);
  }
  declared.add('weather-radar');
  declared.add('military-installations');
  declared.delete('military-awareness'); // not shown in the toggle panel
  const grouped = new Set(LAYER_GROUPS.flatMap((g) => g.layers));
  for (const id of ['flights', 'military', 'ais-live-vessels', 'traffic', 'cctv', 'bikeshare', 'radio', 'weather-radar',
    'local-firms', 'earthquakes', 'local-datacenters', 'local-dams', 'satellites', 'rocket-launches']) {
    assert.ok(grouped.has(id), `${id} is grouped`);
    assert.ok(declared.has(id), `${id} exists in source`);
  }
});

// -- DOM double ---------------------------------------------------------------------

function matches(node, selector) {
  return selector.split(',').some((part) => {
    const trimmed = part.trim();
    if (/^[a-z]+$/.test(trimmed)) return node.tag === trimmed;
    const attr = trimmed.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (attr[1].startsWith('data-')) {
        return attr[2] === undefined ? key in node.dataset : node.dataset[key] === attr[2];
      }
      return false;
    }
    const classes = [...trimmed.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
    if (classes.length && trimmed.replace(/\.[a-zA-Z0-9_-]+/g, '') === '') {
      const own = String(node.className).split(/\s+/);
      return classes.every((c) => own.includes(c));
    }
    return false;
  });
}

function makeNode(tag = 'div') {
  const node = {
    tag,
    children: [],
    className: '',
    dataset: {},
    attributes: {},
    listeners: {},
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    type: '',
    value: '',
    style: {},
    classList: {
      toggle(name, force) {
        const list = String(node.className).split(/\s+/).filter(Boolean);
        const has = list.includes(name);
        const next = force === undefined ? !has : Boolean(force);
        node.className = (next ? (has ? list : [...list, name]) : list.filter((c) => c !== name)).join(' ');
      },
      add(name) { node.classList.toggle(name, true); },
      remove(name) { node.classList.toggle(name, false); },
      contains: (name) => String(node.className).split(/\s+/).includes(name),
    },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    replaceWith(other) {
      const siblings = node.parent.children;
      siblings[siblings.indexOf(node)] = other;
      other.parent = node.parent;
    },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node); },
    addEventListener(name, handler) { (node.listeners[name] ||= []).push(handler); },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute: (name) => (name in node.attributes ? node.attributes[name] : null),
    closest(selector) {
      let current = node;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parent;
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const visit = (current) => {
        for (const child of current.children) {
          if (matches(child, selector) || (selector.includes('.') && matchesCompound(child, selector))) found.push(child);
          visit(child);
        }
      };
      visit(node);
      return found;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    set innerHTML(value) { if (value === '') node.children = []; },
    get innerHTML() { return ''; },
  };
  return node;
}

/** `.a.b` compound only (used for `.data-toggle-btn.active`). */
function matchesCompound(node, selector) {
  const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  const own = String(node.className).split(/\s+/);
  return classes.length > 0 && classes.every((c) => own.includes(c)) && selector.replace(/\.[a-zA-Z0-9_-]+/g, '') === '';
}

function makeLayer(id, name, extra = {}) {
  return {
    id,
    name,
    icon: '',
    source: 'Test',
    updateInterval: -1,
    async init() {},
    enable() {},
    disable() {},
    async update() {},
    getStats() { return { count: 0, lastUpdate: Date.now() }; },
    ...extra,
  };
}

function makeDrawerContainer() {
  const container = makeNode();
  for (const id of ['live', 'weather', 'infrastructure', 'space']) {
    const section = makeNode('section');
    section.dataset.drawerGroup = id;
    const badge = makeNode('span');
    badge.dataset.groupCount = '';
    const body = makeNode();
    body.dataset.groupBody = id;
    section.append(badge, body);
    container.appendChild(section);
  }
  return container;
}

test('grouped rendering: rows land in their group bodies, keep ids and handlers, and static controls survive', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeNode };
  try {
    const mgr = new DataLayerManager({});
    for (const [id, name] of [['satellites', 'Satellites'], ['flights', 'Flights'], ['weather-radar', 'Radar'],
      ['ais-live-vessels', 'Vessels'], ['local-dams', 'Dams'], ['brand-new-layer', 'Brand new']]) {
      mgr.register(makeLayer(id, name));
    }
    const container = makeDrawerContainer();
    // A static control inside a group body (like the weather toggle) must survive re-render.
    const staticTool = makeNode('button');
    staticTool.className = 'drawer-inline-tool';
    const weatherBody = container.querySelector('[data-group-body="weather"]');
    weatherBody.appendChild(staticTool);

    mgr.buildTogglePanel(container);
    const rowsIn = (groupId) => container.querySelector(`[data-group-body="${groupId}"]`)
      .children.filter((n) => n.className === 'data-toggle-row').map((n) => n.dataset.layerId);
    assert.deepEqual(rowsIn('live').slice(0, 2), ['flights', 'ais-live-vessels']);
    assert.ok(rowsIn('live').includes('brand-new-layer'), 'an unlisted layer still gets a row');
    assert.deepEqual(rowsIn('weather'), ['weather-radar']);
    assert.deepEqual(rowsIn('infrastructure'), ['local-dams']);
    assert.deepEqual(rowsIn('space'), ['satellites']);
    assert.equal(weatherBody.children.includes(staticTool), true, 'a static drawer control is not wiped by a render');

    // The row's toggle still drives the layer through the manager.
    const flightsRow = container.querySelector('[data-group-body="live"]').children.find((n) => n.dataset.layerId === 'flights');
    const toggle = flightsRow.querySelector('.data-toggle-btn');
    assert.ok(toggle.listeners.click.length >= 1, 'the click handler is attached');
    await toggle.listeners.click[0]();
    assert.equal(mgr.isEnabled('flights'), true);
    mgr._refreshTogglePanel();
    const liveBadge = container.querySelector('[data-drawer-group="live"]').querySelector('[data-group-count]');
    assert.equal(liveBadge.textContent, '1 on');
    const spaceSection = container.querySelector('[data-drawer-group="space"]');
    assert.equal(spaceSection.hidden, false);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('a plain container (no drawer groups) still renders the flat list exactly as before', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeNode };
  try {
    const mgr = new DataLayerManager({});
    mgr.register(makeLayer('flights', 'Flights'));
    mgr.register(makeLayer('satellites', 'Satellites'));
    const container = makeNode();
    mgr.buildTogglePanel(container);
    assert.deepEqual(container.children.map((n) => n.dataset.layerId), ['flights', 'satellites'], 'registration order, direct children');
  } finally {
    globalThis.document = originalDocument;
  }
});

// -- AIS coverage status (read only) ---------------------------------------------------

const GET_PAYLOAD = {
  mode: 'regions',
  regions: [{ id: 'gulf', label: 'Gulf of Mexico', boxCount: 2 }],
  desired: ['gulf', 'east-coast'],
  subscribed: ['gulf', 'east-coast'],
  applying: false,
  maxRegions: 2,
  writeEnabled: false,
};

test('GET /api/ais-regions payload renders as a compact coverage list', () => {
  const model = buildAisCoverageModel(GET_PAYLOAD);
  assert.deepEqual(model.items, [{ id: 'gulf', label: 'Gulf of Mexico' }, { id: 'east-coast', label: 'U.S. East Coast' }]);
  assert.equal(model.label, 'Coverage');
  assert.equal(model.applying, false);
  assert.equal(model.writable, false, 'the browser model is read-only');
});

test('the /api/ais-live coverage block works too, and pending changes are flagged', () => {
  const model = buildAisCoverageModel({ desired: ['east-coast'], subscribed: ['gulf'], applying: true });
  assert.deepEqual(model.items.map((i) => i.id), ['gulf'], 'shows what the socket was last told');
  assert.equal(model.applying, true);
  assert.deepEqual(buildAisCoverageModel({ desired: ['gulf'], subscribed: [], applying: true }).items.map((i) => i.id), ['gulf']);
});

test('legacy / unknown mode renders the normal Vessels row with no coverage pretence', () => {
  assert.equal(buildAisCoverageModel({ mode: 'legacy-env', desired: [], subscribed: [], applying: false }), null);
  assert.equal(buildAisCoverageModel({ desired: [], subscribed: [], applying: false }), null, 'live block in legacy mode');
  assert.equal(buildAisCoverageModel(null), null);
  assert.equal(buildAisCoverageModel(undefined), null);
  assert.equal(buildAisCoverageModel({ desired: ['atlantis'], subscribed: [] }), null, 'unknown ids are dropped');
});

test('fetchAisRegionsStatus only ever GETs, and a failure means unknown', async () => {
  const calls = [];
  const ok = await fetchAisRegionsStatus(async (url, init) => {
    calls.push([url, init]);
    return { ok: true, json: async () => GET_PAYLOAD };
  });
  assert.deepEqual(ok, GET_PAYLOAD);
  assert.equal(calls[0][0], '/api/ais-regions');
  assert.equal(calls[0][1].method, undefined, 'no method override: a plain GET');
  assert.equal(calls[0][1].body, undefined, 'no body');
  assert.equal(await fetchAisRegionsStatus(async () => ({ ok: false })), null);
  assert.equal(await fetchAisRegionsStatus(async () => { throw new Error('offline'); }), null);
});

test('the manager renders coverage as a read-only list, an updating marker, and an empty future-controls slot', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeNode };
  try {
    const mgr = new DataLayerManager({});
    let model = buildAisCoverageModel(GET_PAYLOAD);
    mgr.register(makeLayer('ais-live-vessels', 'Vessels', { getRowControls: () => (model ? { coverage: model } : null) }));
    const container = makeDrawerContainer();
    mgr.buildTogglePanel(container);
    const row = container.querySelector('[data-layer-id="ais-live-vessels"]');
    const controls = row.querySelector('.data-toggle-controls');
    assert.equal(controls.hidden, true, 'quiet while the layer is off');

    mgr.layers.get('ais-live-vessels').enabled = true;
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, false);
    const node = controls.querySelector('.data-toggle-coverage');
    assert.ok(node);
    assert.deepEqual(node.querySelectorAll('li').map((li) => li.textContent), ['Gulf of Mexico', 'U.S. East Coast']);
    assert.equal(node.querySelectorAll('input').length, 0, 'no inputs: nothing writable');
    assert.equal(node.querySelectorAll('button').length, 0, 'no buttons: nothing writable');
    const slot = node.querySelector('[data-region-controls-slot]');
    assert.ok(slot, 'a reserved slot for the future owner-only switches');
    assert.equal(slot.children.length, 0);
    assert.equal(node.querySelector('.data-toggle-coverage-status'), null);

    model = buildAisCoverageModel({ ...GET_PAYLOAD, applying: true });
    mgr._refreshTogglePanel();
    assert.equal(controls.querySelector('.data-toggle-coverage-status').textContent, 'Updating coverage…', 'status is text, not colour alone');

    model = null; // legacy mode
    mgr._refreshTogglePanel();
    assert.equal(controls.querySelector('.data-toggle-coverage'), null);
    assert.equal(controls.hidden, true, 'the normal Vessels row, no coverage');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('the AIS layer feeds the row from GET status and from the live payload coverage block', () => {
  const source = read('./data/aisLiveVessels.js');
  assert.ok(source.includes('getRowControls() {'));
  assert.ok(source.includes("setCoverageModel(buildAisCoverageModel(payload.coverage));"));
  assert.ok(source.includes('void loadRegionalCoverageStatus();'));
});

// -- drawer behaviour on a DOM double -------------------------------------------------

function makeDrawerDom() {
  const drawer = makeNode('aside');
  drawer.hidden = true;
  const sections = ['live', 'weather', 'map'].map((id, index) => {
    const section = makeNode('section');
    section.dataset.drawerGroup = id;
    const toggle = makeNode('button');
    toggle.className = 'drawer-group-toggle';
    toggle.id = `drawer-toggle-${id}`;
    toggle.attributes['aria-expanded'] = index === 0 ? 'true' : 'false';
    const body = makeNode();
    body.className = 'drawer-group-body';
    body.hidden = index !== 0;
    section.append(toggle, body);
    drawer.appendChild(section);
    return { section, toggle, body };
  });
  return { drawer, sections };
}

test('accordion: opening one group closes the others and keeps aria-expanded in step', () => {
  const { drawer, sections } = makeDrawerDom();
  openOnlyGroup(drawer, 'map');
  assert.deepEqual(sections.map((s) => s.toggle.getAttribute('aria-expanded')), ['false', 'false', 'true']);
  assert.deepEqual(sections.map((s) => s.body.hidden), [true, true, false]);
  openOnlyGroup(drawer, null);
  assert.deepEqual(sections.map((s) => s.body.hidden), [true, true, true]);
  setGroupOpen(sections[1].section, true);
  assert.equal(sections[1].toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(sections[1].section.className.includes('open'), true);
});

function makeAppDom() {
  const byId = new Map();
  const make = (id, tag = 'div') => {
    const node = makeNode(tag);
    node.id = id;
    byId.set(id, node);
    return node;
  };
  const doc = {
    hidden: false,
    listeners: {},
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    addEventListener(name, handler) { (doc.listeners[name] ||= []).push(handler); },
    removeEventListener() {},
    createElement: makeNode,
  };
  const drawer = make('layer-drawer', 'aside');
  drawer.hidden = true;
  const layersBtn = make('layers-btn', 'button');
  layersBtn.attributes['aria-expanded'] = 'false';
  layersBtn.focus = () => { doc.activeElement = layersBtn; };
  const lookBtn = make('look-btn', 'button');
  lookBtn.attributes['aria-expanded'] = 'false';
  const closeBtn = make('layer-drawer-close', 'button');
  const about = make('about-dialog', 'aside');
  about.hidden = true;
  make('about-btn', 'button');
  make('about-dialog-close', 'button');
  make('app-header-map-mode', 'span').textContent = 'Map';
  make('app-header-altitude', 'span');
  make('app-header-clock-value', 'span');
  make('app-header-clock', 'span');
  const look = makeNode('section');
  look.dataset.drawerGroup = 'look';
  const lookToggle = makeNode('button');
  lookToggle.className = 'drawer-group-toggle';
  lookToggle.id = 'drawer-toggle-look';
  lookToggle.attributes['aria-expanded'] = 'false';
  byId.set('drawer-toggle-look', lookToggle);
  const lookBody = makeNode();
  lookBody.className = 'drawer-group-body';
  lookBody.hidden = true;
  look.append(lookToggle, lookBody);
  drawer.appendChild(look);
  const win = {
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => fn(),
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, win, drawer, layersBtn, lookBtn, closeBtn, about, lookToggle };
}

const fire = (doc, target, type, event = {}) => {
  for (const handler of target.listeners?.[type] || doc.listeners[type] || []) handler({ target, defaultPrevented: false, preventDefault() {}, ...event });
};

test('Layers button opens and toggles the drawer; Escape and the close button close it; focus returns', () => {
  const { doc, win, drawer, layersBtn, closeBtn } = makeAppDom();
  const api = initLayerDrawer({ viewer: null, doc, win });
  assert.ok(api);
  assert.equal(drawer.hidden, true, 'closed by default');

  fire(doc, layersBtn, 'click');
  assert.equal(drawer.hidden, false);
  assert.equal(layersBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(api.isOpen(), true);

  fire(doc, doc, 'keydown', { key: 'Escape', target: doc });
  assert.equal(drawer.hidden, true, 'Escape closes');
  assert.equal(layersBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, layersBtn, 'focus returns to the opener');

  fire(doc, layersBtn, 'click');
  fire(doc, layersBtn, 'click');
  assert.equal(drawer.hidden, true, 'the Layers button toggles');

  fire(doc, layersBtn, 'click');
  fire(doc, closeBtn, 'click');
  assert.equal(drawer.hidden, true, 'the close button closes');
  fire(doc, doc, 'keydown', { key: 'a', target: doc });
  fire(doc, doc, 'keydown', { key: 'Escape', target: doc });
  assert.equal(drawer.hidden, true, 'Escape on a closed drawer is inert');
});

test('the Look button opens the drawer on the LOOK group and toggles it closed', () => {
  const { doc, win, drawer, lookBtn, lookToggle } = makeAppDom();
  initLayerDrawer({ viewer: null, doc, win });
  fire(doc, lookBtn, 'click');
  assert.equal(drawer.hidden, false);
  assert.equal(lookToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(lookBtn.getAttribute('aria-expanded'), 'true');
  fire(doc, lookBtn, 'click');
  assert.equal(drawer.hidden, true);
});

test('header formatting helpers', () => {
  assert.equal(formatUtcClock(new Date('2026-09-20T02:05:09Z')), '02:05:09');
  assert.equal(formatHeaderAltitude(45_034), '45 km');
  assert.equal(formatHeaderAltitude(1_500), '1.5 km');
  assert.equal(formatHeaderAltitude(820), '820 m');
  assert.equal(formatHeaderAltitude(Number.NaN), '--');
});

// -- no browser write path, no credential --------------------------------------------------

test('no browser code writes AIS regions or holds an admin credential', () => {
  const clientFiles = ['./ui.js', './main.js', './layerDrawer.js', './layerGroups.js', './data/aisCoverageStatus.js',
    './data/aisLiveVessels.js', './data/manager.js', './data/aisRegions.js', '../index.html'];
  for (const file of clientFiles) {
    const source = read(file);
    assert.equal(/AIS_REGIONS_ADMIN_TOKEN/.test(source), false, `${file} must not mention the admin token`);
    assert.equal(/x-gev-admin-token/i.test(source), false, `${file} must not send the admin header`);
    // Any use of the endpoint path in the browser must be the read-only GET helper.
    if (source.includes('/api/ais-regions')) {
      assert.equal(file, './data/aisCoverageStatus.js', `${file} must not reference the regions endpoint`);
    }
  }
  const status = read('./data/aisCoverageStatus.js');
  assert.equal(/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(status), false, 'no write method');
  assert.equal(/\.setItem\(|sessionStorage|localStorage|document\.cookie/.test(status), false, 'nothing persisted');
  assert.equal(/ais-regions/.test(html), false, 'no form or link to the endpoint in the page');
  assert.equal(/type="password"/.test(html), false, 'no password box');
  assert.equal(/ais-regions|AIS_REGIONS/.test(read('./layerDrawer.js')), false);
  assert.equal(css.includes('data-region-controls-slot') || css.includes('.data-toggle-coverage-slot:empty'), true, 'slot exists but is empty/hidden');
});
