// src/data/radarOverlay.js — static latest weather-radar overlay (Phase 1).
//
// One Cesium.ImageryLayer over the latest RainViewer frame:
//   - Google Photorealistic 3D: added to the active Cesium3DTileset's native
//     `imageryLayers` collection (the globe is hidden there, so a plain scene
//     imagery layer would draw nothing).
//   - Globe stacks (Esri / OSM / Bing): added to `viewer.imageryLayers`, above
//     the base imagery.
//   - If the renderer cannot drape imagery on the tileset (no `imageryLayers`,
//     or adding throws), fall back to the Esri globe stack, and restore the
//     previous stack on disable ONLY if radar caused the switch and the user has
//     not changed stacks since.
//
// Static only: no animation and no continuous-render hold. governorRequestRender
// is called on enable/disable, frame change, opacity change, and attachment
// change. The frame index is polled every 5 minutes while enabled and visible.
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  RAINVIEWER_CREDIT,
  registerDynamicCredit,
  unregisterDynamicCredit,
} from './dataCredits.js';
import {
  DEFAULT_RADAR_PROVIDER_ID,
  RADAR_PROVIDERS,
  fetchLatestRadarFrame,
  formatRadarStatus,
  isRadarFrameStale,
} from './radarFrames.js';

export const RADAR_LAYER_ID = 'weather-radar';
export const RADAR_DEFAULT_OPACITY = 0.65;
export const RADAR_MIN_OPACITY = 0.1;
export const RADAR_MAX_OPACITY = 1;
/** Frame-index poll cadence while enabled and visible. */
export const RADAR_REFRESH_MS = 5 * 60_000;
/** Retry delays after consecutive index failures (last value repeats). */
export const RADAR_BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 600_000]);
/** New-frame layer preloads at ~0 alpha this long before the old one is retired. */
export const RADAR_SWAP_OVERLAP_MS = 1_500;
/** Tile errors on one frame before the layer is reported unavailable. */
export const RADAR_TILE_ERROR_LIMIT = 6;
export const RADAR_FALLBACK_STACK_ID = 'esri-imagery';
export const RADAR_FALLBACK_MESSAGE = 'Radar requires globe mode on this renderer';

const PRELOAD_ALPHA = 0.001;

function clampOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(RADAR_MAX_OPACITY, Math.max(RADAR_MIN_OPACITY, n));
}

/** Default ImageryLayer factory: one standard XYZ provider, no on-screen credit. */
function defaultCreateImageryLayer(frame, alpha) {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: frame.urlTemplate,
    tileWidth: frame.tileSize,
    tileHeight: frame.tileSize,
    minimumLevel: 0,
    maximumLevel: frame.maximumLevel,
  });
  return new Cesium.ImageryLayer(provider, { alpha });
}

/**
 * Build a radar layer module. Every dependency is injectable so the lifecycle,
 * race handling and fallback are testable without a viewer or a network.
 * @param {object} [deps]
 */
