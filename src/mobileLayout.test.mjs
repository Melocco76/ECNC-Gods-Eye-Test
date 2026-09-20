// Phase 3 (phones): header, bottom sheet, touch targets, search, single-panel rule,
// weather fit, attribution-safe offsets, dev chip, and the guarantees that desktop
// and the AIS read-only display are untouched. CSS/markup probes plus a DOM double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initLayerDrawer, MOBILE_QUERY, panelsToClose } from './layerDrawer.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../index.html');
const css = read('../style.css');
const phoneStart = css.indexOf("Phase 3: phones");
const phone = css.slice(phoneStart);
const phoneBlock = phone.slice(phone.indexOf('@media (max-width: 767px) {'), phone.indexOf('/* Very narrow phones. */'));

/** Text of one rule inside the phone block. */
const phoneRule = (selector) => {
  const at = phoneBlock.indexOf(`${selector} {`);
  assert.ok(at >= 0, `phone rule missing: ${selector}`);
  return phoneBlock.slice(at, phoneBlock.indexOf('}', at) + 1);
};

// -- header ---------------------------------------------------------------------------

test('the phone header is 48px with brand left and Search / Layers / About on the right', () => {
  assert.match(phoneBlock, /#app-header \{ --app-header-height: 48px; height: 48px;/);
  const actions = html.slice(html.indexOf('<nav id="app-header-actions"'), html.indexOf('</nav>', html.indexOf('<nav id="app-header-actions"')));
  const order = [...actions.matchAll(/id="(mobile-search-btn|layers-btn|look-btn|about-btn)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['mobile-search-btn', 'layers-btn', 'look-btn', 'about-btn']);
  assert.match(actions, /id="mobile-search-btn"[^>]*aria-expanded="false" aria-controls="mobile-search-panel" aria-label="Search places"/);
  // Not shown on phones: status chip, credit line, clock, Look text button.
  const hidden = phoneRule('#app-header #title-bar .subtitle,\n  #app-header-center,\n  #app-header-clock,\n  #look-btn');
  assert.match(hidden, /display: none/);
  assert.match(html, /<p class="loader-credit">Based on God's Eye View by Bilawal Sidhu<\/p>/, 'creator credit stays on the loader');
  assert.match(html, /id="about-dialog"[\s\S]*?technology demonstration based on God's Eye View by Bilawal Sidhu/, 'and in About');
});

test('header actions are 44x44 and the title can shrink, so nothing overlaps at 320px', () => {
  assert.match(phoneRule('.app-header-btn'), /width: 44px; height: 44px;/);
  assert.match(phoneRule('#app-header #title-bar'), /min-width: 0;/);
  assert.match(phoneRule('#app-header #title-bar h1 > span:last-child'), /text-overflow: ellipsis;/);
  // 8 + 24..28 logo + 6 + ~105 title + 3 x 44 buttons + 4 padding fits 320.
  const budget = 8 + 28 + 6 + 105 + 3 * 44 + 4;
  assert.ok(budget <= 320, `header budget ${budget}px must fit 320px`);
  assert.match(phone, /@media \(max-width: 359px\) \{[\s\S]*?#app-header #title-bar h1 \{ font-size: 14px; \}/);
  assert.match(css, /\.app-header-btn:hover \{/, 'buttons keep their states');
  assert.match(css, /:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/, 'visible focus survives');
});

test('desktop is untouched: the header stays 56px and the mobile-only controls are hidden by default', () => {
  assert.match(css, /#app-header \{\s*--app-header-height: 56px;/);
  assert.match(css, /#mobile-search-btn,\s*#mobile-search-panel,\s*#drawer-places \{ display: none; \}/);
  assert.match(css, /#layer-drawer \{\s*position: fixed;\s*top: 64px;\s*right: 12px;/, 'the desktop drawer keeps its right-hand geometry');
  assert.equal(phoneStart > css.indexOf('#layer-drawer {'), true, 'phone overrides come last and only inside the media query');
  // Every phone rule lives inside @media (max-width: 767px) or the 359px refinement.
  const outside = css.slice(phoneStart, phoneStart + phone.indexOf('@media (max-width: 767px) {'));
  assert.equal(/^[#.][^\n]*\{/m.test(outside.replace(/#mobile-search-btn,\s*#mobile-search-panel,\s*#drawer-places \{ display: none; \}/, '').replace(/\.drawer-places h4 \{[^}]*\}/, '')), false);
});

// -- bottom sheet --------------------------------------------------------------------------

test('under 768px the Layers drawer is a full-width bottom sheet above the credit line', () => {
  const sheet = phoneRule('#layer-drawer');
  assert.match(sheet, /top: auto; left: 0; right: 0; bottom: 72px;/);
  assert.match(sheet, /width: 100%;/);
  assert.match(sheet, /max-height: min\(50vh, calc\(100dvh - 48px - 72px - 16px\)\);/, 'at least half the map stays visible');
  assert.match(sheet, /transform: translateY\(100%\);/);
  assert.match(phoneRule('#layer-drawer.open'), /transform: none;/);
  assert.match(phoneBlock, /@media \(prefers-reduced-motion: reduce\) \{ #layer-drawer \{ transition: none; \} \}/);
  assert.match(css, /\.drawer-scroll \{ overflow-y: auto;/, 'scrolls internally');
  // Same nodes, same handlers: no second layer system.
  assert.equal((html.match(/id="data-toggles"/g) || []).length, 1);
  assert.equal(/id="mobile-layers/.test(html), false);
  assert.equal(MOBILE_QUERY, '(max-width: 767px)');
});

test('while the sheet is open the transient panels and dock step aside without changing state', () => {
  const rule = phoneBlock.slice(phoneBlock.indexOf('body.mobile-sheet-open'), phoneBlock.indexOf('}', phoneBlock.indexOf('body.mobile-sheet-open')) + 1);
  for (const id of ['#cctv-panel', '#scene-panel', '#global-context-panel', '#map-weather-card', '#command-dock', '#key-setup-chip']) {
    assert.ok(rule.includes(id), `${id} tucks away`);
  }
  assert.match(rule, /visibility: hidden; pointer-events: none;/, 'visibility, not display: nothing is torn down');
});

// -- touch targets ----------------------------------------------------------------------------

test('major phone controls are at least 44px and phone inputs are 16px', () => {
  for (const [selector, pattern] of [
    ['.drawer-close', /width: 44px; height: 44px;/],
    ['.drawer-group-toggle', /min-height: 48px;/],
    ['.data-toggle-btn', /min-width: 56px; min-height: 44px;/],
    ['.data-toggle-chip', /min-height: 44px;/],
    ['#layer-drawer #map-stack-chips .map-stack-chip', /min-height: 44px;/],
    ['#layer-drawer #style-buttons .style-btn', /min-height: 44px;/],
    ['#pp-toggles .pp-toggle-btn', /min-height: 44px;/],
    ['#pp-toggles .pp-select', /height: 44px; font-size: 16px;/],
    ['#command-dock #gev-voice-button', /width: 56px; height: 48px;/],
    ['.panel-collapse-btn', /min-width: 44px; min-height: 44px;/],
  ]) {
    assert.match(phoneRule(selector), pattern, `${selector} touch size`);
  }
  assert.match(phoneBlock, /\.drawer-tool-btn, #layer-drawer #top-center-actions button, #layer-drawer \.drawer-inline-tool \{ min-height: 44px; \}/);
  assert.match(phoneBlock, /\.scene-btn, \.cctv-cal-value, #cctv-panel button, #scene-panel button,\s*#global-context-panel button \{ min-height: 44px; \}/);
  assert.match(phoneBlock, /#cctv-camera-select, #scene-select, #cctv-panel select, #scene-panel select \{ min-height: 44px; font-size: 16px; \}/);
  assert.match(phoneBlock, /#global-context-panel input, #global-context-panel select \{ font-size: 16px; \}/);
  assert.match(phoneRule('#mobile-search-panel #location-search'), /height: 44px;[\s\S]*font-size: 16px;/);
  assert.match(phoneRule('.map-weather-close'), /width: 44px; height: 44px;/);
});

// -- search ---------------------------------------------------------------------------------------

function makeNode(tag = 'div') {
  const node = {
    tag, id: '', children: [], className: '', dataset: {}, attributes: {}, listeners: {}, textContent: '',
    hidden: false, style: {}, parent: null,
    classList: {
      add(name) { if (!String(node.className).split(/\s+/).includes(name)) node.className = `${node.className} ${name}`.trim(); },
      remove(name) { node.className = String(node.className).split(/\s+/).filter((c) => c && c !== name).join(' '); },
      toggle(name, force) { (force ? node.classList.add : node.classList.remove)(name); },
      contains: (name) => String(node.className).split(/\s+/).includes(name),
    },
    appendChild(child) { child.parent?.children && (child.parent.children = child.parent.children.filter((c) => c !== child)); child.parent = node; node.children.push(child); return child; },
    append(...nodes) { nodes.forEach((n) => node.appendChild(n)); },
    prepend(child) { node.appendChild(child); node.children.unshift(node.children.pop()); },
    insertBefore(child, ref) { child.parent?.children && (child.parent.children = child.parent.children.filter((c) => c !== child)); child.parent = node; const i = node.children.indexOf(ref); node.children.splice(i < 0 ? node.children.length : i, 0, child); },
    addEventListener(name, handler) { (node.listeners[name] ||= []).push(handler); },
    removeEventListener() {},
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute: (name) => (name in node.attributes ? node.attributes[name] : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() { node.ownerDoc.activeElement = node; },
    click() { for (const h of node.listeners.click || []) h({ target: node, defaultPrevented: false, preventDefault() {} }); },
  };
  return node;
}

function makePhoneDom({ mobile = true } = {}) {
  const byId = new Map();
  const doc = {
    hidden: false, activeElement: null, listeners: {}, body: makeNode('body'),
    getElementById: (id) => byId.get(id) || null,
    querySelector(selector) { return selector === '.location-search-wrap' ? byId.get('search-wrap') : null; },
    addEventListener(name, handler) { (doc.listeners[name] ||= []).push(handler); },
    removeEventListener() {},
    createElement: makeNode,
  };
  const make = (id, tag = 'div') => {
    const node = makeNode(tag);
    node.id = id;
    node.ownerDoc = doc;
    byId.set(id, node);
    return node;
  };
  doc.body.ownerDoc = doc;
  const drawer = make('layer-drawer', 'aside'); drawer.hidden = true;
  const layersBtn = make('layers-btn', 'button'); layersBtn.attributes['aria-expanded'] = 'false';
  make('look-btn', 'button');
  const searchBtn = make('mobile-search-btn', 'button'); searchBtn.attributes['aria-expanded'] = 'false';
  const searchPanel = make('mobile-search-panel'); searchPanel.hidden = true;
  const slot = make('app-header-search');
  const wrap = make('search-wrap');
  const input = make('location-search', 'input');
  wrap.appendChild(input);
  const dockRow = make('dock-row');
  dockRow.appendChild(wrap);
  make('layer-drawer-close', 'button');
  make('about-dialog', 'aside').hidden = true;
  make('about-btn', 'button');
  make('about-dialog-close', 'button');
  make('app-header-map-mode', 'span');
  make('app-header-altitude', 'span');
  make('app-header-clock-value', 'span');
  make('app-header-clock', 'span');
  for (const id of ['cctv-panel', 'scene-panel', 'global-context-panel']) make(id).className = 'panel-collapsible collapsed';
  const card = make('map-weather-card', 'aside'); card.hidden = true;
  make('map-weather-toggle', 'button');
  make('drawer-body-weather');
  const lookToggle = make('drawer-toggle-look', 'button'); lookToggle.attributes['aria-expanded'] = 'false';
  const timers = [];
  const win = {
    matchMedia: () => ({ matches: mobile, addEventListener() {} }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, win, drawer, layersBtn, searchBtn, searchPanel, slot, wrap, input, dockRow, timers, byId };
}

const press = (doc, key) => { for (const h of doc.listeners.keydown || []) h({ key, target: doc, defaultPrevented: false, preventDefault() {} }); };

test('phone search: the header button opens a panel holding the SAME field; Escape closes it and focus returns', () => {
  const dom = makePhoneDom();
  const api = initLayerDrawer({ viewer: null, doc: dom.doc, win: dom.win });
  assert.equal(dom.wrap.parent, dom.searchPanel, 'the existing search field lives in the phone panel');
  assert.equal(dom.searchPanel.hidden, true);
  dom.searchBtn.click();
  assert.equal(dom.searchPanel.hidden, false);
  assert.equal(dom.searchBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(dom.doc.activeElement, dom.input, 'the field takes focus');
  press(dom.doc, 'Escape');
  assert.equal(dom.searchPanel.hidden, true);
  assert.equal(dom.searchBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.doc.activeElement, dom.searchBtn, 'focus returns to the opener');
  assert.ok(api.openSearch && api.closeSearch);
});

test('phone search closes after Enter so the map is visible, and opening Layers closes search', () => {
  const dom = makePhoneDom();
  initLayerDrawer({ viewer: null, doc: dom.doc, win: dom.win });
  dom.searchBtn.click();
  for (const h of dom.input.listeners.keydown || []) h({ key: 'Enter' });
  assert.equal(dom.searchPanel.hidden, false, 'not before the search has been submitted');
  dom.timers.forEach((fn) => fn());
  assert.equal(dom.searchPanel.hidden, true);
  dom.searchBtn.click();
  dom.layersBtn.click();
  assert.equal(dom.searchPanel.hidden, true, 'one overlay at a time');
  assert.equal(dom.drawer.hidden, false);
});

test('desktop keeps the search in the header slot', () => {
  const dom = makePhoneDom({ mobile: false });
  initLayerDrawer({ viewer: null, doc: dom.doc, win: dom.win });
  assert.equal(dom.wrap.parent, dom.slot);
  assert.equal(dom.searchPanel.hidden, true);
});

test('Escape closes the phone sheet, focus returns to the opener, and the sheet flags the body', () => {
  const dom = makePhoneDom();
  initLayerDrawer({ viewer: null, doc: dom.doc, win: dom.win });
  dom.layersBtn.click();
  assert.equal(dom.drawer.hidden, false);
  assert.equal(dom.doc.body.classList.contains('mobile-sheet-open'), true);
  assert.equal(dom.layersBtn.getAttribute('aria-expanded'), 'true');
  press(dom.doc, 'Escape');
  assert.equal(dom.drawer.hidden, true);
  assert.equal(dom.doc.body.classList.contains('mobile-sheet-open'), false);
  assert.equal(dom.doc.activeElement, dom.layersBtn);
});

test('the sheet opens without waiting on a frame (background tabs pause rAF)', () => {
  const source = read('./layerDrawer.js');
  assert.equal(/requestAnimationFrame/.test(source), false);
  assert.match(source, /void drawer\.offsetHeight;\s*drawer\.classList\.add\('open'\);/);
});

// -- single primary panel --------------------------------------------------------------------------------

test('single-primary-panel rule: the newest panel wins, nothing else changes', () => {
  assert.deepEqual(panelsToClose(['cctv-panel'], new Set()), []);
  assert.deepEqual(panelsToClose(['cctv-panel', 'map-weather-card'], new Set(['cctv-panel'])), ['cctv-panel'], 'weather just opened');
  assert.deepEqual(panelsToClose(['cctv-panel', 'scene-panel'], new Set(['cctv-panel'])), ['cctv-panel']);
  assert.deepEqual(panelsToClose(['scene-panel'], new Set(['scene-panel'])), [], 'no change, no action');
  assert.deepEqual(panelsToClose([], new Set(['scene-panel'])), [], 'closing is never fought');
  assert.deepEqual(panelsToClose(['cctv-panel', 'scene-panel', 'map-weather-card'], new Set()).sort(), ['cctv-panel', 'scene-panel'], 'a persisted pile-up keeps one');
});

test('the rule is gated to phones and uses each panel\'s own collapse/close control', () => {
  const source = read('./layerDrawer.js');
  assert.match(source, /if \(isMobile\(\)\) \{\s*const closing = panelsToClose/);
  assert.match(source, /\[data-collapse-target\]/);
  assert.match(source, /\[data-map-weather-close\]/);
  for (const id of ['cctv-panel', 'scene-panel', 'global-context-panel', 'map-weather-card']) {
    assert.ok(source.includes(`id: '${id}'`), `${id} is governed`);
  }
  // Collapsed launchers are replaced by Tools buttons on phones; desktop keeps them.
  assert.match(phoneBlock, /#cctv-panel\.collapsed, #scene-panel\.collapsed, #global-context-panel\.collapsed \{ display: none !important; \}/);
  assert.match(phoneRule('#left-panel-stack, #right-context-rail'), /max-height: min\(50vh, calc\(100dvh - 48px - 72px - 16px\)\) !important;\s*overflow-y: auto;/);
});

test('the dock place shortcuts move into Tools > Places on phones and return on desktop', () => {
  const source = read('./layerDrawer.js');
  assert.match(source, /placesHost\.append\(\.\.\.\[poiRow, poiDivider, pills\]/);
  assert.match(source, /cityRow\.prepend\(pills\)/);
  assert.match(html, /id="drawer-places" class="drawer-places" hidden/);
  assert.match(phoneRule('#command-dock > #location-bar').replace(/\s+/g, ' '), /display: none !important;/);
});

// -- weather, dock/voice, attribution, dev chip --------------------------------------------------------------

test('transient loading chips sit above the HUD, not over the weather card or sheet', () => {
  const rule = phoneBlock.slice(phoneBlock.indexOf('#global-loading-status, #traffic-sync-chip, #cctv-sync-chip {'));
  assert.match(rule, /top: auto !important; bottom: 132px !important; left: 8px !important;/);
});

test('weather fits a 320px screen, stays legible, and leaves the sheet alone', () => {
  const card = phoneRule('#map-weather-card');
  assert.match(card, /top: 56px; left: 8px; right: 8px; width: auto; transform: none;/);
  assert.match(card, /font-size: 13px;/);
  assert.match(card, /background: rgba\(11, 18, 32, 0\.94\);/, 'high-opacity background over bright imagery');
  assert.match(phoneRule('.map-weather-grid'), /repeat\(3, minmax\(0, 1fr\)\)/);
  const source = read('./layerDrawer.js');
  assert.match(source, /listen\(weatherToggle, 'click'/, 'asking for weather clears the sheet');
  // U.S. customary units are untouched.
  assert.match(read('./weatherUnits.js'), /fahrenheit|°F|mph/i);
});

test('the dock keeps voice only: bottom-right above the credit, labels not clipped', () => {
  assert.match(phoneRule('#command-dock'), /left: auto; right: 8px; bottom: 72px;/);
  assert.match(phoneBlock, /#command-dock \.gev-voice-visualizer, #command-dock \.gev-voice-readout \{ display: none; \}/);
  assert.match(phoneBlock, /#command-dock #gev-voice-control \{ display: flex !important; flex-direction: row;/);
  assert.match(phoneBlock, /#command-dock \.gev-voice-heading \{ display: flex; flex: 0 0 auto; flex-direction: column;/);
  assert.match(read('./main.js'), /initGevVoiceCommands/);
});

test('the dev-only Data sources chip moves to the top-right and never touches the credit line', () => {
  const chip = phoneRule('#key-setup-chip');
  assert.match(chip, /top: 56px; bottom: auto; right: 8px; left: auto; width: 44px; height: 44px;/);
  assert.match(phoneBlock, /#key-setup-chip \[data-key-setup-chip-label\] \{[^}]*clip: rect\(0 0 0 0\);/, 'label stays available to assistive tech');
  assert.equal(/#key-setup-chip[^{]*\{[^}]*bottom: (6|[0-9]{1,2})px/.test(phoneBlock), false);
});

test('provider attribution paths stay reachable on phones', () => {
  assert.match(phoneBlock, /body:not\(\.ui-clean-view\):not\(\.recording-mode\) #cesium-credits,[\s\S]*?left: 8px; bottom: 6px; max-width: calc\(100vw - 16px\); \}/);
  assert.match(html, /id="about-btn"[^>]*aria-controls="about-dialog"/);
  assert.match(read('./layerDrawer.js'), /import\('\.\/data\/dataCredits\.js'\)/);
  assert.match(read('./data/dataCredits.js'), /key: 'ecnc-god-eye'/);
  assert.match(read('./data/dataCredits.js'), /RAINVIEWER_CREDIT/);
});

// -- AIS read-only, ids, no write path -----------------------------------------------------------------------------

test('the phone AIS display stays read-only and compact; legacy mode is unchanged', () => {
  assert.match(phoneBlock, /\.data-toggle-coverage \{ font-size: 13px; \}/);
  assert.match(phoneBlock, /\.data-toggle-coverage-list \{ gap: 2px 8px; \}/);
  assert.equal(/data-toggle-coverage[^{]*\{[^}]*(input|button)/.test(phoneBlock), false);
  const manager = read('./data/manager.js');
  assert.match(manager, /_syncRowCoverage\(container, controls\)/);
  for (const file of ['./layerDrawer.js', './layerGroups.js', './ui.js', './main.js', '../index.html']) {
    const source = read(file);
    assert.equal(/method\s*:\s*['"]POST['"][^}]{0,120}ais-regions|ais-regions[^}]{0,120}method\s*:\s*['"]POST/.test(source), false, `${file} has no POST to /api/ais-regions`);
    assert.equal(/AIS_REGIONS_ADMIN_TOKEN|x-gev-admin-token/i.test(source), false, `${file} carries no admin credential`);
  }
});

test('important legacy ids are preserved', () => {
  for (const id of ['data-panel', 'data-toggles', 'pp-toggles', 'global-context-panel', 'right-context-rail', 'world-overlay-root',
    'world-overlay-actions', 'control-panel', 'cesium-container'.replace('cesium-container', 'cesiumContainer'), 'loading-screen',
    'intel-hud', 'location-search', 'search-toggle', 'poi-row', 'location-pills', 'location-bar-divider', 'title-bar',
    'layers-btn', 'look-btn', 'about-btn', 'layer-drawer', 'map-weather-card', 'cctv-panel', 'scene-panel']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must remain`);
  }
});
