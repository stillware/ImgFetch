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
 * ImgFetch, background/service-worker.js
 * The extension's engine: context menus, message routing, download queue,
 * screenshots, history and the offscreen conversion pipeline.
 *
 * Thin by design: all pure logic lives in ../core/*.js so it can be unit
 * tested in Node. This file only touches chrome.* APIs.
 */
import { idb } from './idb.js';
import {
  normalizeUrl,
  getExtensionFromUrl,
  getHostLabel,
  filenameHintFromUrl,
  normalizeHost,
  isPrivateNetworkFetchBlocked,
  lensUrlBlocked,
} from '../core/urls.js';
import {
  buildFilename,
  joinDownloadPath,
  safeExtension,
  sanitizeSegment,
} from '../core/filenames.js';
import {
  normalizeExportFormat,
  qualityForFormat,
  formatLabel,
} from '../core/export.js';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  qualityModeForHost,
  shouldProbeBestSources,
} from '../core/settings.js';
import { DownloadQueue } from '../core/queue.js';
import {
  planFullPageCapture,
  pickScrollTarget,
  tilesCoveringRegion,
  shiftPlanParts,
  PART_MAX_AREA,
  PART_MAX_SIDE,
  PART_PROVEN_AREA,
  CAPTURE_MAX_DURATION_MS,
  CAPTURE_AREA_FLOOR,
  PART_MAX_COUNT,
} from '../core/fullpage-capture.js';
import { captureRecordMeta, pruneCaptureRecords } from '../core/capture-storage.js';
import { decideCaptureStep } from '../core/capture-decision.js';
import { cropPngDataUrl } from '../core/crop-image.js';
import {
  isValidMessage,
  senderKind,
  SENDER_RULES,
  friendlyError,
  setErrorTranslator,
  isValidCaptureId,
  isValidCaptureGroupId,
} from '../core/validation.js';
import { addRecord, pruneRecords, MAX_RECORDS } from '../core/history.js';
import { dedupeImages } from '../core/dedupe.js';
import { pickBestImageUrl } from '../core/image-url.js';
import { coerceScanState } from '../core/scan-state.js';
import { bulkItemPayload, singleItemPayload, pickUpgrade } from '../core/bulk-payload.js';
import { resolveFolder } from '../core/folders.js';
import { initI18n, t } from '../shared/i18n.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const SETTINGS_KEY = 'imgfetch.settings';

/* ------------------------------------------------------------------ */
/* B: runtime localization                                             */
/* ------------------------------------------------------------------ */
// No top-level await: it kills the MV3 worker. Handlers await i18nReady.
let i18nReady = initI18n(); // reassigned when the language setting changes (storage.onChanged below)

/**
 * Localize friendlyError() codes through the loaded locale. Codes are
 * kebab-case ('bad-url'); message keys are camelCase ('error_badUrl').
 * Registered once at startup; the closure resolves t() lazily so it
 * always uses the current locale.
 */
function errorKeyFor(code) {
  const parts = String(code || '').split('-');
  return 'error_' + parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}
setErrorTranslator((code) => {
  const key = errorKeyFor(code);
  const text = t(key);
  // t() returns the key itself when the locale is not loaded yet;
  // fall back to the built-in English strings instead of a raw key.
  if (text !== key) return text;
  const generic = t('ui_somethingWrong');
  return generic === 'ui_somethingWrong' ? null : generic;
});

/**
 * t() with an English fallback. t() returns the key itself when the
 * locale is not loaded yet; that must never reach the user. Used where
 * the worker cannot await i18nReady (e.g. startup queue triage).
 */
function tx(key, english) {
  const s = t(key);
  return s === key ? english : s;
}

/**
 * shared/i18n.js reads the language from chrome.storage.local under the
 * key 'settings', but this worker keeps settings under SETTINGS_KEY
 * ('imgfetch.settings'). Mirror the normalized settings there so
 * initI18n()/setLanguage() in pages and in this worker see the same
 * language. The mirror is written on every saveSettings() and persists
 * across worker restarts.
 */
const I18N_SETTINGS_KEY = 'settings';
function mirrorI18nSettings() {
  try {
    if (settingsCache) chrome.storage.local.set({ [I18N_SETTINGS_KEY]: settingsCache }).catch(() => {});
  } catch { /* storage unavailable; pages fall back to browser language */ }
}
const HISTORY_KEY = 'imgfetch.history';
const LAST_SCAN_KEY = 'imgfetch.lastScan';
const COUNTER_KEY = 'imgfetch.fileCounter';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
/* Pending screenshots (memory first, session storage as backup)        */
/* ------------------------------------------------------------------ */

let settingsCache = null;
let creatingOffscreen = null;
let offscreenLastUsed = 0;
let offscreenInflight = 0; // H4: jobs currently running in the offscreen document
const CAPS_SESSION_KEY = 'imgfetch.caps'; // legacy session backup key (removed on write)
const pendingCompletions = new Map(); // chrome downloadId -> { resolve, reject }

const queue = new DownloadQueue({
  concurrency: 3,
  maxAttempts: 2,
  starter: (item) => performDownload(item),
  onUpdate: (snapshot) => {
    broadcastQueueUpdate(snapshot); // M11: throttled
    scheduleQueuePersist(); // H5
  },
});

/**
 * M11: throttle queue broadcasts. A 500-item bulk fires an update per item
 * state change, thousands of messages. Send at most one per 200 ms, with
 * a trailing send so the final state always lands.
 */
let queueBroadcastTimer = null;
let queueBroadcastPending = null;
function broadcastQueueUpdate(snapshot) {
  queueBroadcastPending = snapshot;
  if (queueBroadcastTimer) return;
  broadcast({ type: 'QUEUE_UPDATE', snapshot });
  queueBroadcastPending = null;
  queueBroadcastTimer = setTimeout(() => {
    queueBroadcastTimer = null;
    const snap = queueBroadcastPending;
    queueBroadcastPending = null;
    if (snap) broadcast({ type: 'QUEUE_UPDATE', snapshot: snap });
  }, 200);
}

/**
 * H5: persist unfinished queue items to session storage (throttled) so a
 * service-worker restart mid-bulk doesn't lose the user's work.
 * N4: flush() persists immediately when a chromeDownloadId is assigned.
 */
import { createQueuePersister, QUEUE_SESSION_KEY } from '../core/queue-persist.js';

const queuePersister = createQueuePersister({
  getState: () => queue.serialize(),
  storage: chrome.storage.session,
});
function scheduleQueuePersist() {
  queuePersister.schedule();
}
// N4: immediate persist, called by trackDownload() the moment a
// chromeDownloadId is assigned, so a restart can adopt the download.
function persistQueueNow() {
  queuePersister.flush();
}

/**
 * H5: rebuild queue state after a worker restart. Items that never
 * started (or died before reaching chrome.downloads) are re-queued;
 * downloads still running in the browser are adopted, tracked to
 * completion instead of being duplicated or lost.
 */
async function restoreQueueState() {
  let saved = null;
  try {
    saved = (await chrome.storage.session.get(QUEUE_SESSION_KEY))[QUEUE_SESSION_KEY];
  } catch {
    return;
  }
  if (!Array.isArray(saved) || !saved.length) return;
  let downloads = [];
  try {
    downloads = (await chrome.downloads.search({})) || [];
  } catch {
    downloads = [];
  }
  const byId = new Map(downloads.map((d) => [d.id, d]));
  const triaged = [];
  const adopted = [];
  for (const s of saved) {
    if (!s || !s.id) continue;
    if (s.state === 'failed') {
      triaged.push({ ...s, state: 'failed' });
      continue;
    }
    if (s.state !== 'active' && s.state !== 'pending') continue; // done/cancelled stay gone
    const dl = s.chromeDownloadId != null ? byId.get(s.chromeDownloadId) : null;
    if (dl && dl.state === 'complete') continue; // finished while we were gone
    if (dl && dl.state === 'in_progress') {
      adopted.push(s);
      triaged.push({ ...s, state: 'pending' });
      continue;
    }
    if (dl) {
      triaged.push({ ...s, state: 'failed', error: tx('queue_downloadInterrupted', 'The download was interrupted.') });
      continue;
    }
    triaged.push({ ...s, state: 'pending' });
  }
  if (!triaged.length) return;
  // B1: adopted ids go straight into restore() as ACTIVE, the starter is
  // never called for them, so a restart can't duplicate a running download.
  queue.restore(
    triaged,
    adopted.map((s) => s.id),
  );
  for (const s of adopted) {
    // Re-attach to the still-running browser download (source of truth).
    pendingCompletions.set(s.chromeDownloadId, {
      resolve: async () => {
        const done = queue.settleAdopted(s.id, true);
        // Best-effort: history is a log, not the download itself, a failed
        // write must not break adoption of the running download.
        if (done && done.history) {
          done.history.bytes = await downloadFileSize(s.chromeDownloadId);
          recordHistory(done.history).catch(() => {});
        }
      },
      reject: (err) => {
        queue.settleAdopted(s.id, false, err && err.message);
      },
    });
  }
  const resumed = triaged.filter((t) => t.state === 'pending').length;
  const failed = triaged.filter((t) => t.state === 'failed').length;
  if (resumed > 0 || failed > 0) {
    broadcast({
      type: 'NOTICE_TEXT',
      text: t('sw_restarted', { count: resumed, resumed, failedPart: failed > 0 ? t('sw_restartFailed', { failed }) : '' }),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Download launcher                                                  */
/* ------------------------------------------------------------------ */

/**
 * The one shared way to start a browser download: caller-built filename,
 * the user's save-as preference, always uniquify on conflict.
 * Returns the download id, or null when the download could not be started.
 * M10: extracted from 4 duplicated call sites.
 */
async function saveToDownloads({ url, path, saveAs }) {
  return chrome.downloads.download({
    url,
    filename: path,
    saveAs: !!saveAs,
    conflictAction: 'uniquify',
  }).catch(() => null);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = normalizeSettings(stored[SETTINGS_KEY]);
  return settingsCache;
}

async function saveSettings(next) {
  settingsCache = normalizeSettings(next);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  mirrorI18nSettings();
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) {
    const oldLang = settingsCache && settingsCache.language;
    settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
    queue.concurrency = settingsCache.maxConcurrent;
    mirrorI18nSettings();
    // B: rebuild menu titles when the language changed.
    if (settingsCache.language !== oldLang) {
      i18nReady = initI18n(); // re-read the new language before rebuilding
      buildMenus();
    }
  } else if (changes[I18N_SETTINGS_KEY]) {
    // B: written directly by shared/i18n.js setLanguage() (options page).
    // Adopt the language into the canonical settings and rebuild menus;
    // the debounced SAVE_SETTINGS lands the full object right after.
    const next = normalizeSettings(changes[I18N_SETTINGS_KEY].newValue);
    if (settingsCache && next.language === settingsCache.language) return;
    settingsCache = next;
    queue.concurrency = settingsCache.maxConcurrent;
    i18nReady = initI18n(); // pick up the new language
    buildMenus();
    chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no listener, popup/options not open */
  });
}

/**
 * Google Lens direct search (2026-10-13).
 * lens.google.com/uploadbyurl?url= takes the image URL and redirects
 * straight into the Lens results page: one click, Google Lens searches the
 * image directly, no dialog, no pasting.
 *
 * Safety guard: lensUrlBlocked (core/urls.js) rejects page-local data:/blob:
 * URLs and private-network URLs before anything is sent to Google.
 */
async function openLensWithUrl(imageUrl) {
  // Direct upload-by-URL: one click, Google Lens searches the image directly.
  const url = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  const tab = await chrome.tabs.create({ url });
  if (!tab || !Number.isInteger(tab.id)) throw new Error('lens-tab-failed');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isScannableTab(tab) {
  return !!tab && typeof tab.id === 'number' && /^https?:\/\//.test(tab.url || '');
}

async function nextFileNumber() {
  const stored = await chrome.storage.local.get(COUNTER_KEY);
  const n = (Number(stored[COUNTER_KEY]) || 0) + 1;
  await chrome.storage.local.set({ [COUNTER_KEY]: n });
  return n;
}

/** Peek the next number without consuming it (for rename suggestions). */
async function peekFileNumber() {
  const stored = await chrome.storage.local.get(COUNTER_KEY);
  return (Number(stored[COUNTER_KEY]) || 0) + 1;
}

/** Pick the download filename: user-typed name wins, else the naming mode. */
async function pickFilename(item, settings, parts) {
  const custom = item && item.payload && sanitizeCustomName(item.payload.customName, parts.ext);
  if (custom) return custom;
  return buildFilename(settings.filenameMode, {
    site: parts.site,
    name: parts.name,
    ext: parts.ext,
    date: new Date(),
    num: await nextFileNumber(),
    width: parts.width,
    height: parts.height,
    custom: settings.customTemplate,
  });
}

/** Sanitize a user-typed filename; enforce the target extension. */
function sanitizeCustomName(raw, ext) {
  let name = String(raw || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  if (!name) return '';
  const wantExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dot = name.lastIndexOf('.');
  const curExt = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  if (wantExt && curExt !== wantExt) {
    name = (dot > 0 ? name.slice(0, dot) : name) + '.' + wantExt;
  }
  return name || '';
}

/** Run a function inside the page's content-script world. */
async function runInPage(tabId, func, args = []) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/scanner.js'],
  });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func,
    args,
  });
  return result && result.result;
}

/**
 * blob: URLs only exist inside the page that created them, the offscreen
 * document and chrome.downloads cannot touch them. Fetch one in-page and
 * return a data URL everyone downstream can consume. With {thumb:true},
 * returns a small JPEG preview instead (for popup thumbnails).
 * Returns null when the blob cannot be resolved.
 */
async function resolveBlobUrl(tabId, blobUrl, opts = {}) {
  if (!blobUrl || !blobUrl.startsWith('blob:')) return blobUrl;
  if (!Number.isInteger(tabId)) return null;
  const thumb = !!opts.thumb;
  try {
    const dataUrl = await runInPage(
      tabId,
      (url, wantThumb) =>
        fetch(url)
          .then((res) => {
            if (!res.ok) throw new Error('fetch-failed');
            return res.blob();
          })
          .then(
            (blob) =>
              new Promise((resolve, reject) => {
                if (!blob || !String(blob.type || '').startsWith('image/')) {
                  reject(new Error('not-image'));
                  return;
                }
                if (blob.size > 25_000_000) {
                  reject(new Error('too-large'));
                  return;
                }
                if (!wantThumb) {
                  const fr = new FileReader();
                  fr.onload = () => resolve(String(fr.result || ''));
                  fr.onerror = () => reject(new Error('read-failed'));
                  fr.readAsDataURL(blob);
                  return;
                }
                // Thumbnail path: decode and downscale to keep the
                // popup light, a 320px JPEG preview is plenty.
                const objUrl = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                  try {
                    const scale = Math.min(1, 320 / Math.max(img.width || 1, img.height || 1));
                    const w = Math.max(1, Math.round((img.width || 320) * scale));
                    const h = Math.max(1, Math.round((img.height || 320) * scale));
                    const c = document.createElement('canvas');
                    c.width = w;
                    c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(c.toDataURL('image/jpeg', 0.72));
                  } catch (e) {
                    reject(e);
                  } finally {
                    URL.revokeObjectURL(objUrl);
                  }
                };
                img.onerror = () => {
                  URL.revokeObjectURL(objUrl);
                  reject(new Error('decode-failed'));
                };
                img.src = objUrl;
              }),
          ),
      [blobUrl, thumb],
    );
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:') ? dataUrl : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Offscreen document (conversion, crop, clipboard)                     */
/* ------------------------------------------------------------------ */

async function ensureOffscreen() {
  // B6: one shared promise around the WHOLE ensure step (check, optional
  // close, create). Without this, two conversions starting together after
  // 30 s idle could both close and both create, the second create fails
  // with "only a single offscreen document".
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const exists = await chrome.offscreen.hasDocument?.().catch(() => false);
    if (exists) {
      // Don't let an idle offscreen document sit in memory: reap it after
      // 30 s of disuse, but never while a job is still running (H4).
      if (offscreenInflight === 0 && Date.now() - offscreenLastUsed > 30_000) {
        try {
          await chrome.offscreen.closeDocument();
        } catch {
          /* already gone */
        }
      } else {
        return;
      }
    }
    // B: the justification string is user-visible in chrome://extensions.
    await i18nReady;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS', 'CLIPBOARD'],
      justification: t('sw_offscreenJustification'),
    });
  })().finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

