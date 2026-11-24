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
 * ImgFetch, core/history.js
 * Lightweight download history helpers. Pure functions, plus the
 * history thumbnail maker (runs in the service worker, where
 * createImageBitmap and OffscreenCanvas are available).
 */

import { dataUrlToBlob } from './data-url.js';
import { isPrivateNetworkFetchBlocked, isRedirectBlocked } from './urls.js';
import { stripBidiControls } from './filenames.js';

export const MAX_RECORDS = 200;

/**
 * History thumbnail: a 120x120 px centre cover crop (3x the 40 px tile,
 * so it stays crisp on high-DPI screens).
 */
export const HIST_THUMB_SIZE = 120;
/** Per-thumbnail cap: 12 KB of encoded bytes. */
export const HIST_THUMB_MAX_BYTES = 12_288;
/** Lowest encoder quality tried before a thumbnail is dropped. */
export const HIST_THUMB_MIN_QUALITY = 0.6;
/** Total thumbnail budget across all records: 3 MB, oldest thumbs dropped first. */
export const HIST_THUMB_MAX_TOTAL_BYTES = 3_145_728;
/** Longest source URL kept on a history record. */
export const HIST_URL_MAX_LENGTH = 2048;
/** Largest in-memory image accepted as a thumbnail source. */
export const HIST_THUMB_SOURCE_MAX_BYTES = 25_000_000;
/** One extra request per direct download, at most: 10 s to answer. */
export const HIST_THUMB_FETCH_TIMEOUT_MS = 10_000;
/** Backfill cap: at most 12 thumbnails per history view open. */
export const HIST_THUMB_BACKFILL_MAX = 12;
/** Encoder qualities tried in order when a thumbnail is over the cap. */
const HIST_THUMB_QUALITIES = [0.85, 0.75, 0.65, HIST_THUMB_MIN_QUALITY];
/**
 * H7: the conservative canvas budget (16,384 px per side,
 * 268,435,456 total pixels). One definition, imported by the offscreen
 * document, so the decode caps can never drift apart again.
 */
export const MAX_IMAGE_SIDE_PX = 16384;
export const MAX_IMAGE_PIXELS = 268_435_456;

/** Throw when an image is past the canvas budget above. */
export function assertImagePixelBudget(w, h) {
  if (!(w > 0 && h > 0) || w > MAX_IMAGE_SIDE_PX || h > MAX_IMAGE_SIDE_PX
    || w * h > MAX_IMAGE_PIXELS) {
    throw new Error('too-large');
  }
}

/**
 * A serial promise queue: enqueue(fn) runs fn only after every earlier
 * enqueued fn has settled, one at a time, in enqueue order. A rejection
 * is reported to that caller only and never breaks the chain, so later
 * work still runs. Used for the single history writer (D4) and for the
 * thumbnail fetch queue (B1).
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(fn) {
      const run = tail.then(() => fn());
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/**
 * Backfill targets for one history view open: records that have a
 * source URL and no thumbnail yet, newest first, at most `max`
 * (default HIST_THUMB_BACKFILL_MAX). Records without a URL are skipped.
 * Input order is newest first, so the filter keeps that order.
 */
export function selectBackfillTargets(records, max = HIST_THUMB_BACKFILL_MAX) {
  const list = Array.isArray(records) ? records : [];
  const out = [];
  for (const r of list) {
    if (out.length >= max) break;
    if (r && typeof r.url === 'string' && r.url && !r.thumb) out.push(r);
  }
  return out;
}

/**
 * Whether a thumbnail may be fetched for this record under these
 * settings. When the setting is off, no request is ever made.
 * `settings` may be null (old stored settings): thumbnails default on.
 */
export function thumbFetchAllowed(settings, record) {
  if (settings && settings.historyShowThumbnails === false) return false;
  if (settings && settings.historyEnabled === false) return false;
  if (!record || typeof record.url !== 'string') return false;
  return /^https?:\/\//i.test(record.url);
}

