/**
 * @module flightPanel
 * @description Expanded "Flight details" panel for the selected CIVIL aircraft.
 *
 * ADDITIVE: the compact tracked readout card stays exactly as it is (it is the
 * quick view). This panel is opened deliberately from a "Flight details" button
 * that only exists while a civil aircraft is selected, and it only READS the
 * flights layer: opening, closing or refreshing it never touches selection,
 * follow, trail, cockpit or the context slot.
 *
 * Phase A uses ONLY data the browser already holds - nothing here fetches:
 *  - live fields from the feed row (adsb.lol in production),
 *  - identity/route already resolved through the adsbdb proxy,
 *  - values calculated locally (bearing, straight-line distance, a rough time
 *    remaining), each one labelled as calculated/estimated.
 * A row is rendered only when its value exists; nothing is invented, and no
 * provider-supplied ETA is ever implied.
 *
 * This module knows nothing about AIS/vessels and imports only the shared
 * great-circle helpers.
 */
import { bearingRad, greatCircleKm } from './data/routePlausible.js';

const KM_PER_NM = 1.852;
const FT_PER_M = 3.28084;
const KT_PER_MPS = 1.94384;
/** ft/min per m/s. */
const FPM_PER_MPS = 196.85;
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Below this the ground speed is too low for a meaningful "time remaining". */
const ETA_MIN_SPEED_MPS = 50; // ~97 kt
const ETA_MIN_DISTANCE_KM = 20;
const ETA_MAX_HOURS = 20;
/** The aircraft must be roughly pointed at the destination or the estimate misleads. */
const ETA_MAX_OFF_COURSE_DEG = 60;

const CLASS_LABELS = Object.freeze({
  airliner: 'Airliner',
  widebody: 'Widebody airliner',
  quadjet: 'Four-engine jet',
  turboprop: 'Turboprop',
  bizjet: 'Business jet',
  light: 'Light aircraft',
  helicopter: 'Helicopter',
  glider: 'Glider',
  fastjet: 'Fast jet',
  uav: 'Unmanned aircraft',
});

const SQUAWK_NOTES = Object.freeze({
  7500: 'hijack code',
  7600: 'radio failure code',
  7700: 'general emergency code',
});

// -- formatting -----------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
const grouped = (n) => Math.round(n).toLocaleString('en-US');

/** `FL350 (35,000 ft)` at or above 18,000 ft, otherwise `5,400 ft`. */
export function formatAltitude(meters) {
  if (!isNum(meters)) return null;
  const ft = Math.round(meters * FT_PER_M);
  return ft >= 18000 ? `FL${Math.round(ft / 100)} (${grouped(ft)} ft)` : `${grouped(ft)} ft`;
}

export function formatGeometricAltitude(meters) {
  return isNum(meters) ? `${grouped(meters * FT_PER_M)} ft (GPS)` : null;
}

export function formatSpeedKt(mps) {
  return isNum(mps) ? `${Math.round(mps * KT_PER_MPS)} kt` : null;
}