async function offscreenCall(message) {
  await ensureOffscreen();
  offscreenLastUsed = Date.now();
  offscreenInflight += 1;
  try {
    const payload = { ...message, target: 'offscreen' };
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await chrome.runtime.sendMessage(payload);
      } catch (err) {
        lastErr = err;
        // createDocument resolves before the offscreen page's scripts have
        // registered their listener, retry instead of failing the job.
        if (/receiving end does not exist/i.test(String((err && err.message) || '')) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    offscreenInflight -= 1;
    offscreenLastUsed = Date.now();
  }
}

/* ------------------------------------------------------------------ */
/* Ranked-source cache: probing costs network round-trips, so repeat       */
/* downloads of the same image reuse the last ranking for 3 minutes.       */
/* ------------------------------------------------------------------ */
const rankedCache = new Map(); // srcUrl -> { at, ranked }

async function findRankedSourcesCached(srcUrl, pageUrl, tabId, candidates) {
  const hit = rankedCache.get(srcUrl);
  if (hit && Date.now() - hit.at < 180_000) return hit.ranked;
  const ranked = await findRankedSources(srcUrl, pageUrl, tabId, candidates);
  rankedCache.set(srcUrl, { at: Date.now(), ranked });
  if (rankedCache.size > 200) {
    const oldest = rankedCache.keys().next();
    if (!oldest.done) rankedCache.delete(oldest.value);
  }
  return ranked;
}

/**
 * M11: screenshot storage. Captures live in IndexedDB (primary), not worker
 * memory, a full-page capture can be tens of MB as a data URL. A tiny
 * in-memory LRU (2 entries) covers the hot path; IndexedDB survives worker
 * restarts and has a far larger quota than chrome.storage.session (~10 MB).
 */
const CAP_CACHE_SIZE = 2;
const capCache = new Map(); // id -> data (LRU, hot path only)

/** Groups whose capture is still running: their records are never pruned. */
const openCaptureGroups = new Set();

/**
 * Round 4 pruning: age + total-bytes + count caps from
 * core/capture-storage.js (the caps themselves live there, once).
 * Open groups are protected; closed groups are pruned whole, never
 * part by part. Metadata comes from the records themselves; blob
 * payloads stay in IndexedDB (a Blob handle is not its bytes).
 */
async function pruneCaptures() {
  try {
    const all = await idb.all('captures');
    if (!all.length) return;
    const metas = all.map((r) => captureRecordMeta(r));
    const drop = pruneCaptureRecords(metas, {
      now: Date.now(),
      openGroupIds: [...openCaptureGroups],
    });
    for (const id of drop) {
      capCache.delete(id);
      await idb.del('captures', id).catch(() => {});
    }
  } catch {
    /* pruning is housekeeping; a failure never breaks a capture */
  }
}

async function rememberCapture(id, data) {
  capCache.set(id, data);
  if (capCache.size > CAP_CACHE_SIZE) {
    const oldest = [...capCache.keys()][0];
    capCache.delete(oldest);
  }
  try {
    await idb.put('captures', { id, ...data });
    await pruneCaptures();
  } catch {
    /* IndexedDB unavailable, the memory cache covers the normal case */
  }
  // Drop the legacy session-storage backup (superseded by IndexedDB).
  try {
    await chrome.storage.session.remove(CAPS_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Register a capture record the offscreen document already wrote to
 * IndexedDB as a Blob (a stitched part). The worker keeps only the
 * metadata; the image bytes never pass through the worker.
 */
async function registerStoredCapture(id, meta) {
  capCache.set(id, { ...meta, blobStored: true });
  if (capCache.size > CAP_CACHE_SIZE) {
    const oldest = [...capCache.keys()][0];
    capCache.delete(oldest);
  }
  await pruneCaptures();
}

/** Chunked Blob -> data URL (service workers have no FileReader). */
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  const type = blob.type || 'image/png';
  return `data:${type};base64,${btoa(bin)}`;
}

async function recallCapture(id) {
  const mem = capCache.get(id);
  if (mem && (mem.dataUrl || mem.blob)) return mem;
  try {
    const rec = await idb.get('captures', id);
    if (rec) {
      const { id: _id, ...data } = rec;
      capCache.set(id, data);
      return data;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Round 4: discarding a parts group removes ALL of its records, so a
 * multi-part capture never leaves orphaned parts behind. Also used
 * when a group is saved and closed.
 */
async function discardCaptureGroup(groupId) {
  const gid = String(groupId || '');
  if (!gid) return { removed: 0 };
  openCaptureGroups.delete(gid);
  let removed = 0;
  try {
    const all = await idb.all('captures');
    for (const r of all) {
      if (r && r.groupId === gid) {
        capCache.delete(r.id);
        await idb.del('captures', r.id).catch(() => {});
        removed += 1;
      }
    }
  } catch {
    /* IndexedDB unavailable: nothing else to clean up */
  }
  return { removed };
}

/**
 * Round 4 (Parts overview): discarding ONE part of a group. The id
 * and group id must both be in the worker-minted formats, and the
 * stored record must really belong to that group, so a page can
 * never delete a capture outside the group it is showing. Returns
 * how many records remain in the group.
 */
async function discardCapture(id, groupId) {
  if (!isValidCaptureId(id) || !isValidCaptureGroupId(groupId)) {
    throw new Error(friendlyError('capture-failed'));
  }
  const cap = await recallCapture(id);
  if (!cap || String(cap.groupId || '') !== groupId) {
    throw new Error(friendlyError('capture-failed'));
  }
  await forgetCapture(id);
  let remaining = 0;
  try {
    const all = await idb.all('captures');
    remaining = all.filter((r) => r && r.groupId === groupId).length;
  } catch {
    remaining = 0;
  }
  return { removed: 1, remaining };
}

async function forgetCapture(id) {
  capCache.delete(id);
  try {
    await idb.del('captures', id);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

/**
 * Perform one queued download. Resolves when the file is fully saved,
 * rejects with a friendly error code when it cannot be saved.
 */
async function performDownload(item) {
  if (item.payload && item.payload.kind === 'zip') {
    return performZipDownload(item);
  }
  if (item.payload && item.payload.mode === 'smart') {
    return performSmartDownload(item);
  }
  const { srcUrl, mode, format, pageUrl, pageTitle, kind } = item.payload;
  checkPublicFetch(srcUrl, pageUrl); // M7
  const settings = await getSettings();
  // Page blob: URLs must be resolved in-page to a data URL first,
  // nothing outside the page can fetch them.
  let src = srcUrl;
  if (typeof src === 'string' && src.startsWith('blob:')) {
    const resolved = await resolveBlobUrl(item.payload.tabId, src);
    if (!resolved) throw new Error(friendlyError('blocked'));
    src = resolved;
  }
  const url = normalizeUrl(src, pageUrl);
  if (!url) throw new Error(friendlyError('bad-url'));

  let finalUrl = url;
  let targetExt = getExtensionFromUrl(url) || 'png';
  let width = 0;
  let height = 0;
  let usedMode = mode;
  let didConvert = false; // L11: skip sniffing when we encoded it ourselves

  if (mode === 'normal' && settings.qualityPreference !== 'original') {
    // M4b: 'normal' bulk downloads also attempt a cheap upgrade from the
    // scan-time candidates already collected in-page, bounded probing,
    // no discovery round-trip. 'original' keeps its exact-URL contract,
    // and qualityPreference 'original' opts out of probing entirely.
    const upgraded = await tryScanCandidateUpgrade(
      url, pageUrl, item.payload.tabId, item.payload.candidates);
    if (upgraded) {
      finalUrl = upgraded.url;
      width = upgraded.width;
      height = upgraded.height;
    }
  } else if (mode === 'best' || mode === 'original') {
    const found = await findValidatedSource(url, pageUrl, mode, item.payload.tabId);
    if (found && found.url) {
      finalUrl = found.url;
      // The validated source may be a different URL (and format) than the
      // clicked one, track its extension; SNIFF_TYPE below confirms bytes.
      targetExt = getExtensionFromUrl(found.url) || targetExt;
      width = found.width || 0;
      height = found.height || 0;
    } else if (mode === 'original') {
      // Honest fallback: best available instead of a wrong "original".
      usedMode = 'best-fallback';
    }
  }

  if (format && format !== 'as-is') {
    const want = safeExtension(format);
    const have = safeExtension(targetExt);
    if (want !== have) {
      // Route through convertSource so every format uses its real encoder:
      // GIF/BMP/SVG have dedicated converters, while CONVERT_IMAGE only
      // handles png/jpg/webp/avif and rejects the rest (which used to
      // fall back to the source URL saved as PNG).
      try {
        const converted = await convertSource(finalUrl, want, settings, pageUrl);
        finalUrl = converted.dataUrl;
        targetExt = converted.ext;
        didConvert = true;
        width = converted.width || width;
        height = converted.height || height;
      } catch {
        // Conversion failed: fall back to the plain source URL instead of
        // failing the whole download; the user gets a notice.
        broadcast({ type: 'NOTICE', code: 'convert-failed' });
        finalUrl = url;
        targetExt = getExtensionFromUrl(url) || 'png';
      }
    }
  }

  finalUrl = await maybeSanitizeSvg(finalUrl, targetExt, pageUrl); // M3

  // L11: for direct downloads the URL's extension is a claim, not a fact.
  // Sniff the real type from the first bytes (cheap Range request); on any
  // failure keep the URL's extension (previous behavior).
  if (/^https?:\/\//i.test(finalUrl) && !didConvert) {
    try {
      const sniffed = await offscreenCall({ type: 'SNIFF_TYPE', srcUrl: finalUrl, pageUrl });
      if (sniffed && sniffed.ok && sniffed.ext) targetExt = sniffed.ext;
    } catch {
      /* keep URL-derived extension */
    }
  }

  const filename = await pickFilename(item, settings, {
    site: getHostLabel(pageUrl || url),
    name: filenameHintFromUrl(finalUrl.startsWith('data:') ? url : finalUrl),
    ext: targetExt,
    width: '',
    height: '',
  });
  const folder = resolveFolder(settings, pageUrl, url, targetExt);
  const path = joinDownloadPath(folder, filename);

  const downloadId = await saveToDownloads({ url: finalUrl, path, saveAs: settings.saveAsDialog });
  if (downloadId == null) throw new Error(friendlyError('download-failed'));

  // Wait for the download to actually finish so the queue reflects reality.
  await trackDownload(item, downloadId, {
    filename: path.split('/').pop(),
    site: sanitizeSegment(getHostLabel(pageUrl || url)),
    pageHost: pageUrl ? new URL(pageUrl).hostname : '',
    format: targetExt,
    width,
    height,
    kind: kind || 'single',
  });

  if (settings.afterDownload === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
      title: 'ImgFetch',
      message: t('notify_saved', { filename: path.split('/').pop() }),
      // Cosmetic: the download already succeeded; a denied notification
      // permission must not surface as an error.
    }).catch(() => {});
  }

  return { downloadId, filename: path, mode: usedMode };
}

/**
 * Ask the page to gather + validate candidates for a source URL.
 * Prefers the tab the download came from; falls back to the active tab.
 * Returns { url, width, height, confidence } or null.
 */
async function findValidatedSource(srcUrl, pageUrl, mode, tabId) {
  let tab = null;
  if (Number.isInteger(tabId)) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!isScannableTab(tab)) tab = await activeTab();
  if (!isScannableTab(tab)) return null;
  try {
    const pageResult = await runInPage(tab.id, (src, wantOriginal) => {
      const api = window.__imgfetch;
      if (!api || typeof api.findBestSource !== 'function') return null;
      return api.findBestSource(src, { original: wantOriginal });
    }, [srcUrl, mode === 'original']);
    if (!pageResult || !pageResult.url) return null;
    return pageResult;
  } catch {
    return null;
  }
}


/**
 * Ask the page for ALL validated sources for a URL, ranked best-first.
 * This is the Smart Download engine's raw material: only genuinely
 * loadable images, never URL-pattern guesses.
 * Returns [{ url, width, height }] (best first).
 */
async function findRankedSources(srcUrl, pageUrl, tabId, candidates) {
  let tab = null;
  if (Number.isInteger(tabId)) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!isScannableTab(tab)) tab = await activeTab();
  if (!isScannableTab(tab)) return [];
  try {
    // M4: scan-time candidates ride along, one in-page call, no
    // separate discovery round-trip per image.
    const res = await runInPage(tab.id, (src, cands) => {
      const api = window.__imgfetch;
      if (!api || typeof api.findRankedSources !== 'function') return [];
      return api.findRankedSources(src, cands);
    }, [srcUrl, Array.isArray(candidates) ? candidates : null]);
    return Array.isArray(res) ? res.filter((r) => r && r.url).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * M4b: cheap best-quality attempt for 'normal' bulk downloads.
 * Uses only the scan-time candidates already collected in-page during the
 * scan, no second discovery round-trip. Probing is bounded (top 4 by
 * width hint; full probing is what the explicit best-quality path does),
 * and it never "upgrades" to a smaller source. Returns
 * { url, width, height } or null. Never throws.
 */
async function tryScanCandidateUpgrade(srcUrl, pageUrl, tabId, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const trimmed = candidates
    .filter((c) => c && typeof c.u === 'string' && c.u)
    .sort((a, b) => (b.w || 0) - (a.w || 0))
    .slice(0, 4);
  if (!trimmed.length) return null;
  let ranked;
  try {
    ranked = await findRankedSourcesCached(srcUrl, pageUrl, tabId, trimmed);
  } catch {
    return null;
  }
  if (!ranked || !ranked.length) return null;
  return pickUpgrade(srcUrl, ranked);
}

/** Resolve when a chrome download actually finishes; reject on failure. */
function waitForDownloadComplete(downloadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCompletions.delete(downloadId);
      reject(new Error(friendlyError('timeout')));
    }, 10 * 60 * 1000);
    pendingCompletions.set(downloadId, {
      resolve: () => {
        clearTimeout(timer);
        pendingCompletions.delete(downloadId);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingCompletions.delete(downloadId);
        reject(err);
      },
    });
  });
}

/**
 * Actual on-disk size of a finished download, for history records.
 * chrome.downloads.search reports fileSize once the download completes,
 * this is the exact size the user got, not an estimate.
 */
async function downloadFileSize(downloadId) {
  // fileSize may not be populated immediately after download completes;
  // retry a few times before giving up.
  for (let i = 0; i < 5; i++) {
    try {
      const [d] = await chrome.downloads.search({ id: downloadId });
      const n = d && Number(d.fileSize);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    } catch {
      return 0;
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

/**
 * H5: tie a chrome.downloads id to its queue item and wait for it.
 * If the worker restarts mid-download, restoreQueueState() re-attaches
 * to the still-running browser download instead of losing the work,
 * and records the history entry the dead worker never got to write.
 */
function trackDownload(item, downloadId, historyEntry) {
  queue.updateItem(item.id, { chromeDownloadId: downloadId, history: historyEntry || null });
  persistQueueNow(); // N4: the id must be on disk before the worker can die
  return waitForDownloadComplete(downloadId)
    .then(async () => {
      if (historyEntry) {
        historyEntry.bytes = await downloadFileSize(downloadId);
        await recordHistory(historyEntry);
      }
    })
    .finally(() => {
      // B6: keep chromeDownloadId on finished items so the popup can offer
      // "Show in folder" (chrome.downloads.show). Done items are never
      // re-serialized for restart recovery, so the id can't go stale there.
      queue.updateItem(item.id, { history: null });
    });
}

/**
 * M3: network SVGs are sanitized before saving, a saved .svg opened in
 * a browser could run embedded scripts. Our generated SVG wrapper is a
 * data: URL and skips this. Failures fall through to the original file
 * rather than losing the download.
 */
async function maybeSanitizeSvg(finalUrl, targetExt, pageUrl) {
  if (targetExt !== 'svg' || String(finalUrl || '').startsWith('data:')) return finalUrl;
  const clean = await offscreenCall({ type: 'SANITIZE_SVG', srcUrl: finalUrl, pageUrl }).catch(() => null);
  return clean && clean.ok && clean.dataUrl ? clean.dataUrl : finalUrl;
}

/**
 * Convert one source to the requested format: decode once, encode once,
 * directly into the target format. Throws a friendly error on failure.
 * GIF is encoded by ImgFetch's own pure-JS encoder (core/gif.js); AVIF
 * requires browser support.
 */
async function convertSource(srcUrl, format, settings, pageUrl) {
  const want = normalizeExportFormat(format);
  if (want === 'gif') {
    const res = await offscreenCall({ type: 'CONVERT_GIF', srcUrl, pageUrl });
    if (!res || !res.ok || !res.dataUrl) throw new Error(friendlyError('convert-failed'));
    return { ...res, ext: 'gif' };
  }
  if (want === 'bmp') {
    const res = await offscreenCall({ type: 'CONVERT_BMP', srcUrl, pageUrl });
    if (!res || !res.ok || !res.dataUrl) throw new Error(friendlyError('convert-failed'));
    return { ...res, ext: 'bmp' };
  }
  if (want === 'svg') {
    const res = await offscreenCall({ type: 'CONVERT_SVG', srcUrl, pageUrl });
    if (!res || !res.ok || !res.dataUrl) throw new Error(friendlyError('convert-failed'));
    return { ...res, ext: 'svg' };
  }
  if (want === 'avif') {
    // The fast probe can misfire, so a "not supported" verdict is verified
    // with one real encode before giving up, the offscreen encoder
    // MIME-verifies its output, so a silent fallback can't slip through.
    if (!(await avifReallyAvailable(srcUrl, settings, pageUrl))) {
      throw new Error(friendlyError('avif-unavailable'));
    }
  }
  try {
    return await encodeImageFormat(srcUrl, want, settings, pageUrl);
  } catch (err) {
    if (String((err && err.message) || err).includes('encode-unsupported')) {
      throw new Error(friendlyError('avif-unavailable'));
    }
    throw err;
  }
}

/** Raw offscreen encode with output verification. Throws on any failure. */
async function encodeImageFormat(srcUrl, format, settings, pageUrl) {
  const want = normalizeExportFormat(format);
  let res;
  try {
    res = await offscreenCall({
      type: 'CONVERT_IMAGE',
      srcUrl,
      format: want,
      quality: qualityForFormat(want, settings),
      pageUrl,
    });
  } catch {
    res = null;
  }
  if (!res || !res.ok || !res.dataUrl) {
    const code = res && res.error ? String(res.error) : '';
    if (code.includes('encode-unsupported')) throw new Error('encode-unsupported');
    throw new Error(friendlyError('convert-failed'));
  }
  return { ...res, ext: want };
}

/**
 * Is AVIF really encodable? Fast probe first; on failure, one real encode
 * attempt (its output is MIME-verified) before concluding it isn't.
 */
async function avifReallyAvailable(srcUrl, settings, pageUrl) {
  if (await supportsAvif()) return true;
  try {
    await encodeImageFormat(srcUrl, 'avif', settings, pageUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download one ranked candidate. When a target format is requested, the best
 * valid source is found first and only then converted, never the reverse.
 * Returns the download result or throws a friendly error.
 */
async function attemptSmartCandidate(item, candidate, wantFormat, settings, say) {
  const { pageUrl, kind } = item.payload;
  let finalUrl = candidate.url;
  let targetExt = getExtensionFromUrl(candidate.url) || 'png';
  let width = candidate.width || 0;
  let height = candidate.height || 0;

  if (wantFormat && wantFormat !== targetExt) {
    say(t('sw_converting', { format: formatLabel(wantFormat) }));
    const converted = await convertSource(candidate.url, wantFormat, settings, pageUrl);
    finalUrl = converted.dataUrl;
    targetExt = converted.ext;
    width = converted.width || width;
    height = converted.height || height;
    if (getExtensionFromUrl(candidate.url) === 'gif') {
      say(t('sw_stillFrameNote'));
    }
  }

  say(t('sw_downloading'));
  finalUrl = await maybeSanitizeSvg(finalUrl, targetExt, pageUrl); // M3
  // L11: direct (unconverted) smart downloads get the same sniff check.
  if (/^https?:\/\//i.test(finalUrl) && finalUrl === candidate.url) {
    try {
      const sniffed = await offscreenCall({ type: 'SNIFF_TYPE', srcUrl: finalUrl, pageUrl });
      if (sniffed && sniffed.ok && sniffed.ext) targetExt = sniffed.ext;
    } catch {
      /* keep URL-derived extension */
    }
  }
  const filename = await pickFilename(item, settings, {
    site: getHostLabel(pageUrl || candidate.url),
    name: filenameHintFromUrl(finalUrl.startsWith('data:') ? candidate.url : finalUrl),
    ext: targetExt,
    width: '',
    height: '',
  });
  const folder = resolveFolder(settings, pageUrl, candidate.url, targetExt);
  const path = joinDownloadPath(folder, filename);

  const downloadId = await saveToDownloads({ url: finalUrl, path, saveAs: settings.saveAsDialog });
  if (downloadId == null) throw new Error(friendlyError('download-failed'));
  await trackDownload(item, downloadId, {
    filename: path.split('/').pop(),
    site: sanitizeSegment(getHostLabel(pageUrl || candidate.url)),
    pageHost: pageUrl ? new URL(pageUrl).hostname : '',
    format: targetExt,
    width,
    height,
    kind: kind || 'single',
  });

  if (settings.afterDownload === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
      title: 'ImgFetch',
      message: t('notify_saved', { filename: path.split('/').pop() }),
      // Cosmetic: the download already succeeded; a denied notification
      // permission must not surface as an error.
    }).catch(() => {});
  } else if (kind !== 'bulk') {
    say(t('sw_downloadedOk'));
  }

  return { downloadId, filename: path };
}

/* ------------------------------------------------------------------ */
/* ZIP download: pack many images into one .zip file.                   */
/* ------------------------------------------------------------------ */
async function performZipDownload(item) {
  const settings = await getSettings();
  const { files, pageUrl, tabId } = item.payload;
  const say = (text) => {
    queue.updateItem(item.id, { label: text });
    broadcast({ type: 'NOTICE_TEXT', text });
  };
  if (!Array.isArray(files) || !files.length) throw new Error(friendlyError('bad-url'));

  // H3: resolve page blob: URLs in-page first (nothing outside the page
  // can fetch them). Unresolvable ones count as skipped, not silent.
  const capped = files.slice(0, 200);
  const cappedNote = files.length > 200 ? t('sw_zipCapped', { total: files.length }) : '';
  let skipped = 0;
  const resolved = [];
  for (const f of capped) {
    const url = String((f && f.url) || '');
    if (url.startsWith('blob:')) {
      const dataUrl = Number.isInteger(tabId) ? await resolveBlobUrl(tabId, url, {}) : null;
      if (dataUrl && dataUrl.startsWith('data:')) {
        resolved.push({ url: dataUrl, name: String((f && f.name) || 'image') });
      } else {
        skipped += 1;
      }
    } else {
      try {
        checkPublicFetch(url, pageUrl); // M7
        resolved.push({ url, name: String((f && f.name) || 'image') });
      } catch {
        skipped += 1;
      }
    }
  }

  say(t('sw_preparingZip', { count: resolved.length, cappedNote }));
  // B6: blob: URLs were resolved to data URLs in-page, those can be huge,
  // so split the payload into small messages (no single runtime message
  // near the size limit). The offscreen side accumulates the chunks.
  const ZIP_MSG_BUDGET = 12_000_000;
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const f of resolved) {
    const est = f.url.startsWith('data:') ? f.url.length : 512;
    if (cur.length && curBytes + est > ZIP_MSG_BUDGET) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += est;
  }
  if (cur.length) chunks.push(cur);
  let res = null;
  // B6: one token per ZIP so concurrent bulk ZIPs accumulate independently.
  const zipToken = `zip-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      // N2: stop a cancelled build between chunks, the catch below sends
      // ZIP_ABORT so accumulated chunks are released, not finished in vain.
      if (queue.cancelled) throw new Error(friendlyError('cancelled'));
      res = await offscreenCall({
        type: 'BUILD_ZIP',
        files: chunks[i],
        pageUrl,
        zipToken,
        more: i < chunks.length - 1,
      });
      if (!res || !res.ok) throw new Error(friendlyError('convert-failed'));
    }
  } catch (err) {
    // N2: release the offscreen accumulator's chunks immediately, do not
    // leak them until the offscreen document closes. Best-effort: the
    // offscreen may be gone already.
    try {
      await offscreenCall({ type: 'ZIP_ABORT', zipToken });
    } catch { /* offscreen gone, nothing to release */ }
    throw err;
  }
  if (!res || !res.url) throw new Error(friendlyError('convert-failed'));
  skipped += Number(res.skipped) || 0;

  say(t('sw_downloadingZip'));
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const folder = resolveFolder(settings, pageUrl, '', 'zip');
  const path = joinDownloadPath(folder, `imgfetch-images-${stamp}.zip`, ['zip']);
  let downloadId;
  const zipHistory = {
    filename: path.split('/').pop(),
    site: sanitizeSegment(getHostLabel(pageUrl || '')),
    pageHost: pageUrl ? new URL(pageUrl).hostname : '',
    format: 'zip',
    width: 0,
    height: 0,
    kind: 'bulk',
    count: res.count,
  };
  try {
    downloadId = await saveToDownloads({ url: res.url, path, saveAs: settings.saveAsDialog });
    if (downloadId == null) throw new Error(friendlyError('download-failed'));
    await trackDownload(item, downloadId, zipHistory); // H3: don't report "done" early
  } finally {
    // Best-effort cleanup: the offscreen document may already be gone.
    await offscreenCall({ type: 'REVOKE_URL', url: res.url }).catch(() => {});
  }
  const doneMsg = skipped > 0
    ? t('sw_zipDonePartial', { count: res.count, total: capped.length, skipped })
    : t('sw_zipDoneFull', { count: res.count });
  say(doneMsg);
  return { downloadId };
}

/**
 * Smart Download: find every genuinely available source, rank them,
 * take the best valid one (converting only if a target format was asked
 * for), and walk down the list automatically when a source fails.
 * Never upscales; never claims quality it has not measured.
 */
async function performSmartDownload(item) {
  const settings = await getSettings();
  const { srcUrl, pageUrl, kind } = item.payload;
  checkPublicFetch(srcUrl, pageUrl); // M7
  const single = kind !== 'bulk';
  const say = (text) => {
    queue.updateItem(item.id, { label: text });
    if (single) broadcast({ type: 'NOTICE_TEXT', text });
  };

  let wantFormat = item.payload.format && item.payload.format !== 'as-is'
    ? normalizeExportFormat(item.payload.format)
    : null;

  // Page blob: URLs are resolved in-page first; the blob itself is the
  // source, so best-source probing is skipped for them.
  let smartSrc = srcUrl;
  let isBlobSource = false;
  if (typeof smartSrc === 'string' && smartSrc.startsWith('blob:')) {
    const resolved = await resolveBlobUrl(item.payload.tabId, smartSrc);
    if (!resolved) throw new Error(friendlyError('blocked'));
    smartSrc = resolved;
    isBlobSource = true;
  }

  const url = normalizeUrl(smartSrc, pageUrl);
  if (!url) throw new Error(friendlyError('bad-url'));

  say(t('sw_findingBest'));
  // B3: qualityPreference 'original' skips best-source probing entirely,
  // the exact source URL is used (fewer requests, faster, more private).
  const ranked = isBlobSource || !shouldProbeBestSources(settings, 'smart')
    ? []
    : await findRankedSourcesCached(url, pageUrl, item.payload.tabId, item.payload.candidates);
  const attempts = ranked.length ? ranked : [{ url, width: 0, height: 0 }];
  if (!attempts.some((a) => a.url === url)) attempts.push({ url, width: 0, height: 0 });

  // When a specific format is requested, prefer the candidate that is already
  // in that format: it downloads directly with zero conversion, this keeps
  // animated GIFs animated instead of pointlessly re-encoding a sibling.
  if (wantFormat) {
    attempts.sort((a, b) => {
      const am = getExtensionFromUrl(a.url) === wantFormat ? 0 : 1;
      const bm = getExtensionFromUrl(b.url) === wantFormat ? 0 : 1;
      return am - bm;
    });
  }

  // GIF requests are genuinely encoded by ImgFetch (core/gif.js), so any
  // source can satisfy them, animated sources still download directly to
  // preserve their animation (see the sort above + attemptSmartCandidate).
  if (wantFormat === 'avif' && !(await avifReallyAvailable(url, settings, pageUrl))) {
    say(friendlyError('avif-unavailable'));
    wantFormat = 'png';
  }

  const tried = new Set();
  let lastError = null;
  for (const candidate of attempts.slice(0, 5)) {
    if (tried.has(candidate.url)) continue;
    tried.add(candidate.url);
    try {
      return await attemptSmartCandidate(item, candidate, wantFormat, settings, say);
    } catch (err) {
      lastError = err;
      say(t('sw_retryingSource'));
    }
  }
  const final = lastError || new Error(friendlyError('download-failed'));
  if (single) broadcast({ type: 'NOTICE_TEXT', text: final.message });
  throw final;
}

async function recordHistory(entry) {
  const settings = await getSettings();
  if (!settings.historyEnabled) return;
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  let records = addRecord(stored[HISTORY_KEY] || [], { ...entry, at: Date.now() });
  records = pruneRecords(records, settings.historyRetentionDays);
  await chrome.storage.local.set({ [HISTORY_KEY]: records.slice(0, MAX_RECORDS) });
}

chrome.downloads.onChanged.addListener((delta) => {
  const pending = pendingCompletions.get(delta.id);
  if (!pending) return;
  if (delta.state && delta.state.current === 'complete') {
    pending.resolve();
  } else if (delta.state && delta.state.current === 'interrupted') {
    pending.reject(new Error(friendlyError('download-failed')));
  } else if (delta.error && delta.error.current) {
    pending.reject(new Error(friendlyError('download-failed')));
  }
});

/* ------------------------------------------------------------------ */
/* Page scanning                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Scan lifecycle: idle -> scanning -> results | error                   */
/* The state lives in session storage so the popup can pick up a scan    */
/* that was started by the global shortcut while it was closed.          */
/* ------------------------------------------------------------------ */

const SCAN_STATE_KEY = 'imgfetch.scanState';
const scanInflight = new Map(); // tabId -> Promise (debounce/lock)

async function setScanState(patch) {
  const cur = (await chrome.storage.session.get(SCAN_STATE_KEY))[SCAN_STATE_KEY] || { status: 'idle' };
  const next = { ...cur, ...patch };
  // Ephemeral UI state: if session storage is unavailable the scan still
    // ran, the popup just won't show its progress.
    await chrome.storage.session.set({ [SCAN_STATE_KEY]: next }).catch(() => {});
  return next;
}

async function getScanState() {
  const stored = (await chrome.storage.session.get(SCAN_STATE_KEY))[SCAN_STATE_KEY];
  return coerceScanState(stored);
}

/**
 * Start (or join) a scan for a tab. Rapid double-presses of the shortcut
 *, or the popup's Scan button racing the shortcut, share one inflight
 * scan instead of starting duplicates.
 */
function requestScan(tabId) {
  const id = Number(tabId);
  const existing = scanInflight.get(id);
  if (existing) return existing;
  // Mark SCANNING synchronously (the storage write is kicked off now) so a
  // popup opened in the next tick already sees the live state.
  const marked = setScanState({ status: 'scanning', tabId: id, at: Date.now(), error: '' });
  const p = (async () => {
    await marked;
    // Wake a popup that is already open on its dashboard: it switches to
    // the scanning pane on progress events (no new message type needed).
    broadcast({ type: 'SCAN_PROGRESS', done: 0, total: 1 });
    try {
      const scan = await scanPage(id);
      await setScanState({ status: 'results', tabId: id, at: Date.now(), error: '' });
      return scan;
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200);
      await setScanState({ status: 'error', tabId: id, at: Date.now(), error: msg });
      throw err;
    } finally {
      scanInflight.delete(id);
    }
  })();
  scanInflight.set(id, p);
  // Every caller attaches its own handlers; this guards the shared promise
  // itself against unhandled rejections between attach points.
  p.catch(() => {});
  return p;
}

async function scanPage(tabId) {
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await activeTab();
  if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));

  const settings = await getSettings();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, // M5: images inside iframes
    files: ['content/scanner.js'],
  });
  // Optional: scroll through the page so lazy-loaded images reveal
  // themselves, then restore the user's scroll position before scanning.
  // scanDepth 'loaded' skips this for speed; 'scroll' (default) does it.
  const scrollScan = settings.scanDepth
    ? settings.scanDepth !== 'loaded'
    : settings.detectLazyScroll !== false;
  if (scrollScan) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => new Promise((resolve) => {
        try {
          const doc = document.documentElement;
          const vh = Math.max(window.innerHeight || 1, 1);
          const y0 = window.scrollY || 0;
          let i = 0;
          const tick = () => {
            try {
              // Re-read height each step: infinite-scroll pages grow.
              const total = Math.max(doc.scrollHeight || 0, 1);
              const steps = Math.min(16, Math.max(2, Math.ceil(total / vh)));
              if (i >= steps) {
                window.scrollTo(0, y0);
                // Let freshly revealed images decode before scanning.
                setTimeout(() => resolve(true), 600);
                return;
              }
              window.scrollTo(0, Math.round((total / steps) * i));
              i += 1;
              setTimeout(tick, 400);
            } catch {
              resolve(false);
            }
          };
          tick();
        } catch {
          resolve(false);
        }
      }),
    }).catch(() => null);
  }
  const scanResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, // M5: scan inside iframes too
    world: 'ISOLATED',
    func: (options) => window.__imgfetch.scanPage(options),
    args: [{
      includeBackgrounds: settings.includeBackgrounds,
      minLongest: { any: 0, medium: 400, large: 1200, xlarge: 2000 }[settings.minSizePreset] ?? 400,
    }],
  }).catch(() => []);
  // Merge per-frame results (frames that failed to inject return nothing).
  let images = [];
  let droppedBySize = 0;
  let droppedByRelevance = 0;
  let frameCount = 0;
  for (const r of scanResults || []) {
    const s = r && r.result;
    if (!s || !Array.isArray(s.images)) continue;
    frameCount += 1;
    images.push(...s.images);
    droppedBySize += Number(s.droppedBySize) || 0;
    droppedByRelevance += Number(s.droppedByRelevance) || 0;
  }
  if (!images.length && frameCount === 0) throw new Error(friendlyError('scan-failed'));
  // Hard cap so a pathological page can't blow up memory/storage.
  const MAX_SCAN_IMAGES = 3000;
  if (images.length > MAX_SCAN_IMAGES) images = images.slice(0, MAX_SCAN_IMAGES);

  // Duplicate removal: same image in several sizes → keep the largest only.
  let deduped = 0;
  if (settings.dedupeScan) {
    try {
      const r = dedupeImages(images.map((img) => ({
        url: img.src || img.url || '',
        width: img.width || 0,
        height: img.height || 0,
        ref: img,
      })));
      images = r.images.map((d) => d.ref);
      deduped = r.removed;
    } catch {
      /* dedupe is best-effort; keep the original list on failure */
    }
  }

  const payload = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title || '',
    pageHost: (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })(),
    at: Date.now(),
    images,
    deduped,
    droppedBySize,
    droppedByRelevance,
  };
  // Session storage is only a restore cache, the popup already received the
  // full scan via SCAN_DONE. If the payload is too large, store a trimmed
  // copy rather than failing the whole scan.
  try {
    await chrome.storage.session.set({ [LAST_SCAN_KEY]: payload });
  } catch {
    try {
      const trimmed = {
        ...payload,
        images: payload.images.filter((img) => {
          const src = img.src || '';
          return !src.startsWith('data:') || src.length <= 200_000;
        }),
      };
      await chrome.storage.session.set({ [LAST_SCAN_KEY]: trimmed });
    } catch {
      /* popup already has the data */
    }
  }
  broadcast({ type: 'SCAN_DONE', scan: payload });
  return payload;
}

/* ------------------------------------------------------------------ */
/* Screenshots                                                         */
/* ------------------------------------------------------------------ */

/**
 * FIX 3: every capture targets the REAL active tab of the current window,
 * whatever its URL (http, https, chrome://, edge://, about:,
 * chrome-extension://, data:, file:// when allowed). The silent fallback to
 * "the most recently used web tab" is gone: capturing a different tab than
 * the one the user sees is never acceptable.
 *
 * Modes that need script injection (area, element, full page) are driven
 * through the pure decision table in core/capture-decision.js: injection is
 * attempted inside try/catch and its failure (a restricted page, or an
 * empty tab.url on one) is the fallback signal, tab.url itself is never
 * consulted. Where the browser forbids injection, the capture falls back
 * to the visible area of the SAME tab with a clear localized notice; where
 * even the visible capture is refused (Chrome Web Store, Edge Add-ons), a
 * clear localized error is shown. Never a silent failure, never a raw
 * error string, never another tab.
 */
const CAPTURE_MODE_LABEL_KEYS = {
  visible: 'menu_shotVisible',
  area: 'menu_shotArea',
  element: 'menu_shotElement',
  full: 'menu_shotFull',
};

/**
 * Run one capture request through the FIX 3 decision table.
 * @param {'visible'|'area'|'element'|'full'} requestedMode
 * @param {(tab) => Promise} runMode the requested mode, run after a
 *   successful injection (null for 'visible', which needs no injection)
 */
async function captureWithFallback(requestedMode, runMode) {
  await i18nReady;
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id) || typeof tab.windowId !== 'number') {
    throw new Error(friendlyError('no-tab'));
  }
  // H8: paused sites block captures, but only http/https pages have site
  // preferences; other URL types skip the check instead of failing it.
  if (/^https?:\/\//i.test(tab.url || '')) {
    assertSiteAllowed(await getSettings(), tab.url);
  }
  const outcomes = { injection: null, visible: null };
  let visibleDataUrl = null;
  for (;;) {
    const d = decideCaptureStep(requestedMode, outcomes);
    if (d.step === 'inject') {
      let ok = false;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/scanner.js'],
        });
        ok = true;
      } catch {
        /* restricted page (or an empty URL on one): the fallback signal */
      }
      outcomes.injection = ok ? 'ok' : 'failed';
    } else if (d.step === 'capture-visible') {
      visibleDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
      outcomes.visible = visibleDataUrl ? 'ok' : 'failed';
    } else if (d.step === 'proceed') {
      if (typeof runMode !== 'function') throw new Error(friendlyError('capture-failed'));
      return runMode(tab);
    } else if (d.step === 'done' || d.step === 'fallback-done') {
      if (d.step === 'fallback-done') {
        const labelKey = CAPTURE_MODE_LABEL_KEYS[d.noticeVars.mode] || CAPTURE_MODE_LABEL_KEYS.visible;
        broadcast({ type: 'NOTICE_TEXT', text: t(d.noticeKey, { mode: t(labelKey) }) });
      }
      return finishCapture(visibleDataUrl, 0, 0);
    } else if (d.step === 'refuse') {
      throw new Error(t(d.errorKey));
    } else {
      throw new Error(friendlyError('capture-failed'));
    }
  }
}

/** Visible-area capture of the active tab, whatever its URL. */
async function captureVisible() {
  return captureWithFallback('visible', null);
}

/**
 * Shared tail for single screenshots: store the record and open the
 * preview/annotate page. M10: extracted from captureVisible/Area/Element
 * (3 identical tails). Split full-page captures do NOT come through
 * here: the full-page loop stores each part as a Blob record and opens
 * one Parts overview tab when the last part lands.
 */
/** Capture record ids embed their creation time; the pruner reads it back. */
function makeCaptureId() {
  return `cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function finishCapture(dataUrl, width, height, opts = {}) {
  const id = makeCaptureId();
  const record = { dataUrl, width, height, at: Date.now() };
  const partIndex = Number(opts.partIndex) || 0;
  const partTotal = Number(opts.partTotal) || 0;
  if (partIndex > 0 && partTotal > 1) {
    record.partIndex = partIndex;
    record.partTotal = partTotal;
  }
  await rememberCapture(id, record);
  const st = await getSettings();
  const page = st.annotateAfterCapture ? 'pages/annotate.html' : 'pages/capture.html';
  // Single captures reuse one result tab; a caller that must not reuse
  // (none today) can say so explicitly.
  await openResultTab(page, id, { reuse: opts.reuse !== false });
  return { id };
}

/**
 * Result tabs for screenshots. Single captures reuse one result tab (each
 * new capture replaces the previous one instead of spawning a tab per
 * screenshot); the parts of a split capture each get their own tab.
 * Returns the tab id.
 */
let resultTabId = 0;

async function openResultTab(page, id, opts = {}) {
  const url = chrome.runtime.getURL(`${page}#${id}`);
  const reuse = opts.reuse !== false;
  if (reuse && resultTabId) {
    try {
      await chrome.tabs.get(resultTabId);
      await chrome.tabs.update(resultTabId, { url, active: true });
      // Hash-only updates don't reload the page, force it so the new
      // capture id is picked up.
      await chrome.tabs.reload(resultTabId);
      return resultTabId;
    } catch {
      resultTabId = 0; // tab was closed, fall through and create
    }
  }
  const tab = await chrome.tabs.create({ url });
  if (reuse) resultTabId = tab.id;
  return tab.id;
}

/**
 * B: localized overlay picker hints. Resolved after i18nReady and passed
 * into the classic content script via executeScript args, because
 * content/overlay.js cannot use a static import.
 */
async function overlayHints() {
  await i18nReady;
  return {
    select: t('overlay_selectHint'),
    capture: t('overlay_captureHint'),
    inspect: t('overlay_inspectHint'),
  };
}

/**
 * Capture a region chosen with the overlay picker (area or element).
 * M10: captureArea() and captureElement() merged, their bodies were
 * identical except for the picker function.
 * FIX 3: the tab comes from captureWithFallback (always the real active
 * tab, whatever its URL); content/scanner.js is already injected there.
 */
async function captureRegion(tab, mode, pick) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/overlay.js'],
    });
  } catch {
    // Scanner injected fine but the overlay did not (vanishingly rare):
    // the same honest fallback as a restricted page, never another tab.
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
    if (!dataUrl) throw new Error(t('cap_captureRefused'));
    broadcast({
      type: 'NOTICE_TEXT',
      text: t('cap_restrictedFallback', { mode: t(CAPTURE_MODE_LABEL_KEYS[mode] || CAPTURE_MODE_LABEL_KEYS.area) }),
    });
    return finishCapture(dataUrl, 0, 0);
  }
  const hints = await overlayHints();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'ISOLATED',
    func: pick,
    args: [hints],
  });
  const rect = result && result.result;
  if (!rect) return { cancelled: true };
  // The screenshot must be taken while the source tab is still active, so
  // capture first; the result tab (which steals focus) opens right after.
  const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
  if (!full) throw new Error(t('cap_captureRefused'));
  // Open the result tab early: the user sees the editor loading state while
  // the crop and the store finish. The page retries its record read briefly
  // (shared/capture-io.js), so opening before the store lands is safe.
  const id = makeCaptureId();
  const st = await getSettings();
  const page = st.annotateAfterCapture ? 'pages/annotate.html' : 'pages/capture.html';
  const tabId = await openResultTab(page, id, { reuse: true });
  try {
    // FIX 4.6: the overlay reports device-pixel rects; the crop cuts 1:1
    // with no resampling. Cropping in the worker (createImageBitmap plus
    // OffscreenCanvas) is lossless by construction: no quality parameter
    // exists. It also skips the offscreen cold start and both base64
    // message round trips of the old offscreen crop path.
    const cropped = await cropPngDataUrl(full, rect);
    await rememberCapture(id, {
      dataUrl: cropped.dataUrl, width: cropped.width, height: cropped.height, at: Date.now(),
    });
  } catch (err) {
    // Never leave a stuck loading page: close the tab we just opened,
    // then surface the original error exactly like before.
    await chrome.tabs.remove(tabId).catch(() => {});
    throw err;
  }
  // The user may have closed the result tab mid-flight; drop the capture
  // instead of leaking it until the hourly prune.
  const stillThere = await chrome.tabs.get(tabId).catch(() => null);
  if (!stillThere) {
    await forgetCapture(id);
    return { id, closed: true };
  }
  // L4: the element picker clamps to the viewport, say so when it cut the element.
  if (rect.clipped) {
    broadcast({
      type: 'NOTICE_TEXT',
      text: t('sw_elementClipped'),
    });
  }
  return { id };
}

