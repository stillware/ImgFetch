/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch, popup/popup.js
 * Popup controller: scan results, filters, preview, queue and history.
 * Module script: imports pure core helpers directly.
 */
import {
  applyFilters,
  formatGroup,
  matchesQuery,
  sortImages,
  sizeChipForPreset,
} from '../core/filters.js';
import { groupByDay } from '../core/history.js';
import {
  buildHistoryRow,
  historyCountLabel,
  wireClearHistory,
  updateHistoryRowThumb,
  HISTORY_FORMAT_LABELS as FORMAT_LABELS,
} from '../shared/history-ui.js';
import { initI18n, t, applyI18n, onLanguageChange } from '../shared/i18n.js';

const UI = window.ImgFetchUI;

// B: runtime localization. No top-level await; handlers await i18nReady.
const i18nReady = initI18n();
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  scan: null,          // { images, url, title, at }
  visible: [],         // filtered+sorted images
  selected: new Set(),
  downloaded: new Set(), // D3: image ids downloaded in this popup session
  filters: { size: 'any', formats: [], orientations: [], query: '', sort: 'order' },
  quality: 'smart',    // 'smart' | 'normal'
  avifOk: null,       // M12: null = unknown (assume supported), false = hide AVIF UI
  gridShown: 0,       // M11: how many grid items are currently rendered (windowed)
  view: 'home',        // 'home' | 'history'
  pane: 'idle',        // home sub-view: 'idle' | 'scanning' | 'results' | 'queue'
};

/**
 * Cancel flag for a scan the popup itself started. The worker has no
 * CANCEL_SCAN message, so Cancel cannot abort the scan in the page; it
 * returns the popup to the dashboard and discards that scan's result
 * when it arrives (see cancelScan). A new scan clears the flag.
 */
let scanDismissed = false;

/** Display order of the format chips, matching the mockup. */
const FORMAT_CHIP_ORDER = ['png', 'jpg', 'webp', 'gif', 'avif'];
/** Format labels and history badge classes live in shared/history-ui.js. */

/* ------------------------------------------------------------------ */
/* Page blob: thumbnails, blob: URLs only resolve inside the page, so the */
/* popup asks the service worker to fetch a preview in-page.               */
/* ------------------------------------------------------------------ */

const blobPreviewCache = new Map(); // blob: URL -> data URL
const blobPreviewPending = new Set();
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Assign an <img> source for a scan record. Page blob: URLs can't load in
 * the popup origin, so they resolve lazily (with a blank placeholder and
 * a shimmer class until the preview arrives). `full` resolves the original
 * bytes (preview modal); otherwise a light JPEG thumbnail is used.
 */
function setThumbSource(imgEl, img, full) {
  const src = img.src || '';
  if (!src.startsWith('blob:')) {
    imgEl.src = src;
    return;
  }
  imgEl.dataset.blobSrc = src;
  imgEl.dataset.blobMode = full ? 'full' : 'thumb';
  const cached = blobPreviewCache.get(src + (full ? '#full' : '#thumb'));
  if (cached) {
    imgEl.src = cached;
    return;
  }
  imgEl.src = BLANK_IMG;
  imgEl.classList.add('thumb-loading');
  const key = src + (full ? '#full' : '#thumb');
  if (blobPreviewPending.has(key)) return;
  blobPreviewPending.add(key);
  // B6: cap concurrent thumbnail resolutions, hundreds of results used to
  // fire one RESOLVE_BLOB message each, all at once.
  const tabId = state.scan && state.scan.tabId;
  enqueueBlobResolve(key, src, full, tabId);
}

/**
 * B6: bounded-concurrency queue for blob: thumbnail resolutions.
 * At most BLOB_RESOLVE_CONCURRENCY in flight; the rest wait their turn.
 */
const BLOB_RESOLVE_CONCURRENCY = 6;
let blobResolveActive = 0;
const blobResolveQueue = [];

function enqueueBlobResolve(key, src, full, tabId) {
  blobResolveQueue.push({ key, src, full, tabId });
  pumpBlobResolves();
}

function pumpBlobResolves() {
  while (blobResolveActive < BLOB_RESOLVE_CONCURRENCY && blobResolveQueue.length) {
    const job = blobResolveQueue.shift();
    blobResolveActive += 1;
    resolveOneBlob(job).finally(() => {
      blobResolveActive -= 1;
      pumpBlobResolves();
    });
  }
}

