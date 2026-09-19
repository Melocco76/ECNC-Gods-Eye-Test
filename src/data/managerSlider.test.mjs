// DataLayerManager: optional slider row control + layer-owned status text
// (both added for the weather-radar layer). DOM double only — no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';

/** DOM double rich enough for the row-controls render path. */
function makeElement() {
  const element = {
    children: [],
    className: '',
    dataset: {},
    style: {},
    attributes: {},
    listeners: {},
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    type: '',
    value: '',
    classList: { toggle() {} },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) n.parent = this; this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    remove() {
      const siblings = this.parent?.children;
      if (siblings) this.parent.children = siblings.filter((n) => n !== this);
    },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    closest(selector) {
      return String(this.className).split(/\s+/).includes(selector.slice(1)) ? this : null;
    },
    querySelector(selector) {
      if (selector.startsWith('[data-layer-id="')) {
        const id = selector.slice(16, -2);
        return this.children.find((child) => child.dataset.layerId === id) || null;
      }
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      const visit = (node) => {
        if (String(node.className).split(/\s+/).includes(className)) return node;
        for (const child of node.children || []) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    },
    set innerHTML(value) { if (value === '') this.children = []; },
    get innerHTML() { return ''; },
  };
  return element;
}

function collectByClass(node, className) {
  const found = [];
  const visit = (current) => {
    if (String(current.className).split(/\s+/).includes(className)) found.push(current);
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return found;
}

function makeSliderLayer() {
  const state = { opacity: 0.65, paramCalls: [] };
  return {
    state,
    module: {
      id: 'weather-radar',
      name: 'Weather Radar',
      icon: '',
      source: 'RainViewer',
      updateInterval: -1,
      async init() {},
      enable() {},
      disable() {},
      async update() {},
      getStats() { return { count: 0, lastUpdate: Date.now(), loading: true }; },
      getStatusText() { return 'RADAR · 14:20Z · 8 min ago'; },
      setParams(params) {
        state.paramCalls.push(params);
        if (Number.isFinite(params.opacity)) state.opacity = params.opacity;
      },
      getParams() { return { opacity: state.opacity }; },
      getRowControls() {
        const pct = Math.round(state.opacity * 100);
        return {
          slider: {
            id: 'opacity', label: 'OPACITY', paramKey: 'opacity', scale: 0.01,
            min: 10, max: 100, step: 5, value: pct, valueText: `${pct}%`, ariaLabel: 'Radar opacity',
          },
          note: { text: 'Radar © RainViewer', href: 'https://www.rainviewer.com/' },
          reserveSlot: true,
        };
      },
    },
  };
}

test('a layer can declare a slider: rendered in place, hidden while off, written through setParams', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeElement };
  const mgr = new DataLayerManager({});
  const layer = makeSliderLayer();
  mgr.register(layer.module);
  const container = makeElement();

  try {
    mgr.buildTogglePanel(container);
    const row = container.querySelector('[data-layer-id="weather-radar"]');
    const controls = row.querySelector('.data-toggle-controls');
    assert.equal(controls.hidden, true, 'quiet while the layer is off');

    assert.equal(await mgr.setEnabled('weather-radar', true), true);
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, false);

    assert.equal(collectByClass(controls, 'data-toggle-slider').length, 1, 'slider row rendered');
    const [input] = collectByClass(controls, 'data-toggle-slider-input');
    const [value] = collectByClass(controls, 'data-toggle-slider-value');
    assert.equal(input.type, 'range');
    assert.equal(input.value, '65');
    assert.equal(value.textContent, '65%');
    assert.deepEqual([input.attributes.min, input.attributes.max, input.attributes.step], ['10', '100', '5']);
    assert.equal(input.attributes['aria-label'], 'Radar opacity');
    assert.equal(collectByClass(controls, 'data-toggle-slot-reserved').length, 1, 'space reserved for a future control');
    const [note] = collectByClass(controls, 'data-toggle-note');
    assert.equal(note.textContent, 'Radar © RainViewer');
    assert.equal(note.attributes.href, 'https://www.rainviewer.com/');
    assert.equal(note.attributes.rel, 'noopener noreferrer');

    // Dragging: the delegated input listener scales the percent into the layer's unit.
    input.value = '40';
    controls.listeners.input({ target: input });
    assert.deepEqual(layer.state.paramCalls.at(-1), { opacity: 0.4 });
    assert.equal(layer.state.opacity, 0.4);
    assert.equal(value.textContent, '40%', 'the value label follows the layer state');

    // Panel refreshes reuse the same nodes (a drag in progress keeps focus).
    mgr._refreshTogglePanel();
    mgr._refreshTogglePanel();
    assert.equal(collectByClass(controls, 'data-toggle-slider-input')[0], input, 'input node is reused');
    assert.equal(collectByClass(controls, 'data-toggle-slider').length, 1, 'no duplicate slider rows');
    assert.equal(collectByClass(controls, 'data-toggle-note').length, 1);

    // A non-finite drag value is ignored.
    const callsBefore = layer.state.paramCalls.length;
    input.value = 'x';
    controls.listeners.input({ target: input });
    assert.equal(layer.state.paramCalls.length, callsBefore);

    // Disabling hides the block again.
    assert.equal(await mgr.setEnabled('weather-radar', false), true);
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, true);
    assert.equal(collectByClass(controls, 'data-toggle-slider').length, 0, 'slider removed when off');
    assert.equal(collectByClass(controls, 'data-toggle-note').length, 0);
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('a layer-supplied status line is shown verbatim while enabled, and never while off', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSliderLayer();
  mgr.register(layer.module);
  const meta = () => mgr._buildMetaText(mgr.getAll().find((entry) => entry.id === 'weather-radar'));
  assert.notEqual(meta(), 'RADAR · 14:20Z · 8 min ago', 'off: the generic composition');
  assert.equal(await mgr.setEnabled('weather-radar', true), true);
  assert.equal(meta(), 'RADAR · 14:20Z · 8 min ago');
  layer.module.getStatusText = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => meta(), 'a throwing status hook falls back to the generic text');
  layer.module.getStatusText = () => '   ';
  assert.notEqual(meta().trim(), '', 'a blank status falls back to the generic text');
  await mgr.destroyAll();
});