async function captureArea() {
  return captureWithFallback('area', (tab) => captureRegion(tab, 'area', (hints) => window.__imgfetch.selectArea(hints)));
}

/** Capture a single page element chosen with the picker. */
async function captureElement() {
  return captureWithFallback('element', (tab) => captureRegion(tab, 'element', (hints) => window.__imgfetch.selectElement(hints)));
}

async function saveCapture(id) {
  const cap = await recallCapture(id);
  if (!cap) throw new Error(friendlyError('capture-failed'));
  const settings = await getSettings();
  let dataUrl = cap.dataUrl;
  if (!dataUrl && cap.blob) {
    // Round 4: stitched parts are stored as Blobs; the Save flow works
    // on the real bytes, converted here in the worker.
    dataUrl = await blobToDataUrl(cap.blob);
  }
  if (!dataUrl) throw new Error(friendlyError('capture-failed'));
  // H7: the extension follows the actual bytes, only claim JPG after a
  // successful conversion, otherwise the file stays an honest PNG.
  let ext = 'png';
  if (settings.screenshotFormat === 'jpg') {
    const converted = await offscreenCall({
      type: 'CONVERT_IMAGE',
      srcUrl: dataUrl,
      format: 'jpg',
      quality: settings.screenshotQuality,
    });
    if (converted && converted.ok) {
      dataUrl = converted.dataUrl;
      ext = 'jpg';
    }
  }
  const filename = buildFilename(settings.filenameMode, {
    site: 'screenshot',
    name: 'imgfetch-screenshot',
    ext,
    date: new Date(),
    num: await nextFileNumber(),
    width: cap.width,
    height: cap.height,
    custom: settings.customTemplate,
  });
  const path = joinDownloadPath(settings.useSubfolder ? settings.subfolder : '', filename);
  const downloadId = await saveToDownloads({ url: dataUrl, path, saveAs: settings.saveAsDialog });
  if (downloadId == null) throw new Error(friendlyError('download-failed'));
  await forgetCapture(id);
  await recordHistory({
    filename: path.split('/').pop(),
    site: 'screenshot',
    pageHost: '',
    format: ext,
    width: cap.width,
    height: cap.height,
    bytes: await downloadFileSize(downloadId),
    kind: 'screenshot',
  });
  return { filename: path };
}