async function resolveOneBlob({ key, src, full, tabId }) {
  try {
    const res = await UI.send('RESOLVE_BLOB', {
      url: src,
      tabId: String(tabId == null ? '' : tabId),
      mode: full ? 'full' : 'thumb',
    });
    if (res && res.dataUrl) {
      blobPreviewCache.set(key, res.dataUrl);
      const wantMode = full ? 'full' : 'thumb';
      document.querySelectorAll('img[data-blob-src]').forEach((el) => {
        if (el.dataset.blobSrc === src && el.dataset.blobMode === wantMode) {
          el.src = res.dataUrl;
          el.classList.remove('thumb-loading');
        }
      });
    }
  } catch {
    /* thumbnail stays in shimmer state; the full image still downloads */
  } finally {
    blobPreviewPending.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', init);

/**
 * Localize tooltips that live as plain title attributes in the HTML and
 * therefore are not covered by data-i18n-attr.
 */
function applyDynamicTitles() {
  const bulkBest = document.querySelector('#bulkBest');
  const bulkBestTip = bulkBest && bulkBest.closest('label')
    ? bulkBest.closest('label').querySelector('span')
    : null;
  if (bulkBestTip) bulkBestTip.title = t('popup_bulkBestTitle');
}

async function init() {
  await i18nReady;
  applyI18n();
  applyDynamicTitles();
  onLanguageChange(() => { applyI18n(); applyDynamicTitles(); renderCaptureProgress(); refreshResultsChrome(); if (UI.refreshDropdowns) UI.refreshDropdowns(document); });
  try {
    const { settings } = await UI.send('GET_SETTINGS');
    state.settings = settings;
    UI.applyTheme(settings.theme);
    UI.watchSystemTheme(() => state.settings.theme);
    // M12: hide AVIF options when the browser can't encode it.
    try {
      const { avif } = await UI.send('GET_FORMAT_SUPPORT');
      state.avifOk = !!avif;
    } catch {
      state.avifOk = false;
    }
    const avifOpt = document.querySelector('#dlFormat option[value="avif"]');
    if (avifOpt && !state.avifOk) {
      avifOpt.disabled = true;
      avifOpt.textContent = t('popup_avifUnsupported');
    }
    // H1: results size filter starts from the user's scan setting.
    const chip = sizeChipForPreset(settings.minSizePreset);
    state.filters.size = chip;
    document.querySelectorAll('[data-size]').forEach((c) =>
      c.setAttribute('aria-pressed', String(c.getAttribute('data-size') === chip)));
  } catch {
    UI.applyTheme('system');
  }

  wireNav();
  wireHome();
  wireResults();
  wireQueue();
  wireHistory();
  // Phase 5 A7: one shared custom dropdown per native select.
  if (UI.initDropdowns) UI.initDropdowns(document);

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // The last scan and any running downloads are preserved, never lost.
  // A scan started by the global shortcut while the popup was closed is
  // picked up here: land on the live SCANNING pane, or show fresh RESULTS
  // directly. The user never presses Scan again for a scan that ran.
  try {
    const { scan } = await UI.send('GET_LAST_SCAN');
    if (scan && scan.images) state.scan = scan;
  } catch { /* no stored scan; continue without it */ }
  try {
    const { state: scanState, forCurrentTab } = await UI.send('GET_SCAN_STATE');
    if (scanState && forCurrentTab) {
      if (scanState.status === 'scanning') {
        applyRoute({ view: 'home', pane: 'idle' });
        renderHomeStatus();
        navigate('home', 'scanning');
        updateScanProgress(0, 1);
        return;
      }
      if (scanState.status === 'results' && state.scan && state.scan.images) {
        applyRoute({ view: 'home', pane: 'idle' });
        renderHomeStatus();
        showScan(state.scan, true);
        return;
      }
    }
  } catch { /* scan state unavailable; fall through to dashboard */ }
  applyRoute({ view: 'home', pane: 'idle' });
  renderHomeStatus();
  // If downloads are in flight when the popup opens, land on the queue pane
  // so the progress bar is visible immediately (not hidden on the dashboard).
  try {
    const { snapshot } = await UI.send('GET_QUEUE');
    if (snapshot && (snapshot.active > 0 || snapshot.pending > 0)) {
      navigate('home', 'queue');
    }
  } catch { /* queue unavailable; stay on dashboard */ }
  // Round 5: reopened mid-capture, show the live progress at once.
  try {
    const { progress } = await UI.send('GET_CAPTURE_PROGRESS');
    if (progress && progress.phase === 'capturing') showCaptureProgress(progress);
  } catch { /* no capture running: stay idle */ }
}

function onRuntimeMessage(msg, sender) {
  // F4: the popup only acts on broadcasts from our own extension (the
  // service worker). A foreign sender must never drive popup state.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'SCAN_PROGRESS': {
      // H2: this broadcast arrives directly from the content script, so
      // the worker's isValidMessage never sees it. Reject malformed
      // counts before they reach the progress bar.
      if (!Number.isInteger(msg.done) || !Number.isInteger(msg.total)
        || msg.done < 0 || msg.total < 0 || msg.done > 1_000_000 || msg.total > 1_000_000
        || msg.done > msg.total) break;
      // A scan started by the global shortcut while this popup sat on its
      // dashboard: follow it live instead of waiting for another click.
      // Only the opening broadcast (0 done, no real total yet) starts a
      // new scan, so only it clears a previous Cancel. Later progress
      // from the scan the user just cancelled must not resurrect it:
      // clearing the flag on every message let the next progress yank
      // the popup back to the scanning pane after Cancel (see cancelScan).
      const starting = msg.done === 0 && msg.total <= 1;
      if (starting) {
        scanDismissed = false;
        if (state.view === 'home' && state.pane === 'idle') navigate('home', 'scanning');
      }
      if (!scanDismissed) updateScanProgress(msg.done, msg.total);
      break;
    }
    case 'SCAN_DONE':
      // A scan the user cancelled stays discarded: the worker has no abort
      // path, so its late result must not yank the popup to the results.
      if (msg.scan && !scanDismissed) showScan(msg.scan, true);
      break;
    case 'QUEUE_UPDATE':
      if (msg.snapshot) {
        renderQueue(msg.snapshot);
        renderHomeStatus(msg.snapshot);
        maybeAutoCollapseQueue(msg.snapshot);
        // D3: a finished queue item marks its tile downloaded, even when
        // the download was started outside this results view.
        markDownloaded((msg.snapshot.items || []).filter((i) => i.state === 'done').map((i) => i.id));
      }
      break;
    case 'NOTICE_TEXT':
      UI.toast(msg.text);
      break;
    case 'CAPTURE_PROGRESS':
      onCaptureProgressMessage(msg);
      break;
    case 'NOTICE':
      if (msg.detail) UI.toast(msg.detail);
      else if (msg.code) UI.toast(friendlyNotice(msg.code));
      break;
    case 'HISTORY_THUMB': {
      // B1 backfill: a thumbnail arrived after the row was painted.
      // Update that row's tile in place, without re-rendering the list.
      if (msg.id && msg.thumb && state.view === 'history') {
        const row = document.querySelector(`[data-record-id="${CSS.escape(String(msg.id))}"]`);
        if (row) updateHistoryRowThumb(row, msg.thumb);
      }
      break;
    }
    default:
      break;
  }
}

function friendlyNotice(code) {
  const map = {
    queued: t('notice_queued'),
    copied: t('notice_copied'),
    'copy-failed': t('notice_copyFailed'),
    'disabled-site': t('notice_disabledSite'),
    'convert-failed': t('notice_convertFailed'),
    'original-unknown': t('notice_originalUnknown'),
    'lens-failed': t('notice_lensFailed'),
    'lens-paste-manually': t('notice_lensPasteManually'),
  };
  return map[code] || t('notice_done');
}

/* ------------------------------------------------------------------ */
/* Queue auto-collapse, the progress pane gets out of the way once    */
/* everything finishes, instead of sitting open on a done list.       */
/* ------------------------------------------------------------------ */

let queueDoneTimer = 0;
let queueCompletedAt = 0;
let popupInteractedAt = 0;
['click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => {
  popupInteractedAt = Date.now();
}, { passive: true, capture: true }));

function maybeAutoCollapseQueue(snapshot) {
  const total = snapshot.total || 0;
  const finished = (snapshot.done || 0) + (snapshot.failed || 0);
  clearTimeout(queueDoneTimer);
  if (!total || finished < total) return; // still running
  if (!state.settings || state.settings.autoCollapseQueue === false) return;
  queueCompletedAt = Date.now();
  queueDoneTimer = setTimeout(() => {
    // Don't yank the UI: skip when the user touched the popup after
    // completion, or when they already navigated elsewhere.
    if (popupInteractedAt > queueCompletedAt) return;
    if (state.view !== 'home' || state.pane !== 'queue') return;
    navigate('home', 'idle', { replace: true });
  }, 1000);
}

/* ------------------------------------------------------------------ */
/* Navigation, one predictable router                                  */
/* ------------------------------------------------------------------ */

// Top-level views: 'home' | 'history'. The home view has sub-panes:
// 'idle' (dashboard) | 'scanning' | 'results' | 'queue' (download status).
const PANE_IDS = {
  idle: 'paneIdle',
  scanning: 'paneScanning',
  results: 'paneResults',
  queue: 'paneQueue',
};

const nav = {
  stack: [], // previous { view, pane } routes, for Back
};

function currentRoute() {
  return { view: state.view, pane: state.pane };
}

function routeOrder(route) {
  // G2: the page slide follows navigation, so routes have an order:
  // home panes first, history last. A move to a later route slides
  // forward, to an earlier one slides back.
  if (route.view === 'history') return 4;
  return { idle: 0, scanning: 1, results: 2, queue: 3 }[route.pane] ?? 0;
}

let routedOnce = false;

