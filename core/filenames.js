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
 * ImgFetch, core/filenames.js
 * Filename safety: every user-visible filename is built through here.
 * Pure functions, no chrome.* dependencies (unit-testable in Node).
 */

export const SAFE_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg',
]);

// Extensions that must never be produced by ImgFetch.
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jse',
  'wsf', 'wsh', 'jar', 'html', 'htm', 'svgz',
]);

const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/**
 * H5: directional formatting characters that let a hostile name spoof
 * its displayed order (U+202E right-to-left override makes
 * "photo-gnp.exe" display as "photo-exe.png"). They carry no meaning
 * in a file name, so they are stripped everywhere a name is cleaned.
 * Zero-width joiners inside real words are not in this set.
 */
// Phase 6 (F-P6-6): also strip invisible format characters that carry no
// meaning in a file name but can hide text: U+200B zero width space,
// U+2060 word joiner, U+061C Arabic letter mark, U+180E Mongolian vowel
// separator, U+00AD soft hyphen. U+200C/U+200D are deliberately kept:
// ZWNJ is a real letter in Persian/Urdu words and ZWJ joins emoji.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\uFEFF\u200B\u2060\u061C\u180E\u00AD]/g;
export function stripBidiControls(raw) {
  return String(raw ?? '').replace(BIDI_CONTROLS, '');
}

/**
 * Phase 6 (F-P6-7): truncate without splitting a surrogate pair. A plain
 * slice(0, N) can end on a lone high surrogate (a 96-char cap landing
 * inside an emoji), and a lone surrogate in a file name is mangled or
 * rejected by the downloads API. Drops the trailing high surrogate.
 */
export function truncateNoLoneSurrogate(s, max) {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}
const MAX_SEGMENT = 96;
const MAX_FILENAME = 180;

/** Sanitize one path segment (file base name or folder name). */
// Case-insensitive: CON PRN AUX NUL COM1-COM9 LPT1-LPT9 (with or without extension).
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeSegment(raw) {
  let s = String(raw ?? '');
  // Decode percent-escapes defensively; never let them smuggle separators.
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as-is */
  }
  s = stripBidiControls(s)
    .replace(ILLEGAL_CHARS, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  // Collapse repeated dots/dashes left by removals.
  s = s.replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-');
  if (!s) return '';
  if (s.length > MAX_SEGMENT) s = truncateNoLoneSurrogate(s, MAX_SEGMENT).trim();
  // L1: Windows reserved device names (CON, NUL, COM1…) are illegal as file
  // names even with an extension, prefix with an underscore.
  // Phase 6 (F-P6-7): the prefix is applied after the length cap, so a
  // 96-character reserved name used to come back 97 long. Re-truncate
  // after prefixing so the cap always holds.
  const stem = s.split('.')[0];
  if (WIN_RESERVED.test(stem)) s = truncateNoLoneSurrogate(`_${s}`, MAX_SEGMENT);
  return s;
}


/** Map a requested extension to a safe image extension. */
export function safeExtension(requested, fallback = 'png') {
  let ext = String(requested || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (ext === 'jpeg') ext = 'jpg';
  if (BLOCKED_EXTENSIONS.has(ext)) return fallback;
  if (SAFE_IMAGE_EXTENSIONS.has(ext)) return ext;
  return fallback;
}

/**
 * Build a safe filename from a template and context.
 * ctx: {site, name, date:Date|string, time, width, height, num, ext}
 */
export function buildFilename(template, ctx = {}) {
  const mode = template === 'site' || template === 'original' || template === 'custom'
    ? template
    : 'original';
  const now = ctx.date instanceof Date ? ctx.date : new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

  const site = sanitizeSegment(ctx.site || 'download') || 'download';
  const rawName = sanitizeSegment(ctx.name || 'image') || 'image';
  // Strip any extension the page supplied; we attach our own safe one.
  const name = rawName.replace(/\.[a-z0-9]{2,5}$/i, '');
  const num = ctx.num != null ? String(ctx.num).padStart(3, '0') : '001';
  const dims = ctx.width && ctx.height ? `${ctx.width}x${ctx.height}` : '';

  let base;
  if (mode === 'original') {
    base = name || 'image';
  } else if (mode === 'site') {
    base = `${site} - ${date} - ${num}`;
  } else {
    base = String(ctx.custom || '{site} - {date} - {num}')
      .replaceAll('{site}', site)
      .replaceAll('{name}', name || 'image')
      .replaceAll('{date}', date)
      .replaceAll('{time}', time)
      .replaceAll('{width}', String(ctx.width || ''))
      .replaceAll('{height}', String(ctx.height || ''))
      .replaceAll('{dimensions}', dims)
      .replaceAll('{num}', num);
    base = sanitizeSegment(base) || 'image';
  }

  const ext = safeExtension(ctx.ext, 'png');
  let filename = `${base}.${ext}`;
  if (filename.length > MAX_FILENAME) {
    filename = `${truncateNoLoneSurrogate(base, MAX_FILENAME - ext.length - 1)}.${ext}`;
  }
  return filename;
}

/**
 * Join an optional subfolder with a filename for chrome.downloads.
 * Returns just the filename when no folder is configured. Never allows
 * traversal outside the Downloads folder.
 * `extraExts` lets callers keep a non-image extension (e.g. 'zip') that
 * safeExtension would otherwise map back to the image fallback.
 */
export function joinDownloadPath(folder, filename, extraExts = []) {
  const file = sanitizeSegment(filename).replace(/\.[a-z0-9]{2,5}$/i, '');
  const ext = (String(filename).match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'png';
  const extra = new Set(extraExts.map((e) => String(e).toLowerCase().replace(/[^a-z0-9]/g, '')));
  const normExt = String(ext).toLowerCase();
  const safeExt = extra.has(normExt) ? normExt : safeExtension(ext);
  const safeFile = `${file || 'image'}.${safeExt}`;
  const folderParts = String(folder || '')
    .split(/[\\/]/)
    .map((p) => sanitizeSegment(p))
    .filter((p) => p && p !== '.' && p !== '..');
  const safeFolder = folderParts.slice(0, 3).join('/');
  return safeFolder ? `${safeFolder}/${safeFile}` : safeFile;
}

/** Validate an imported settings JSON string; returns parsed object or throws. */
/**
 * H6: an imported settings file is untrusted input. Cap it at
 * 1,000,000 characters before parsing: a real export is a few KB,
 * and an unbounded JSON.parse of a hostile file would hang the page.
 */
export const SETTINGS_IMPORT_MAX_CHARS = 1_000_000;
export function parseSettingsImport(text) {
  if (typeof text !== 'string' || text.length > SETTINGS_IMPORT_MAX_CHARS) {
    throw new Error('too-large');
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('not-an-object');
  }
  return data;
}