/**
 * Full-page screenshot (FIX 4): scroll through the page capturing each
 * viewport tile, then stitch the tiles in the offscreen document.
 *
 * - The capture target is the page's largest scrollable region: the
 *   document, a large inner element, or a same-origin iframe (FIX 4.1).
 * - No truncation, no downscaling: a page taller than the safe canvas
 *   limits is captured WHOLE at full device resolution, split into
 *   numbered parts ("Part i of N"), each part within the limits (FIX 4.2).
 * - Tiles are processed one at a time and their bitmaps released
 *   immediately; only the finished part PNG exists transiently before it
 *   moves to IndexedDB (FIX 4.3). Tile offsets are exact integers in
 *   device px, scroll positions device-aligned (FIX 4.4).
 * - After each scroll the capture waits for viewport stability (in-view
 *   lazy images, bounded) instead of a fixed delay; fixed AND sticky
 *   elements are hidden after the first tile; every page change is
 *   restored in the finally, even on failure or tab close (FIX 4.5).
 * - Cancellable via CANCEL_CAPTURE: safe, the finally still restores the
 *   page and STITCH_ABORT releases the offscreen canvas.
 */
/* FIX 4: full-page capture limits live in core/fullpage-capture.js (pure,
 * tested). Tiles are captured at full device resolution; pages that need
 * more than one part are split, never truncated, never downscaled. */
const TILE_GAP_MS = 520; // captureVisibleTab is rate-limited (~2/s); 520 ms keeps a small headroom

/**
 * One viewport tile. A quota rejection
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) is waited out with a
 * small bounded backoff and retried: a tile is NEVER silently skipped.
 * Other failures keep the original one-retry behaviour, then the
 * caller fails the capture honestly instead of stitching a hole.
 */
async function captureTile(windowId) {
  let failures = 0;
  let quotaWaits = 0;
  for (;;) {
    let shot = null;
    let errText = '';
    try {
      shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      errText = String((err && err.message) || err);
    }
    if (shot) return shot;
    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(errText) && quotaWaits < 4) {
      quotaWaits += 1;
      await new Promise((res) => setTimeout(res, 350 * quotaWaits));
      continue;
    }
    failures += 1;
    if (failures >= 2) return null;
    await new Promise((res) => setTimeout(res, TILE_GAP_MS));
  }
}