function applyRoute(route, direction) {
  state.view = route.view;
  state.pane = route.pane;
  $('viewHome').hidden = route.view !== 'home';
  $('viewHistory').hidden = route.view !== 'history';
  $('navHome').setAttribute('aria-pressed', String(route.view === 'home'));
  $('navHistory').setAttribute('aria-pressed', String(route.view === 'history'));
  let shown = null;
  if (route.view === 'home') {
    for (const [name, id] of Object.entries(PANE_IDS)) {
      $(id).hidden = name !== route.pane;
    }
    shown = $(PANE_IDS[route.pane]);
  } else {
    shown = $('viewHistory');
  }
  // G2: the newly shown view slides in (8 px, 250 ms, blur to 0).
  // The first route is the popup's first paint and never animates.
  if (routedOnce && direction && direction !== 'none' && shown && UI.runViewTransition) {
    UI.runViewTransition(shown, direction);
  }
  routedOnce = true;
}

/**
 * Navigate to a view/pane. The previous route is pushed so Back works;
 * pass { replace: true } to skip the stack for transient states.
 */
function navigate(view, pane, opts = {}) {
  const next = { view, pane: view === 'home' ? (pane || 'idle') : null };
  const cur = currentRoute();
  const same = cur.view === next.view && cur.pane === next.pane;
  if (!same && !opts.replace) {
    nav.stack.push(cur);
    if (nav.stack.length > 20) nav.stack.shift();
  }
  applyRoute(next, same || opts.replace ? 'none' : (routeOrder(next) >= routeOrder(cur) ? 'forward' : 'back'));
  onEnterRoute(next);
}

function goBack() {
  const prev = nav.stack.pop();
  if (prev) {
    applyRoute(prev, 'back');
    onEnterRoute(prev);
  } else {
    goHome();
  }
}

/**
 * Home always returns to the dashboard and resets *temporary* view state:
 * the selection and the search box. Persistent settings, download history,
 * the stored scan, and any running downloads are never touched.
 */
function goHome() {
  state.selected.clear();
  state.filters.query = '';
  const search = $('search');
  if (search) search.value = '';
  paintSelection();
  updateFooter();
  nav.stack.length = 0;
  const route = { view: 'home', pane: 'idle' };
  applyRoute(route, 'back');
  onEnterRoute(route);
}

function onEnterRoute(route) {
  if (route.view === 'history') {
    loadHistory();
    return;
  }
  if (route.pane === 'results' && state.scan) refreshVisible();
  if (route.pane === 'queue') refreshQueue();
  if (route.pane === 'idle') renderHomeStatus();
}

