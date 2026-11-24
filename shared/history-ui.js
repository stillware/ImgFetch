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
 * ImgFetch, shared/history-ui.js
 * The one shared download-history row design, used by the popup history
 * screen and by the Download History section of the options page.
 *
 * A row is a 40 px tile (a real 120 px thumbnail when the record has a
 * valid one, else the neutral kind icon), the filename without its final
 * image extension plus its format badge, one muted subtext line, and on
 * the right the file size, which gives way to three icon buttons on row
 * hover and on keyboard focus-within. No innerHTML anywhere: every node
 * is built with createElement and textContent, and a thumbnail is only
 * ever assigned to img.src after sanitizeHistoryThumb accepts it.
 *
 * Callers pass `deps`: { t, formatSize, showDownload, toast,
 * showThumbnails }. `t` is the page's i18n function, `formatSize`
 * formats the record size (ImgFetchUI.formatHistorySize), `showDownload`
 * reveals a download by id (a UI.send('SHOW_DOWNLOAD') wrapper),
 * `toast` shows a message, and `showThumbnails` (default true) hides
 * the thumbnail tile when false without deleting any stored thumbnail.
 *
 * Buttons: Open opens the downloaded file in the system default app
 * (B2, needs the optional downloads.open permission, requested from the
 * click). The open itself runs in this page, not in the worker: the
 * downloads.open API needs the click's user gesture, and the worker
 * round-trip loses it (proven live: the worker call fails with "User
 * gesture required"). Copy copies the image itself as image/png (B3, fetched once
 * from the record URL and re-encoded through a canvas when it is not
 * PNG). The source link action is gone: the source URL stays visible as
 * a tooltip on the title and in the row subtext.
 */
import {
  stripImageExtension, sanitizeHistoryThumb, decideOpenFile, copyImageAvailable,
  fetchImageBytes, HIST_THUMB_FETCH_TIMEOUT_MS, HIST_THUMB_SOURCE_MAX_BYTES,
} from '../core/history.js';
import { formatGroup } from '../core/filters.js';

/** Chip and thumbnail labels: WebP keeps its mixed case, the rest are caps. */
export const HISTORY_FORMAT_LABELS = { png: 'PNG', jpg: 'JPG', webp: 'WebP', gif: 'GIF', avif: 'AVIF' };
/**
 * History format badge classes per format group. PNG, JPG, GIF and AVIF
 * reuse the existing badge tints (accent, warn, ok, accent); WebP uses a
 * translucent cyan tint (see .hist-fmt-webp). Unknown and other formats
 * get no badge. These are the only badge styles: do not change them.
 */
export const HISTORY_FORMAT_BADGE_CLASS = {
  png: 'badge badge-accent hist-fmt',
  jpg: 'badge badge-warn hist-fmt',
  webp: 'badge hist-fmt hist-fmt-webp',
  gif: 'badge badge-ok hist-fmt',
  avif: 'badge badge-accent hist-fmt',
};

/** Sprite path, relative to the popup and options pages (both one level deep). */
const SPRITE_URL = '../shared/assets/lucide-sprite.svg';

/** Lucide icon from the bundled sprite, as an inline <svg><use>. */
function rowIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon icon-16');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${SPRITE_URL}#${name}`);
  svg.appendChild(use);
  return svg;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * Relative time for a history record: "Just now", "N min ago", "N h ago",
 * "Yesterday", otherwise a short date. Every value comes from the
 * record's own `at` field.
 */