/** Whether a history record has a retrievable image source for Copy image (B3). */
export function copyImageAvailable(record) {
  return !!(record && typeof record.url === 'string' && /^https?:\/\//i.test(record.url));
}

/**
 * B2 open-file decision, pure so tests can drive it without chrome.*:
 * given what the page and the worker found, decide the next step.
 * 'open': permission held and the file exists, open it in the default app.
 * 'request': the file exists but the optional permission is not held yet.
 * 'show': the permission was denied or is unavailable, or the open API
 * is missing, so fall back to showing the file in its folder.
 * 'not-found': the download no longer exists.
 */
export function decideOpenFile({ exists, permissionHeld, permissionAvailable, openSupported }) {
  if (!exists) return 'not-found';
  if (openSupported === false || permissionAvailable === false) return 'show';
  if (permissionHeld) return 'open';
  return 'request';
}

/**
 * Fetch one image with the thumbnail and copy safety rules, through an
 * injected `fetcher` (the real fetch in the worker and in pages, a stub
 * in tests). One attempt only, never retried: a timeout (default 10 s),
 * a size cap (default HIST_THUMB_SOURCE_MAX_BYTES, 25 MB), credentials
 * omitted, no referrer, non-OK responses rejected. The Content-Length
 * header is checked before the body is read, and the decoded size is
 * checked again after it. Returns { bytes, mime, finalUrl } on success
 * and throws on any failure. Callers treat every throw as a silent
 * fallback, never as an error to show or retry.
 */
/**
 * Sniff the real image type from the first bytes. The Content-Type
 * header is a claim from the host, never evidence: a text/html error
 * page served as image/jpeg must fail here, before any decoder or
 * canvas ever sees it. Returns the MIME type, or '' when the bytes
 * are not a recognisable image.
 */
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 2) return '';
  const ascii = (off, len) => {
    let s = '';
    for (let i = off; i < off + len && i < bytes.length; i += 1) {
      s += String.fromCharCode(bytes[i]);
    }
    return s;
  };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
  if (ascii(4, 4) === 'ftyp' && (ascii(8, 4) === 'avif' || ascii(8, 4) === 'avis')) return 'image/avif';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) return 'image/x-icon';
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00)
    || (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A)) return 'image/tiff';
  // SVG is text: skip a BOM, whitespace, an XML declaration and comments,
  // then the first element must be <svg.
  const head = ascii(0, Math.min(4096, bytes.length));
  let s = head.replace(/^\uFEFF/, '').trimStart();
  if (s.startsWith('<?xml')) {
    const end = s.indexOf('?>');
    if (end === -1) return '';
    s = s.slice(end + 2).trimStart();
  }
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->');
    if (end === -1) return '';
    s = s.slice(end + 3).trimStart();
  }
  if (/^<svg[\s>]/.test(s)) return 'image/svg+xml';
  return '';
}