function wireNav() {
  $('navHome').addEventListener('click', goHome);
  $('navHistory').addEventListener('click', () => navigate('history'));
  $('navSettings').addEventListener('click', () => {
    // Fire-and-forget: the options page opens in a new tab; if the worker
    // is unreachable the click simply does nothing (no state to corrupt).
    UI.send('OPEN_OPTIONS').catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* Home dashboard status                                               */
/* ------------------------------------------------------------------ */

function homeStatusCard(title, btnLabel, onClick) {
  const card = UI.el('div', null, 'status-card');
  card.append(UI.el('span', title, 'status-card-title'));
  const btn = UI.el('button', btnLabel, 'btn btn-sm btn-primary');
  btn.addEventListener('click', onClick);
  card.append(btn);
  return card;
}

/**
 * Dashboard status: an in-flight download queue or a stored scan, surfaced
 * as quick-access cards. Takes an optional queue snapshot so QUEUE_UPDATE
 * broadcasts don't need a second round-trip.
 */
async function renderHomeStatus(snapshot) {
  const box = $('homeStatus');
  if (!box) return;
  let snap = snapshot;
  if (!snap) {
    try {
      ({ snapshot: snap } = await UI.send('GET_QUEUE'));
    } catch {
      snap = null;
    }
  }
  box.textContent = '';
  if (snap && (snap.active > 0 || snap.pending > 0)) {
    const n = snap.active + snap.pending;
    box.append(homeStatusCard(
      t('home_downloadsInProgress', { count: n }),
      t('home_viewDownloads'),
      () => navigate('home', 'queue'),
    ));
  } else if (state.scan && state.scan.images && state.scan.images.length) {
    box.append(lastScanRow());
  }
  box.hidden = box.childNodes.length === 0;
}

/**
 * Dashed "Last scan" row: the real host and the real image count from the
 * stored scan, never mockup data. The whole row opens the results, which
 * is what the old View results button did.
 */
function lastScanRow() {
  const n = state.scan.images.length;
  const host = state.scan.pageHost || '';
  const row = UI.el('button', null, 'last-scan-row');
  row.type = 'button';
  row.append(UI.icon('history', { size: 16 }));
  const label = UI.el('span', null, 'last-scan-text');
  label.append(UI.el('b', t('popup_lastScan')));
  if (host) label.append(document.createTextNode(` \u00b7 ${host}`));
  row.append(label, UI.el('span', t('popup_scanFoundCount', { count: n }), 'last-scan-count'));
  row.addEventListener('click', () => navigate('home', 'results'));
  return row;
}

/* ------------------------------------------------------------------ */
/* Full-page capture progress (round 5): one live status row under     */
/* the shot buttons, fed by CAPTURE_PROGRESS broadcasts, never a       */
/* stack of per-tile toasts.                                           */
/* ------------------------------------------------------------------ */

const captureUi = {
  active: false,
  stopping: false,
  progress: null, // last CAPTURE_PROGRESS payload, phase 'capturing'
  watchdog: 0,
};

const SHOT_BUTTON_IDS = ['btnShotVisible', 'btnShotArea', 'btnShotElement', 'btnShotFull'];
const CAPTURE_WATCHDOG_MS = 30000;

function setShotButtonsLocked(locked) {
  for (const id of SHOT_BUTTON_IDS) {
    const b = $(id);
    if (b) b.disabled = locked;
  }
}

function renderCaptureProgress() {
  const p = captureUi.progress;
  if (!p || !$('captureProgress')) return;
  $('captureProgressText').textContent = p.partTotal > 1
    ? t('parts_tileProgress', { part: p.part, partTotal: p.partTotal, n: p.tile, tileCount: p.tileCount })
    : t('sw_capturingTile', { n: p.tile, tileCount: p.tileCount });
  const wrap = $('captureProgressBarWrap');
  wrap.setAttribute('aria-valuemax', String(p.tileCount));
  wrap.setAttribute('aria-valuenow', String(p.tile));
  $('captureProgressBar').style.transform = p.tileCount > 0
    ? `scaleX(${p.tile / p.tileCount})`
    : 'scaleX(0)';
}

function armCaptureWatchdog() {
  clearTimeout(captureUi.watchdog);
  captureUi.watchdog = setTimeout(async () => {
    // No progress and no end signal for a long stretch: ask the
    // worker for the truth instead of staying locked forever.
    try {
      const { progress } = await UI.send('GET_CAPTURE_PROGRESS');
      if (progress && progress.phase === 'capturing') {
        showCaptureProgress(progress);
        return;
      }
    } catch { /* worker unreachable: unlock below */ }
    endCaptureProgress();
  }, CAPTURE_WATCHDOG_MS);
}

function showCaptureProgress(p) {
  captureUi.active = true;
  captureUi.progress = p;
  $('captureProgress').hidden = false;
  setShotButtonsLocked(true);
  renderCaptureProgress();
  armCaptureWatchdog();
}

function endCaptureProgress() {
  captureUi.active = false;
  captureUi.stopping = false;
  captureUi.progress = null;
  clearTimeout(captureUi.watchdog);
  const box = $('captureProgress');
  if (box) box.hidden = true;
  const wrap = $('captureProgressBarWrap');
  if (wrap) {
    wrap.setAttribute('aria-valuemax', '0');
    wrap.setAttribute('aria-valuenow', '0');
  }
  const bar = $('captureProgressBar');
  if (bar) bar.style.transform = 'scaleX(0)';
  const stop = $('btnCaptureStop');
  if (stop) {
    stop.disabled = false;
    stop.textContent = t('popup_captureStop');
  }
  setShotButtonsLocked(false);
}

function onCaptureProgressMessage(msg) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  if (msg.phase === 'capturing') {
    showCaptureProgress({
      part: n(msg.part), partTotal: n(msg.partTotal),
      tile: n(msg.tile), tileCount: n(msg.tileCount),
    });
  } else {
    endCaptureProgress();
  }
}
/* ------------------------------------------------------------------ */
/* Home: scan + screenshots                                            */
/* ------------------------------------------------------------------ */

function wireHome() {
  $('btnScan').addEventListener('click', doScan);
  $('btnRescan').addEventListener('click', doScan);
  $('btnShotVisible').addEventListener('click', async () => {
    try {
      await UI.send('CAPTURE_VISIBLE');
      window.close();
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnShotArea').addEventListener('click', () => {
    // Fire-and-forget: the popup must close now so it doesn't swallow the
    // first click on the page. Errors surface as a notification.
    UI.send('CAPTURE_AREA').catch(() => {});
    window.close();
  });
  $('btnShotElement').addEventListener('click', () => {
    UI.send('CAPTURE_ELEMENT').catch(() => {});
    window.close();
  });
  $('btnShotFull').addEventListener('click', async () => {
    // Round 5: lock the shot buttons at once; CAPTURE_PROGRESS
    // broadcasts drive the status row from here, and the end signal
    // (or the watchdog) unlocks again.
    captureUi.active = true;
    setShotButtonsLocked(true);
    armCaptureWatchdog();
    try {
      await UI.send('CAPTURE_FULL');
      window.close();
    } catch (err) {
      endCaptureProgress();
      UI.toast(err.message);
    }
  });
  $('btnCaptureStop').addEventListener('click', async () => {
    if (!captureUi.active || captureUi.stopping) return;
    captureUi.stopping = true;
    const stop = $('btnCaptureStop');
    stop.disabled = true;
    stop.textContent = t('popup_captureStopping');
    // The worker keeps the finished parts and opens the Parts
    // overview; the CAPTURE_PROGRESS 'stopped' end signal resets
    // this button and unlocks the shot buttons.
    try { await UI.send('CANCEL_CAPTURE'); } catch { /* the end signal still unlocks */ }
  });
  $('btnScanCancel').addEventListener('click', cancelScan);
}

async function doScan() {
  scanDismissed = false;
  navigate('home', 'scanning');
  updateScanProgress(0, 1);
  try {
    const { scan } = await UI.send('SCAN_PAGE');
    // SCAN_DONE broadcast will also arrive; render directly for snappiness.
    // A Cancel in the meantime discards this result (see cancelScan).
    if (scan && !scanDismissed) showScan(scan, true);
  } catch (err) {
    if (scanDismissed) return;
    navigate('home', 'idle');
    UI.toastError(err.message);
  }
}

/**
 * Cancel the scan from the popup's side. The worker has no CANCEL_SCAN
 * message and background/ is out of scope for this phase, so the scan in
 * the page itself runs to completion; what Cancel stops is the popup
 * following it: the flag discards the late SCAN_DONE result and the
 * direct SCAN_PAGE result (see doScan), and the popup returns to the
 * dashboard at once. Verified live: after Cancel the popup stays on the
 * dashboard when the scan finishes.
 */
function cancelScan() {
  scanDismissed = true;
  navigate('home', 'idle');
}

function updateScanProgress(done, total) {
  // done/total come from the content scanner (candidates found / elements
  // to scan), so the percentage is real. The worker's opening broadcast
  // (0/1) carries no real total yet: show the indeterminate bar instead
  // of a fake 0%.
  const wrap = $('scanProgressWrap');
  const known = total > 1;
  if (wrap) wrap.classList.toggle('indeterminate', !known);
  // The indeterminate style sets the bar width in CSS; an inline
  // transform would shrink it, so only set one for a known total.
  $('scanBar').style.transform = known ? `scaleX(${Math.min(100, Math.round((done / total) * 100)) / 100})` : '';
  $('scanStatus').textContent = t('popup_scanFoundCount', { count: done });
}

/* ------------------------------------------------------------------ */
/* Results: filters + grid + selection                                 */
/* ------------------------------------------------------------------ */

function wireResults() {
  document.querySelectorAll('[data-size]').forEach((chip) => {
    chip.addEventListener('click', () => setSizeFilter(chip.getAttribute('data-size')));
  });
  $('search').addEventListener('input', UI.debounce((e) => {
    state.filters.query = e.target.value;
    refreshVisible();
  }));
  $('filterOrient').addEventListener('change', (e) => {
    state.filters.orientations = e.target.value ? [e.target.value] : [];
    refreshVisible();
  });
  $('sortMode').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    refreshVisible();
  });
  $('btnViewAll').addEventListener('click', viewAll);
  $('selAll').addEventListener('click', () => {
    state.visible.forEach((img) => state.selected.add(img.id));
    paintSelection();
    updateFooter();
  });
  $('selNone').addEventListener('click', () => {
    state.selected.clear();
    paintSelection();
    updateFooter();
  });
  $('selInvert').addEventListener('click', () => {
    for (const img of state.visible) {
      if (state.selected.has(img.id)) state.selected.delete(img.id);
      else state.selected.add(img.id);
    }
    paintSelection();
    updateFooter();
  });
  $('qSmart').addEventListener('click', () => setQuality('smart'));
  $('qNormal').addEventListener('click', () => setQuality('normal'));
  $('btnDownload').addEventListener('click', downloadSelected);
  $('btnZip').addEventListener('click', downloadZip);
}

function setQuality(q) {
  state.quality = q;
  $('qSmart').setAttribute('aria-pressed', String(q === 'smart'));
  $('qNormal').setAttribute('aria-pressed', String(q === 'normal'));
}

function showScan(scan, selectAll) {
  state.scan = scan;
  state.selected.clear();
  if (selectAll) {
    scan.images.forEach((img) => state.selected.add(img.id));
  }
  $('resTitle').textContent = t('popup_resultsComplete');
  $('resSub').textContent = (scan.title || '').slice(0, 70);
  renderResSummary();
  renderFormatChips();
  if (!scan.images.length) {
    navigate('home', 'idle');
    const dropped = Number(scan.droppedBySize) || 0;
    UI.toast(
      dropped > 0
        ? t('results_noImagesFiltered', { count: dropped, dropped })
        : t('results_noImages'),
    );
    return;
  }
  navigate('home', 'results');
  // D3: seed already-downloaded badges from the live queue, so tiles
  // downloaded earlier in this session show their badge when results open.
  UI.send('GET_QUEUE').then(({ snapshot }) => {
    if (!snapshot || !state.scan) return;
    markDownloaded((snapshot.items || []).filter((i) => i.state === 'done').map((i) => i.id));
  }).catch(() => {});
}

/**
 * Summary cards from real scan numbers only. The scanner reports what it
 * kept, what it deduped and what it dropped, so:
 * found = kept + deduped + dropped by size + dropped as interface assets
 * (everything the scanner encountered), ready = kept, small or duplicate
 * = dropped by size + deduped. When the worker hid interface assets the
 * footer already says so, which is why the three cards need not sum.
 */
function renderResSummary() {
  const box = $('resSummary');
  if (!box || !state.scan) return;
  const kept = state.scan.images.length;
  const deduped = Number(state.scan.deduped) || 0;
  const bySize = Number(state.scan.droppedBySize) || 0;
  const byRelevance = Number(state.scan.droppedByRelevance) || 0;
  const cards = [
    { value: kept + deduped + bySize + byRelevance, label: t('popup_resultsFoundLabel'), big: true },
    { value: kept, label: t('popup_resultsReadyLabel'), big: false },
    { value: deduped + bySize, label: t('popup_resultsSmallDupLabel'), big: false },
  ];
  box.textContent = '';
  for (const c of cards) {
    const card = UI.el('div', null, 'res-stat' + (c.big ? ' res-stat-big' : ''));
    card.append(UI.el('b', String(c.value)));
    card.append(UI.el('span', c.label));
    box.append(card);
  }
}

/**
 * Format chips: All plus the formats actually present in this scan, in
 * the mockup order, plus Large only, which is the existing 1200px+ size
 * filter shown in the same row. One format at a time, like the select was.
 * A format the user picked on a previous scan but absent here shows no
 * pressed chip; the grid then reports no match until All is picked.
 */
function renderFormatChips() {
  const box = $('formatChips');
  if (!box || !state.scan) return;
  const present = new Set();
  for (const img of state.scan.images) {
    const g = formatGroup(img.format);
    if (FORMAT_CHIP_ORDER.includes(g)) present.add(g);
  }
  box.textContent = '';
  const mkChip = (label, pressed, onClick) => {
    const chip = UI.el('button', label, 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(pressed));
    chip.addEventListener('click', onClick);
    box.append(chip);
    return chip;
  };
  mkChip(t('popup_filterAll'), state.filters.formats.length === 0, () => {
    state.filters.formats = [];
    renderFormatChips();
    refreshVisible();
  });
  for (const fmt of FORMAT_CHIP_ORDER) {
    if (!present.has(fmt)) continue;
    mkChip(FORMAT_LABELS[fmt], state.filters.formats.includes(fmt), () => {
      state.filters.formats = [fmt];
      renderFormatChips();
      refreshVisible();
    });
  }
  mkChip(t('popup_filterLargeOnly'), state.filters.size === 'large', () => {
    setSizeFilter(state.filters.size === 'large' ? 'any' : 'large');
  });
}

/** Set the size filter from the size chips or the Large only chip. */
function setSizeFilter(size) {
  state.filters.size = size;
  document.querySelectorAll('[data-size]').forEach((c) =>
    c.setAttribute('aria-pressed', String(c.getAttribute('data-size') === size)));
  renderFormatChips();
  refreshVisible();
}

/**
 * "View all N images": no new feature, it clears every filter (search,
 * size, format, orientation, sort) so the grid shows each found image.
 * The selection is untouched; images hidden by the old filters simply
 * stay unselected.
 */
function viewAll() {
  state.filters.query = '';
  state.filters.formats = [];
  state.filters.orientations = [];
  state.filters.sort = 'order';
  const search = $('search');
  if (search) search.value = '';
  const orient = $('filterOrient');
  if (orient) { orient.value = ''; if (UI.syncDropdown) UI.syncDropdown(orient); }
  const sort = $('sortMode');
  if (sort) { sort.value = 'order'; if (UI.syncDropdown) UI.syncDropdown(sort); }
  setSizeFilter('any');
  $('viewHome').scrollTop = 0;
}

/** Re-apply localized results chrome after a language change. */
function refreshResultsChrome() {
  if (!state.scan) return;
  $('resTitle').textContent = t('popup_resultsComplete');
  renderResSummary();
  renderFormatChips();
  updateFooter();
}

function refreshVisible() {
  if (!state.scan) return;
  const f = state.filters;
  let list = applyFilters(state.scan.images, {
    size: f.size === 'any' ? 'any' : f.size,
    formats: f.formats,
    orientations: f.orientations,
  });
  list = list.filter((img) => matchesQuery(img, f.query, state.scan));
  list = sortImages(list, f.sort);
  state.visible = list;
  // Drop selections that are no longer visible.
  const ids = new Set(list.map((i) => i.id));
  for (const id of [...state.selected]) {
    if (!ids.has(id)) state.selected.delete(id);
  }
  renderGrid();
  updateFooter();
}

/**
 * M11: windowed grid rendering. A scan can return 3000 images, building
 * 3000 DOM nodes (and 3000 <img> loads) at once janks the popup. Render
 * the first page, then append more as the sentinel scrolls into view.
 */
const GRID_PAGE = 120;
let gridSentinelObserver = null;

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  state.gridShown = 0;
  // B6: drop queued thumbnail resolutions and virtualization state.
  blobResolveQueue.length = 0;
  if (gridPlaceholderObserver) {
    gridPlaceholderObserver.disconnect();
  }
  if (gridSentinelObserver) {
    gridSentinelObserver.disconnect();
    gridSentinelObserver = null;
  }
  if (!state.visible.length) {
    const empty = UI.el('div', null, 'empty');
    empty.style.gridColumn = '1 / -1';
    empty.append(UI.el('div', '◫', 'glyph'));
    empty.append(UI.el('p', t('results_noMatch')));
    grid.append(empty);
    return;
  }
  appendGridPage();
}

