/**
 * @module layerDrawer
 * @description Desktop header + Layers drawer behaviour.
 *
 * The markup is static in index.html. This module only wires it: accordion,
 * open/close, Escape, focus return, the About dialog, the header status and
 * clock, and the few controls that other modules create or reparent at runtime
 * (the Display panel and the header search). Nothing is rebuilt: every moved
 * node keeps its id and its listeners.
 */

const DRAWER_ID = 'layer-drawer';

/**
 * Apply the accordion state to one group. Pure DOM, exported for tests.
 * @param {HTMLElement} section `.drawer-group`
 * @param {boolean} open
 */
export function setGroupOpen(section, open) {
  const toggle = section.querySelector('.drawer-group-toggle');
  const body = section.querySelector('.drawer-group-body');
  if (!toggle || !body) return;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  body.hidden = !open;
  section.classList.toggle('open', open);
}

/**
 * Open exactly one group and close the rest (true accordion).
 * @param {HTMLElement} drawer
 * @param {string|null} groupId
 */
export function openOnlyGroup(drawer, groupId) {
  for (const section of drawer.querySelectorAll('[data-drawer-group]')) {
    setGroupOpen(section, section.dataset.drawerGroup === groupId);
  }
}

/** Format `HH:MM:SS` in UTC. */
export function formatUtcClock(date) {
  return date.toISOString().slice(11, 19);
}