export function formatHistoryTime(at, t) {
  const stamp = Number(at) || 0;
  const age = Date.now() - stamp;
  if (!stamp || age < 60000) return t('history_timeNow');
  const mins = Math.floor(age / 60000);
  if (mins < 60) return t('history_timeMinutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('history_timeHours', { count: hours });
  const day = new Date(stamp);
  const yesterday = new Date(Date.now() - 86400000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(day, yesterday)) return t('history_timeYesterday');
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Group count with its word, correctly pluralized: "79 files", "1 file". */
export function historyCountLabel(count, t) {
  return t('history_files', { count });
}

/** One-line subtext: "domain.com · 2 min ago", or "Screenshot · 2 h ago". */
export function historySubtext(record, t) {
  const time = formatHistoryTime(record.at, t);
  if (record.kind === 'screenshot') return `${t('menu_screenshot')} · ${time}`;
  const site = record.pageHost || record.site || '';
  return site ? `${site} · ${time}` : time;
}

/**
 * The chrome.permissions API, or null when the browser has none. The
 * grant is stored by the browser, so if the popup closes while the
 * permission prompt is up, the next click simply finds the permission
 * already granted and opens the file.
 */
function downloadsOpenApi() {
  try {
    const api = (typeof chrome !== 'undefined' && chrome.permissions) || null;
    if (!api || typeof api.contains !== 'function') return null;
    return api;
  } catch {
    return null;
  }
}

/** True when the optional downloads.open permission is already held. */
async function hasDownloadsOpenPermission() {
  const api = downloadsOpenApi();
  if (!api) return false;
  try {
    return (await api.contains({ permissions: ['downloads.open'] })) === true;
  } catch {
    return false;
  }
}

/**
 * Ask for the optional downloads.open permission. Must be called from
 * the click handler (a user gesture). Returns true only when the
 * browser reports the grant.
 */
async function requestDownloadsOpenPermission() {
  const api = downloadsOpenApi();
  if (!api || typeof api.request !== 'function') return false;
  try {
    return (await api.request({ permissions: ['downloads.open'] })) === true;
  } catch {
    return false;
  }
}

/** The downloads API in this page (chrome.* on Chrome, browser.* on Firefox). */
function downloadsApi() {
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads) return chrome.downloads;
    if (typeof browser !== 'undefined' && browser.downloads) return browser.downloads;
  } catch {
    /* no downloads API in this context */
  }
  return null;
}

/**
 * Open a finished download in the system default app, from this page so
 * the click's user gesture still applies. Throws 'open-unavailable'
 * when the browser has no downloads.open API, 'file-not-found' when the
 * download no longer exists, and 'open-failed' when the file exists but
 * could not be opened (most commonly the gesture expired while the
 * permission prompt was up). The caller must never report 'open-failed'
 * as a missing file: it falls back to showing the file in its folder.
 */
async function openDownloadFile(dlId) {
  const dl = downloadsApi();
  if (!dl || typeof dl.open !== 'function') throw new Error('open-unavailable');
  let found = null;
  try {
    found = await dl.search({ id: dlId });
  } catch {
    found = null;
  }
  if (!found || !found.length) throw new Error('file-not-found');
  try {
    await dl.open(dlId);
  } catch {
    throw new Error('open-failed');
  }
}

/**
 * Start a clipboard write for one PNG source, synchronously inside the
 * click's user gesture, with a promise-backed ClipboardItem (same shape
 * as shared/copy-shot.js startClipboardWrite), so the fetch and encode
 * can finish after the gesture without losing it.
 */
function writePngToClipboard(pngPromise) {
  Promise.resolve(pngPromise).catch(() => {});
  if (typeof ClipboardItem === 'undefined') throw new Error('ClipboardItem unavailable');
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || !nav.clipboard || typeof nav.clipboard.write !== 'function') {
    throw new Error('clipboard write unavailable');
  }
  return nav.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
}

/**
 * Decode fetched image bytes to a PNG Blob. A PNG source is copied byte
 * for byte; anything else is decoded and re-encoded through a canvas,
 * which also means an animated GIF copies its first frame. Throws on
 * any failure; the caller shows the quiet failure message.
 */
async function imageBytesToPng(bytes, mime) {
  const type = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  const blob = new Blob([bytes], { type: type.startsWith('image/') ? type : 'image/png' });
  if (blob.type === 'image/png') return blob;
  if (typeof createImageBitmap !== 'function') throw new Error('decode unavailable');
  const bitmap = await createImageBitmap(blob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (!(w > 0 && h > 0) || w > 8000 || h > 8000 || w * h > 32_000_000) {
      throw new Error('image too large');
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png');
      } catch (err) {
        reject(err);
      }
    });
    return png;
  } finally {
    try { bitmap.close(); } catch { /* already closed */ }
  }
}

/**
 * G2: a thumbnail fades in over 150 ms once it has loaded (the shared
 * .hist-thumb rule starts it at opacity 0, .is-loaded brings it to 1).
 * No pop, no layout shift: the tile keeps its size throughout. A cached
 * thumbnail may already be complete when src is set, so check that too.
 */
function revealThumb(img) {
  const show = () => img.classList.add('is-loaded');
  try {
    if (img.complete && img.naturalWidth > 0) { show(); return; }
  } catch { /* a DOM stub without complete; the load listener covers it */ }
  img.addEventListener('load', show);
}

/**
 * Update one rendered row with a thumbnail that arrived after the row
 * was painted (B1 backfill). Returns true when the tile was updated.
 */