/**
 * Run func in the page WITHOUT re-injecting the content script.
 * captureWithFallback injects content/scanner.js once; the tile loop uses
 * this lighter path (dozens of tiles per capture).
 */
async function runInPageFunc(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func,
    args,
  });
  return result && result.result;
}

/** Set by CANCEL_CAPTURE while a full-page capture is in flight. */
let fullCaptureCancel = false;

/**
 * Round 5: the last full-page capture progress, memory only. The
 * popup renders CAPTURE_PROGRESS broadcasts as one live status row
 * (never a toast per tile) and asks GET_CAPTURE_PROGRESS when it
 * opens mid-capture. Cleared by endCaptureProgress at capture end.
 */
let lastCaptureProgress = null;

function setCaptureProgress(progress) {
  lastCaptureProgress = progress;
  broadcast({ type: 'CAPTURE_PROGRESS', ...progress });
}

function endCaptureProgress(phase) {
  if (!lastCaptureProgress) return;
  const last = lastCaptureProgress;
  lastCaptureProgress = null;
  broadcast({
    type: 'CAPTURE_PROGRESS',
    part: last.part, partTotal: last.partTotal,
    tile: last.tile, tileCount: last.tileCount, phase,
  });
}

async function captureFullPage() {
  try {
    return await captureWithFallback('full', (tab) => captureFullPageInner(tab));
  } catch (err) {
    // Round 5: a failed or cancelled capture must still release a
    // popup waiting on progress (the no-parts cancel lands here).
    endCaptureProgress('error');
    throw err;
  }
}