function appendGridPage() {
  const grid = $('grid');
  const oldSentinel = $('gridSentinel');
  if (oldSentinel) oldSentinel.remove();
  const frag = document.createDocumentFragment();
  const end = Math.min(state.gridShown + GRID_PAGE, state.visible.length);
  for (let i = state.gridShown; i < end; i++) {
    frag.append(makeThumbAt(i));
  }
  state.gridShown = end;
  grid.append(frag);
  if (state.gridShown < state.visible.length) {
    const sentinel = UI.el('div', null, 'grid-sentinel');
    sentinel.id = 'gridSentinel';
    sentinel.style.gridColumn = '1 / -1';
    sentinel.style.textAlign = 'center';
    sentinel.style.padding = '12px';
    sentinel.style.color = 'var(--muted)';
    sentinel.style.fontSize = '12px';
    sentinel.textContent = t('popup_showingMore', { shown: state.gridShown, total: state.visible.length });
    grid.append(sentinel);
    gridSentinelObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        gridSentinelObserver.disconnect();
        gridSentinelObserver = null;
        appendGridPage();
      }
    }, { root: null, rootMargin: '400px' });
    gridSentinelObserver.observe(sentinel);
  }
  maybeVirtualizeGrid();
  updateFooter();
}

/** Build the thumb wrapper for visible[i], tagged with its index. */
function makeThumbAt(i, allowStagger = true) {
  const el = makeThumbBtn(state.visible[i]);
  el.querySelector('.thumb').dataset.vindex = String(i);
  // G2: the results grid staggers the first 8 tiles only (40 ms each,
  // 12 px up and fade over 250 ms). Later pages appear at once, and
  // virtualised re-inflations on scroll never re-animate.
  if (allowStagger && i < 8) {
    el.style.setProperty('--i', String(i));
    el.classList.add('motion-stagger');
  }
  return el;
}