export function compassPoint(deg) {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function formatBearing(deg) {
  if (!isNum(deg)) return null;
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${d}° ${compassPoint(d)}`;
}

/** `+1,280 fpm ▲`, `−640 fpm ▼`, or `Level` inside ±50 fpm. */
export function formatVerticalRate(mps) {
  if (!isNum(mps)) return null;
  const fpm = Math.round((mps * FPM_PER_MPS) / 10) * 10;
  if (Math.abs(fpm) < 50) return 'Level';
  return `${fpm > 0 ? '+' : '−'}${grouped(Math.abs(fpm))} fpm ${fpm > 0 ? '▲' : '▼'}`;
}

export function formatCoordinates(lat, lon) {
  if (!isNum(lat) || !isNum(lon)) return null;
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** `Updated 4s ago`, `Updated 1m 05s ago`. Null when the age is unknown. */
export function formatDataAge(ageMs) {
  if (!isNum(ageMs)) return null;
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `Updated ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m}m ${String(s % 60).padStart(2, '0')}s ago`;
  return 'Updated over 1h ago';
}

export function formatDuration(minutes) {
  if (!isNum(minutes) || minutes < 0) return null;
  const total = Math.round(minutes);
  if (total < 60) return `${Math.max(1, total)} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

/**
 * Clock time of a trace timestamp: `12:42 PM` today, `Sep 20, 11:15 PM` otherwise.
 * @param {number} epochSec
 * @param {number} nowMs
 * @param {string} [timeZone] IANA zone (tests pin one; the browser default is used otherwise).
 */
export function formatTraceTime(epochSec, nowMs, timeZone) {
  if (!isNum(epochSec)) return null;
  const date = new Date(epochSec * 1000);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
  const day = (d) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(d);
  if (day(date) === day(new Date(nowMs))) return time;
  return `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(date)}, ${time}`;
}

export function formatSquawk(code) {
  const c = text(code);
  if (!c) return null;
  const note = SQUAWK_NOTES[c];
  return note ? `${c} · ${note}` : c;
}

// -- calculations (never provider data) ---------------------------------------------------------

/** Initial great-circle bearing from A to B in degrees [0, 360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  return (((bearingRad(lat1, lon1, lat2, lon2) * 180) / Math.PI) + 360) % 360;
}

/** Smallest absolute difference between two compass angles. */
export function angleDiffDeg(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/**
 * Straight-line remaining distance and bearing to the destination airport.
 * @returns {{km:number, nm:number, bearing:number}|null}
 */
export function remainingToDestination({ lat, lon, destination }) {
  if (!isNum(lat) || !isNum(lon) || !isNum(destination?.lat) || !isNum(destination?.lon)) return null;
  const km = greatCircleKm(lat, lon, destination.lat, destination.lon);
  return { km, nm: km / KM_PER_NM, bearing: bearingDeg(lat, lon, destination.lat, destination.lon) };
}

/**
 * ROUGH time remaining: straight-line distance over current ground speed. It is
 * only produced when it would not mislead: airborne, a usable ground speed, a
 * real distance, and the aircraft pointed roughly at the destination.
 * @returns {number|null} minutes
 */
export function estimateMinutesRemaining({ distanceKm, speedMps, trackDeg, bearing, onGround }) {
  if (onGround === true) return null;
  if (!isNum(distanceKm) || distanceKm < ETA_MIN_DISTANCE_KM) return null;
  if (!isNum(speedMps) || speedMps < ETA_MIN_SPEED_MPS) return null;
  if (!isNum(trackDeg) || !isNum(bearing) || angleDiffDeg(trackDeg, bearing) > ETA_MAX_OFF_COURSE_DEG) return null;
  const minutes = distanceKm * 1000 / speedMps / 60;
  return minutes / 60 > ETA_MAX_HOURS ? null : minutes;
}

// -- model --------------------------------------------------------------------------------------------

function airport(point) {
  const code = text(point?.code);
  if (!code) return null;
  const name = text(point?.name);
  return name ? `${code} · ${name}` : code;
}

/**
 * Turn the flights layer's tracked-aircraft description into sections/rows.
 * Rows with no value are omitted; sections with no rows are omitted.
 *
 * @param {object|null} d `flightsLayer.getTrackedDetails()`
 * @param {{nowMs?: number}} [options]
 * @returns {{icao24: string, title: string, sections: {id: string, title: string, rows: {key: string, label: string, value: string, tag?: string, tone?: string}[]}[]}|null}
 */
export function buildFlightDetailsModel(d, { nowMs = Date.now(), timeZone } = {}) {
  if (!d || !text(d.icao24)) return null;
  const callsign = text(d.callsign);
  const registration = text(d.registration);
  const route = d.route && airport(d.route.origin) && airport(d.route.destination) ? d.route : null;
  const airborne = d.onGround !== true;
  const speedUsable = isNum(d.velocityMps) && (d.velocityMps > 0 || d.onGround === true);

  const flight = [
    ['callsign', 'Callsign', callsign],
    ['operator', 'Airline / operator', text(d.airline)],
    ['route', 'Route', route ? `${text(route.origin.code)} → ${text(route.destination.code)}` : null],
    ['origin', 'Origin', route ? airport(route.origin) : null],
    ['destination', 'Destination', route ? airport(route.destination) : null],
  ];

  const typeCode = text(d.typeCode);
  const klass = text(d.klass);
  const showClass = klass && (typeCode || klass !== 'airliner'); // 'airliner' alone is only the default guess
  const typeName = text(d.typeName);
  const manufacturer = text(d.manufacturer);
  // The provider usually folds the manufacturer into the type string ("Airbus A321 ...");
  // a separate Manufacturer row would only repeat it.
  const manufacturerRedundant = Boolean(manufacturer && typeName && typeName.toLowerCase().includes(manufacturer.toLowerCase()));
  // Registry fields are labelled for what they are: the owner OF RECORD, which is not
  // necessarily the airline flying this leg (that stays in the FLIGHT section).
  const aircraft = [
    ['registration', 'Registration', registration],
    ['manufacturer', 'Manufacturer', manufacturerRedundant ? null : manufacturer],
    ['type', 'Type', typeName],
    ['typeCode', 'ICAO type', typeCode],
    ['registeredOwner', 'Registered owner', text(d.registeredOwner)],
    ['ownerCountry', 'Owner country', text(d.registeredOwnerCountry)],
    ['operatorCode', 'Operator code', text(d.operatorFlagCode)],
    ['class', 'Class', showClass ? (CLASS_LABELS[klass] || klass) : null],
    ['icao24', 'ICAO24', text(d.icao24)?.toUpperCase()],
    ['country', 'Country (ICAO24 block)', text(d.originCountry)],
  ];

  const live = [
    ['status', 'Status', d.stale ? 'Stale · showing last known position' : 'Live'],
    ['ground', 'Ground state', d.onGround === true ? 'On ground' : (d.onGround === false ? 'Airborne' : null)],
    ['altitude', 'Altitude', airborne ? formatAltitude(d.altitudeM) : null],
    ['geoAltitude', 'Geometric altitude', airborne ? formatGeometricAltitude(d.geoAltitudeM) : null],
    ['speed', 'Ground speed', speedUsable ? formatSpeedKt(d.velocityMps) : null],
    ['track', 'Track', speedUsable && d.velocityMps > 0 ? formatBearing(d.trackDeg ?? d.track) : null],
    ['vertical', 'Vertical rate', airborne ? formatVerticalRate(d.verticalRateMps) : null],
    ['squawk', 'Squawk', formatSquawk(d.squawk)],
    ['position', 'Position', formatCoordinates(d.latitude, d.longitude)],
    ['age', 'Data age', isNum(d.lastContactEpochMs) ? formatDataAge(nowMs - d.lastContactEpochMs) : null],
  ];

  const calc = [];
  let remaining = null;
  if (route) {
    remaining = remainingToDestination({ lat: d.latitude, lon: d.longitude, destination: route.destination });
  }
  if (remaining) {
    calc.push(['bearing', 'Bearing to destination', formatBearing(remaining.bearing), 'CALCULATED']);
    calc.push(['distance', 'Distance remaining', `${grouped(remaining.nm)} nm (${grouped(remaining.km)} km) straight line`, 'ESTIMATED']);
    const minutes = estimateMinutesRemaining({
      distanceKm: remaining.km,
      speedMps: d.velocityMps,
      trackDeg: d.trackDeg ?? d.track,
      bearing: remaining.bearing,
      onGround: d.onGround,
    });
    const duration = minutes === null ? null : formatDuration(minutes);
    if (duration) calc.push(['eta', 'Time remaining', `≈ ${duration}`, 'ESTIMATED']);
  }

  // History from the adsb.lol trace (selection-only). Times are the first/last TRACE timestamps of the
  // current leg, not a schedule; distance and duration are calculated here from those points.
  const history = d.history;
  const historyReady = history?.status === 'ready' && history.stats;
  if (history?.status === 'loading') {
    calc.push(['history', 'History', 'Loading…']);
  } else if (history?.status === 'unavailable') {
    calc.push(['history', 'History', 'History unavailable']);
  } else if (historyReady) {
    const st = history.stats;
    const since = formatTraceTime(st.startEpoch, nowMs, timeZone);
    calc.push(['trackedSince', 'Tracked since', since ? `${since}${st.startsAtTraceBeginning ? ' (start of available trace)' : ''}` : null]);
    if (st.onGroundNow) calc.push(['trackedUntil', 'Tracked until', formatTraceTime(st.endEpoch, nowMs, timeZone)]);
    calc.push(['trackedDuration', 'Tracked duration', isNum(st.durationSec) ? formatDuration(st.durationSec / 60) : null, 'CALCULATED']);
    calc.push(['trackedDistance', 'Tracked distance', isNum(st.distanceKm) ? `${grouped(st.distanceKm / KM_PER_NM)} nm (${grouped(st.distanceKm)} km)` : null, 'CALCULATED']);
    calc.push(['historyPoints', 'History points', isNum(st.keptPoints) && isNum(st.legPoints) ? `${grouped(st.keptPoints)} shown · ${grouped(st.legPoints)} recorded` : null]);
  }

  const enrichedByAdsbdb = Boolean(registration || text(d.typeName) || typeCode || text(d.airline) || route
    || manufacturer || text(d.registeredOwner) || text(d.registeredOwnerCountry) || text(d.operatorFlagCode));
  const source = [
    ['feed', 'Live position', text(d.feed?.source) ? `${text(d.feed.source)}${text(d.feed?.coverage) ? ` · ${text(d.feed.coverage)}` : ''}` : null],
    ['identity', 'Identity / route', enrichedByAdsbdb ? 'adsbdb' : null],
    ['history', 'Track history', historyReady ? 'adsb.lol trace · current leg' : null],
    ['calcNote', 'Calculated values', (remaining || historyReady) ? 'Values tagged CALCULATED or ESTIMATED are computed here from airport coordinates and the position trace. They are not provider data, and time remaining is a rough estimate.' : null],
  ];

  const toRows = (rows) => rows
    .filter(([, , value]) => value)
    .map(([key, label, value, tag]) => ({ key, label, value, ...(tag ? { tag } : {}) }));
  const sections = [
    { id: 'flight', title: 'Flight', rows: toRows(flight) },
    { id: 'aircraft', title: 'Aircraft', rows: toRows(aircraft) },
    { id: 'live', title: 'Live', rows: toRows(live) },
    { id: 'route', title: 'Route', rows: toRows(calc) },
    { id: 'source', title: 'Source', rows: toRows(source) },
  ].filter((section) => section.rows.length > 0);

  return {
    icao24: text(d.icao24).toLowerCase(),
    title: callsign || registration || text(d.icao24).toUpperCase(),
    sections,
  };
}

// -- panel controller -------------------------------------------------------------------------------

/**
 * Wire the button/panel that already exist in index.html. Returns null when the
 * markup is absent (nothing to wire, nothing to break).
 *
 * @param {object} options
 * @param {() => object|null} options.getDetails Reads the tracked civil aircraft description.
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @param {() => number} [options.now]
 * @param {number} [options.refreshMs] Refresh cadence while the panel is OPEN (never per frame).
 */
export function initFlightPanel({ getDetails, requestHistory = null, doc = globalThis.document, win = globalThis.window, now = () => Date.now(), refreshMs = 2000 } = {}) {
  const button = doc?.getElementById('flight-details-btn');
  const panel = doc?.getElementById('flight-details-panel');
  const body = doc?.getElementById('flight-details-body');
  const title = doc?.getElementById('flight-details-title');
  if (!button || !panel || !body || typeof getDetails !== 'function') return null;
  const closeBtn = panel.querySelector?.('[data-flight-details-close]') || null;

  let selectedId = null;
  let open = false;
  let timer = null;
  let settleTimer = null;
  let lastSignature = '';
  let refs = new Map();
  const cleanups = [];
  const listen = (target, name, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler, options);
    cleanups.push(() => target.removeEventListener?.(name, handler, options));
  };

  const setButton = () => {
    // The button only exists while a civil aircraft is selected and the panel is closed.
    button.hidden = !selectedId || open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  function clearBody() {
    lastSignature = '';
    refs = new Map();
    body.replaceChildren?.();
    if (title) title.textContent = '';
  }

  function paint(model) {
    if (title) title.textContent = model.title;
    const signature = `${model.icao24}#${model.sections.map((s) => `${s.id}:${s.rows.map((r) => r.key).join(',')}`).join('|')}`;
    if (signature !== lastSignature) {
      const sameAircraft = lastSignature.startsWith(`${model.icao24}#`);
      const scroll = sameAircraft ? body.scrollTop : 0;
      refs = new Map();
      body.replaceChildren?.();
      for (const section of model.sections) {
        const wrap = doc.createElement('section');
        wrap.className = 'flight-details-section';
        wrap.setAttribute('aria-label', section.title);
        const heading = doc.createElement('h3');
        heading.textContent = section.title;
        const list = doc.createElement('dl');
        for (const row of section.rows) {
          const line = doc.createElement('div');
          line.className = row.key === 'calcNote' ? 'flight-details-row is-note' : 'flight-details-row';
          const dt = doc.createElement('dt');
          dt.textContent = row.label;
          const dd = doc.createElement('dd');
          const value = doc.createElement('span');
          value.className = 'flight-details-value';
          value.textContent = row.value;
          dd.appendChild(value);
          let tag = null;
          if (row.tag) {
            tag = doc.createElement('small');
            tag.className = 'flight-details-tag';
            tag.textContent = row.tag;
            dd.appendChild(tag);
          }
          line.append(dt, dd);
          list.appendChild(line);
          refs.set(row.key, { value, tag });
        }
        wrap.append(heading, list);
        body.appendChild(wrap);
      }
      lastSignature = signature;
      body.scrollTop = scroll;
      return;
    }
    for (const section of model.sections) {
      for (const row of section.rows) {
        const ref = refs.get(row.key);
        if (!ref) continue;
        if (ref.value.textContent !== row.value) ref.value.textContent = row.value;
        if (ref.tag && row.tag && ref.tag.textContent !== row.tag) ref.tag.textContent = row.tag;
      }
    }
  }

  /** Read the layer and paint. A description for a DIFFERENT aircraft than the selected one is never shown. */
  function refresh() {
    if (!open) return;
    let details = null;
    try { details = getDetails(); } catch { details = null; }
    const model = details && selectedId && String(details.icao24).toLowerCase() === selectedId
      ? buildFlightDetailsModel(details, { nowMs: now() })
      : null;
    if (!model) {
      clearBody();
      return;
    }
    paint(model);
  }

  /** The panel being opened (or following a new selection while open) is the deliberate action that fetches history. */
  function askForHistory() {
    if (typeof requestHistory !== 'function' || !selectedId) return;
    try { requestHistory(selectedId); } catch { /* history is optional */ }
  }

  function stopTimer() {
    if (timer !== null) { win.clearInterval(timer); timer = null; }
  }

  function openPanel() {
    if (open || !selectedId) return;
    // The Layers drawer occupies the same right edge; only one may be open.
    const drawer = doc.getElementById('layer-drawer');
    if (drawer?.classList?.contains('open')) doc.getElementById('layer-drawer-close')?.click();
    open = true;
    panel.hidden = false;
    doc.body?.classList?.add('flight-details-open'); // lets the phone layout clear the voice dock
    setButton();
    askForHistory();
    refresh();
    stopTimer();
    timer = win.setInterval(refresh, refreshMs);
    timer?.unref?.();
  }

  function closePanel({ restoreFocus = false } = {}) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    doc.body?.classList?.remove('flight-details-open');
    stopTimer();
    setButton();
    if (restoreFocus && !button.hidden) button.focus?.();
  }

  function settle() {
    settleTimer = null;
    if (selectedId) return;
    closePanel();
    clearBody();
    setButton();
  }

  const onSelected = (event) => {
    const detail = event?.detail || {};
    if (settleTimer !== null) { win.clearTimeout(settleTimer); settleTimer = null; }
    if (detail.layerId !== 'flights') {
      // Another layer took the selection (military, vessel...): this panel is civil-only.
      selectedId = null;
      settle();
      return;
    }
    const id = String(detail.id || '').toLowerCase();
    const changed = id !== selectedId;
    selectedId = id || null;
    if (changed) clearBody();
    setButton();
    if (open) {
      if (changed) askForHistory();
      refresh();
    }
  };

  const onCleared = (event) => {
    const detail = event?.detail || {};
    if (detail.layerId && detail.layerId !== 'flights') return;
    selectedId = null;
    // Switching planes emits "cleared" then "selected" in the same call; wait one
    // tick so an open panel follows the switch instead of closing and reopening.
    if (settleTimer !== null) win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(settle, 0);
  };

  listen(win, 'gev:awareness-subject-selected', onSelected);
  listen(win, 'gev:awareness-subject-cleared', onCleared);
  listen(button, 'click', () => openPanel());
  listen(closeBtn, 'click', () => closePanel({ restoreFocus: true }));
  // Escape inside the panel closes the panel only; it must not reach the
  // document-level handler that deselects the aircraft.
  listen(panel, 'keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation?.();
    closePanel({ restoreFocus: true });
  });

  const drawer = doc.getElementById('layer-drawer');
  if (drawer && typeof win.MutationObserver === 'function') {
    const observer = new win.MutationObserver(() => {
      if (drawer.classList?.contains('open') && open) closePanel();
    });
    observer.observe(drawer, { attributes: true, attributeFilter: ['class'] });
    cleanups.push(() => observer.disconnect());
  }

  panel.hidden = true;
  setButton();

  return {
    open: openPanel,
    close: closePanel,
    isOpen: () => open,
    selectedId: () => selectedId,
    refresh,
    destroy() {
      stopTimer();
      doc.body?.classList?.remove('flight-details-open');
      if (settleTimer !== null) win.clearTimeout(settleTimer);
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
