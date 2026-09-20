// RETAINED owner-session client code (ownerCoverage.js + ownerSignInDialog.js). The app no
// longer wires it into the Vessels row - regional coverage is now a personal viewer filter -
// but the modules stay, tested, for future maintenance. Covers the owner state machine, the
// sign-in dialog, and the source-level guarantees (no credential storage, no URL credential,
// cookie-only browser flow).
// A tiny fake DOM keeps this dependency-free; nothing here touches a network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createOwnerCoverage, planRegionChange, OWNER_LEGACY_MESSAGE, OWNER_SESSION_URL, OWNER_REGIONS_URL } from './data/ownerCoverage.js';
import { openOwnerSignInDialog } from './ownerSignInDialog.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = read('../style.css');
const TOKEN = 'fake-owner-token-do-not-leak-321';

// -- fake DOM -------------------------------------------------------------------------------

function makeDom() {
  const doc = {
    activeElement: null,
    listeners: {},
    ids: new Map(),
    createElement: (tag) => makeNode(tag, doc),
    getElementById: (id) => doc.ids.get(id) || null,
    addEventListener(name, fn) { (doc.listeners[name] ||= []).push(fn); },
    removeEventListener(name, fn) { doc.listeners[name] = (doc.listeners[name] || []).filter((f) => f !== fn); },
    fire(name, event) { for (const fn of doc.listeners[name] || []) fn(event); },
  };
  doc.body = makeNode('body', doc);
  return doc;
}

function makeNode(tag, doc) {
  const node = {
    tag, children: [], className: '', dataset: {}, attributes: {}, listeners: {}, parent: null,
    textContent: '', hidden: false, disabled: false, checked: false, value: '', type: '', id: '', title: '',
    classList: { contains: (name) => String(node.className).split(/\s+/).includes(name) },
    appendChild(child) { child.parent = node; node.children.push(child); if (child.id) doc.ids.set(child.id, child); return child; },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    replaceWith(other) {
      const list = node.parent.children;
      list[list.indexOf(node)] = other;
      other.parent = node.parent;
    },
    remove() {
      if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node);
      if (node.id) doc.ids.delete(node.id);
      node.parent = null;
    },
    addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
    setAttribute(name, value) { node.attributes[name] = String(value); if (name === 'id') node.id = String(value); },
    getAttribute: (name) => (name in node.attributes ? node.attributes[name] : null),
    focus() { doc.activeElement = node; for (const fn of node.listeners.focus || []) fn({}); },
    click() { if (!node.disabled) for (const fn of node.listeners.click || []) fn({ preventDefault() {} }); },
    change() { for (const fn of node.listeners.change || []) fn({}); },
    async submit() { for (const fn of node.listeners.submit || []) await fn({ preventDefault() {} }); },
  };
  Object.defineProperty(node, 'id', {
    get() { return node.attributes.id || ''; },
    set(v) { node.attributes.id = String(v); },
  });
  return node;
}

function all(node, predicate, out = []) {
  for (const child of node.children) {
    if (predicate(child)) out.push(child);
    all(child, predicate, out);
  }
  return out;
}
const byClass = (node, cls) => all(node, (n) => String(n.className).split(/\s+/).includes(cls));
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ').replace(/\s+/g, ' ').trim();

// -- fake server ------------------------------------------------------------------------------

function fakeServer({ mode = 'regions', desired = ['gulf'], signedIn = false, token = TOKEN, rejectPost = null } = {}) {
  const calls = [];
  const state = { mode, desired: [...desired], subscribed: [...desired], applying: false, signedIn };
  const status = () => ({
    mode: state.mode, regions: [], desired: state.desired, subscribed: state.subscribed, applying: state.applying,
    minRegions: 1, maxRegions: 2, writeEnabled: state.mode === 'regions',
  });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    const reply = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });
    if (url === OWNER_SESSION_URL) {
      if (method === 'GET') return reply(200, { authenticated: state.signedIn, expiresAt: null });
      if (method === 'DELETE') { state.signedIn = false; return reply(200, { authenticated: false, expiresAt: null }); }
      if (JSON.parse(init.body).token === token) { state.signedIn = true; return reply(200, { authenticated: true, expiresAt: 'x' }); }
      return reply(401, { error: 'Authentication failed.' });
    }
    if (url === OWNER_REGIONS_URL && method === 'POST') {
      if (rejectPost) return reply(rejectPost, { error: 'no' });
      if (!state.signedIn) return reply(401, { error: 'Authorization required.' });
      state.desired = JSON.parse(init.body).regions;
      state.applying = true;
      return reply(202, {});
    }
    if (url === OWNER_REGIONS_URL) return reply(200, status());
    return reply(404, {});
  };
  return { calls, state, fetchImpl, settle() { state.subscribed = [...state.desired]; state.applying = false; } };
}