/**
 * B6: grid virtualization. Past GRID_VIRTUALIZE_AT rendered thumbs, pages
 * fully above the viewport are swapped for height-matched placeholders, so
 * the DOM stays bounded however far the user scrolls. Placeholders keep
 * their height (no scroll jump) and re-inflate when scrolled near.
 */
const GRID_VIRTUALIZE_AT = 360;
let gridPlaceholderObserver = null;

function ensurePlaceholderObserver() {
  if (!gridPlaceholderObserver) {
    gridPlaceholderObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) inflateGridPlaceholder(e.target);
      }
    }, { root: null, rootMargin: '800px' });
  }
}

function maybeVirtualizeGrid() {
  const grid = $('grid');
  ensurePlaceholderObserver();
  for (;;) {
    const thumbs = grid.querySelectorAll(':scope > .thumb-wrap');
    if (thumbs.length <= GRID_VIRTUALIZE_AT) return;
    const first = thumbs[0];
    if (first.getBoundingClientRect().bottom > -800) return; // near viewport, stop
    const take = Math.min(GRID_PAGE, thumbs.length - GRID_VIRTUALIZE_AT);
    const last = thumbs[take - 1];
    const h = Math.max(
      0,
      Math.round(last.getBoundingClientRect().bottom - first.getBoundingClientRect().top),
    );
    const ph = document.createElement('div');
    ph.className = 'grid-placeholder';
    ph.style.gridColumn = '1 / -1';
    ph.style.height = `${h}px`;
    ph.dataset.startIndex = first.querySelector('.thumb').dataset.vindex || '0';
    ph.dataset.count = String(take);
    grid.insertBefore(ph, first);
    for (let k = 0; k < take; k++) thumbs[k].remove();
    gridPlaceholderObserver.observe(ph);
  }
}

function inflateGridPlaceholder(ph) {
  if (gridPlaceholderObserver) gridPlaceholderObserver.unobserve(ph);
  const start = Number(ph.dataset.startIndex) || 0;
  const count = Number(ph.dataset.count) || GRID_PAGE;
  const frag = document.createDocumentFragment();
  const end = Math.min(start + count, state.visible.length);
  for (let i = start; i < end; i++) {
    frag.append(makeThumbAt(i, false));
  }
  ph.replaceWith(frag);
}

/**
 * D3: already-downloaded badge. An image downloaded in this popup session
 * is marked on its tile so a second download is a deliberate repeat,
 * never a surprise, and never blocked. The badge is the shared .badge-ok
 * pill, positioned opposite the selection tick; no new CSS is needed.
 */
function makeDownloadedBadge() {
  const badge = UI.el('span', t('results_downloaded'), 'badge badge-ok dl-badge');
  // Small enough to fit inside an 86 px thumb: the shared .badge is
  // 12 px with 8 px side padding, which clips the word on a tile. It
  // sits just below the top row so it never covers the selection check
  // (top end, shown when the tile is selected), the format tag (bottom
  // start) or the zoom button (bottom end).
  badge.style.cssText = 'position:absolute; top:26px; inset-inline-start:5px; font-size:10px; padding:2px 5px;';
  return badge;
}

/** Record downloaded ids and paint their badges onto tiles on screen. */
function markDownloaded(ids) {
  let changed = false;
  for (const id of ids || []) {
    if (id && !state.downloaded.has(id)) {
      state.downloaded.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  for (const id of ids || []) {
    if (!id) continue;
    const btn = document.querySelector(`.thumb[data-img-id="${CSS.escape(String(id))}"]`);
    if (btn && !btn.querySelector('.dl-badge')) btn.append(makeDownloadedBadge());
  }
}

function makeThumbBtn(img) {
    // D2: click/tap toggles selection (checkbox semantics); the magnifier
    // button opens the preview. Keyboard: Space toggles, Enter previews.
    // B6: wrapper div with two SIBLING buttons, a button inside a button
    // is invalid HTML and confuses screen readers.
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb';
    btn.setAttribute('role', 'checkbox');
    btn.setAttribute('aria-checked', String(state.selected.has(img.id)));
    btn.title = t('popup_thumbTitle', { name: img.filename || t('ui_fallbackName'), dims: UI.formatDims(img.width, img.height) });
    const thumb = document.createElement('img');
    thumb.loading = 'lazy';
    thumb.alt = img.alt || img.filename || t('ui_fallbackName');
    // Thumbnails: never hand page HTML to the DOM as markup, src only.
    setThumbSource(thumb, img, false);
    thumb.referrerPolicy = 'no-referrer';
    const tick = UI.el('span', null, 'tick');
    tick.setAttribute('aria-hidden', 'true');
    tick.append(UI.icon('check'));
    // Format label, bottom-left like the mockup; hidden when unknown.
    const fmt = formatGroup(img.format);
    const dims = fmt && fmt !== 'unknown' && fmt !== 'other'
      ? UI.el('span', FORMAT_LABELS[fmt] || fmt.toUpperCase(), 'dims')
      : null;
    const zoom = UI.el('button', null, 'zoom-btn');
    zoom.type = 'button';
    zoom.setAttribute('aria-label', t('preview_zoomAria', { name: img.filename || t('ui_fallbackName') }));
    zoom.title = t('preview_zoomTitle');
    // Magnifier icon built via DOM (no innerHTML, project convention).
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '11');
    circle.setAttribute('cy', '11');
    circle.setAttribute('r', '7');
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', 'm21 21-4.3-4.3');
    svg.append(circle, line);
    zoom.append(svg);
    const parts = [thumb, tick];
    if (dims) parts.push(dims);
    if (state.downloaded.has(img.id)) parts.push(makeDownloadedBadge());
    btn.append(...parts);
    wrap.append(btn, zoom);
    btn.addEventListener('click', () => {
      toggleSelect(img.id);
    });
    zoom.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreview(img);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        toggleSelect(img.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        openPreview(img);
      }
    });
    btn.dataset.imgId = img.id;
    return wrap;
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  paintSelection();
  updateFooter();
}

function paintSelection() {
  document.querySelectorAll('.thumb').forEach((btn) => {
    btn.setAttribute('aria-checked', String(state.selected.has(btn.dataset.imgId)));
  });
}