export async function fetchImageBytes(fetcher, url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || HIST_THUMB_FETCH_TIMEOUT_MS;
  const maxBytes = Number(options.maxBytes) || HIST_THUMB_SOURCE_MAX_BYTES;
  if (typeof fetcher !== 'function') throw new Error('no-fetcher');
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('bad-url');
  // H3: the private-network guard belongs here, not only in the callers.
  // The history Copy path used to re-fetch a record URL with no guard
  // at all, and no caller re-checked redirects. options.pageUrl is the
  // page the record came from (the same-host exception still applies).
  if (options.pageUrl !== undefined && isPrivateNetworkFetchBlocked(url, options.pageUrl)) {
    throw new Error('private-network');
  }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
  let res;
  try {
    res = await fetcher(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctl ? ctl.signal : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    if (ctl && ctl.signal.aborted) throw new Error('timeout');
    throw err;
  }
  if (!res || !res.ok) {
    clearTimeout(timer);
    throw new Error('fetch-failed');
  }
  // Redirect re-check before the body is read: a public URL must not
  // bounce the request onto a private address.
  if (options.pageUrl !== undefined && typeof res.url === 'string' && res.url
    && isRedirectBlocked(res.url, options.pageUrl)) {
    clearTimeout(timer);
    throw new Error('blocked-redirect');
  }
  const getHeader = (name) => (res.headers && typeof res.headers.get === 'function'
    ? res.headers.get(name) : null);
  const declared = Number(getHeader('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    clearTimeout(timer);
    throw new Error('too-large');
  }
  let bytes;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      // H3/H7: enforce the cap WHILE STREAMING. The old arrayBuffer path
      // buffered the whole body first, so a hostile host could make the
      // worker hold gigabytes before the cap was ever checked.
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            total += value.length;
            if (total > maxBytes) {
              try { await reader.cancel(); } catch { /* already closed */ }
              throw new Error('too-large');
            }
            chunks.push(value);
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
      bytes = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { bytes.set(c, o); o += c.length; }
    } else {
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength > maxBytes) throw new Error('too-large');
      bytes = new Uint8Array(buf);
    }
  } catch (err) {
    if (ctl && ctl.signal.aborted) throw new Error('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) throw new Error('not-image');
  return {
    bytes,
    mime: sniffed,
    finalUrl: typeof res.url === 'string' ? res.url : '',
  };
}

/**
 * Encode bytes as a base64 data URL (chunked, so a large image does not
 * blow the stack). The MIME defaults to image/png when the given one is
 * not an image type.
 */
export function bytesToDataUrl(bytes, mime) {
  const type = typeof mime === 'string' && mime.startsWith('image/')
    ? mime.split(';')[0].trim() : 'image/png';
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** File extensions stripped from the displayed history title (last one only). */
const STRIPPABLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg']);

/**
 * Display title for a history record: the filename without its final
 * image extension. Only the last of .png .jpg .jpeg .webp .gif .avif
 * .bmp .svg is stripped (case insensitive), and only when something
 * remains before it, so ".png" stays ".png" and "photo.xyz" is untouched.
 */
export function stripImageExtension(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  if (!STRIPPABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return name;
  return name.slice(0, dot);
}

/** Approximate decoded byte size of a base64 data URL (0 when not one). */
export function thumbByteSize(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Keep a thumbnail only when it is a JPEG or WebP data URL within the
 * per-thumb cap; anything else is dropped (never stored, never rendered).
 */
export function sanitizeHistoryThumb(value) {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('data:image/jpeg') && !value.startsWith('data:image/webp')) return undefined;
  if (thumbByteSize(value) > HIST_THUMB_MAX_BYTES) return undefined;
  return value;
}

/** Keep a source URL only when it is http(s) and within the length cap. */
export function sanitizeHistoryUrl(value) {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (!/^https?:\/\//i.test(url) || url.length > HIST_URL_MAX_LENGTH) return undefined;
  return url;
}

/** Keep a download id only when it is a non-negative integer. */
export function sanitizeHistoryDlId(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Drop the oldest thumbnails first until the total thumb bytes fit the
 * 3 MB budget. Records stay; only their `thumb` field is removed.
 * Mutates the passed records (they are the list about to be stored).
 */
export function enforceThumbBudget(records) {
  const list = Array.isArray(records) ? records : [];
  let total = 0;
  for (const r of list) total += thumbByteSize(r && r.thumb);
  if (total <= HIST_THUMB_MAX_TOTAL_BYTES) return list;
  for (let i = list.length - 1; i >= 0 && total > HIST_THUMB_MAX_TOTAL_BYTES; i -= 1) {
    const r = list[i];
    if (r && r.thumb) {
      total -= thumbByteSize(r.thumb);
      delete r.thumb;
    }
  }
  return list;
}

/**
 * Record: { id, filename, site, pageHost, format, width, height, bytes, at, kind }
 * kind: 'single' | 'bulk' | 'screenshot'
 * bytes: actual on-disk file size measured at download completion (0 = unknown,
 * e.g. records written before this field existed).
 */
export function addRecord(records, record) {
  const list = Array.isArray(records) ? [...records] : [];
  const cleanText = (v, max) => stripBidiControls(String(v || ''))
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  const entry = {
    id: record.id || `h${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    filename: cleanText(record.filename, 180) || 'image',
    site: cleanText(record.site, 120),
    pageHost: cleanText(record.pageHost, 253),
    format: cleanText(record.format, 12),
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    bytes: Math.max(0, Math.round(Number(record.bytes) || 0)),
    at: Number(record.at) || Date.now(),
    kind: ['single', 'bulk', 'screenshot'].includes(record.kind) ? record.kind : 'single',
  };
  // New optional fields, each validated; a bad value is dropped, never stored.
  // A transient thumbSource on the input is never stored (see makeHistoryThumb).
  const thumb = sanitizeHistoryThumb(record.thumb);
  if (thumb !== undefined) entry.thumb = thumb;
  const url = sanitizeHistoryUrl(record.url);
  if (url !== undefined) entry.url = url;
  const dlId = sanitizeHistoryDlId(record.dlId);
  if (dlId !== undefined) entry.dlId = dlId;
  list.unshift(entry);
  return enforceThumbBudget(list.slice(0, MAX_RECORDS));
}

/**
 * H6: re-sanitise one stored record on READ. addRecord sanitises on
 * write, but storage can hold records written by older versions or
 * tampered with by anything that can write chrome.storage.local, so a
 * hostile record must never reach the UI unsanitised. Returns a clean
 * record, or null when the stored value is not a record at all.
 */
export function sanitizeHistoryRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const cleanText = (v, max) => stripBidiControls(String(v || ''))
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  const cleanNum = (v, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(0, Math.round(n)), max);
  };
  const entry = {
    id: typeof record.id === 'string' && record.id
      ? record.id.slice(0, 120)
      : `h${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    filename: cleanText(record.filename, 180) || 'image',
    site: cleanText(record.site, 120),
    pageHost: cleanText(record.pageHost, 253),
    format: cleanText(record.format, 12),
    width: cleanNum(record.width, 1_000_000),
    height: cleanNum(record.height, 1_000_000),
    bytes: cleanNum(record.bytes, Number.MAX_SAFE_INTEGER),
    at: cleanNum(record.at, Number.MAX_SAFE_INTEGER) || Date.now(),
    kind: ['single', 'bulk', 'screenshot'].includes(record.kind) ? record.kind : 'single',
  };
  const thumb = sanitizeHistoryThumb(record.thumb);
  if (thumb !== undefined) entry.thumb = thumb;
  const url = sanitizeHistoryUrl(record.url);
  if (url !== undefined) entry.url = url;
  const dlId = sanitizeHistoryDlId(record.dlId);
  if (dlId !== undefined) entry.dlId = dlId;
  return entry;
}

/** Drop records older than retentionDays. */
export function pruneRecords(records, retentionDays = 30) {
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  return enforceThumbBudget((records || []).filter((r) => (r.at || 0) >= cutoff).slice(0, MAX_RECORDS));
}

function dayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Group records into [{key,label,items}] newest day first.
 * Pass the i18n t() as `translate` to localize the Today/Yesterday
 * labels; without it the labels stay in English (keeps Node tests
 * deterministic and the module free of i18n state).
 */
export function groupByDay(records, translate) {
  const dayLabel = (key, fallback) => {
    if (typeof translate === 'function') {
      try {
        const s = translate(key);
        if (typeof s === 'string' && s && s !== key) return s;
      } catch { /* fall through to the English fallback */ }
    }
    return fallback;
  };
  const groups = new Map();
  for (const r of records || []) {
    const key = dayKey(r.at || Date.now());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, items]) => ({
      key,
      label: key === today ? dayLabel('history_today', 'Today')
        : key === yesterday ? dayLabel('history_yesterday', 'Yesterday')
        : formatDay(key),
      count: items.length,
      items,
    }));
}

function formatDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Read image dimensions from encoded bytes without a full decode.
 * Supports PNG, GIF, JPEG and WebP; returns null when unknown.
 */
export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 10) return null;
  // PNG: width and height in the IHDR chunk at offset 16.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    if (bytes.length < 24) return null;
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // BMP: width and height are little-endian int32 at offsets 18 and 22.
  // Height may be negative (top-down bitmap); the pixel count uses its size.
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    if (bytes.length < 26) return null;
    const w = (bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)) >>> 0;
    let h = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
    if (h < 0) h = -h;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // ICO: width and height are single bytes at offsets 6 and 7 (0 means 256).
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) {
    if (bytes.length < 8) return null;
    const w = bytes[6] === 0 ? 256 : bytes[6];
    const h = bytes[7] === 0 ? 256 : bytes[7];
    return { w, h };
  }
  // GIF: logical screen size at offset 6.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // JPEG: scan markers for a start-of-frame segment.
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (i + 4 > bytes.length) break;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7)
        || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
        const h = (bytes[i + 5] << 8) | bytes[i + 6];
        const w = (bytes[i + 7] << 8) | bytes[i + 8];
        return w > 0 && h > 0 ? { w, h } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF header, then a VP8X, VP8L or VP8 chunk.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58 && bytes.length >= 30) {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { w, h };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4C && bytes.length >= 25) {
      const w = 1 + (bytes[21] | ((bytes[22] & 0x3F) << 8));
      const h = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0F) << 10));
      return { w, h };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20 && bytes.length >= 30) {
      const w = bytes[26] | ((bytes[27] & 0x3F) << 8);
      const h = bytes[28] | ((bytes[29] & 0x3F) << 8);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    return null;
  }
  return null;
}