async function captureFullPageInner(tab) {
  const tabId = tab.id;
  const windowId = tab.windowId;
  fullCaptureCancel = false;
  const startedAt = Date.now();

  // FIX 4.1: describe the page's scrollable regions and pick the capture
  // target (document, inner container, or same-origin iframe).
  const ctx = await runInPageFunc(tabId, () => window.__imgfetch.describeScrollContext());
  if (!ctx || !ctx.doc) throw new Error(friendlyError('capture-failed'));
  const picked = pickScrollTarget(ctx);
  const target = picked.target;
  const notices = picked.notices || {};
  const dpr = Number(ctx.dpr) > 0 ? Number(ctx.dpr) : 1;

  // Content size (CSS px) and visible box size of the target.
  let fullW, fullH, boxW, boxH;
  if (target.kind === 'document') {
    fullW = ctx.doc.scrollW; fullH = ctx.doc.scrollH;
    boxW = ctx.viewportW; boxH = ctx.viewportH;
  } else {
    const list = target.kind === 'frame' ? (ctx.frames || []) : (ctx.containers || []);
    const rep = list.find((c) => c.token === target.token);
    if (!rep) throw new Error(friendlyError('capture-failed'));
    fullW = rep.scrollW; fullH = rep.scrollH;
    boxW = rep.clientW; boxH = rep.clientH;
  }
  let currentFullW = fullW;
  let currentFullH = fullH;

  // Round 4: freeze CSS animations/transitions for the whole capture
  // (restored by restoreCaptureTarget in the finally below).
  await runInPageFunc(tabId, () => window.__imgfetch.setCaptureStyleLock(true)).catch(() => {});

  // H2: never capture the wrong tab. This only READS tab state; our own
  // capture work opens no tab and takes no focus until the very end, so
  // a false here always means the USER really switched away.
  const tabStillActive = async () => {
    const live = await chrome.tabs.get(tabId).catch(() => null);
    if (!live || live.windowId !== windowId) return false;
    const active = await activeTab().catch(() => null);
    return !!active && active.id === tabId;
  };
  const setFixedHidden = (hide) =>
    runInPageFunc(tabId, (h) => window.__imgfetch.setFixedHidden(h), [hide]).catch(() => 0);

  // Original page state, restored in the finally no matter what happens.
  const origWinScroll = await runInPageFunc(tabId, () => ({ x: window.scrollX || 0, y: window.scrollY || 0 }));
  let box = null; // CSS px crop box for container/frame targets
  if (target.kind !== 'document') {
    box = await runInPageFunc(tabId, (t) => window.__imgfetch.ensureTargetVisible(t), [target]);
    if (!box) throw new Error(friendlyError('capture-failed'));
    // The tile shows the box/window intersection; plan the tile grid on
    // what is actually visible so tiles and crops agree exactly.
    const visW = Math.min(box.x + box.w, ctx.viewportW) - Math.max(box.x, 0);
    const visH = Math.min(box.y + box.h, ctx.viewportH) - Math.max(box.y, 0);
    if (!(visW >= 50 && visH >= 50)) throw new Error(friendlyError('capture-failed'));
    boxW = visW;
    boxH = visH;
  }

  // Round 4 allocation fallback: above the round-3 proven area, probe
  // the largest planned part in the offscreen document first. If the
  // canvas cannot be allocated and encoded there, halve the area
  // budget and replan, before a single tile is captured.
  let areaBudget = PART_MAX_AREA;
  let plan = planFullPageCapture({
    fullW, fullH, viewportW: boxW, viewportH: boxH, dpr, maxArea: areaBudget,
  });
  let allocNoticeShown = false;
  const noteAllocFallback = () => {
    if (allocNoticeShown) return;
    allocNoticeShown = true;
    broadcast({ type: 'NOTICE_TEXT', text: t('parts_allocFallback') });
  };
  {
    const largest = plan.parts.reduce((m, pt) => Math.max(m, pt.w * pt.h), 0);
    if (largest > PART_PROVEN_AREA) {
      const big = plan.parts.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a), plan.parts[0]);
      let ok = false;
      while (!ok && areaBudget > CAPTURE_AREA_FLOOR) {
        const probe = await offscreenCall({ type: 'STITCH_PROBE', width: big.w, height: big.h }).catch(() => null);
        if (probe && probe.ok) { ok = true; break; }
        areaBudget = Math.max(CAPTURE_AREA_FLOOR, Math.floor(areaBudget / 2));
        noteAllocFallback();
        plan = planFullPageCapture({
          fullW, fullH, viewportW: boxW, viewportH: boxH, dpr, maxArea: areaBudget,
        });
      }
      if (!ok) throw new Error(friendlyError('capture-failed'));
    }
  }

  if (notices.innerCaptured) {
    broadcast({ type: 'NOTICE_TEXT', text: t('scroll_innerCaptured') });
  }
  if (notices.nestedClipped) {
    broadcast({ type: 'NOTICE_TEXT', text: t('scroll_nestedClipped') });
  }
  if (notices.crossOriginClipped) {
    broadcast({ type: 'NOTICE_TEXT', text: t('scroll_crossOriginClipped') });
  }
  if (plan.parts.length > 1) {
    broadcast({ type: 'NOTICE_TEXT', text: t('part_splitting', { count: plan.parts.length }) });
  }
  if (plan.sanityCapped) {
    broadcast({ type: 'NOTICE_TEXT', text: t('part_sanityCapped', { count: plan.parts.length }) });
  }

  const origTargetScroll = await runInPageFunc(tabId, (t) => window.__imgfetch.readCaptureTargetScroll(t), [target]);
  // Device-px crop of the target's visible box inside each viewport tile
  // (container/frame targets; the document needs no crop). The box does
  // not move while its content scrolls, so one crop fits every tile.
  const crop = box ? {
    x: Math.max(0, Math.round(Math.max(box.x, 0) * dpr)),
    y: Math.max(0, Math.round(Math.max(box.y, 0) * dpr)),
    w: Math.max(1, Math.round(boxW * dpr)),
    h: Math.max(1, Math.round(boxH * dpr)),
  } : null;
  // CSS px box for the stability wait.
  const stableBox = box
    ? { x: Math.max(box.x, 0), y: Math.max(box.y, 0), w: boxW, h: boxH }
    : { x: 0, y: 0, w: ctx.viewportW, h: ctx.viewportH };

  const groupId = `grp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  openCaptureGroups.add(groupId);
  const partIds = [];
  let tileNo = 0;
  let lastCaptureAt = 0;
  let stopped = null; // { reason: 'cancel'|'tab'|'cap'|'alloc', total }
  let pendingGrowthDevH = 0;

  const singleColumn = () => plan.parts.every((pt) => pt.x0 === 0 && pt.w === plan.devW);
  const renumber = () => {
    plan.parts.forEach((pt, i) => { pt.index = i + 1; pt.total = plan.parts.length; });
  };
  const readTargetSize = async () => {
    const sz = await runInPageFunc(tabId, (t) => window.__imgfetch.readCaptureTargetSize(t), [target]).catch(() => null);
    return sz && Number(sz.scrollH) > 0 ? sz : null;
  };
  // Replace the parts from index `fromIdx` on with a fresh plan of the
  // region [regionY0Dev, newTotalDevH), planned as its own page and
  // shifted down. Single-column layouts only (tall pages, the growing
  // and fallback cases that matter); anything else keeps its plan.
  const replanRegion = (fromIdx, regionY0Dev, newTotalDevH) => {
    const regionDevH = Math.max(1, newTotalDevH - regionY0Dev);
    const sub = planFullPageCapture({
      fullW: currentFullW, fullH: regionDevH / dpr,
      viewportW: boxW, viewportH: boxH, dpr, maxArea: areaBudget,
    });
    if (sub.sanityCapped) plan.sanityCapped = true;
    plan.parts = [
      ...plan.parts.slice(0, fromIdx),
      ...shiftPlanParts(sub.parts, regionY0Dev, dpr),
    ];
    if (plan.parts.length > PART_MAX_COUNT) {
      plan.parts = plan.parts.slice(0, PART_MAX_COUNT);
      plan.sanityCapped = true;
    }
    plan.devH = regionY0Dev + sub.devH;
    renumber();
  };
  // Extend the part currently being stitched (its session is open in
  // the offscreen document) to cover a grown page height, adding the
  // new tile rows; anything past the part limits becomes new parts.
  const extendCurrentPart = async (part, newDevH) => {
    const maxH = Math.max(part.h, Math.min(plan.maxSide || PART_MAX_SIDE, Math.floor(areaBudget / plan.devW)));
    const wantH = Math.min(newDevH - part.y0, maxH);
    if (wantH > part.h) {
      const ext = await offscreenCall({ type: 'STITCH_EXTEND', height: wantH }).catch(() => null);
      if (ext && ext.ok) {
        const existing = new Set(part.tiles.map((t) => `${t.dx},${t.dy}`));
        const region = { x0: part.x0, y0: part.y0, w: part.w, h: wantH };
        for (const t of tilesCoveringRegion(region, plan.devW, newDevH, plan.tileW, plan.tileH, dpr)) {
          if (!existing.has(`${t.dx},${t.dy}`)) part.tiles.push(t);
        }
        part.h = wantH;
        part.cssH = part.h / dpr;
      }
    }
    if (part.y0 + part.h < newDevH) {
      const remY0 = part.y0 + part.h;
      const sub = planFullPageCapture({
        fullW: currentFullW, fullH: (newDevH - remY0) / dpr,
        viewportW: boxW, viewportH: boxH, dpr, maxArea: areaBudget,
      });
      plan.parts.push(...shiftPlanParts(sub.parts, remY0, dpr));
      if (plan.parts.length > PART_MAX_COUNT) {
        plan.parts = plan.parts.slice(0, PART_MAX_COUNT);
        plan.sanityCapped = true;
      }
    }
    plan.devH = Math.max(plan.devH, Math.min(newDevH, plan.parts.reduce((m, pt) => Math.max(m, pt.y0 + pt.h), 0)));
    renumber();
  };
  // Largest device-px Y whose rows are COMPLETELY captured in a part:
  // every tile row above it finished across the part's full width.
  // A stopped part is only saved cropped to this safe end.
  const safeCropEnd = (part, doneTiles) => {
    const rows = [...new Set(part.tiles.map((t) => t.dy))].sort((a, b) => a - b);
    let end = 0;
    for (const dy of rows) {
      if (dy > end) break;
      let x = 0;
      const iv = part.tiles
        .filter((t, i) => t.dy === dy && doneTiles.has(i))
        .map((t) => [t.dx, t.dx + plan.tileW])
        .sort((a, b) => a[0] - b[0]);
      let covered = iv.length > 0;
      for (const [a, b] of iv) {
        if (a > x) { covered = false; break; }
        x = Math.max(x, b);
      }
      if (!covered || x < part.w) break;
      end = Math.max(end, Math.min(dy + plan.tileH, part.h));
    }
    return end;
  };

  try {
    for (let pi = 0; pi < plan.parts.length && !stopped; pi += 1) {
      const part = plan.parts[pi];
      const begin = await offscreenCall({ type: 'STITCH_BEGIN', width: part.w, height: part.h }).catch(() => null);
      if (!begin || !begin.ok) {
        // Allocation failure on a later part: halve the area budget
        // and replan what is left (or the whole page when nothing has
        // been captured yet); never crash the worker.
        if (areaBudget > CAPTURE_AREA_FLOOR && (pi === 0 || singleColumn())) {
          areaBudget = Math.max(CAPTURE_AREA_FLOOR, Math.floor(areaBudget / 2));
          noteAllocFallback();
          if (pi === 0 && partIds.length === 0) {
            plan = planFullPageCapture({
              fullW: currentFullW, fullH: currentFullH,
              viewportW: boxW, viewportH: boxH, dpr, maxArea: areaBudget,
            });
          } else {
            replanRegion(pi, part.y0, plan.devH);
          }
          pi -= 1;
          continue;
        }
        stopped = { reason: 'alloc', total: plan.parts.length };
        break;
      }
      const doneTiles = new Set();
      let pendingStitch = null;
      let pendingTileIndex = -1;
      const flushStitch = async () => {
        if (!pendingStitch) return true;
        const r = await pendingStitch;
        pendingStitch = null;
        if (!r || !r.ok) return false;
        if (pendingTileIndex >= 0) doneTiles.add(pendingTileIndex);
        pendingTileIndex = -1;
        return true;
      };
      let sessionOpen = true;
      try {
        let ti = 0;
        let settleWaits = 0;
        for (;;) {
          while (ti < part.tiles.length && !stopped) {
            if (fullCaptureCancel) { stopped = { reason: 'cancel', total: plan.parts.length }; break; }
            if (Date.now() - startedAt > CAPTURE_MAX_DURATION_MS) { stopped = { reason: 'cap', total: plan.parts.length }; break; }
            if (!(await tabStillActive())) { stopped = { reason: 'tab', total: plan.parts.length }; break; }
            const tile = part.tiles[ti];
            // Scroll the target; read back the ACTUAL position and derive
            // exact integer device-px offsets from it, so even a browser
            // that snaps fractional scrolls stitches without gaps.
            const actual = await runInPageFunc(
              tabId,
              (t, x, y) => window.__imgfetch.scrollCaptureTarget(t, x, y),
              [target, tile.sx, tile.sy],
            );
            if (!actual) throw new Error(friendlyError('capture-failed'));
            const ax = Math.round((actual.x || 0) * dpr);
            const ay = Math.round((actual.y || 0) * dpr);
            // After the first tile, hide fixed AND sticky headers/banners
            // so they don't repeat in every tile (restored in finally).
            if (tileNo === 1) await setFixedHidden(true);
            // FIX 4.5: viewport stability instead of a fixed delay, then
            // respect the captureVisibleTab rate limit. The previous
            // tile's stitch (below) runs DURING this wait: the pipeline
            // overlaps, and at most one tile bitmap is ever in flight.
            await runInPageFunc(
              tabId,
              (b, ms) => window.__imgfetch.waitForViewportStable(b, ms),
              [stableBox, 2500],
            ).catch(() => null);
            const sinceLast = Date.now() - lastCaptureAt;
            if (sinceLast < TILE_GAP_MS) {
              await new Promise((r) => setTimeout(r, TILE_GAP_MS - sinceLast));
            }
            // The stability wait and the rate-limit gap are exactly
            // when a user switch or cancel lands, so re-check BEFORE
            // the screenshot and again AFTER it. A bitmap grabbed
            // across a switch can show the OTHER tab (captureVisibleTab
            // photographs the active tab, not necessarily ours), so
            // such a tile is discarded, never stitched: the part is
            // cropped to the complete tiles before it instead.
            if (fullCaptureCancel) { stopped = { reason: 'cancel', total: plan.parts.length }; break; }
            if (!(await tabStillActive())) { stopped = { reason: 'tab', total: plan.parts.length }; break; }
            const shot = await captureTile(windowId);
            lastCaptureAt = Date.now();
            if (!shot) throw new Error(friendlyError('capture-failed'));
            if (fullCaptureCancel) { stopped = { reason: 'cancel', total: plan.parts.length }; break; }
            if (!(await tabStillActive())) { stopped = { reason: 'tab', total: plan.parts.length }; break; }
            tileNo += 1;
            const futureTiles = plan.parts.slice(pi + 1).reduce((n, pt) => n + pt.tiles.length, 0);
            const tileCount = tileNo + (part.tiles.length - ti - 1) + futureTiles;
            if (tileCount > 1) {
              // Round 5: tile progress is a live status broadcast,
              // not a toast per tile (NOTICE_TEXT stays for one-off
              // notices like capped, stopped and captured).
              setCaptureProgress({
                part: plan.parts.length > 1 ? part.index : 1,
                partTotal: plan.parts.length,
                tile: tileNo,
                tileCount,
                phase: 'capturing',
              });
            }
            if (!(await flushStitch())) throw new Error(friendlyError('capture-failed'));
            const tileMsg = {
              type: 'STITCH_TILE',
              dataUrl: shot,
              dx: ax - part.x0,
              dy: ay - part.y0,
            };
            if (crop) {
              tileMsg.sx = crop.x;
              tileMsg.sy = crop.y;
              tileMsg.sw = crop.w;
              tileMsg.sh = crop.h;
            }
            pendingTileIndex = ti;
            pendingStitch = offscreenCall(tileMsg).catch(() => null);
            ti += 1;
            // Growing pages: sample the target size periodically; the
            // remaining plan is replanned between parts, and the last
            // part is extended in the settle phase below.
            if (tileNo % 8 === 0) {
              const sz = await readTargetSize();
              if (sz) {
                currentFullH = sz.scrollH;
                currentFullW = sz.scrollW;
                const nd = Math.round(sz.scrollH * dpr);
                if (nd > pendingGrowthDevH) pendingGrowthDevH = nd;
              }
            }
          }
          if (stopped) break;
          if (pi !== plan.parts.length - 1) break;
          // Last part: the page must have stopped growing. Re-read the
          // height; growth extends this part (or appends new parts),
          // a settled height (two reads, a short bounded wait apart)
          // ends the capture.
          const sz = await readTargetSize();
          if (sz) {
            currentFullH = sz.scrollH;
            currentFullW = sz.scrollW;
            const nd = Math.round(sz.scrollH * dpr);
            const ndw = Math.round(sz.scrollW * dpr);
            if (ndw === plan.devW && nd >= plan.devH + plan.tileH && singleColumn()) {
              if (!(await flushStitch())) throw new Error(friendlyError('capture-failed'));
              const beforeTiles = part.tiles.length;
              await extendCurrentPart(part, nd);
              if (part.tiles.length > beforeTiles) continue;
              break; // at a part limit: remainder parts were appended
            }
          }
          if (settleWaits >= 1) break;
          settleWaits += 1;
          await new Promise((r) => setTimeout(r, 350));
        }
        if (!(await flushStitch())) throw new Error(friendlyError('capture-failed'));
      } catch (err) {
        if (sessionOpen) await offscreenCall({ type: 'STITCH_ABORT' }).catch(() => null);
        throw err;
      }
      if (stopped) {
        // Deliver the finished parts, plus this part cropped to the
        // rows really captured when that is safe. Nothing is lost and
        // nothing half-stitched is presented as complete.
        const cropEnd = safeCropEnd(part, doneTiles);
        let savedPartial = false;
        if (cropEnd > 0) {
          const end = await offscreenCall({
            type: 'STITCH_END_BLOB', format: 'png', cropHeight: cropEnd,
            record: {
              id: makeCaptureId(), partIndex: part.index, partTotal: plan.parts.length,
              groupId, groupOpen: true, at: Date.now(),
            },
          }).catch(() => null);
          if (end && end.ok) {
            sessionOpen = false;
            await registerStoredCapture(end.id, {
              width: end.width, height: end.height, partIndex: part.index,
              partTotal: plan.parts.length, groupId, at: Date.now(), bytes: end.bytes,
            });
            partIds.push(end.id);
            savedPartial = true;
          }
        }
        if (!savedPartial) {
          await offscreenCall({ type: 'STITCH_ABORT' }).catch(() => null);
        }
        break;
      }
      // The part is encoded with canvas.toBlob in the offscreen
      // document and written straight into IndexedDB as a Blob record;
      // only its id and byte size come back here.
      const end = await offscreenCall({
        type: 'STITCH_END_BLOB', format: 'png',
        record: {
          id: makeCaptureId(), partIndex: part.index, partTotal: plan.parts.length,
          groupId, groupOpen: true, at: Date.now(),
        },
      }).catch(() => null);
      sessionOpen = false;
      if (!end || !end.ok) throw new Error(friendlyError('capture-failed'));
      await registerStoredCapture(end.id, {
        width: end.width, height: end.height, partIndex: part.index,
        partTotal: plan.parts.length, groupId, at: Date.now(), bytes: end.bytes,
      });
      partIds.push(end.id);
      // Growth noticed while this part ran: replan the parts that have
      // not started yet so the new tail is captured too.
      if (pi < plan.parts.length - 1 && pendingGrowthDevH >= plan.devH + plan.tileH && singleColumn()) {
        const nextY0 = plan.parts[pi + 1].y0;
        replanRegion(pi + 1, nextY0, pendingGrowthDevH);
        pendingGrowthDevH = 0;
      }
    }
  } finally {
    // FIX 4.5: always restore the page, even on failure, cancellation,
    // or abort. Best-effort: the tab may be closed already.
    fullCaptureCancel = false;
    const ox = (origTargetScroll && origTargetScroll.x) || 0;
    const oy = (origTargetScroll && origTargetScroll.y) || 0;
    await runInPageFunc(tabId, (t, x, y) => window.__imgfetch.scrollCaptureTarget(t, x, y),
      [target, ox, oy]).catch(() => {});
    await runInPageFunc(tabId, () => window.__imgfetch.restoreCaptureTarget()).catch(() => {});
    const wx = (origWinScroll && origWinScroll.x) || 0;
    const wy = (origWinScroll && origWinScroll.y) || 0;
    await runInPageFunc(tabId, (x, y) => window.scrollTo(x, y), [wx, wy]).catch(() => {});
    await setFixedHidden(false);
  }

  // The capture is over and the page is restored. Only NOW may a tab
  // open: the group's records get their final partTotal, then exactly
  // one tab appears (the editor for a single part, the Parts overview
  // for several parts or for a stopped multi-part capture).
  try {
    if (partIds.length) {
      await offscreenCall({
        type: 'CAPTURE_GROUP_FINALIZE', groupId, partTotal: partIds.length,
      }).catch(() => null);
    }
  } finally {
    openCaptureGroups.delete(groupId);
  }
  if (!partIds.length) {
    if (stopped && stopped.reason === 'cancel') throw new Error(friendlyError('cancelled'));
    throw new Error(friendlyError('capture-failed'));
  }
  if (stopped) {
    if (stopped.reason === 'cap') {
      broadcast({ type: 'NOTICE_TEXT', text: t('parts_capped') });
    } else {
      if (stopped.reason === 'alloc') noteAllocFallback();
      broadcast({
        type: 'NOTICE_TEXT',
        text: t('parts_stopped', { count: partIds.length, total: Math.max(stopped.total || 0, partIds.length) }),
      });
    }
    await openResultTab('pages/parts.html', groupId, { reuse: false });
    endCaptureProgress('stopped');
    return { id: partIds[0], partIds, groupId, stopped: true };
  }
  if (partIds.length === 1) {
    const st = await getSettings();
    const page = st.annotateAfterCapture ? 'pages/annotate.html' : 'pages/capture.html';
    await openResultTab(page, partIds[0], { reuse: true });
    if (tileNo > 1) {
      broadcast({
        type: 'NOTICE_TEXT',
        text: t('sw_fullPageCaptured', { width: plan.parts[0].w, height: plan.parts[0].h }),
      });
    }
    endCaptureProgress('done');
    return { id: partIds[0], partIds, groupId };
  }
  await openResultTab('pages/parts.html', groupId, { reuse: false });
  endCaptureProgress('done');
  return { id: partIds[0], partIds, groupId };
}
/**
 * Copy an image to the clipboard from inside the page itself. The page owns
 * blob: URLs and sends its own referrer/cookies, so this succeeds where the
 * offscreen copy fails (page blobs, hotlink-protected images). Returns true
 * when something image-like landed on the clipboard.
 */
/**
 * Copy Image Link support: read the right-clicked <img> straight from the
 * page so we can prefer its currentSrc (what the browser actually rendered
 * for srcset/<picture>), then its src attribute, <source> srcsets and the
 * page's own lazy-load attributes. Matches the element by the context
 * menu's srcUrl; returns null when the element can't be reached (restricted
 * page, shadow DOM, …) and the caller falls back to info.srcUrl.
 */
async function readImageDescriptor(tabId, srcUrl) {
  if (!Number.isInteger(tabId) || tabId < 0 || !srcUrl) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (wantedSrc) => {
        try {
          const norm = (u) => {
            try {
              return new URL(String(u), location.href).href;
            } catch {
              return '';
            }
          };
          const target = norm(wantedSrc);
          if (!target) return null;
          const imgs = Array.from(document.querySelectorAll('img'));
          const el =
            imgs.find((i) => norm(i.currentSrc) === target) ||
            imgs.find((i) => norm(i.getAttribute('src') || '') === target);
          if (!el) return null;
          const pic = el.closest('picture');
          const sourceSrcsets = [];
          if (pic) {
            for (const s of pic.querySelectorAll('source')) {
              const ss = s.getAttribute('srcset');
              if (ss) sourceSrcsets.push(ss);
            }
          }
          const lazy = {};
          for (const a of [
            'data-src',
            'data-original',
            'data-lazy-src',
            'data-srcset',
            'data-original-src',
            'data-full-src',
            'data-hi-res-src',
            'data-large-src',
          ]) {
            const v = el.getAttribute(a);
            if (v) lazy[a] = v;
          }
          return {
            currentSrc: el.currentSrc || '',
            srcAttr: el.getAttribute('src') || '',
            sourceSrcsets,
            lazy,
            naturalWidth: el.naturalWidth || 0,
            naturalHeight: el.naturalHeight || 0,
          };
        } catch {
          return null;
        }
      },
      args: [String(srcUrl)],
    });
    return (res && res.result) || null;
  } catch {
    return null;
  }
}

/**
 * Copy a URL as plain text inside the page (ISOLATED world). The context
 * menu click carries user activation, which is why this succeeds where the
 * offscreen document's clipboard write can fail ("Document is not focused").
 * Same pattern as copyImageInPage, which is why Copy Image already works.
 */
async function copyLinkTextInPage(tabId, text) {
  if (!Number.isInteger(tabId) || tabId < 0 || !text) return false;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (t) =>
        (async () => {
          try {
            await navigator.clipboard.writeText(t);
            return true;
          } catch {
            try {
              const ta = document.createElement('textarea');
              ta.value = t;
              ta.setAttribute('readonly', '');
              ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
              document.documentElement.appendChild(ta);
              ta.select();
              const ok = document.execCommand('copy');
              ta.remove();
              return !!ok;
            } catch {
              return false;
            }
          }
        })(),
      args: [String(text)],
    });
    return !!(res && res.result === true);
  } catch {
    return false;
  }
}

/**
 * Small non-blocking toast inside the page (auto-fades, never navigates,
 * never opens anything). Used for the Copy Image Link confirmations.
 */
async function showPageToast(tabId, text, isError) {
  if (!Number.isInteger(tabId) || tabId < 0 || !text) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (msg, err) => {
        try {
          const prev = document.querySelector('[data-imgfetch-toast]');
          if (prev) prev.remove();
          const el = document.createElement('div');
          el.setAttribute('data-imgfetch-toast', '1');
          el.textContent = msg;
          el.style.cssText =
            'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);' +
            'z-index:2147483647;background:' +
            (err ? '#b3261e' : '#171a2e') +
            ';color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 16px;' +
            'border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
            'pointer-events:none;opacity:0;transition:opacity .18s ease;';
          document.documentElement.appendChild(el);
          requestAnimationFrame(() => {
            el.style.opacity = '1';
          });
          setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 300);
          }, 2200);
        } catch {
          /* never break the page */
        }
      },
      args: [String(text), !!isError],
    });
  } catch {
    /* toast is best-effort */
  }
}

async function copyImageInPage(tabId, srcUrl) {
  if (!Number.isInteger(tabId) || tabId < 0 || !srcUrl) return false;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (src) => (async () => {
      try {
        let blob = null;
        try {
          const res = await fetch(src, { credentials: 'include' });
          if (res.ok) {
            const b = await res.blob();
            if (b && String(b.type || '').startsWith('image/')) blob = b;
          }
        } catch {
          blob = null;
        }
        if (!blob) {
          // Canvas route: load via <img>, re-export as PNG. Needs a
          // CORS-clean image; a tainted canvas throws and we bail out.
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('load-failed'));
            if (!src.startsWith('blob:') && !src.startsWith('data:')) {
              im.crossOrigin = 'anonymous';
            }
            im.src = src;
          });
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!(w > 0 && h > 0) || w > 8000 || h > 8000 || w * h > 32_000_000) {
            return false;
          }
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(img, 0, 0);
          blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        }
        if (!blob) return false;
        const type = String(blob.type || '').startsWith('image/') ? blob.type : 'image/png';
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        return true;
      } catch {
        return false;
      }
    })(),
    args: [String(srcUrl)],
  }).catch(() => null);
  return !!(results && results[0] && results[0].result === true);
}

/* ------------------------------------------------------------------ */
/* Context menus                                                       */
/* ------------------------------------------------------------------ */

const MENU_IDS = {
  rootImage: 'imgfetch-image',
  smart: 'imgfetch-smart',
  saveAs: 'imgfetch-saveas',
  savePng: 'imgfetch-save-png',
  saveJpg: 'imgfetch-save-jpg',
  saveWebp: 'imgfetch-save-webp',
  saveAvif: 'imgfetch-save-avif',
  saveGif: 'imgfetch-save-gif',
  saveSvg: 'imgfetch-save-svg',
  saveBmp: 'imgfetch-save-bmp',
  sepImage1: 'imgfetch-sep-image-1',
  openOriginal: 'imgfetch-open-original',
  copyLink: 'imgfetch-copy-link',
  copyImage: 'imgfetch-copy-image',
  lensSearch: 'imgfetch-lens-search',
  imageInfo: 'imgfetch-info',
  sepImage2: 'imgfetch-sep-image-2',
  more: 'imgfetch-more',
  scanPage: 'imgfetch-scan-page',
  screenshot: 'imgfetch-screenshot',
  shotVisible: 'imgfetch-shot-visible',
  shotArea: 'imgfetch-shot-area',
  shotFull: 'imgfetch-shot-full',
  shotElement: 'imgfetch-shot-element',
  addSitePref: 'imgfetch-add-site',
  disableSite: 'imgfetch-disable-site',
  openSettings: 'imgfetch-open-settings',
  rootPage: 'imgfetch-page',
  pageScan: 'imgfetch-page-scan',
  pageShotVisible: 'imgfetch-page-shot-visible',
  pageShotArea: 'imgfetch-page-shot-area',
  pageShotFull: 'imgfetch-page-shot-full',
  pageShotElement: 'imgfetch-page-shot-element',
};

function hostOfPageUrl(pageUrl) {
  try {
    return normalizeHost(new URL(pageUrl).hostname);
  } catch {
    return '';
  }
}

/**
 * H8: single choke point for site preferences and global quality defaults.
 * Returns the effective download mode for a page.
 * Precedence: per-site preference > the action's requested mode >
 * qualityPreference (B3: defaultAction was removed, every action names its
 * mode explicitly, so there is no generic case left for it).
 * Throws when ImgFetch is paused on the site ('disabled').
 */
function sitePrefFor(settings, host) {
  const h = String(host || '').toLowerCase();
  const raw = h && settings.sitePrefs[h];
  if (!raw) return '';
  return raw === 'best' ? 'smart' : raw; // legacy installs stored 'best'
}

function resolveDownloadMode(settings, pageUrl, requested) {
  const host = hostOfPageUrl(pageUrl);
  const pref = sitePrefFor(settings, host);
  if (pref === 'disabled') throw new Error(friendlyError('disabled-site'));
  if (pref === 'smart' || pref === 'normal') return pref;
  const req = String(requested || '');
  if (req === 'smart' || req === 'normal' || req === 'original' || req === 'best') return req;
  const q = qualityModeForHost(settings, host); // 'smart' | 'original' here
  return q === 'disabled' ? 'smart' : q; // unreachable, safety net
}

/** Throw when ImgFetch is paused on the page's site (H8). */
function assertSiteAllowed(settings, pageUrl) {
  if (sitePrefFor(settings, hostOfPageUrl(pageUrl)) === 'disabled') {
    throw new Error(friendlyError('disabled-site'));
  }
}

/** Apply concurrency + retry settings to the queue before enqueuing (H8). */
function prepareQueue(settings) {
  queue.concurrency = settings.maxConcurrent;
  queue.maxAttempts = settings.autoRetryOnce ? 2 : 1;
}

/**
 * M7: block extension-privileged fetches (no CORS) to private networks,
 * loopback, link-local, RFC-1918, unless the page itself is on that host.
 * A malicious page could otherwise make the browser GET internal URLs.
 * Throws a friendly error; the queue surfaces it like any download failure.
 * B2: the rule lives in core/urls.js so offscreen.js and info.js apply
 * the identical check.
 */
function checkPublicFetch(url, pageUrl) {
  if (!isPrivateNetworkFetchBlocked(url, pageUrl)) return;
  throw new Error(friendlyError('private-network'));
}

let menuBuildChain = Promise.resolve();
async function buildMenus() {
  // F6: serialize overlapping calls so removeAll/create cannot interleave
  // and produce duplicate-id errors.
  const run = menuBuildChain.then(() => buildMenusInner());
  menuBuildChain = run.catch(() => {});
  return run;
}

async function buildMenusInner() {
  // B: menu titles come from the loaded locale.
  await i18nReady;
  chrome.contextMenus.removeAll(() => {
    const img = ['image'];
    const page = ['page'];
    const M = MENU_IDS;

    // ---- Image menu: ImgFetch ----
    // D7: flat top level, Smart Download, Save as, Copy Link, Copy Image,
    // Image Info, More. Rarely used items live under More.
    chrome.contextMenus.create({ id: M.rootImage, title: 'ImgFetch', contexts: img });
    chrome.contextMenus.create({
      id: M.smart, parentId: M.rootImage, title: t('popup_qualitySmart'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.saveAs, parentId: M.rootImage, title: t('menu_saveAs'), contexts: img,
    });
    for (const [id, label] of [
      [M.savePng, 'PNG'],
      [M.saveJpg, 'JPG'],
      [M.saveWebp, 'WebP'],
      [M.saveAvif, 'AVIF'],
      [M.saveGif, 'GIF'],
      [M.saveSvg, t('menu_svgEmbedded')],
      [M.saveBmp, 'BMP'],
    ]) {
      chrome.contextMenus.create({ id, parentId: M.saveAs, title: label, contexts: img });
    }
    chrome.contextMenus.create({
      id: M.sepImage1, type: 'separator', parentId: M.rootImage, contexts: img,
    });
    chrome.contextMenus.create({
      id: M.copyLink, parentId: M.rootImage, title: t('menu_copyLink'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.copyImage, parentId: M.rootImage, title: t('menu_copyImage'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.imageInfo, parentId: M.rootImage, title: t('menu_imageInfo'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.sepImage2, type: 'separator', parentId: M.rootImage, contexts: img,
    });
    chrome.contextMenus.create({
      id: M.more, parentId: M.rootImage, title: t('menu_more'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.openOriginal, parentId: M.more, title: t('menu_openOriginal'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.lensSearch, parentId: M.more, title: t('menu_lens'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.scanPage, parentId: M.more, title: t('menu_scanPage'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.screenshot, parentId: M.more, title: t('menu_screenshot'), contexts: img,
    });
    for (const [id, label] of [
      [M.shotVisible, t('menu_shotVisible')],
      [M.shotArea, t('menu_shotArea')],
      [M.shotElement, t('menu_shotElement')],
      [M.shotFull, t('menu_shotFull')],
    ]) {
      chrome.contextMenus.create({ id, parentId: M.screenshot, title: label, contexts: img });
    }
    chrome.contextMenus.create({
      id: M.addSitePref, parentId: M.more, title: t('menu_addSitePref'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.disableSite, parentId: M.more, title: t('menu_disableSite'), contexts: img,
    });
    chrome.contextMenus.create({
      id: M.openSettings, parentId: M.more, title: t('menu_settings'), contexts: img,
    });

    // ---- Page menu ----
    chrome.contextMenus.create({ id: M.rootPage, title: 'ImgFetch', contexts: page });
    chrome.contextMenus.create({
      id: M.pageScan, parentId: M.rootPage, title: t('menu_scanPage'), contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotVisible, parentId: M.rootPage, title: t('menu_shotVisible'), contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotArea, parentId: M.rootPage, title: t('menu_shotArea'), contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotFull, parentId: M.rootPage, title: t('menu_shotFull'), contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotElement, parentId: M.rootPage, title: t('menu_shotElement'), contexts: page,
    });
  });
}

/** Surface capture errors even when the popup is already closed. */
function shotError(err) {
  const msg = String((err && err.message) || err).slice(0, 200);
  broadcast({ type: 'NOTICE', detail: msg });
  chrome.notifications
    .create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-48.png'), title: 'ImgFetch', message: msg })
    .catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await handleMenuClick(info, tab);
  } catch (err) {
    broadcast({ type: 'NOTICE', code: 'download-failed', detail: String(err && err.message || err).slice(0, 200) });
  }
});

async function handleMenuClick(info, tab) {
  const settings = await getSettings();
  const pageUrl = (tab && tab.url) || '';
  const host = hostOfPageUrl(pageUrl);
  const siteAllowed = [
    MENU_IDS.openSettings,
    MENU_IDS.addSitePref,
    MENU_IDS.disableSite,
  ];
  // H8: paused sites are honored here; the settings/site menus stay
  // available so the user can re-enable the site.
  try {
    assertSiteAllowed(settings, pageUrl);
  } catch {
    if (!siteAllowed.includes(info.menuItemId)) {
      broadcast({ type: 'NOTICE', code: 'disabled-site' });
      return;
    }
  }

  const enqueueOne = (srcUrl, mode, format) => {
    const effMode = resolveDownloadMode(settings, pageUrl, mode); // H8
    // "Ask for filename", open the rename sheet instead of downloading.
    if (settings.askFilename) {
      const q = new URLSearchParams({
        src: srcUrl || '',
        mode: effMode,
        format: format || 'as-is',
        pageUrl: pageUrl || '',
        tabId: tab && typeof tab.id === 'number' ? String(tab.id) : '',
      });
      chrome.tabs.create({ url: chrome.runtime.getURL(`pages/rename.html?${q.toString()}`) });
      return;
    }
    prepareQueue(settings);
    queue.enqueue([{
      id: `m-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      label: filenameHintFromUrl(srcUrl) || 'image',
      payload: {
        srcUrl, mode: effMode, format, pageUrl,
        pageTitle: (tab && tab.title) || '',
        tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        kind: 'single',
      },
    }]);
    broadcast({ type: 'NOTICE', code: 'queued' });
    // Show the popup with the download progress (best-effort: needs a user
    // gesture and Chrome 127+; silently ignored otherwise).
    try { chrome.action.openPopup().catch(() => {}); } catch { /* old Chrome; ignore */ }
  };



  switch (info.menuItemId) {
    case MENU_IDS.smart:
      enqueueOne(info.srcUrl, 'smart', 'as-is');
      break;
    case MENU_IDS.savePng:
      enqueueOne(info.srcUrl, 'smart', 'png');
      break;
    case MENU_IDS.saveJpg:
      enqueueOne(info.srcUrl, 'smart', 'jpg');
      break;
    case MENU_IDS.saveWebp:
      enqueueOne(info.srcUrl, 'smart', 'webp');
      break;
    case MENU_IDS.saveAvif:
      enqueueOne(info.srcUrl, 'smart', 'avif');
      break;
    case MENU_IDS.saveGif:
      enqueueOne(info.srcUrl, 'smart', 'gif');
      break;
    case MENU_IDS.saveSvg:
      enqueueOne(info.srcUrl, 'smart', 'svg');
      break;
    case MENU_IDS.saveBmp:
      enqueueOne(info.srcUrl, 'smart', 'bmp');
      break;
    case MENU_IDS.openOriginal: {
      const ranked = await findRankedSourcesCached(info.srcUrl, pageUrl, tab && typeof tab.id === 'number' ? tab.id : null);
      const target = normalizeUrl((ranked[0] && ranked[0].url) || info.srcUrl, pageUrl);
      if (target) chrome.tabs.create({ url: target });
      break;
    }
    case MENU_IDS.imageInfo: {
      const src = encodeURIComponent(info.srcUrl || '');
      const tabParam = tab && typeof tab.id === 'number' ? `&tabId=${tab.id}` : '';
      const pageParam = pageUrl ? `&pageUrl=${encodeURIComponent(pageUrl)}` : '';
      chrome.tabs.create({ url: chrome.runtime.getURL(`pages/info.html?src=${src}${tabParam}${pageParam}`) });
      break;
    }
    case MENU_IDS.copyLink: {
      // Copy Image Link: the image URL as plain text ONLY. Never opens a
      // tab, never navigates the page, never copies image data. Kept
      // strictly separate from Copy Image (which copies the bitmap).
      const tabId = tab && typeof tab.id === 'number' ? tab.id : -1;
      // 1-2. Best URL from the actual element (currentSrc first), else the
      // menu's own srcUrl as the validated fallback.
      let raw = null;
      const desc = await readImageDescriptor(tabId, info.srcUrl);
      if (desc) raw = pickBestImageUrl(desc);
      const url = normalizeUrl(raw || '', pageUrl) || normalizeUrl(info.srcUrl, pageUrl);
      if (!url) {
        await showPageToast(tabId, t('sw_copyLinkFailed'), true);
        broadcast({ type: 'NOTICE_TEXT', text: t('sw_copyLinkFailed') });
        break;
      }
      // 3. Clipboard: in-page first (the menu click's user activation makes
      // this the reliable path), offscreen document as backup.
      let copied = await copyLinkTextInPage(tabId, url);
      if (!copied) {
        try {
          const res = await offscreenCall({ type: 'CLIPBOARD_WRITE', text: url });
          copied = !!(res && res.ok);
        } catch (err) {
          console.debug('[imgfetch] copy-link failed:', err);
          copied = false;
        }
      }
      if (copied) {
        await showPageToast(tabId, t('notice_copiedLink'), false);
        broadcast({ type: 'NOTICE', code: 'copied' });
      } else {
        await showPageToast(tabId, t('sw_copyLinkFailed'), true);
        broadcast({ type: 'NOTICE_TEXT', text: t('sw_copyLinkFailed') });
      }
      break;
    }
    case MENU_IDS.copyImage: {
      const url = normalizeUrl(info.srcUrl, pageUrl);
      if (!url) {
        broadcast({ type: 'NOTICE', code: 'bad-url' });
        break;
      }
      try {
        checkPublicFetch(url, pageUrl); // M7
      } catch (err) {
        broadcast({ type: 'NOTICE_TEXT', text: err.message });
        break;
      }
      // Fallback chain: (1) offscreen copy, (2) in-page copy, the page
      // owns blob: URLs and sends its own referrer/cookies, fixing hotlink-
      // protected and page-blob images, (3) copy the link as text so the
      // clipboard never ends up empty.
      try {
        const res = await offscreenCall({ type: 'CLIPBOARD_IMAGE', srcUrl: url, pageUrl });
        if (!res || !res.ok) throw new Error('copy-failed');
        broadcast({ type: 'NOTICE', code: 'copied' });
      } catch {
        let done = false;
        try {
          done = await copyImageInPage(tab && tab.id, url);
        } catch {
          done = false;
        }
        if (done) {
          broadcast({ type: 'NOTICE', code: 'copied' });
          break;
        }
        try {
          const res = await offscreenCall({ type: 'CLIPBOARD_WRITE', text: url });
          if (res && res.ok) {
            broadcast({
              type: 'NOTICE_TEXT',
              text: t('sw_linkCopiedInstead'),
            });
          } else {
            broadcast({ type: 'NOTICE', code: 'copy-failed' });
          }
        } catch {
          broadcast({ type: 'NOTICE', code: 'copy-failed' });
        }
      }
      break;
    }
    case MENU_IDS.lensSearch: {
      const url = normalizeUrl(info.srcUrl, pageUrl);
      if (!url) {
        broadcast({ type: 'NOTICE', code: 'bad-url' });
        break;
      }
      // J1 safety guard: never send page-local or private-network URLs to Google.
      const blocked = lensUrlBlocked(url, pageUrl);
      if (blocked) {
        broadcast({ type: 'NOTICE', code: blocked });
        break;
      }
      // Direct Lens search: uploadbyurl redirects straight into results.
      openLensWithUrl(url).catch(() => {
        broadcast({ type: 'NOTICE', code: 'lens-failed' });
      });
      break;
    }
    case MENU_IDS.openSettings:
      chrome.runtime.openOptionsPage();
      break;
    case MENU_IDS.scanPage:
    case MENU_IDS.pageScan:
      if (tab && typeof tab.id === 'number') {
        scanPage(tab.id).catch((err) => broadcast({ type: 'NOTICE', detail: String(err.message || err).slice(0, 200) }));
        // Best-effort: openPopup needs a user gesture and can be denied; the
        // requested action itself already ran or surfaced its own notice.
        chrome.action.openPopup().catch(() => {});
      }
      break;
    case MENU_IDS.shotVisible:
    case MENU_IDS.pageShotVisible:
      captureVisible().catch(shotError);
      break;
    case MENU_IDS.shotArea:
    case MENU_IDS.pageShotArea:
      captureArea().catch(shotError);
      break;
    case MENU_IDS.shotFull:
    case MENU_IDS.pageShotFull:
      captureFullPage().catch(shotError);
      break;
    case MENU_IDS.shotElement:
    case MENU_IDS.pageShotElement:
      captureElement().catch(shotError);
      break;
    case MENU_IDS.addSitePref: {
      if (!host) {
        broadcast({ type: 'NOTICE', code: 'no-tab' });
        break;
      }
      const s = await getSettings();
      if (!s.sitePrefs[host]) s.sitePrefs[host] = 'smart';
      await saveSettings(s);
      broadcast({ type: 'NOTICE_TEXT', text: t('sw_siteAdded', { host }) });
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#sites') });
      break;
    }
    case MENU_IDS.disableSite: {
      if (!host) {
        broadcast({ type: 'NOTICE', code: 'no-tab' });
        break;
      }
      const s = await getSettings();
      s.sitePrefs[host] = 'disabled';
      await saveSettings(s);
      broadcast({ type: 'NOTICE_TEXT', text: t('sw_sitePaused', { host }) });
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen document messages are handled by the offscreen page itself;
  // never route or answer them here (answering 'invalid-message' could win
  // a response race against the offscreen's real handler).
  if (msg && msg.target === 'offscreen') return false;
  if (!isValidMessage(msg)) {
    sendResponse({ ok: false, error: 'invalid-message' });
    return false;
  }
  // M6: only accept messages from our own extension, and only the message
  // types each sender kind is allowed to send. Fail closed.
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'foreign-sender' });
    return false;
  }

  // M6: only accept messages from our own extension, and only the message
  // types each sender kind is allowed to send. Fail closed.
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'foreign-sender' });
    return false;
  }
  const kind = senderKind(sender);
  const allowed = SENDER_RULES[msg.type];
  if (!allowed || !allowed.includes(kind)) {
    sendResponse({ ok: false, error: 'forbidden' });
    return false;
  }
  (async () => {
    try {
      const result = await routeMessage(msg, kind, sender);
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
  })();
  return true; // async response
});