/** Compact altitude for the header: `45 km`, `820 m`. */
export function formatHeaderAltitude(meters) {
  if (!Number.isFinite(meters)) return '--';
  if (meters >= 10_000) return `${Math.round(meters / 1000)} km`;
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.max(0, Math.round(meters))} m`;
}

/**
 * Wire the header and the drawer.
 * @param {{viewer?: object, doc?: Document, win?: Window}} [options]
 * @returns {{open: Function, close: Function, isOpen: () => boolean, destroy: () => void}|null}
 */
export function initLayerDrawer({ viewer = null, doc = document, win = window } = {}) {
  const drawer = doc.getElementById(DRAWER_ID);
  const layersBtn = doc.getElementById('layers-btn');
  const lookBtn = doc.getElementById('look-btn');
  if (!drawer || !layersBtn) return null;

  const cleanups = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener(type, handler, options);
    cleanups.push(() => target?.removeEventListener(type, handler, options));
  };

  let openerButton = null;

  // -- Display panel: reparented into LOOK -------------------------------
  // ui.js prepends #pp-toggles into the right rail during its own init, so this
  // runs afterwards. The node keeps its id and listeners; only its parent moves.
  const lookHost = doc.getElementById('drawer-look-display');
  const display = doc.getElementById('pp-toggles');
  if (lookHost && display && display.parentElement !== lookHost) {
    lookHost.appendChild(display);
    display.classList.add('in-drawer');
    display.classList.remove('collapsed');
  }

  // -- Weather toggle: filed under WEATHER & HAZARDS ---------------------
  const weatherBody = doc.getElementById('drawer-body-weather');
  const weatherToggle = doc.getElementById('map-weather-toggle');
  if (weatherBody && weatherToggle && weatherToggle.parentElement !== weatherBody) {
    weatherBody.prepend(weatherToggle);
    weatherToggle.classList.add('drawer-inline-tool');
  }

  // Text labels for icon-only buttons that now live in the drawer.
  for (const button of drawer.querySelectorAll('[data-drawer-label]')) {
    if (button.querySelector('.drawer-btn-label')) continue;
    const label = doc.createElement('span');
    label.className = 'drawer-btn-label';
    label.textContent = button.dataset.drawerLabel;
    button.appendChild(label);
  }

  // -- Open / close -------------------------------------------------------
  const lookOpen = () => doc.getElementById('drawer-toggle-look')?.getAttribute('aria-expanded') === 'true';
  const syncExpanded = (open = !drawer.hidden) => {
    layersBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lookBtn?.setAttribute('aria-expanded', open && lookOpen() ? 'true' : 'false');
  };

  const isOpen = () => !drawer.hidden;

  function open(groupId = null, opener = layersBtn) {
    openerButton = opener;
    if (groupId) openOnlyGroup(drawer, groupId);
    drawer.hidden = false;
    syncExpanded(true);
    win.requestAnimationFrame?.(() => drawer.classList.add('open'));
    if (!win.requestAnimationFrame) drawer.classList.add('open');
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    drawer.classList.remove('open');
    drawer.hidden = true;
    syncExpanded(false);
    if (restoreFocus) (openerButton || layersBtn).focus?.();
  }

  listen(layersBtn, 'click', () => (isOpen() ? close() : open(null, layersBtn)));
  listen(lookBtn, 'click', () => {
    if (isOpen() && lookOpen()) close();
    else open('look', lookBtn);
  });
  listen(doc.getElementById('layer-drawer-close'), 'click', () => close());

  listen(doc, 'keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (about && !about.hidden) {
      closeAbout();
      return;
    }
    if (isOpen()) {
      event.preventDefault();
      close();
    }
  });

  // -- Accordion ----------------------------------------------------------
  const toggles = () => [...drawer.querySelectorAll('.drawer-group-toggle')].filter((el) => !el.closest('[hidden]'));
  listen(drawer, 'click', (event) => {
    const toggle = event.target.closest?.('.drawer-group-toggle');
    if (!toggle) return;
    const section = toggle.closest('[data-drawer-group]');
    const opening = toggle.getAttribute('aria-expanded') !== 'true';
    openOnlyGroup(drawer, opening ? section.dataset.drawerGroup : null);
    syncExpanded();
  });
  listen(drawer, 'keydown', (event) => {
    const toggle = event.target.closest?.('.drawer-group-toggle');
    if (!toggle) return;
    const list = toggles();
    const index = list.indexOf(toggle);
    let next = null;
    if (event.key === 'ArrowDown') next = list[(index + 1) % list.length];
    else if (event.key === 'ArrowUp') next = list[(index - 1 + list.length) % list.length];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  // Initial state: only the group marked expanded in the markup is open.
  const initiallyOpen = drawer.querySelector('.drawer-group-toggle[aria-expanded="true"]')
    ?.closest('[data-drawer-group]')?.dataset.drawerGroup ?? null;
  openOnlyGroup(drawer, initiallyOpen);

  // -- Tools: open existing panels, focus search ----------------------------
  listen(drawer, 'click', (event) => {
    const panelButton = event.target.closest?.('[data-open-panel]');
    if (panelButton) {
      const panel = doc.getElementById(panelButton.dataset.openPanel);
      const collapseButton = panel?.querySelector('[data-collapse-target]');
      if (panel && collapseButton && panel.classList.contains('collapsed')) collapseButton.click();
      close({ restoreFocus: false });
      panel?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.target.closest?.('[data-drawer-focus-search]')) {
      close({ restoreFocus: false });
      const search = doc.getElementById('location-search');
      if (search) {
        search.classList.add('expanded');
        search.focus();
      }
    }
  });

  // -- Header search (desktop only; mobile keeps the dock search) ----------
  const searchSlot = doc.getElementById('app-header-search');
  const searchWrap = doc.querySelector('.location-search-wrap');
  const dockSearchParent = searchWrap?.parentElement || null;
  const dockSearchNext = searchWrap?.nextSibling || null;
  const mq = win.matchMedia ? win.matchMedia('(min-width: 768px)') : null;
  const placeSearch = () => {
    if (!searchSlot || !searchWrap) return;
    if (!mq || mq.matches) {
      if (searchWrap.parentElement !== searchSlot) searchSlot.appendChild(searchWrap);
      doc.getElementById('location-search')?.classList.add('expanded');
    } else if (dockSearchParent && searchWrap.parentElement !== dockSearchParent) {
      dockSearchParent.insertBefore(searchWrap, dockSearchNext);
    }
  };
  placeSearch();
  if (mq?.addEventListener) listen(mq, 'change', placeSearch);

  // -- Header status: map mode + altitude -----------------------------------
  const modeEl = doc.getElementById('app-header-map-mode');
  const altEl = doc.getElementById('app-header-altitude');
  const syncMode = () => {
    if (!modeEl) return;
    const active = doc.querySelector('#map-stack-chips [aria-pressed="true"], #map-stack-chips .active');
    const label = (active?.textContent || doc.getElementById('map-stack-status')?.textContent || '').trim();
    if (label && modeEl.textContent !== label) modeEl.textContent = label;
  };
  syncMode();
  listen(win, 'gev:map-stack-changed', () => win.setTimeout(syncMode, 0));
  const chips = doc.getElementById('map-stack-chips');
  let chipObserver = null;
  if (chips && typeof win.MutationObserver === 'function') {
    chipObserver = new win.MutationObserver(syncMode);
    chipObserver.observe(chips, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'class'] });
    cleanups.push(() => chipObserver.disconnect());
  }
  const syncAltitude = () => {
    if (!altEl || !viewer?.camera?.positionCartographic) return;
    const text = formatHeaderAltitude(viewer.camera.positionCartographic.height);
    if (altEl.textContent !== text) altEl.textContent = text;
  };
  syncAltitude();
  const moveEnd = viewer?.camera?.moveEnd;
  if (moveEnd?.addEventListener) {
    const remove = moveEnd.addEventListener(syncAltitude);
    cleanups.push(() => (typeof remove === 'function' ? remove() : moveEnd.removeEventListener?.(syncAltitude)));
  }

  // -- UTC clock ---------------------------------------------------------------
  const clockEl = doc.getElementById('app-header-clock-value');
  const tick = (force = false) => {
    if (clockEl && (force || !doc.hidden)) clockEl.textContent = formatUtcClock(new Date());
    doc.getElementById('app-header-clock')?.setAttribute('title', `UTC ${new Date().toISOString().slice(0, 10)}`);
  };
  tick(true);
  const clockTimer = win.setInterval(tick, 1000);
  cleanups.push(() => win.clearInterval(clockTimer));

  // -- About / credits ------------------------------------------------------------
  const about = doc.getElementById('about-dialog');
  const aboutBtn = doc.getElementById('about-btn');
  let creditsLoaded = false;
  async function loadCredits() {
    if (creditsLoaded) return;
    creditsLoaded = true;
    const list = doc.getElementById('about-credits-list');
    if (!list) return;
    try {
      const { DATA_CREDITS } = await import('./data/dataCredits.js');
      for (const credit of DATA_CREDITS) {
        const li = doc.createElement('li');
        li.innerHTML = credit.html;
        list.appendChild(li);
      }
    } catch {
      creditsLoaded = false;
    }
  }
  function openAbout() {
    if (!about) return;
    about.hidden = false;
    aboutBtn?.setAttribute('aria-expanded', 'true');
    void loadCredits();
    about.querySelector('#about-dialog-close')?.focus?.();
  }
  function closeAbout() {
    if (!about) return;
    about.hidden = true;
    aboutBtn?.setAttribute('aria-expanded', 'false');
    aboutBtn?.focus?.();
  }
  listen(aboutBtn, 'click', () => (about?.hidden === false ? closeAbout() : openAbout()));
  listen(doc.getElementById('about-dialog-close'), 'click', closeAbout);

  return {
    open,
    close,
    isOpen,
    openAbout,
    closeAbout,
    destroy() {
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