/** Blob to data URL, for the encoded thumbnail (FileReader runs in workers). */
function thumbBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('encode-failed'));
    fr.readAsDataURL(blob);
  });
}

/**
 * Make a 120x120 px centre cover-crop thumbnail from an image that is
 * already in memory as a data URL. WebP at quality 0.85 when the
 * encoder supports it, else JPEG at 0.85 on a white backing (JPEG has
 * no alpha); quality steps down to 0.6 only when the result is over
 * the 12 KB cap, and the thumbnail is dropped when it still does not
 * fit. Large sources are downscaled stepwise (480 px, then 120 px)
 * with high-quality resampling, so the result stays sharp. Throws on
 * any failure; callers must catch it and continue without a thumbnail.
 * Never fetches anything: the source must be a data URL already held
 * by the caller. SVG sources are not thumbnailed here (no DOM in the
 * worker to render them); they fall back to the icon tile.
 */
export async function makeHistoryThumb(source) {
  const g = globalThis;
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') {
    throw new Error('unsupported');
  }
  if (typeof source !== 'string' || !source.startsWith('data:image/')) throw new Error('bad-source');
  if (source.length > HIST_THUMB_SOURCE_MAX_BYTES) throw new Error('too-large');
  const blob = dataUrlToBlob(source);
  if (!blob.type.startsWith('image/')) throw new Error('bad-source');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let dims = imageDimensions(bytes);
  if (!dims) {
    const probe = await g.createImageBitmap(blob);
    dims = { w: probe.width, h: probe.height };
    probe.close();
  }
  // H7: cap pixel counts BEFORE decoding. A tiny file can claim enormous
  // dimensions (decompression bomb); the header check above catches PNG,
  // GIF, JPEG, WebP, BMP and ICO, and the probe path checks after decode
  // for formats with no header parser (AVIF, TIFF, SVG).
  assertImagePixelBudget(dims.w, dims.h);
  const side = Math.min(dims.w, dims.h);
  const sx = Math.floor((dims.w - side) / 2);
  const sy = Math.floor((dims.h - side) / 2);
  let small = null;
  try {
    if (side > 480) {
      try {
        small = await g.createImageBitmap(blob, sx, sy, side, side,
          { resizeWidth: 480, resizeHeight: 480, resizeQuality: 'high' });
      } catch {
        small = null;
      }
    }
    if (!small) {
      try {
        small = await g.createImageBitmap(blob, sx, sy, side, side,
          { resizeWidth: HIST_THUMB_SIZE, resizeHeight: HIST_THUMB_SIZE, resizeQuality: 'high' });
      } catch {
        small = await g.createImageBitmap(blob, sx, sy, side, side);
      }
    }
    const canvas = new g.OffscreenCanvas(HIST_THUMB_SIZE, HIST_THUMB_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, HIST_THUMB_SIZE, HIST_THUMB_SIZE);
    let probe = null;
    try {
      probe = await canvas.convertToBlob({ type: 'image/webp', quality: HIST_THUMB_QUALITIES[0] });
    } catch {
      probe = null;
    }
    if (probe && probe.type === 'image/webp' && probe.size > 0) {
      for (let qi = 0; qi < HIST_THUMB_QUALITIES.length; qi += 1) {
        const quality = HIST_THUMB_QUALITIES[qi];
        const out = qi === 0 ? probe : await canvas.convertToBlob({ type: 'image/webp', quality });
        if (!out || out.type !== 'image/webp' || out.size === 0) continue;
        const url = await thumbBlobToDataUrl(out);
        if (thumbByteSize(url) <= HIST_THUMB_MAX_BYTES) return url;
      }
      return null;
    }
    const flat = new g.OffscreenCanvas(HIST_THUMB_SIZE, HIST_THUMB_SIZE);
    const flatCtx = flat.getContext('2d');
    flatCtx.fillStyle = '#ffffff';
    flatCtx.fillRect(0, 0, HIST_THUMB_SIZE, HIST_THUMB_SIZE);
    flatCtx.drawImage(canvas, 0, 0);
    for (const quality of HIST_THUMB_QUALITIES) {
      const out = await flat.convertToBlob({ type: 'image/jpeg', quality });
      if (!out || out.type !== 'image/jpeg' || out.size === 0) continue;
      const url = await thumbBlobToDataUrl(out);
      if (thumbByteSize(url) <= HIST_THUMB_MAX_BYTES) return url;
    }
    return null;
  } finally {
    if (small) small.close();
  }
}