/**
 * Byte size of a data: image URL, computed arithmetically from the URL
 * itself: base64 payload length for base64 URLs, decoded length
 * otherwise. The scanner reports no byte size for http(s) images, and
 * thumbnails are downscaled re-encodes, so only data: images have a
 * known size here. Returns null when the size cannot be computed.
 */
function dataUrlByteSize(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!payload) return 0;
  if (/;base64$/i.test(header)) {
    const clean = payload.replace(/\s/g, '');
    if (/[^A-Za-z0-9+/=]/.test(clean)) return null;
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.floor((clean.length * 3) / 4) - pad;
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch {
    return null;
  }
}

/** Known byte size of one scanned image, or null when unknown. */
function knownImageBytes(img) {
  const direct = img && Number(img.bytes);
  if (direct > 0) return direct;
  // Scan images carry the address as .src (see setThumbSource).
  if (img && typeof img.src === 'string') return dataUrlByteSize(img.src);
  if (img && typeof img.url === 'string') return dataUrlByteSize(img.url);
  return null;
}

/**
 * Selected total size, under the summary cards. Shown only when at
 * least one selected image has a known size; marked approximate when
 * some selected images have unknown sizes. Phase 5 A8: the line
 * reserves its space permanently (fixed height in popup.html), so it
 * is never hidden; the text swaps in and out instead, and the chips
 * and the grid never move.
 */
function paintSelectedSize() {
  const el = $('resSelectedSize');
  if (!el || !state.scan) return;
  if (state.selected.size === 0) { UI.swapText(el, ''); return; }
  let total = 0;
  let known = 0;
  let unknown = 0;
  for (const img of state.scan.images) {
    if (!state.selected.has(img.id)) continue;
    const b = knownImageBytes(img);
    if (b == null) unknown += 1;
    else { total += b; known += 1; }
  }
  if (known === 0 || total <= 0) { UI.swapText(el, ''); return; }
  const size = UI.formatBytes(total);
  UI.swapText(el, unknown > 0
    ? t('results_selectedSizeApprox', { size })
    : t('results_selectedSize', { size }));
}

function updateFooter() {
  const n = state.selected.size;
  const total = state.scan ? state.scan.images.length : 0;
  const deduped = state.scan && state.scan.deduped ? ` · ${t('results_duplicatesRemoved', { count: state.scan.deduped })}` : '';
  const uiHidden = state.scan && state.scan.droppedByRelevance ? ` · ${t('results_assetsHidden', { count: state.scan.droppedByRelevance })}` : '';
  const hidden = total - state.visible.length;
  const hiddenTxt = hidden > 0 ? ` · ${t('results_hiddenByFilters', { count: hidden })}` : '';
  $('resultCount').textContent = `${t('results_shownFound', { shown: state.visible.length, total })}${deduped}${uiHidden}${hiddenTxt}`;
  // The label span carries the text; the download icon beside it is static
  // markup, so localizing never wipes it. The count swaps with the 150 ms
  // text swap (G2) instead of jumping.
  UI.swapText($('btnDownloadLabel'), n === 0 ? t('popup_download') : t('popup_downloadCount', { count: n }));
  $('btnDownload').disabled = n === 0;
  $('btnZip').disabled = n === 0;
  if (state.scan) {
    $('btnViewAllLabel').textContent = t('popup_viewAllImages', { count: total });
  }
  paintSelectedSize();
}

async function selectedFiles() {
  return state.visible
    .filter((img) => state.selected.has(img.id))
    .slice(0, 200)
    .map((img, i) => ({
      url: img.src,
      name: `image-${String(i + 1).padStart(3, '0')}-${(img.src.split('/').pop() || 'img').split('?')[0].slice(0, 60) || 'img'}`,
    }));
}

async function downloadZip() {
  const files = await selectedFiles();
  if (!files.length) return;
  try {
    await UI.send('DOWNLOAD_ZIP', { files });
    navigate('home', 'queue');
  } catch (err) {
    UI.toast(err.message);
  }
}