async function routeMessage(msg, kind, sender) {
  // B: never surface a raw message key; wait for the locale first.
  await i18nReady;
  const settings = await getSettings();
  switch (msg.type) {
    case 'GET_SETTINGS':
      return { settings };

    case 'SAVE_SETTINGS': {
      if (kind !== 'extension') throw new Error('forbidden');
      const next = await saveSettings(msg.settings || {});
      return { settings: next };
    }

    case 'RESET_SETTINGS': {
      if (kind !== 'extension') throw new Error('forbidden');
      const next = await saveSettings({ ...DEFAULT_SETTINGS });
      return { settings: next };
    }

    case 'SCAN_PAGE': {
      const tab = await activeTab();
      if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));
      assertSiteAllowed(settings, tab.url); // H8: paused sites block scanning too
      // Shared inflight lock: racing the global shortcut never double-scans.
      const scan = await requestScan(tab.id);
      return { scan };
    }

    case 'GET_SCAN_STATE': {
      const tab = await activeTab();
      const scanState = await getScanState();
      return {
        state: scanState,
        forCurrentTab: !!(tab && scanState.tabId === tab.id),
      };
    }

    case 'GET_LAST_SCAN': {
      const stored = await chrome.storage.session.get(LAST_SCAN_KEY);
      const tab = await activeTab();
      const last = stored[LAST_SCAN_KEY];
      const fresh = last && tab && last.tabId === tab.id && last.url === tab.url
        && Date.now() - last.at < 5 * 60 * 1000;
      return { scan: fresh ? last : null };
    }

    case 'SUGGEST_FILENAME': {
      const srcUrl = normalizeUrl(msg.srcUrl, msg.pageUrl);
      const ext = msg.format && msg.format !== 'as-is'
        ? normalizeExportFormat(msg.format)
        : (getExtensionFromUrl(srcUrl) || 'png');
      const name = buildFilename(settings.filenameMode, {
        site: getHostLabel(msg.pageUrl || srcUrl),
        name: filenameHintFromUrl(srcUrl) || 'image',
        ext,
        date: new Date(),
        num: await peekFileNumber(),
        width: 0,
        height: 0,
        custom: settings.customTemplate,
      });
      return { name };
    }

    case 'DOWNLOAD_IMAGE': {
      // H6: prefer the originating context's page/tab (rename and info
      // pages are extension tabs, activeTab() would point at them).
      const explicitTabId = Number.parseInt(msg.tabId, 10);
      const tab = Number.isInteger(explicitTabId) && explicitTabId >= 0
        ? await chrome.tabs.get(explicitTabId).catch(() => null)
        : await activeTab();
      const pageUrl = typeof msg.pageUrl === 'string' && msg.pageUrl
        ? msg.pageUrl
        : (tab && tab.url) || '';
      prepareQueue(settings);
      queue.enqueue([{
        id: msg.id || `d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        label: filenameHintFromUrl(msg.srcUrl) || 'image',
        payload: singleItemPayload(msg, {
          mode: resolveDownloadMode(settings, pageUrl, msg.mode), // H8
          pageUrl,
          pageTitle: (tab && tab.title) || '',
          tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        }),
      }]);
      return { queued: true };
    }

    case 'DOWNLOAD_ZIP': {
      const tab = await activeTab();
      const pageUrl = (tab && tab.url) || '';
      assertSiteAllowed(settings, pageUrl); // H8
      const files = Array.isArray(msg.files) ? msg.files.slice(0, 200) : [];
      if (!files.length) return { queued: 0 };
      prepareQueue(settings);
      queue.enqueue([{
        id: msg.id || `z-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        label: `ZIP (${files.length} images, as shown)`,
        payload: {
          kind: 'zip',
          files,
          pageUrl,
          tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        },
      }]);
      broadcast({ type: 'NOTICE', code: 'queued' });
      return { queued: 1 };
    }

    case 'DOWNLOAD_STRIPPED': {
      // L9: re-encoded copy with all metadata (EXIF/GPS) removed.
      const srcUrl = String(msg.url || '');
      if (!/^https?:\/\//i.test(srcUrl) && !srcUrl.startsWith('data:image/')) {
        throw new Error(friendlyError('bad-url'));
      }
      checkPublicFetch(srcUrl, msg.pageUrl); // M7/B2: same gate as downloads
      const stripped = await offscreenCall({ type: 'STRIP_METADATA', srcUrl, pageUrl: msg.pageUrl });
      if (!stripped || !stripped.ok || !stripped.dataUrl) {
        throw new Error(friendlyError('convert-failed'));
      }
      const ext = String(stripped.format || 'png').toLowerCase();
      const stem = sanitizeSegment(filenameHintFromUrl(srcUrl)).replace(/\.[a-z0-9]{2,4}$/i, '') || 'image';
      const filename = `${stem}-clean.${ext}`;
      const folder = resolveFolder(settings, msg.pageUrl || '', srcUrl, ext);
      const path = joinDownloadPath(folder, filename);
      const downloadId = await saveToDownloads({ url: stripped.dataUrl, path, saveAs: settings.saveAsDialog });
      if (downloadId == null) throw new Error(friendlyError('download-failed'));
      await recordHistory({
        filename: path.split('/').pop(),
        url: srcUrl,
        pageUrl: msg.pageUrl || '',
        width: stripped.width || 0,
        height: stripped.height || 0,
        bytes: await downloadFileSize(downloadId),
        format: ext,
      });
      return { ok: true };
    }

    case 'DOWNLOAD_MANY': {
      const tab = await activeTab();
      const pageUrl = (tab && tab.url) || '';
      const list = Array.isArray(msg.items) ? msg.items.slice(0, 500) : [];
      prepareQueue(settings);
      queue.enqueue(list.map((it, i) => ({
        id: it.id || `b-${Date.now()}-${i}`,
        label: filenameHintFromUrl(it.srcUrl) || `image-${i + 1}`,
        payload: bulkItemPayload(it, {
          mode: resolveDownloadMode(settings, pageUrl, it.mode), // H8
          format: it.format,
          pageUrl,
          pageTitle: (tab && tab.title) || '',
          tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        }),
      })));
      return { queued: list.length };
    }

    case 'GET_QUEUE':
      return { snapshot: queue.snapshot() };
    case 'RETRY_QUEUE':
      return { snapshot: queue.retryFailed() };
    case 'CANCEL_QUEUE': {
      // L10: cancel honestly, active chrome.downloads are cancelled too,
      // not just pending queue items.
      const snap = queue.snapshot();
      const activeIds = (snap.items || [])
        .filter((it) => it.state === 'active' && it.chromeDownloadId != null)
        .map((it) => it.chromeDownloadId);
      // Best-effort per download: an id may already be finished/gone; the
      // queue item is marked cancelled regardless.
      await Promise.all(activeIds.map((id) => chrome.downloads.cancel(id).catch(() => {})));
      return { snapshot: queue.cancel() };
    }
    case 'CLEAR_QUEUE':
      return { snapshot: queue.clearFinished() };

    case 'GET_HISTORY': {
      const stored = await chrome.storage.local.get(HISTORY_KEY);
      return { records: stored[HISTORY_KEY] || [] };
    }
    case 'CLEAR_HISTORY': {
      if (kind !== 'extension') throw new Error('forbidden');
      await chrome.storage.local.set({ [HISTORY_KEY]: [] });
      return { cleared: true };
    }

    case 'CAPTURE_VISIBLE':
      return captureVisible();
    case 'CAPTURE_AREA':
      return captureArea().catch((err) => { shotError(err); throw err; });
    case 'CAPTURE_ELEMENT':
      return captureElement().catch((err) => { shotError(err); throw err; });
    case 'CAPTURE_FULL':
      return captureFullPage();
    case 'CANCEL_CAPTURE':
      // FIX 4.5: cancel an in-flight full-page capture. Safe: the
      // capture's finally still restores the page and releases the
      // offscreen canvas; completed parts stay as real results.
      fullCaptureCancel = true;
      return { cancelled: true };
    case 'SAVE_CAPTURE':
      if (kind !== 'extension') throw new Error('forbidden');
      return saveCapture(String(msg.id || ''));

    case 'DISCARD_CAPTURE_GROUP':
      if (kind !== 'extension') throw new Error('forbidden');
      return discardCaptureGroup(String(msg.groupId || ''));

    case 'DISCARD_CAPTURE':
      if (kind !== 'extension') throw new Error('forbidden');
      return discardCapture(String(msg.id || ''), String(msg.groupId || ''));

    case 'SAVE_ANNOTATED': {
      if (kind !== 'extension') throw new Error('forbidden');
      const capId = String(msg.id || '');
      const dataUrl = String(msg.dataUrl || '');
      if (!capId || !dataUrl.startsWith('data:image/png')) throw new Error('bad-input');
      if (dataUrl.length > 40_000_000) throw new Error('too-large');
      const cap = await recallCapture(capId);
      if (!cap) throw new Error(friendlyError('capture-failed'));
      // Swap in the annotated image, then save through the normal path.
      // A blob-stored part keeps no stale Blob next to the new dataUrl.
      const { blob: _oldBlob, blobStored: _oldFlag, ...rest } = cap;
      await rememberCapture(capId, { ...rest, dataUrl });
      return saveCapture(capId);
    }

    case 'GET_CAPTURE_PROGRESS':
      // Round 5: a popup that opens mid-capture asks for the last
      // progress so it can show the live status row at once.
      return { progress: lastCaptureProgress };
    case 'GET_CAPTURE': {
      const cap = await recallCapture(String(msg.id || ''));
      if (!cap) throw new Error(friendlyError('capture-failed'));
      // FIX 4.2: parts of a split capture carry their "Part i of N"
      // numbering for the result/annotate flow. Round 4: pages read
      // blob records straight from IndexedDB (shared/capture-io.js);
      // this message fallback converts the Blob so legacy callers
      // still receive a usable dataUrl.
      let dataUrl = cap.dataUrl || null;
      if (!dataUrl && cap.blob) dataUrl = await blobToDataUrl(cap.blob);
      return {
        dataUrl,
        width: cap.width,
        height: cap.height,
        partIndex: cap.partIndex || 0,
        partTotal: cap.partTotal || 0,
        groupId: cap.groupId || '',
      };
    }

    case 'GET_IMAGE_INFO': {
      // The info page itself becomes the active tab when it loads, so prefer
      // the source tab id passed in the page URL; fall back to active tab.
      let tab = null;
      const requested = Number(msg.tabId);
      if (Number.isInteger(requested) && requested >= 0) {
        tab = await chrome.tabs.get(requested).catch(() => null);
      }
      if (!isScannableTab(tab)) tab = await activeTab();
      if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));
      const info = await runInPage(tab.id, (src) => {
        const api = window.__imgfetch;
        if (!api || typeof api.getImageInfo !== 'function') return null;
        return api.getImageInfo(src);
      }, [String(msg.srcUrl || '')]);
      if (!info) throw new Error(friendlyError('not-image'));
      return { info };
    }

    case 'RESOLVE_BLOB': {
      // Popup thumbnails / previews for page blob: URLs: fetch in-page and
      // return a data URL the popup can render. mode 'full' returns the
      // original bytes; anything else returns a light JPEG preview.
      const tabId = Number(msg.tabId);
      if (!Number.isInteger(tabId)) throw new Error(friendlyError('bad-url'));
      const full = String(msg.mode || '') === 'full';
      const dataUrl = await resolveBlobUrl(tabId, String(msg.url || ''), { thumb: !full });
      if (!dataUrl) throw new Error(friendlyError('blocked'));
      return { dataUrl };
    }

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return {};

    case 'SHOW_DOWNLOAD': {
      // B6: reveal a finished download in the file manager.
      const downloadId = Number(msg.downloadId);
      if (!Number.isInteger(downloadId) || downloadId < 0) {
        throw new Error(friendlyError('bad-url'));
      }
      chrome.downloads.show(downloadId);
      return {};
    }

    case 'GET_FORMAT_SUPPORT':
      return { avif: await supportsAvif() };

    case 'SCAN_PROGRESS':
      // Progress is consumed directly by the popup's own message listener.
      return {};

    default:
      throw new Error('unknown-message');
  }
}