export function updateHistoryRowThumb(row, thumb) {
  if (!row || typeof row.querySelector !== 'function') return false;
  const clean = sanitizeHistoryThumb(thumb);
  if (!clean) return false;
  const tile = row.querySelector('.hist-tile');
  if (!tile) return false;
  const old = tile.querySelector('.hist-thumb');
  if (old) old.remove();
  const img = document.createElement('img');
  img.className = 'hist-thumb';
  img.alt = '';
  img.draggable = false;
  img.width = 40;
  img.height = 40;
  img.addEventListener('error', () => img.remove());
  img.src = clean;
  revealThumb(img);
  tile.append(img);
  return true;
}

/**
 * One history row. The thumbnail image sits on top of the kind icon in
 * the tile; if it fails to load it is removed and the icon shows.
 * Buttons are only rendered when they can act: Open and Show in folder
 * need a download id, Copy needs a retrievable source URL (B3 hides it
 * for screenshots without a URL and for data: downloads).
 */
export function buildHistoryRow(record, deps) {
  const r = record || {};
  const { t } = deps;
  const row = el('div', null, 'hist-item');
  if (r.id) row.dataset.recordId = r.id;
  const kindIcon = r.kind === 'bulk' ? 'images' : r.kind === 'screenshot' ? 'camera' : 'image';
  const tile = el('div', null, 'hist-tile');
  tile.append(rowIcon(kindIcon));
  const thumb = sanitizeHistoryThumb(r.thumb);
  if (thumb && deps.showThumbnails !== false) {
    const img = document.createElement('img');
    img.className = 'hist-thumb';
    img.alt = '';
    img.draggable = false;
    img.width = 40;
    img.height = 40;
    img.addEventListener('error', () => img.remove());
    img.src = thumb;
    revealThumb(img);
    tile.append(img);
  }
  const main = el('div', null, 'hist-main');
  const name = el('div', null, 'hist-name');
  // The source URL stays visible as a tooltip on the title (the file
  // name first, so a truncated name is still readable on hover).
  name.title = (typeof r.url === 'string' && r.url)
    ? `${r.filename || ''}
${r.url}` : (r.filename || '');
  name.append(el('span', stripImageExtension(r.filename || t('ui_fallbackName')), 'hist-name-text'));
  const fmt = formatGroup(r.format);
  const fmtClass = HISTORY_FORMAT_BADGE_CLASS[fmt];
  if (fmtClass) name.append(el('span', HISTORY_FORMAT_LABELS[fmt], fmtClass));
  main.append(name, el('div', historySubtext(r, t), 'hist-sub'));
  row.append(tile, main);
  const side = el('div', null, 'hist-side');
  const sizeText = Number(r.bytes) > 0 ? deps.formatSize(r) : '';
  if (sizeText) side.append(el('span', sizeText, 'hist-size'));
  const actions = el('div', null, 'hist-actions');
  if (Number.isInteger(r.dlId)) {
    // B2: Open opens the downloaded FILE in the system default app, not
    // a browser tab. The optional downloads.open permission is requested
    // from this click (a user gesture) the first time; a denied or
    // unavailable permission falls back to showing the file in its
    // folder, quietly.
    const open = el('button', null, 'icon-btn hist-action');
    open.type = 'button';
    open.setAttribute('aria-label', t('history_openFile'));
    open.title = t('history_openFile');
    open.append(rowIcon('file-text'));
    open.addEventListener('click', async (e) => {
      e.stopPropagation();
      const api = downloadsOpenApi();
      const held = api ? await hasDownloadsOpenPermission() : false;
      const dl = downloadsApi();
      let decision = decideOpenFile({
        exists: true,
        permissionHeld: held,
        permissionAvailable: api !== null,
        openSupported: !!dl && typeof dl.open === 'function',
      });
      if (decision === 'request') {
        decision = (await requestDownloadsOpenPermission()) ? 'open' : 'show';
      }
      if (decision === 'open') {
        try {
          await openDownloadFile(r.dlId);
        } catch (err) {
          if (err && err.message === 'file-not-found') {
            deps.toast(t('history_fileNotFound'));
          } else {
            // open-unavailable or open-failed (for example the gesture
            // expired while the prompt was up): the file exists, so show
            // it in its folder instead of claiming it is gone.
            try {
              await deps.showDownload(r.dlId);
              deps.toast(t('history_showInFolderInstead'));
            } catch {
              deps.toast(t('history_fileNotFound'));
            }
          }
        }
        return;
      }
      try {
        await deps.showDownload(r.dlId);
        deps.toast(t('history_showInFolderInstead'));
      } catch {
        deps.toast(t('history_fileNotFound'));
      }
    });
    actions.append(open);
  }
  if (Number.isInteger(r.dlId)) {
    const show = el('button', null, 'icon-btn hist-action');
    show.type = 'button';
    show.setAttribute('aria-label', t('queue_showInFolder'));
    show.title = t('queue_showInFolder');
    show.append(rowIcon('folder-open'));
    show.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await deps.showDownload(r.dlId);
      } catch {
        deps.toast(t('history_fileNotFound'));
      }
    });
    actions.append(show);
  }
  if (copyImageAvailable(r)) {
    // B3: Copy copies the IMAGE as image/png, not the link. The fetch
    // starts inside the click (one request, same safe helper as the
    // thumbnail fetch), the clipboard write is registered synchronously
    // with a promise-backed ClipboardItem, and a non-PNG source is
    // re-encoded through a canvas (an animated GIF copies its first
    // frame). Rows without a retrievable source get no copy button.
    const copy = el('button', null, 'icon-btn hist-action');
    copy.type = 'button';
    copy.setAttribute('aria-label', t('history_copyImage'));
    copy.title = t('history_copyImage');
    copy.append(rowIcon('copy'));
    const tip = el('span', t('history_copied'), 'hist-copied');
    tip.setAttribute('aria-hidden', 'true');
    copy.append(tip);
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      const pngPromise = (async () => {
        // H3: the Copy re-fetch goes through the same guard as the
        // thumbnail fetch (private-network block + redirect re-check),
        // keyed to the page the record came from.
        const fetched = await fetchImageBytes(
          (u, init) => fetch(u, init),
          r.url,
          {
            timeoutMs: HIST_THUMB_FETCH_TIMEOUT_MS,
            maxBytes: HIST_THUMB_SOURCE_MAX_BYTES,
            pageUrl: r.pageHost ? `https://${r.pageHost}/` : '',
          },
        );
        return imageBytesToPng(fetched.bytes, fetched.mime);
      })();
      let written;
      try {
        written = writePngToClipboard(pngPromise);
      } catch {
        deps.toast(t('history_copyImageFailed'));
        return;
      }
      written.then(() => {
        tip.classList.add('is-visible');
        setTimeout(() => tip.classList.remove('is-visible'), 1200);
        deps.toast(t('copySuccess'));
      }).catch(() => {
        deps.toast(t('history_copyImageFailed'));
      });
    });
    actions.append(copy);
  }
  if (actions.childNodes.length) side.append(actions);
  row.append(side);
  return row;
}