export function createRadarOverlayLayer(deps = {}) {
  const provider = RADAR_PROVIDERS[deps.providerId || DEFAULT_RADAR_PROVIDER_ID];
  const fetchFrame = deps.fetchFrame || fetchLatestRadarFrame;
  const now = deps.now || Date.now;
  const createImageryLayer = deps.createImageryLayer || defaultCreateImageryLayer;
  const requestRender = deps.requestRender || governorRequestRender;
  const credits = deps.credits || {
    register: (viewer) => registerDynamicCredit(viewer, RAINVIEWER_CREDIT),
    unregister: (viewer) => unregisterDynamicCredit(viewer, RAINVIEWER_CREDIT),
  };
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((id) => clearTimeout(id));
  const getDocument = deps.getDocument || (() => (typeof document !== 'undefined' ? document : null));
  const getEventTarget = deps.getEventTarget || (() => (typeof window !== 'undefined' ? window : null));

  let _viewer = null;
  let _controller = deps.mapStackController || null;
  let _tileset = deps.tileset || null;

  let _enabled = false;
  /** Bumped on every enable/disable/destroy: a late async result carrying an old value is dropped. */
  let _gen = 0;
  let _state = 'off'; // off | loading | ready | unavailable | globe-required
  let _error = null;
  let _opacity = RADAR_DEFAULT_OPACITY;

  let _frame = null;
  let _lastFetchOk = null;
  let _failures = 0;
  let _tileErrors = 0;
  let _fetching = false;

  /** @type {{layer: object, collection: object, owner: 'tileset'|'viewer', removers: Function[]}|null} */
  let _attached = null;
  /** Previous-frame layer kept alive until the new frame has had time to load. */
  let _retiring = null;
  let _swapTimer = null;

  let _photorealUnsupported = false;
  let _fallbackInFlight = false;
  /** @type {{previousId: string, gen: number|null}|null} */
  let _fallback = null;

  let _pollTimer = null;
  let _nextDueAt = 0;
  let _pausedHidden = false;
  let _visibilityCleanup = null;
  let _stackCleanup = null;

  // ── Surface selection ──────────────────────────────────────────────────

  function activeSurface() {
    const id = _controller?.getActiveId?.();
    if (id) return id === 'photoreal' ? 'tileset' : 'viewer';
    return _viewer?.scene?.globe?.show === false ? 'tileset' : 'viewer';
  }

  function tilesetCollection() {
    const tileset = _controller?.googleTileset || _tileset;
    const collection = tileset?.imageryLayers;
    return collection && typeof collection.add === 'function' && typeof collection.remove === 'function'
      ? collection
      : null;
  }

  function isSwitching() {
    try { return _controller?.getState?.()?.status === 'switching'; } catch { return false; }
  }

  function markDirty(reason) {
    try { requestRender(reason); } catch { /* render governor not installed */ }
  }

  // ── Layer attach / detach ──────────────────────────────────────────────

  function buildAttachment(owner, alpha) {
    const collection = owner === 'tileset' ? tilesetCollection() : _viewer?.imageryLayers;
    if (!collection) throw new Error(`no ${owner} imagery collection`);
    const layer = createImageryLayer(_frame, alpha);
    collection.add(layer);
    const removers = [];
    const errorEvent = layer?.imageryProvider?.errorEvent;
    if (errorEvent && typeof errorEvent.addEventListener === 'function') {
      const remove = errorEvent.addEventListener(onTileError);
      if (typeof remove === 'function') removers.push(remove);
    }
    return { layer, collection, owner, removers, framePath: _frame.path };
  }

  function destroyAttachment(attachment) {
    if (!attachment) return;
    for (const remove of attachment.removers) {
      try { remove(); } catch { /* listener already gone */ }
    }
    try { attachment.collection.remove(attachment.layer, true); } catch { /* collection gone */ }
  }

  function finishSwap() {
    if (_swapTimer !== null) { clearTimer(_swapTimer); _swapTimer = null; }
    if (_retiring) { destroyAttachment(_retiring); _retiring = null; }
    if (_attached) {
      try { _attached.layer.alpha = _opacity; } catch { /* layer destroyed */ }
    }
    markDirty('radar-frame');
  }

  function detach() {
    if (_swapTimer !== null) { clearTimer(_swapTimer); _swapTimer = null; }
    if (_retiring) { destroyAttachment(_retiring); _retiring = null; }
    if (_attached) { destroyAttachment(_attached); _attached = null; }
    try { credits.unregister(_viewer); } catch { /* credit display gone */ }
  }

  function attachCredit() {
    try { credits.register(_viewer); } catch { /* credit display unavailable */ }
  }

  function onTileError() {
    if (!_enabled) return;
    _tileErrors += 1;
    if (_tileErrors === RADAR_TILE_ERROR_LIMIT) {
      _state = 'unavailable';
      _error = 'Radar tiles unavailable';
      // The frame may have rotated out from under us — look for a newer one now.
      void refreshFrame();
    }
  }

  /** Make the attachment match the active map stack. Idempotent and synchronous. */
  function reconcile() {
    if (!_enabled || !_frame) return;
    if (isSwitching()) return; // the 'ready' stack event re-runs this
    const owner = activeSurface();

    // The user took the stack away from a fallback we caused: never restore over them.
    if (_fallback && _controller?.getSwitchGeneration?.() !== _fallback.gen && !_fallbackInFlight) {
      _fallback = null;
    }

    if (owner === 'tileset') {
      if (_photorealUnsupported) {
        detach();
        _state = 'globe-required';
        markDirty('radar-attach');
        return;
      }
      if (_attached?.owner === 'tileset' && _attached.collection === tilesetCollection()) {
        if (_attached.framePath !== _frame.path) swapFrame();
        return;
      }
      detach();
      if (!tilesetCollection()) {
        void beginFallback('tileset imageryLayers unavailable');
        return;
      }
      try {
        _attached = buildAttachment('tileset', _opacity);
      } catch (error) {
        void beginFallback(String(error?.message || error));
        return;
      }
      _state = 'ready';
      _error = null;
      attachCredit();
      markDirty('radar-attach');
      return;
    }

    if (_attached?.owner === 'viewer' && _attached.collection === _viewer?.imageryLayers) {
      if (_attached.framePath !== _frame.path) swapFrame();
      return;
    }
    detach();
    try {
      _attached = buildAttachment('viewer', _opacity);
    } catch (error) {
      _state = 'unavailable';
      _error = String(error?.message || error);
      markDirty('radar-attach');
      return;
    }
    _state = 'ready';
    _error = null;
    attachCredit();
    markDirty('radar-attach');
  }

  // ── Fallback (photoreal cannot drape radar) ────────────────────────────

  function restoreFallback(record) {
    const controller = _controller;
    if (!record || !controller?.setStack) return;
    if (controller.getActiveId?.() === record.previousId) return;
    // Only if nobody has switched stacks since our own switch.
    if (controller.getSwitchGeneration?.() !== record.gen) return;
    try {
      Promise.resolve(controller.setStack(record.previousId)).catch(() => {});
    } catch { /* controller gone */ }
  }

  async function beginFallback(reason) {
    if (_fallbackInFlight) return;
    _photorealUnsupported = true;
    detach();
    const controller = _controller;
    if (!controller?.setStack || controller.isStackAvailable?.(RADAR_FALLBACK_STACK_ID) === false) {
      _state = 'globe-required';
      _error = RADAR_FALLBACK_MESSAGE;
      markDirty('radar-fallback');
      return;
    }
    const gen = _gen;
    const previousId = controller.getActiveId?.() || 'photoreal';
    _fallbackInFlight = true;
    _state = 'globe-required';
    _error = null;
    console.info(`[Radar] ${RADAR_FALLBACK_MESSAGE} (${reason})`);
    try {
      await controller.setStack(RADAR_FALLBACK_STACK_ID);
    } catch (error) {
      console.warn('[Radar] fallback stack switch failed:', error);
    } finally {
      _fallbackInFlight = false;
    }
    const activeId = controller.getActiveId?.();
    if (!activeId || activeId === previousId) {
      // The switch did not take: say so honestly instead of pretending.
      if (gen === _gen && _enabled) {
        _state = 'unavailable';
        _error = 'Could not switch to globe mode for radar';
        markDirty('radar-fallback');
      }
      return;
    }
    const record = { previousId, gen: controller.getSwitchGeneration?.() ?? null };
    if (gen !== _gen || !_enabled) {
      // Radar was turned off while the switch was in flight — undo our own switch.
      restoreFallback(record);
      return;
    }
    _fallback = record;
    reconcile();
  }

  // ── Frame index polling ────────────────────────────────────────────────

  function isHidden() {
    return getDocument()?.hidden === true;
  }

  function clearPoll() {
    if (_pollTimer !== null) { clearTimer(_pollTimer); _pollTimer = null; }
  }

  function scheduleNext(delayMs) {
    clearPoll();
    if (!_enabled) return;
    _nextDueAt = now() + delayMs;
    if (isHidden()) { _pausedHidden = true; return; }
    _pollTimer = setTimer(() => {
      _pollTimer = null;
      if (!_enabled) return;
      if (isHidden()) { _pausedHidden = true; return; }
      void refreshFrame();
    }, delayMs);
  }

  function nextDelay() {
    if (_failures > 0) return RADAR_BACKOFF_MS[Math.min(_failures - 1, RADAR_BACKOFF_MS.length - 1)];
    return RADAR_REFRESH_MS;
  }

  /** Swap in a new frame without a visible gap, preserving opacity. */
  function swapFrame() {
    finishSwap();
    const old = _attached;
    let next;
    try {
      next = buildAttachment(old.owner, PRELOAD_ALPHA);
    } catch (error) {
      // Keep the frame that is already on screen; the next poll retries.
      console.warn('[Radar] could not attach the new radar frame:', error);
      return;
    }
    _retiring = old;
    _attached = next;
    _swapTimer = setTimer(() => { _swapTimer = null; finishSwap(); }, RADAR_SWAP_OVERLAP_MS);
    markDirty('radar-frame');
  }

  async function refreshFrame() {
    if (!_enabled || _fetching) return;
    const gen = _gen;
    _fetching = true;
    let frame = null;
    let failure = null;
    try {
      frame = await fetchFrame({ provider });
    } catch (error) {
      failure = error;
    } finally {
      _fetching = false;
    }
    if (gen !== _gen || !_enabled) return;

    if (failure || !frame) {
      _failures += 1;
      // A radar that is already showing stays showing.
      if (!_frame) {
        _state = 'unavailable';
        _error = String(failure?.message || 'Radar frame index unavailable');
      }
      scheduleNext(nextDelay());
      return;
    }

    _failures = 0;
    _lastFetchOk = now();
    if (!_frame || frame.path !== _frame.path) {
      _frame = frame;
      _tileErrors = 0;
      _error = null;
      if (_state === 'unavailable') _state = 'ready';
    }
    // Same path: nothing to do — unless an earlier swap failed and left the
    // previous frame on screen, in which case retry it now.
    if (!_attached || _attached.framePath !== _frame.path) reconcile();
    scheduleNext(RADAR_REFRESH_MS);
  }

  function onVisibilityChange() {
    if (!_enabled) return;
    if (isHidden()) {
      clearPoll();
      _pausedHidden = true;
      return;
    }
    if (!_pausedHidden && _pollTimer !== null) return;
    _pausedHidden = false;
    scheduleNext(Math.max(0, _nextDueAt - now()));
  }

  function installListeners() {
    const doc = getDocument();
    if (!_visibilityCleanup && doc?.addEventListener) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
      _visibilityCleanup = () => doc.removeEventListener('visibilitychange', onVisibilityChange);
    }
    const target = getEventTarget();
    if (!_stackCleanup && target?.addEventListener) {
      const onStack = (event) => {
        try {
          if (!_enabled || event?.detail?.status === 'switching') return;
          reconcile();
        } catch (error) {
          console.warn('[Radar] stack-change handling failed:', error);
        }
      };
      target.addEventListener('gev:map-stack-changed', onStack);
      _stackCleanup = () => target.removeEventListener('gev:map-stack-changed', onStack);
    }
  }

  function removeListeners() {
    if (_visibilityCleanup) { _visibilityCleanup(); _visibilityCleanup = null; }
    if (_stackCleanup) { _stackCleanup(); _stackCleanup = null; }
  }

  // ── Presentation ───────────────────────────────────────────────────────

  /** Radar is showing on the globe because WE switched stacks (and the user has not since). */
  function fallbackActive() {
    return Boolean(_fallback) && _controller?.getSwitchGeneration?.() === _fallback.gen;
  }

  function globeRequired() {
    return _state === 'globe-required' || fallbackActive();
  }

  function statusText() {
    if (!_enabled) return '';
    const nowMs = now();
    // Radar not drawn and the user must pick a globe stack (or none is available).
    if (_state === 'globe-required') return formatRadarStatus({ state: 'globe-required', nowMs });
    // The automatic switch succeeded: radar is already working.
    if (fallbackActive()) return formatRadarStatus({ state: 'globe-fallback', nowMs });
    if (_state === 'unavailable') return formatRadarStatus({ state: 'unavailable', nowMs });
    if (!_frame) return formatRadarStatus({ state: 'loading', nowMs });
    return formatRadarStatus({ state: 'ready', frame: _frame, nowMs });
  }

  // ── Layer module contract ──────────────────────────────────────────────

  const layer = {
    id: RADAR_LAYER_ID,
    name: 'Weather Radar',
    icon: '☔',
    source: provider.name,
    updateInterval: 0,
    // Re-render the row so "8 min ago" ticks and staleness surfaces on its own.
    statsRefreshInterval: 15_000,

    /** Connect the map-stack controller (and its Google tileset). Optional in tests. */
    attachMapContext({ mapStackController = null, tileset = null } = {}) {
      if (mapStackController) _controller = mapStackController;
      if (tileset) _tileset = tileset;
    },

    init(viewer) {
      _viewer = viewer || _viewer;
      _enabled = false;
      _state = 'off';
    },

    async enable(viewer, { signal } = {}) {
      if (viewer) _viewer = viewer;
      if (_enabled) return true;
      _enabled = true;
      const gen = ++_gen;
      _state = 'loading';
      _error = null;
      _frame = null;
      _failures = 0;
      _tileErrors = 0;
      _photorealUnsupported = false;
      installListeners();
      markDirty('radar-enable');

      let frame = null;
      let failure = null;
      _fetching = true;
      try {
        frame = await fetchFrame({ signal, provider });
      } catch (error) {
        failure = error;
      } finally {
        _fetching = false;
      }
      if (gen !== _gen || !_enabled) return true; // disabled while the fetch was pending
      if (signal?.aborted) throw failure || new DOMException('Aborted', 'AbortError');

      if (failure || !frame) {
        // Stay enabled but honest: UNAVAILABLE, retrying with backoff.
        _failures = 1;
        _state = 'unavailable';
        _error = String(failure?.message || 'Radar frame index unavailable');
        scheduleNext(nextDelay());
        return true;
      }
      _frame = frame;
      _lastFetchOk = now();
      reconcile();
      scheduleNext(RADAR_REFRESH_MS);
      return true;
    },

    disable() {
      _gen += 1;
      const wasEnabled = _enabled;
      _enabled = false;
      clearPoll();
      _pausedHidden = false;
      removeListeners();
      detach();
      const record = _fallback;
      _fallback = null;
      _photorealUnsupported = false;
      _fallbackInFlight = false;
      _state = 'off';
      _error = null;
      _frame = null;
      _tileErrors = 0;
      _failures = 0;
      restoreFallback(record);
      if (wasEnabled) markDirty('radar-disable');
      return true;
    },

    async update() {
      return true; // frame refresh is owned by this module's own visibility-aware poll
    },

    destroy() {
      layer.disable();
      _viewer = null;
      _controller = null;
      _tileset = null;
      _opacity = RADAR_DEFAULT_OPACITY;
      _lastFetchOk = null;
    },

    /** { opacity } in 0.1..1; anything else is rejected. */
    setParams(params = {}) {
      if (!Object.hasOwn(params, 'opacity')) return true;
      const next = clampOpacity(params.opacity);
      if (next === null) return false;
      _opacity = next;
      // During a frame swap the incoming layer is still preloading at ~0 alpha.
      if (_attached && _swapTimer === null) {
        try { _attached.layer.alpha = _opacity; } catch { /* layer destroyed */ }
      }
      markDirty('radar-opacity');
      return true;
    },

    getParams() {
      return { opacity: _opacity };
    },

    getStatusText() {
      return statusText();
    },

    /** Row descriptor consumed by the data-layer panel. */
    getRowControls() {
      return {
        slider: {
          id: 'opacity',
          label: 'OPACITY',
          paramKey: 'opacity',
          scale: 0.01,
          min: Math.round(RADAR_MIN_OPACITY * 100),
          max: Math.round(RADAR_MAX_OPACITY * 100),
          step: 5,
          value: Math.round(_opacity * 100),
          valueText: `${Math.round(_opacity * 100)}%`,
          ariaLabel: 'Radar opacity',
        },
        note: { text: `Radar © ${provider.name}`, href: provider.homepage },
        // Space for the future play/pause control (Phase 3); nothing functional yet.
        reserveSlot: true,
      };
    },

    getStats() {
      const stale = _frame ? isRadarFrameStale(_frame, now()) : false;
      const retryInSec = _pollTimer !== null && _failures > 0
        ? Math.max(0, Math.round((_nextDueAt - now()) / 1000))
        : 0;
      return {
        count: 0,
        lastUpdate: _lastFetchOk,
        loading: _state === 'loading',
        loadingLabel: statusText(),
        stale,
        fallback: globeRequired(),
        error: !_frame && _state === 'unavailable' ? _error : null,
        status: _state === 'unavailable' ? 'unavailable' : undefined,
        source: provider.name,
        state: _state,
        frameTimeMs: _frame?.timeMs ?? null,
        framePath: _frame?.path ?? null,
        opacity: _opacity,
        attachedTo: _attached?.owner ?? null,
        retryInSec,
      };
    },
  };

  return layer;
}

const radarOverlayLayer = createRadarOverlayLayer();

export default radarOverlayLayer;