async function downloadSelected() {
  // M4: bulk defaults to "as shown", probing hundreds of images would
  // hammer the site. The explicit "best quality" switch opts back in.
  const bestQuality = $('bulkBest') && $('bulkBest').checked;
  const items = state.visible
    .filter((img) => state.selected.has(img.id))
    .slice(0, 500)
    .map((img) => ({
      id: img.id,
      srcUrl: img.src,
      mode: bestQuality ? state.quality : 'normal',
      format: $('dlFormat').value,
      candidates: Array.isArray(img.candidates) ? img.candidates.slice(0, 6) : null,
    }));
  if (!items.length) return;
  try {
    await UI.send('DOWNLOAD_MANY', { items });
    markDownloaded(items.map((i) => i.id));
    // G2: the button shows the 500 ms success check draw, then the
    // queue view opens. The button is disabled during the draw so a
    // second click cannot re-send the batch.
    const btn = $('btnDownload');
    btn.disabled = true;
    await UI.showSuccessCheck(btn);
    btn.disabled = false;
    navigate('home', 'queue');
  } catch (err) {
    UI.toastError(err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Preview modal                                                       */
/* ------------------------------------------------------------------ */

function openPreview(img) {
  const root = $('modalRoot');
  root.textContent = '';
  const backdrop = UI.el('div', null, 'modal-backdrop');
  const modal = UI.el('div', null, 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', t('preview_imageInfo'));

  const closeBtn = UI.el('button', '✕', 'icon-btn');
  closeBtn.setAttribute('aria-label', t('preview_close'));
  closeBtn.style.cssText = 'float:inline-end;';
  const title = UI.el('h3', null, 'section-title');
  const titleName = document.createElement('bdi');
  titleName.textContent = img.filename || t('preview_imagePreview');
  title.append(titleName);
  title.style.cssText = 'margin:0 0 8px; padding-inline-end:32px; word-break:break-all;';

  const preview = document.createElement('img');
  preview.className = 'preview';
  setThumbSource(preview, img, true);
  preview.alt = img.alt || t('preview_imagePreview');
  preview.referrerPolicy = 'no-referrer';

  const kv = document.createElement('dl');
  kv.className = 'kv';
  const rows = [
    [t('kv_size'), UI.formatDims(img.width, img.height)],
    [t('kv_format'), (img.format || t('kv_unknownFormat')).toUpperCase()],
    [t('kv_source'), img.isBackground ? t('kv_sourceBackground') : t('kv_sourcePage')],
  ];
  for (const [k, v] of rows) {
    kv.append(UI.el('dt', k), UI.el('dd', v));
  }

  const actions = UI.el('div', null, 'preview-actions');
  const mkBtn = (label, primary, fn) => {
    const b = UI.el('button', label, `btn ${primary ? 'btn-primary' : 'btn-ghost'}`);
    b.addEventListener('click', fn);
    return b;
  };
  const single = (mode, format) => async () => {
    close();
    try {
      await UI.send('DOWNLOAD_IMAGE', {
        srcUrl: img.src,
        mode,
        format: format || 'as-is',
        candidates: Array.isArray(img.candidates) ? img.candidates.slice(0, 6) : null,
      });
      markDownloaded([img.id]);
      navigate('home', 'queue');
    } catch (err) {
      UI.toast(err.message);
    }
  };
  actions.append(
    mkBtn(t('popup_qualitySmart'), true, single('smart')),
    mkBtn(t('preview_savePng'), false, single('smart', 'png')),
    mkBtn(t('preview_saveJpeg'), false, single('smart', 'jpg')),
    mkBtn(t('preview_saveWebp'), false, single('smart', 'webp')),
    // M12: no AVIF button when the browser can't encode it.
    ...(state.avifOk === false ? [] : [mkBtn(t('preview_saveAvif'), false, single('smart', 'avif'))]),
  );
  const moreRow = UI.el('div', null, 'row');
  moreRow.style.marginTop = '8px';
  const openBtn = mkBtn(t('preview_openOriginal'), false, async () => {
    close();
    if (/^https?:\/\//i.test(img.src)) {
      chrome.tabs.create({ url: img.src });
    } else {
      UI.toast(t('info_cannotOpenTab'));
    }
  });
  openBtn.classList.add('btn-sm');
  const infoBtn = mkBtn(t('preview_imageInfo'), false, () => {
    close();
    const scan = state.scan || {};
    const qp = new URLSearchParams({
      src: img.src || '',
      pageUrl: scan.url || '',
      tabId: scan.tabId != null ? String(scan.tabId) : '',
    });
    chrome.tabs.create({
      url: chrome.runtime.getURL(`pages/info.html?${qp.toString()}`),
    });
  });
  infoBtn.classList.add('btn-sm');
  moreRow.append(openBtn, infoBtn);

  const prevFocus = document.activeElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const close = () => {
    if (backdrop.classList.contains('is-closing')) return;
    document.removeEventListener('keydown', onKey);
    if (reduceMotion) {
      root.textContent = '';
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      return;
    }
    backdrop.classList.add('is-closing');
    setTimeout(() => {
      root.textContent = '';
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }, UI.motionDurationMs ? UI.motionDurationMs('--duration-quick', 150) : 150);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), [href], img[tabindex]')]
      .filter((n) => n.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);

  modal.append(closeBtn, title, preview, kv, actions, moreRow);
  backdrop.append(modal);
  root.append(backdrop);
  closeBtn.focus();
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

function wireQueue() {
  $('btnQueueRetry').addEventListener('click', async () => {
    try {
      const { snapshot } = await UI.send('RETRY_QUEUE');
      renderQueue(snapshot);
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnQueueCancel').addEventListener('click', async () => {
    try {
      const { snapshot } = await UI.send('CANCEL_QUEUE');
      renderQueue(snapshot);
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnQueueClear').addEventListener('click', async () => {
    try {
      const { snapshot } = await UI.send('CLEAR_QUEUE');
      renderQueue(snapshot);
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnBack').addEventListener('click', goBack);
}

async function refreshQueue() {
  try {
    const { snapshot } = await UI.send('GET_QUEUE');
    renderQueue(snapshot);
  } catch (err) {
    UI.toast(err.message);
  }
}

/** Localized label for a queue item state ('pending', 'active', ...). */
function queueStateLabel(state) {
  const key = {
    pending: 'queue_statePending',
    active: 'queue_stateActive',
    done: 'queue_stateDone',
    failed: 'queue_stateFailed',
    cancelled: 'queue_stateCancelled',
  }[state];
  return key ? t(key) : state;
}

function renderQueue(snapshot) {
  const total = snapshot.total || 0;
  const done = snapshot.done || 0;
  const failed = snapshot.failed || 0;
  $('queueSummary').textContent =
    total === 0
      ? t('queue_empty')
      : t('queue_summaryDone', { done, total }) + (failed ? ` · ${t('queue_summaryFailed', { failed })}` : '');
  $('queueBar').style.transform = total ? `scaleX(${done / total})` : 'scaleX(0)';

  const list = $('queueList');
  list.textContent = '';
  if (!total) {
    list.append(UI.el('p', t('history_emptyShort'), 'muted small'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of snapshot.items.slice(-30).reverse()) {
    const row = UI.el('div', null, 'q-item');
    const dot = UI.el('span', null, `q-dot q-${item.state}`);
    const label = UI.el('span', item.label || t('ui_fallbackName'));
    label.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    const status = UI.el('span', queueStateLabel(item.state), 'muted small');
    row.append(dot, label, status);
    if (item.state === 'failed' && item.error) row.title = item.error;
    // B6: finished downloads can be revealed in the file manager.
    if (item.state === 'done' && Number.isInteger(item.chromeDownloadId)) {
      const show = UI.el('button', t('queue_showInFolder'), 'btn btn-sm btn-ghost');
      show.style.marginInlineStart = '8px';
      show.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await UI.send('SHOW_DOWNLOAD', { downloadId: String(item.chromeDownloadId) });
        } catch (err) {
          UI.toast(err.message);
        }
      });
      row.append(show);
    }
    frag.append(row);
  }
  list.append(frag);
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function wireHistory() {
  wireClearHistory($('btnClearHistory'), {
    t,
    toast: (msg) => UI.toast(msg),
    clear: () => UI.send('CLEAR_HISTORY'),
    onCleared: () => loadHistory(),
    list: $('historyList'),
    swapText: (node, text) => UI.swapText(node, text),
  });
}

let historyLoadSeq = 0;
async function loadHistory() {
  const seq = ++historyLoadSeq;
  const list = $('historyList');
  list.textContent = '';
  try {
    const { records } = await UI.send('GET_HISTORY');
    // Only the latest overlapping load may paint (see options loadOptHistory).
    if (seq !== historyLoadSeq) return;
    if (!records || !records.length) {
      const es = UI.emptyState({
        icon: 'history',
        title: t('history_emptyTitle'),
        description: t('history_emptyDesc'),
      });
      list.append(es);
      // G2: the empty state fades in over 250 ms.
      if (UI.fadeIn) UI.fadeIn(es);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const group of groupByDay(records, t)) {
      const head = UI.el('div', null, 'hist-day');
      head.append(UI.el('span', group.label), UI.el('span', historyCountLabel(group.count, t), 'hist-count'));
      frag.append(head);
      for (const r of group.items) {
        frag.append(historyRow(r));
      }
    }
    list.append(frag);
    // G2: history rows enter with a 40 ms stagger, first 8 rows only.
    if (UI.stagger) UI.stagger(list, '.hist-item', 8);
    // B1 backfill: thumbnail the records that still have no thumb, in
    // the background. The worker caps it at 12 per view open and
    // broadcasts each finished thumbnail (HISTORY_THUMB above).
    UI.send('BACKFILL_HISTORY_THUMBS').catch(() => {});
  } catch (err) {
    list.append(UI.el('p', err.message, 'muted small'));
  }
}

/** One history row: the shared design from shared/history-ui.js. */
function historyRow(r) {
  return buildHistoryRow(r, {
    t,
    formatSize: (rec) => UI.formatHistorySize(rec),
    showDownload: (dlId) => UI.send('SHOW_DOWNLOAD', { downloadId: String(dlId) }),
    toast: (msg) => UI.toast(msg),
    showThumbnails: !state.settings || state.settings.historyShowThumbnails !== false,
  });
}