let avifSupport = null;
async function supportsAvif() {
  if (avifSupport !== null) return avifSupport;
  // J3: cache only a definite answer. A failed probe (offscreen not ready,
  // transient error) is inconclusive, do not cache it as false for the
  // whole session; retry on the next call.
  try {
    const res = await offscreenCall({ type: 'SUPPORTS_AVIF' });
    if (res && typeof res.ok === 'boolean') avifSupport = res.ok;
  } catch {
    /* inconclusive, leave uncached so the next call retries */
  }
  return avifSupport === true;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * The global Scan shortcut is a real command, not a popup opener:
 * validate the active tab -> start the scan -> open the popup on top of
 * the live SCANNING state. The scan is NOT awaited here: the popup opens
 * immediately and flips to RESULTS by itself. Restricted pages
 * (chrome://, edge://, web store, PDFs) and paused sites get a useful
 * error instead of silence or a crash.
 */
async function handleScanCommand() {
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id) || !isScannableTab(tab)) {
    notifyScanIssue(t('sw_scanOffLimits'));
    return;
  }
  try {
    assertSiteAllowed(await getSettings(), tab.url); // H8: paused sites block the shortcut too
  } catch {
    notifyScanIssue(t('notice_disabledSiteSeePrefs'));
    return;
  }
  requestScan(tab.id).catch((err) => {
    notifyScanIssue(String((err && err.message) || err).slice(0, 200));
  });
  // Best-effort: openPopup needs a user gesture and can be denied; the
  // requested action itself already ran or surfaced its own notice.
  chrome.action.openPopup().catch(() => {});
}

/** Surface scan-command problems even when the popup is closed. */
function notifyScanIssue(message) {
  broadcast({ type: 'NOTICE_TEXT', text: message });
  chrome.notifications
    .create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-48.png'), title: 'ImgFetch', message })
    .catch(() => {});
}

/**
 * Select Element (Alt+Shift+E): pick any element on the page and show its
 * image details. Image → Image Info page; image container → its largest
 * image; anything else → a graceful "no image" note. Never reads form
 * values or page content, only image attributes.
 */
async function handleSelectElement() {
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id) || !isScannableTab(tab)) {
    notifyScanIssue(t('sw_pickOffLimits'));
    return;
  }
  try {
    assertSiteAllowed(await getSettings(), tab.url); // H8: paused sites block it too
  } catch {
    notifyScanIssue(t('notice_disabledSiteSeePrefs'));
    return;
  }
  const pageUrl = tab.url || '';
  let picked = null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/overlay.js'],
    });
    const hints = await overlayHints();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: (hints) => window.__imgfetch.pickElement(hints),
      args: [hints],
    });
    picked = (res && res.result) || null;
  } catch (err) {
    console.debug('[imgfetch] select-element failed:', err);
    picked = null;
  }
  if (!picked) return; // Esc / cancelled, silent, like the area selector
  let url = null;
  if (picked.descriptor) {
    url = normalizeUrl(pickBestImageUrl(picked.descriptor) || '', pageUrl);
  } else if (picked.backgroundUrl) {
    url = normalizeUrl(picked.backgroundUrl, pageUrl);
  }
  if (!url) {
    await showPageToast(tab.id, t('sw_noImageInElement'), true);
    return;
  }
  const src = encodeURIComponent(url);
  chrome.tabs.create({
    url: chrome.runtime.getURL(
      `pages/info.html?src=${src}&tabId=${tab.id}&pageUrl=${encodeURIComponent(pageUrl)}`,
    ),
  }).catch((err) => console.debug('[imgfetch] select-element: could not open info tab:', err));
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'imgfetch-scan-page' || command === 'imgfetch-scan-page-alt') {
      await handleScanCommand();
    } else if (command === 'imgfetch-select-element') {
      await handleSelectElement();
    } else if (command === 'imgfetch-capture-area') {
      await captureArea();
    } else if (command === 'imgfetch-capture-element') {
      await captureElement();
    }
  } catch (err) {
    broadcast({ type: 'NOTICE', detail: String(err.message || err).slice(0, 200) });
  }
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await getSettings(); // writes defaults on first run
  buildMenus();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
});

// H5: every worker start (install, browser start, or restart after being
// killed idle) reconciles the persisted queue with real download state.
restoreQueueState().catch(() => {
  /* never break worker startup */
});

// B: friendly codes used with NOTICE broadcasts, resolved through the
// loaded locale. t() is sync; the worker may still be loading the
// locale when the first NOTICE arrives, so resolve after i18nReady.
function noticeTextFor(code) {
  if (code === 'queued') return t('notice_queued');
  if (code === 'copied') return t('notice_copiedLink');
  if (code === 'disabled-site') return t('notice_disabledSiteSeePrefs');
  return null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'NOTICE' && msg.code) {
    // Re-broadcast resolved text for surfaces that want plain strings.
    i18nReady.then(() => {
      const text = noticeTextFor(msg.code);
      if (text) broadcast({ type: 'NOTICE_TEXT', text });
    });
  }
  return false;
});