/**
 * Two-step Clear history: the first click arms the button in place
 * ("Confirm Clear?" in the danger colour), the second click within
 * 4 seconds clears, otherwise the button reverts. No separate dialog.
 * The button carries aria-live so the change is announced. G2: arming
 * and reverting swap the label with the 150 ms text swap (deps.swapText
 * is UI.swapText; plain textContent when a caller does not pass it),
 * and on confirm the rows fade out together in 150 ms before the list
 * is cleared (deps.list is the list element; without it the clear is
 * immediate). deps: { t, toast, clear, onCleared, list?, swapText? }.
 */
export function wireClearHistory(button, deps) {
  const label = button.querySelector('span') || button;
  const original = label.textContent;
  const swap = typeof deps.swapText === 'function'
    ? deps.swapText
    : (node, text) => { node.textContent = text; };
  let armed = false;
  let timer = null;
  button.setAttribute('aria-live', 'polite');
  const disarm = () => {
    armed = false;
    if (timer) { clearTimeout(timer); timer = null; }
    swap(label, original);
    button.classList.remove('is-confirm');
  };
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      swap(label, deps.t('history_clearConfirmInline'));
      button.classList.add('is-confirm');
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    try {
      // The exit animation finishes before removal, but never blocks
      // the next action: it is 150 ms, and reduced motion skips it.
      let reduce = false;
      try {
        reduce = typeof window !== 'undefined' && !!window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch { /* reduced-motion query unavailable; animate */ }
      if (!reduce && deps.list && typeof deps.list.querySelectorAll === 'function') {
        const rows = deps.list.querySelectorAll('.hist-item');
        if (rows.length) {
          rows.forEach((row) => row.classList.add('motion-fade-out'));
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      await deps.clear();
      deps.onCleared();
      deps.toast(deps.t('history_cleared'));
    } catch (err) {
      deps.toast(err.message);
    }
  });
}