const newOwner = (server, changes = []) => createOwnerCoverage({
  fetchImpl: server.fetchImpl,
  onChange: () => changes.push(1),
  readStatus: async (f) => (await f(OWNER_REGIONS_URL, { credentials: 'same-origin' })).json(),
});

// -- state machine ------------------------------------------------------------------------------

test('planRegionChange enforces min 1, max 2 and known ids', () => {
  assert.deepEqual(planRegionChange(['gulf'], 'east-coast', true), { ok: true, regions: ['gulf', 'east-coast'] });
  assert.equal(planRegionChange(['gulf', 'east-coast'], 'west-coast', true).ok, false, 'max 2');
  assert.match(planRegionChange(['gulf', 'east-coast'], 'west-coast', true).error, /At most 2/);
  assert.equal(planRegionChange(['gulf'], 'gulf', false).ok, false, 'min 1');
  assert.match(planRegionChange(['gulf'], 'gulf', false).error, /At least one/);
  assert.deepEqual(planRegionChange(['gulf', 'east-coast'], 'gulf', false), { ok: true, regions: ['east-coast'] });
  assert.equal(planRegionChange(['gulf'], 'atlantis', true).ok, false);
});

test('signing in uses one request body, keeps no token, and sends only the session cookie afterwards', async () => {
  const server = fakeServer();
  const owner = newOwner(server);
  await owner.refreshSession();
  assert.equal(owner.view().signedIn, false);
  assert.equal(await owner.signIn('wrong'), false);
  assert.equal(owner.view().signedIn, false);
  assert.equal(await owner.signIn(TOKEN), true);
  assert.equal(owner.view().signedIn, true);
  const withToken = server.calls.filter((c) => JSON.stringify(c).includes(TOKEN));
  assert.equal(withToken.length, 1, 'the token is sent exactly once');
  assert.equal(withToken[0].url, OWNER_SESSION_URL);
  assert.equal(withToken[0].method, 'POST');
  assert.equal(withToken[0].url.includes(TOKEN), false, 'never in a URL');
  for (const call of server.calls) {
    assert.equal(call.init.credentials, 'same-origin', 'cookie-only browser flow');
    assert.equal(JSON.stringify(call.init.headers || {}).toLowerCase().includes('admin-token'), false, 'no admin header');
    assert.equal(/[?#]/.test(call.url), false, 'no query or hash');
  }
  assert.equal(JSON.stringify(owner._state).includes(TOKEN), false, 'not retained in state');
  assert.equal(JSON.stringify(owner.view()).includes(TOKEN), false);
});

test('legacy mode never attempts a POST, even when signed in', async () => {
  const server = fakeServer({ mode: 'legacy-env', desired: [], signedIn: true });
  const owner = newOwner(server);
  await owner.refreshSession();
  const view = owner.view();
  assert.equal(view.signedIn, true);
  assert.equal(view.regionalMode, false);
  await owner.toggle('east-coast', true);
  assert.equal(server.calls.some((c) => c.method === 'POST' && c.url === OWNER_REGIONS_URL), false);
  assert.equal(owner.view().error, OWNER_LEGACY_MESSAGE);
});

test('a change is asked of the server and only shown once the server reports it', async () => {
  const server = fakeServer({ desired: ['gulf'], signedIn: true });
  const owner = newOwner(server);
  await owner.refreshSession();
  const seen = [];
  const original = server.fetchImpl;
  const spied = createOwnerCoverage({
    fetchImpl: async (url, init) => { if (init?.method === 'POST') seen.push(spied.view().selected); return original(url, init); },
    onChange: () => {},
    readStatus: async (f) => (await f(OWNER_REGIONS_URL, { credentials: 'same-origin' })).json(),
  });
  await spied.refreshSession();
  await spied.toggle('east-coast', true);
  assert.deepEqual(seen, [['gulf']], 'during the POST the view still shows the server state, not the wish');
  assert.deepEqual(spied.view().selected, ['gulf', 'east-coast'], 'after the server answered, its state is shown');
  assert.equal(spied.view().applying, true, 'and it reports the change as still applying');
  assert.equal(spied.view().busy, false);
});

test('min-1 and max-2 are enforced client-side before anything is posted', async () => {
  const server = fakeServer({ desired: ['gulf'], signedIn: true });
  const owner = newOwner(server);
  await owner.refreshSession();
  await owner.toggle('gulf', false);
  assert.match(owner.view().error, /At least one/);
  server.state.desired = ['gulf', 'east-coast'];
  await owner.refreshSession();
  await owner.toggle('west-coast', true);
  assert.match(owner.view().error, /At most 2/);
  assert.equal(server.calls.filter((c) => c.method === 'POST' && c.url === OWNER_REGIONS_URL).length, 0);
});

test('a failed update shows an error, changes nothing, and an ended session signs the owner out', async () => {
  const failing = fakeServer({ desired: ['gulf'], signedIn: true, rejectPost: 500 });
  const owner = newOwner(failing);
  await owner.refreshSession();
  await owner.toggle('east-coast', true);
  assert.match(owner.view().error, /Nothing was changed/);
  assert.deepEqual(owner.view().selected, ['gulf']);
  assert.equal(owner.view().signedIn, true);
  const expired = fakeServer({ desired: ['gulf'], signedIn: true, rejectPost: 401 });
  const other = newOwner(expired);
  await other.refreshSession();
  await other.toggle('east-coast', true);
  assert.equal(other.view().signedIn, false);
  assert.match(other.view().error, /Sign in again/);
});

test('signing out asks the server and clears the owner view', async () => {
  const server = fakeServer({ signedIn: true });
  const owner = newOwner(server);
  await owner.refreshSession();
  await owner.signOut();
  assert.equal(owner.view().signedIn, false);
  assert.equal(server.calls.at(-1).method, 'DELETE');
});

test('live coverage updates move the applying flag without another request', async () => {
  const server = fakeServer({ signedIn: true, desired: ['gulf', 'east-coast'] });
  const owner = newOwner(server);
  await owner.refreshSession();
  const before = server.calls.length;
  owner.noteLiveCoverage({ desired: ['gulf', 'east-coast'], subscribed: ['gulf'], applying: true });
  assert.equal(owner.view().applying, true);
  owner.noteLiveCoverage({ desired: ['gulf', 'east-coast'], subscribed: ['gulf', 'east-coast'], applying: false });
  assert.equal(owner.view().applying, false);
  assert.equal(server.calls.length, before);
});

function withDom(fn) {
  const saved = globalThis.document;
  globalThis.document = makeDom();
  return Promise.resolve(fn(globalThis.document)).finally(() => { globalThis.document = saved; });
}

// -- sign-in dialog -------------------------------------------------------------------------------------

test('the sign-in dialog is a labelled password form that never echoes or keeps the token', () => withDom(async (doc) => {
  let received = null;
  const dialog = openOwnerSignInDialog({ doc, submit: async (token) => { received = token; return false; } });
  const root = dialog.element;
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
  assert.match(text(root), /Owner Controls/);
  const input = all(root, (n) => n.tag === 'input')[0];
  assert.equal(input.type, 'password');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  const label = all(root, (n) => n.tag === 'label')[0];
  assert.equal(label.getAttribute('for'), input.id);
  assert.equal(label.textContent, 'Admin token:');
  assert.deepEqual(all(root, (n) => n.tag === 'button').map((b) => b.textContent), ['Sign in', 'Cancel']);
  input.value = TOKEN;
  const form = all(root, (n) => n.tag === 'form')[0];
  await form.submit();
  assert.equal(received, TOKEN, 'handed over once');
  assert.equal(input.value, '', 'cleared as soon as the request settled');
  assert.equal(text(root).includes(TOKEN), false, 'never rendered as text');
  assert.match(text(root), /Sign-in failed\./, 'a generic failure message; the dialog stays for a retry');
  assert.equal(doc.getElementById('owner-signin-dialog'), root);
}));

test('a successful sign-in closes the dialog; Cancel and Escape close it and clear the field', () => withDom(async (doc) => {
  const ok = openOwnerSignInDialog({ doc, submit: async () => true });
  all(ok.element, (n) => n.tag === 'input')[0].value = TOKEN;
  await all(ok.element, (n) => n.tag === 'form')[0].submit();
  assert.equal(doc.getElementById('owner-signin-dialog'), null, 'closed on success');
  const again = openOwnerSignInDialog({ doc, submit: async () => false });
  const input = all(again.element, (n) => n.tag === 'input')[0];
  input.value = 'typed';
  all(again.element, (n) => n.tag === 'button' && n.textContent === 'Cancel')[0].click();
  assert.equal(input.value, '');
  assert.equal(doc.getElementById('owner-signin-dialog'), null);
  const third = openOwnerSignInDialog({ doc, submit: async () => false });
  assert.equal(openOwnerSignInDialog({ doc, submit: async () => false }), null, 'only one dialog at a time');
  doc.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(doc.getElementById('owner-signin-dialog'), null);
  assert.ok(third);
}));

test('an empty submit does not call the server', () => withDom(async (doc) => {
  let calls = 0;
  const dialog = openOwnerSignInDialog({ doc, submit: async () => { calls += 1; return true; } });
  await all(dialog.element, (n) => n.tag === 'form')[0].submit();
  assert.equal(calls, 0);
  assert.match(text(dialog.element), /Enter the admin token\./);
}));

// -- source guarantees ----------------------------------------------------------------------------

const CLIENT_FILES = ['./data/ownerCoverage.js', './ownerSignInDialog.js', './data/aisCoverageStatus.js', './data/aisLiveVessels.js', './data/manager.js', './layerDrawer.js', './ui.js', './main.js'];

test('no client file stores, hard-codes or URL-carries a credential', () => {
  for (const file of CLIENT_FILES) {
    const source = read(file);
    assert.equal(/AIS_REGIONS_ADMIN_TOKEN|x-gev-admin-token/i.test(source), false, `${file}: admin token`);
  }
  for (const file of ['./data/ownerCoverage.js', './ownerSignInDialog.js', './data/aisCoverageStatus.js']) {
    const source = code(file);
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie|location\./.test(source), false, `${file}: no storage, cookie or location access`);
  }
  assert.equal(/token/i.test(read('../index.html').replace(/<script[\s\S]*?<\/script>/g, '')), false, 'no token field or text in the static page');
});

test('the browser only ever POSTs region ids, from one place, with the cookie', () => {
  const owner = read('./data/ownerCoverage.js');
  assert.equal((owner.match(/method: 'POST'/g) || []).length, 2, 'session login and region write');
  assert.match(owner, /credentials: 'same-origin'/);
  assert.match(owner, /JSON\.stringify\(\{ regions \}\)/);
  for (const file of CLIENT_FILES.filter((f) => f !== './data/ownerCoverage.js')) {
    assert.equal(/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(read(file)), false, `${file}: no other write`);
  }
  for (const file of CLIENT_FILES.filter((f) => !['./data/ownerCoverage.js', './data/aisCoverageStatus.js'].includes(f))) {
    assert.equal(read(file).includes('/api/ais-regions'), false, `${file}: does not name the endpoint`);
  }
});

test('the owner sign-in code is retained but NOT wired into the app or the Vessels row', () => {
  const html = read('../index.html');
  assert.equal(/owner-signin|Owner controls|owner-dialog/i.test(html), false);
  // Nothing the app actually loads imports the owner modules.
  for (const file of ['./data/manager.js', './data/aisLiveVessels.js', './layerDrawer.js', './ui.js', './main.js', './data/aisCoverageStatus.js', './data/aisViewFilter.js']) {
    assert.equal(/ownerCoverage|ownerSignInDialog/.test(code(file)), false, `${file} must not import the owner modules`);
  }
  const manager = code('./data/manager.js');
  assert.equal(/Owner controls|Sign in|owner-signin|OWNER_/.test(manager), false, 'no owner UI in the row renderer');
});

// -- mobile / layout ---------------------------------------------------------------------------------

const phone = css.slice(css.lastIndexOf('/* ══ AIS viewer filter'));

test('the retained dialog styles stay mobile-safe (44px, 16px field, top-anchored, no backdrop)', () => {
  assert.match(phone, /\.owner-dialog-input \{ min-height: 44px; font-size: 16px; \}/);
  assert.match(phone, /\.owner-dialog-btn \{ min-height: 44px; \}/);
  assert.match(phone, /width: min\(340px, calc\(100vw - 32px\)\)/, 'fits 320px with a 16px gutter');
  const dialog = /\.owner-dialog \{([^}]*)\}/.exec(phone)[1];
  assert.match(dialog, /position: fixed; top: 72px;/, 'anchored to the top');
  assert.equal(/bottom\s*:/.test(dialog), false, 'never anchored to the bottom where the credit is');
  assert.equal(/inset\s*:\s*0|width:\s*100vw|height:\s*100vh/.test(phone), false, 'no full-screen backdrop');
});

test('the owner block adds no rule that could disturb the pinned coverage/credit rules', () => {
  assert.equal(/!important/.test(phone), false);
  assert.equal(/#cesium-credits|#command-dock|#right-context-rail/.test(phone), false);
  assert.ok(css.includes('.data-toggle-coverage { font-size: 13px; }'), 'existing phone coverage rule untouched');
});
