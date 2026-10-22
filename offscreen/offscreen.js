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
 * ImgFetch, offscreen/offscreen.js
 * Off-DOM image pipeline: format conversion, full-page stitching and
 * clipboard writes. Receives only validated messages from the service
 * worker (runtime messages with target === 'offscreen').
 */
import { encodeGif, encodeGifAnimated } from '../core/gif.js';
import { createZipParts } from '../core/zip.js';
import { isPrivateNetworkFetchBlocked, isRedirectBlocked } from '../core/urls.js';
import { dataUrlToBlob } from '../core/data-url.js';
import { sanitizeSvgDocument, stripSvgDoctype } from '../core/svg.js';
import { quantizePngRgba } from '../core/png-quantize.js';
// N2: chunked-ZIP accumulator with abort + 2-min TTL (no more leaked chunks).
import { createZipAccumulator } from '../core/zip-accum.js';
// N1: the stitch size rule lives in core/fullpage-capture.js, the planner
// and the stitcher share it, so they can never disagree again.
import { isStitchSizeAccepted } from '../core/fullpage-capture.js';

(() => {
  'use strict';

  const SAFE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

  function allowedSource(src, pageUrl) {
    if (typeof src !== 'string' || !src) return false;
    if (src.startsWith('data:image/')) return src.length <= 25_000_000;
    try {
      const u = new URL(src);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    } catch {
      return false;
    }
    // B2: same private-network rule as the worker (defense in depth).
    // pageUrl comes from the worker's message so the same-host intranet
    // exception keeps working here too.
    if (isPrivateNetworkFetchBlocked(src, pageUrl)) return false;
    return true;
  }

  /**
   * F1: after any fetch that can receive an untrusted URL, re-check the
   * FINAL url (response.url, after redirects) with the same
   * private-network rule that vetted the original URL, and refuse the
   * response if the redirect landed somewhere blocked.
   */
  function throwIfRedirectBlocked(res, pageUrl) {
    if (res && isRedirectBlocked(res.url, pageUrl)) throw new Error('blocked-redirect');
  }

  async function loadBitmap(src, pageUrl) {
    let blob;
    if (typeof src === 'string' && src.startsWith('data:')) {
      // F6: screenshot data URLs are decoded locally (chunked atob via
      // core/data-url.js), never through fetch(dataUrl).
      blob = dataUrlToBlob(src);
    } else {
      const res = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      throwIfRedirectBlocked(res, pageUrl);
      if (!res.ok) throw new Error(`http-${res.status}`);
      blob = await res.blob();
    }
    if (!blob.type.startsWith('image/')) throw new Error('not-image');
    return createImageBitmap(blob);
  }

  function encode(bitmap, sx, sy, sw, sh, format, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d');
    if (format === 'jpg' || format === 'jpeg') {
      // JPEG has no alpha, paint white first to avoid black backgrounds.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const mime = MIME[format] || MIME.png;
    const q = Math.min(1, Math.max(0.1, Number(quality) || 1));
    if (format === 'png' && q < 1) {
      // J2: the PNG slider is real. The browser's PNG encoder is always
      // lossless, so reduce the color count first (median-cut); fewer
      // colors compress much better. 100% skips this entirely (lossless).
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const quantized = quantizePngRgba(img.data, canvas.width, canvas.height, q);
      img.data.set(quantized);
      ctx.putImageData(img, 0, 0);
    }
    const dataUrl = canvas.toDataURL(mime, format === 'png' ? undefined : q);
    // Format fidelity: never return a mislabeled file. If the browser silently
    // fell back to another encoder (e.g. PNG for AVIF), fail loudly so the
    // caller can fall back honestly instead of saving a wrong-format file.
    if (!dataUrl.startsWith(`data:${mime}`)) throw new Error('encode-unsupported');
    return {
      dataUrl,
      width: canvas.width,
      height: canvas.height,
    };
  }

  /**
   * M3/B4: sanitize a network SVG before saving. A saved .svg opened in a
   * browser can run embedded scripts, the allowlist sanitizer in
   * core/svg.js keeps only known-safe elements/attributes, neutralizes
   * javascript: URLs (including tab/newline-obfuscated ones), strips
   * foreignObject/script/iframe/embed/object, href-retargeting SMIL, and
   * @import / external url() in styles. External image references are
   * preserved (they're just images).
   */
  async function sanitizeSvg(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const res = await fetch(msg.srcUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    throwIfRedirectBlocked(res, msg.pageUrl);
    if (!res.ok) throw new Error(`http-${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error('too-large');
    // Strip DOCTYPE / internal entities before parsing: billion-laughs
    // style entity expansion would otherwise hang the parser on hostile
    // input. DOCTYPE never affects SVG rendering.
    const doc = new DOMParser().parseFromString(stripSvgDoctype(text), 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('not-svg');
    sanitizeSvgDocument(doc);
    const clean = new XMLSerializer().serializeToString(doc);
    return {
      ok: true,
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`,
    };
  }

  /**
   * M3: createImageBitmap often can't decode SVG, fall back to
   * rendering via an <img> element so SVG -> PNG/JPG works.
   */
  async function loadBitmapWithSvgFallback(src, pageUrl) {
    try {
      return await loadBitmap(src, pageUrl);
    } catch (err) {
      let text = '';
      try {
        if (typeof src === 'string' && src.startsWith('data:')) {
          text = (await dataUrlToBlob(src).text()).slice(0, 4000);
        } else {
          const res = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
          if (res.ok && !isRedirectBlocked(res.url, pageUrl)) {
            text = (await res.text()).slice(0, 4000);
          }
        }
      } catch {
        /* fall through */
      }
      if (!/<svg[\s>]/.test(text)) throw err;
      const blobUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(err);
          img.src = blobUrl;
        });
        return await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }

  async function convertImage(msg) {
    const format = String(msg.format || 'png').toLowerCase();
    if (!SAFE_FORMATS.has(format)) throw new Error('bad-format');
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const bitmap = await loadBitmapWithSvgFallback(msg.srcUrl, msg.pageUrl);
    try {
      return { ok: true, ...encode(bitmap, 0, 0, bitmap.width, bitmap.height, format, msg.quality) };
    } finally {
      bitmap.close();
    }
  }

  /**
   * L9: re-encode the image in its own format. Decoding to a bitmap and
   * re-encoding drops all EXIF (including GPS), the clean copy has no
   * metadata. Quality 1.0 to minimize generational loss.
   */
  async function stripMetadata(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const m = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(String(msg.srcUrl || ''));
    let format = (m && m[1].toLowerCase()) || 'png';
    if (format === 'jpeg') format = 'jpg';
    if (!SAFE_FORMATS.has(format)) format = 'png';
    const bitmap = await loadBitmapWithSvgFallback(msg.srcUrl, msg.pageUrl);
    try {
      return { ok: true, format, ...encode(bitmap, 0, 0, bitmap.width, bitmap.height, format, 1) };
    } finally {
      bitmap.close();
    }
  }

  /**
   * L11: sniff the real image type from the first bytes (Range request).
   * A `.jpg` URL can serve WebP, the filename and history must reflect the
   * actual bytes, not the URL's claim.
   */
  async function sniffType(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const res = await fetch(msg.srcUrl, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Range: 'bytes=0-31' },
    }).catch(() => null);
    if (res && isRedirectBlocked(res.url, msg.pageUrl)) throw new Error('sniff-failed');
    if (!res || (!res.ok && res.status !== 206)) throw new Error('sniff-failed');
    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf || buf.byteLength < 4) throw new Error('sniff-failed');
    const sniffed = sniffImageType(buf);
    const ext = sniffed && ZIP_TYPE_TO_EXT[sniffed];
    if (!ext) throw new Error('sniff-unknown');
    return { ok: true, ext };
  }

  async function clipboardWrite(msg) {
    const text = String(msg.text || '').slice(0, 8192);
    if (!text) throw new Error('empty');
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (firstErr) {
      // The async Clipboard API rejects in the offscreen document when it
      // isn't focused ("NotAllowedError: Document is not focused"). The
      // legacy execCommand path has no focus requirement, use it as backup.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
        document.documentElement.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) return { ok: true, fallback: 'execCommand' };
      } catch {
        /* fall through to the original error */
      }
      throw firstErr;
    }
  }

  /**
   * Copy the actual image (not just its link) to the clipboard as PNG,
   * so it can be pasted into chats, docs and editors.
   */
  async function clipboardImage(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const bitmap = await loadBitmap(msg.srcUrl, msg.pageUrl);
    try {
      const w = bitmap.width;
      const h = bitmap.height;
      if (!(w > 0 && h > 0) || w > 8000 || h > 8000) throw new Error('bad-size');
      if (w * h > 32_000_000) throw new Error('too-large');
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('encode-failed');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return { ok: true, width: w, height: h };
    } finally {
      bitmap.close();
    }
  }

  /**
   * Build a .zip from fetched images. msg: { files: [{url, name}] }.
   * Caps guard memory: 200 files, 50MB each, 300MB total.
   */
  /**
   * H3: ZIP download that scales. Fetches with concurrency 4 and a 30 s
   * per-file timeout, detects the real image type (magic bytes, then
   * Content-Type, then URL) so entries are never mislabeled, and returns
   * a blob: URL instead of a giant base64 data URL, the old path broke
   * past ~45 MB because of the runtime message size limit.
   * Returns { ok, url, count, skipped, bytes }. The worker revokes the
   * URL after the download completes (REVOKE_URL).
   */
  const ZIP_MAX_FILES = 200;
  const ZIP_MAX_FILE_BYTES = 50_000_000;
  const ZIP_MAX_TOTAL_BYTES = 300_000_000;
  const ZIP_FETCH_TIMEOUT_MS = 30_000;
  const ZIP_FETCH_CONCURRENCY = 4;
  // Distinct rule (not the full-page area cap): max bytes fetched when
  // probing whether a GIF is animated.
  const GIF_PROBE_MAX_BYTES = 100_000_000;

  async function mapConcurrent(list, n, fn) {
    const out = new Array(list.length);
    let next = 0;
    const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
      while (next < list.length) {
        const i = next;
        next += 1;
        try {
          out[i] = await fn(list[i], i);
        } catch {
          out[i] = { skipped: 'failed' };
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  function dataUrlToBytes(url) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ''));
    if (!m) return null;
    try {
      if (m[2]) {
        const bin = atob(m[3]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      }
      return new TextEncoder().encode(decodeURIComponent(m[3])).buffer;
    } catch {
      return null;
    }
  }

  const ZIP_TYPE_TO_EXT = {
    'image/gif': 'gif',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };

  /** Real extension for ZIP entries: magic bytes, then Content-Type, then URL. */
  function zipEntryExt(data, contentType, url) {
    const sniffed = sniffImageType(data.buffer || data);
    if (sniffed && ZIP_TYPE_TO_EXT[sniffed]) return ZIP_TYPE_TO_EXT[sniffed];
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (ZIP_TYPE_TO_EXT[ct]) return ZIP_TYPE_TO_EXT[ct];
    const fromUrl = String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    if (fromUrl && /^[a-z0-9]+$/i.test(fromUrl[1])) return fromUrl[1].toLowerCase();
    return 'img';
  }

  function zipEntryName(r) {
    const ext = zipEntryExt(r.data, r.contentType, r.url);
    let stem = String(r.name || '');
    // data: URLs make ugly names, use a clean numbered stem instead.
    if (!stem || r.url.startsWith('data:')) {
      stem = `image-${String(r.index + 1).padStart(3, '0')}`;
    } else {
      stem = stem.split('?')[0].split('/').pop() || stem;
    }
    stem = stem.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 80) || `image-${String(r.index + 1).padStart(3, '0')}`;
    return `${stem}.${ext}`;
  }

  async function fetchZipFile(f, i, pageUrl) {
    const url = String((f && f.url) || '');
    if (!url) return { skipped: 'empty-url' };
    if (!allowedSource(url, pageUrl)) return { skipped: 'unsupported-source' };
    if (url.startsWith('data:')) {
      const buf = dataUrlToBytes(url);
      if (!buf || buf.byteLength === 0) return { skipped: 'bad-data-url' };
      if (buf.byteLength > ZIP_MAX_FILE_BYTES) return { skipped: 'too-large' };
      return { data: new Uint8Array(buf), contentType: '', url, index: i, name: f.name };
    }
    let res;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ZIP_FETCH_TIMEOUT_MS);
      try {
        res = await fetch(url, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { skipped: err && err.name === 'AbortError' ? 'timeout' : 'fetch-failed' };
    }
    if (isRedirectBlocked(res.url, pageUrl)) return { skipped: 'blocked-redirect' };
    if (!res.ok) return { skipped: `http-${res.status}` };
    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf || buf.byteLength === 0) return { skipped: 'empty-body' };
    if (buf.byteLength > ZIP_MAX_FILE_BYTES) return { skipped: 'too-large' };
    return {
      data: new Uint8Array(buf),
      contentType: res.headers.get('content-type') || '',
      url,
      index: i,
      name: f.name,
    };
  }

  /**
   * B6: chunked transfer. The worker splits huge BUILD_ZIP payloads (blob:
   * URLs resolved to data URLs in-page) into small messages so no single
   * runtime message hits the size limit. Chunks carry a zipToken; the
   * offscreen side accumulates per token (concurrent ZIPs can't corrupt
   * each other) until the final chunk (more:false) builds the zip.
   * Single-chunk calls behave as before.
   */
  // N2: accumulator releases a token's chunks on abort (ZIP_ABORT from the
  // worker's catch/finally) or after a 2-minute TTL sweep, a failed or
  // cancelled multi-chunk ZIP no longer leaks memory until close.
  const zipAccums = createZipAccumulator();
  // N2: drop a failed/cancelled ZIP's accumulated chunks immediately.
  function zipAbort(msg) {
    zipAccums.abort(String(msg.zipToken || 'default'));
    return { ok: true };
  }

  async function buildZip(msg) {
    zipAccums.sweep();
    const files = Array.isArray(msg.files) ? msg.files.slice(0, ZIP_MAX_FILES) : [];
    if (!files.length && !msg.more) throw new Error('empty');
    const token = String(msg.zipToken || 'default');
    const pageUrl = msg.pageUrl || null;
    const fetched = await mapConcurrent(files, ZIP_FETCH_CONCURRENCY, (f, i) => fetchZipFile(f, i, pageUrl));
    const acc = zipAccums.get(token);
    for (const r of fetched) {
      if (!r || r.skipped || !r.data) {
        if (r && r.skipped) acc.skipped.push(r.skipped);
        continue;
      }
      if (acc.total + r.data.length > ZIP_MAX_TOTAL_BYTES) {
        acc.skipped.push('total-cap');
        continue;
      }
      acc.total += r.data.length;
      acc.entries.push({ name: zipEntryName(r), data: r.data });
    }
    if (msg.more) {
      return { ok: true, pending: true, accumulated: acc.entries.length };
    }
    zipAccums.take(token);
    if (!acc.entries.length) throw new Error('empty');
    // B6: Blob built straight from the entry parts, no concatenated
    // intermediate buffer (saves one full copy of the archive in memory).
    const { parts, size } = createZipParts(acc.entries);
    const blob = new Blob(parts, { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    // The blob lives as long as the offscreen document; the worker
    // revokes it after the download completes.
    return {
      ok: true,
      url,
      count: acc.entries.length,
      skipped: acc.skipped.length,
      bytes: size,
    };
  }

  function revokeObjectUrl(msg) {
    try {
      if (typeof msg.url === 'string' && msg.url.startsWith('blob:')) {
        URL.revokeObjectURL(msg.url);
      }
    } catch {
      /* already revoked */
    }
    return { ok: true };
  }

  /**
   * Real 24-bit BMP encoding (headers + pixel data, no compression).
   * Canvas cannot encode BMP, so it is written by hand, never faked.
   */
  async function convertBmp(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const bitmap = await loadBitmap(msg.srcUrl, msg.pageUrl);
    try {
      const w = bitmap.width;
      const h = bitmap.height;
      if (w <= 0 || h <= 0 || w > 16000 || h > 16000) throw new Error('bad-size');
      if (w * h > 90_000_000) throw new Error('too-large');
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      const rowSize = Math.floor((24 * w + 31) / 32) * 4;
      const fileSize = 54 + rowSize * h;
      const buf = new ArrayBuffer(fileSize);
      const dv = new DataView(buf);
      dv.setUint16(0, 0x4d42, true); // 'BM'
      dv.setUint32(2, fileSize, true);
      dv.setUint32(10, 54, true); // pixel data offset
      dv.setUint32(14, 40, true); // DIB header size
      dv.setInt32(18, w, true);
      dv.setInt32(22, h, true); // positive height = bottom-up
      dv.setUint16(26, 1, true); // planes
      dv.setUint16(28, 24, true); // bits per pixel
      const px = new Uint8Array(buf, 54);
      for (let y = 0; y < h; y += 1) {
        const srcRow = (h - 1 - y) * w * 4;
        const dstRow = y * rowSize;
        for (let x = 0; x < w; x += 1) {
          px[dstRow + x * 3] = data[srcRow + x * 4 + 2]; // B
          px[dstRow + x * 3 + 1] = data[srcRow + x * 4 + 1]; // G
          px[dstRow + x * 3 + 2] = data[srcRow + x * 4]; // R
        }
      }
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return {
        ok: true,
        dataUrl: `data:image/bmp;base64,${btoa(bin)}`,
        width: w,
        height: h,
      };
    } finally {
      bitmap.close();
    }
  }

  /**
   * Wrap the source raster in a genuine SVG document (base64-embedded).
   * A real, valid .svg file, never a renamed raster.
   */
  async function convertSvg(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const res = await fetch(msg.srcUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    throwIfRedirectBlocked(res, msg.pageUrl);
    if (!res.ok) throw new Error(`http-${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not-image');
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width;
    const h = bitmap.height;
    bitmap.close();
    if (w <= 0 || h <= 0) throw new Error('not-image');
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read-failed'));
      fr.readAsDataURL(blob);
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="${dataUrl}" width="${w}" height="${h}"/></svg>`;
    return {
      ok: true,
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      width: w,
      height: h,
    };
  }

  /** Sniff a container type for WebCodecs ImageDecoder from magic bytes. */
  function sniffImageType(buf) {
    const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
    const str = String.fromCharCode(...b.slice(0, 6));
    if (str === 'GIF87a' || str === 'GIF89a') return 'image/gif';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (str.slice(0, 4) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
    return '';
  }

  /**
   * Animated GIF via WebCodecs: decode every frame of an animated source
   * (e.g. animated WebP/APNG) and encode a real multi-frame GIF89a.
   * Returns null when the source isn't animated or WebCodecs is unavailable.
   */
  async function tryAnimatedGif(srcUrl, pageUrl) {
    if (typeof ImageDecoder === 'undefined') return null;
    const res = await fetch(srcUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    if (isRedirectBlocked(res.url, pageUrl)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > GIF_PROBE_MAX_BYTES) return null;
    const type = sniffImageType(buf);
    if (!type) return null;
    let decoder = null;
    try {
      decoder = new ImageDecoder({ data: buf, type });
      if (decoder.tracks && decoder.tracks.ready) await decoder.tracks.ready;
      const track = (decoder.tracks && decoder.tracks.selectedTrack)
        || (decoder.tracks && decoder.tracks[0]);
      if (!track || !(track.frameCount > 1)) return null;
      let frameCount = Math.min(track.frameCount || 0, 60);
      if (frameCount < 2) return null;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const frames = [];
      let w = 0;
      let h = 0;
      for (let i = 0; i < frameCount; i += 1) {
        let result = null;
        try {
          result = await decoder.decode({ frameIndex: i });
        } catch {
          break;
        }
        const img = result.image;
        try {
          const fw = img.displayWidth || img.codedWidth;
          const fh = img.displayHeight || img.codedHeight;
          if (!(fw > 0 && fh > 0)) continue;
          if (w === 0) {
            w = fw;
            h = fh;
            if (w > 4000 || h > 4000 || w * h > 16_000_000) return null;
            // Keep total work bounded: drop frames if the animation is huge.
            while (frameCount > 2 && w * h * frameCount > 64_000_000) frameCount -= 1;
            canvas.width = w;
            canvas.height = h;
          }
          if (fw !== w || fh !== h) continue; // skip odd-sized frames
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const rgba = ctx.getImageData(0, 0, w, h).data;
          const delayCs = Math.max(2, Math.round((img.duration || 100000) / 10000));
          frames.push({ data: rgba, delayCs });
        } finally {
          img.close();
        }
      }
      if (frames.length < 2) return null;
      const bytes = encodeGifAnimated(w, h, frames);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return {
        ok: true,
        dataUrl: `data:image/gif;base64,${btoa(binary)}`,
        width: w,
        height: h,
        animated: true,
      };
    } catch {
      return null;
    } finally {
      try { decoder && decoder.close(); } catch { /* decoder already closed */ }
    }
  }

  /**
   * Genuine GIF89a encoding via ImgFetch's own pure-JS encoder (no browser
   * support needed). Animated sources (WebP/APNG) become real multi-frame
   * GIFs; anything else becomes a still. Transparency is preserved as
   * 1-bit GIF transparency.
   */
  async function convertGif(msg) {
    if (!allowedSource(msg.srcUrl, msg.pageUrl)) throw new Error('bad-source');
    const animated = await tryAnimatedGif(msg.srcUrl, msg.pageUrl).catch(() => null);
    if (animated) return animated;
    const bitmap = await loadBitmap(msg.srcUrl, msg.pageUrl);
    try {
      const w = bitmap.width;
      const h = bitmap.height;
      if (w <= 0 || h <= 0 || w > 4000 || h > 4000) throw new Error('bad-size');
      if (w * h > 16_000_000) throw new Error('too-large');
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const bytes = encodeGif(w, h, rgba);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return {
        ok: true,
        dataUrl: `data:image/gif;base64,${btoa(binary)}`,
        width: w,
        height: h,
      };
    } finally {
      bitmap.close();
    }
  }

  /**
   * Round 4: stitched parts are written STRAIGHT into IndexedDB from
   * here (same extension origin, same 'imgfetch' database and
   * 'captures' store as background/idb.js), as Blob records. A part
   * can be tens of MB; it must never travel back to the worker as a
   * base64 data URL inside a runtime message. The worker only ever
   * receives the record id and the byte size.
   */
  function capturesDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('imgfetch', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('captures')) {
          db.createObjectStore('captures', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbTxDone(db, mode, run) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('captures', mode);
      run(tx.objectStore('captures'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function putCaptureRecord(record) {
    const db = await capturesDb();
    try {
      await idbTxDone(db, 'readwrite', (store) => { store.put(record); });
    } finally {
      db.close();
    }
  }

  async function allCaptureRecords() {
    const db = await capturesDb();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction('captures', 'readonly').objectStore('captures').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  /**
   * Close a parts group once the capture settles: every record of the
   * group gets its final partTotal and is no longer marked open (the
   * worker's pruner protects open groups and prunes closed groups
   * only as a whole).
   */
  async function captureGroupFinalize(msg) {
    const groupId = String(msg.groupId || '');
    if (!groupId) throw new Error('bad-group');
    const partTotal = Math.max(0, Math.round(Number(msg.partTotal) || 0));
    const all = await allCaptureRecords();
    const mine = all.filter((r) => r && r.groupId === groupId);
    const db = await capturesDb();
    try {
      await idbTxDone(db, 'readwrite', (store) => {
        for (const r of mine) store.put({ ...r, partTotal, groupOpen: false });
      });
    } finally {
      db.close();
    }
    return { ok: true, updated: mine.length };
  }

  /**
   * Stitch viewport captures into one full-page image.
   * msg: { images: [{dataUrl, x, y}], width, height, format, quality }
   */
  /**
   * H2: progressive full-page stitching. Tiles arrive one runtime message
   * at a time (STITCH_BEGIN / STITCH_TILE / STITCH_END) instead of one
   * giant message, so long pages can't hit the ~64 MB message limit.
   * The canvas lives here between calls; STITCH_END always releases it.
   */
  let stitchSession = null;

  function stitchBegin(msg) {
    // N6: release any previous session, but a missing one is fine (first
    // capture). stitchEnd() throws 'no-stitch-session' when there is no
    // session, which made EVERY first STITCH_BEGIN fail.
    if (stitchSession) stitchEnd(); // never leak a previous session
    const width = Math.round(Number(msg.width) || 0);
    const height = Math.round(Number(msg.height) || 0);
    // N1: acceptance rule shared with the planner (core/fullpage-capture.js).
    if (!isStitchSizeAccepted(width, height)) {
      throw new Error('bad-size');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width !== width || canvas.height !== height) {
      // The browser refused (or silently shrank) the allocation: say so
      // instead of stitching into a smaller canvas than planned.
      canvas.width = 0;
      canvas.height = 0;
      throw new Error('alloc-failed');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // Tiles arrive at device resolution; the canvas may be downscaled.
    const scale = Math.min(1, Math.max(0.01, Number(msg.scale) || 1));
    stitchSession = { canvas, ctx, width, height, scale, tiles: 0 };
    return { ok: true };
  }

  /**
   * FIX 4: tiles are always drawn 1:1 (no resampling, no downscale). The
   * worker passes exact integer device-px offsets (dx, dy). For inner
   * scroll containers / iframes it also passes a source crop
   * (sx, sy, sw, sh): the tile is the full viewport capture, only the
   * target's visible box is stitched. The legacy {x, y} form draws the
   * whole tile at (x, y).
   */
  async function stitchTile(msg) {
    const s = stitchSession;
    if (!s) throw new Error('no-stitch-session');
    if (!allowedSource(msg.dataUrl, msg.pageUrl)) throw new Error('bad-source');
    const bitmap = await loadBitmap(msg.dataUrl, msg.pageUrl);
    try {
      const dx = Math.round(Number(msg.dx ?? msg.x) || 0);
      const dy = Math.round(Number(msg.dy ?? msg.y) || 0);
      const hasCrop = Number(msg.sw) > 0 && Number(msg.sh) > 0;
      if (hasCrop) {
        const sx = Math.max(0, Math.round(Number(msg.sx) || 0));
        const sy = Math.max(0, Math.round(Number(msg.sy) || 0));
        const sw = Math.min(Math.round(Number(msg.sw)), bitmap.width - sx);
        const sh = Math.min(Math.round(Number(msg.sh)), bitmap.height - sy);
        if (sw <= 0 || sh <= 0) throw new Error('bad-crop');
        s.ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, sw, sh);
      } else {
        s.ctx.drawImage(bitmap, dx, dy);
      }
      s.tiles += 1;
    } finally {
      bitmap.close();
    }
    return { ok: true, tiles: s.tiles };
  }

  function stitchEnd(msg) {
    const s = stitchSession;
    stitchSession = null;
    if (!s) throw new Error('no-stitch-session');
    try {
      const format = msg.format === 'jpg' ? 'jpg' : 'png';
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const q = format === 'jpg' ? Math.min(1, Math.max(0.1, Number(msg.quality) || 1)) : undefined;
      return {
        ok: true,
        dataUrl: s.canvas.toDataURL(mime, q),
        width: s.width,
        height: s.height,
        tiles: s.tiles,
      };
    } finally {
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
  }

  /**
   * Round 4 allocation probe: allocate a canvas at the planned part
   * size, paint it and encode it losslessly, then release it. The
   * worker probes the largest planned part BEFORE capturing; when this
   * fails it replans with half the area budget and tries again, so an
   * allocation limit can never crash a capture halfway through.
   */
  async function stitchProbe(msg) {
    const width = Math.round(Number(msg.width) || 0);
    const height = Math.round(Number(msg.height) || 0);
    if (!isStitchSizeAccepted(width, height)) return { ok: false, error: 'bad-size' };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width !== width || canvas.height !== height) {
        return { ok: false, error: 'alloc-failed' };
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return { ok: false, error: 'alloc-failed' };
      return { ok: true, bytes: blob.size };
    } catch {
      return { ok: false, error: 'alloc-failed' };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Round 4: grow the live stitch canvas (a growing page extended the
   * last part). The old canvas is drawn onto a taller one and released;
   * on allocation failure the session is left untouched and the caller
   * falls back to finishing the part at its planned height.
   */
  function stitchExtend(msg) {
    const s = stitchSession;
    if (!s) throw new Error('no-stitch-session');
    const height = Math.round(Number(msg.height) || 0);
    if (!(height > s.height) || !isStitchSizeAccepted(s.width, height)) {
      return { ok: false, error: 'bad-size' };
    }
    const canvas = document.createElement('canvas');
    canvas.width = s.width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width !== s.width || canvas.height !== height) {
      canvas.width = 0;
      canvas.height = 0;
      return { ok: false, error: 'alloc-failed' };
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s.width, height);
    ctx.drawImage(s.canvas, 0, 0);
    s.canvas.width = 0;
    s.canvas.height = 0;
    stitchSession = { canvas, ctx, width: s.width, height, scale: s.scale, tiles: s.tiles };
    return { ok: true, height };
  }

  /**
   * Round 4: finish a stitch session into IndexedDB as a Blob record.
   * msg.record carries the worker-chosen metadata (id, partIndex,
   * partTotal, groupId, groupOpen, at). Optional msg.cropHeight keeps
   * only the top rows (a stopped capture saves the rows that were
   * really captured). The canvas is released immediately after the
   * encode; the reply carries only the record id and byte size.
   */
  async function stitchEndBlob(msg) {
    const s = stitchSession;
    stitchSession = null;
    if (!s) throw new Error('no-stitch-session');
    const rec = (msg && msg.record) || {};
    const id = String(rec.id || '');
    if (!id) {
      s.canvas.width = 0;
      s.canvas.height = 0;
      throw new Error('bad-record');
    }
    try {
      const cropH = Math.round(Number(msg.cropHeight) || 0);
      let source = s.canvas;
      let outH = s.height;
      let temp = null;
      if (cropH > 0 && cropH < s.height) {
        temp = document.createElement('canvas');
        temp.width = s.width;
        temp.height = cropH;
        const tctx = temp.getContext('2d');
        if (!tctx || temp.width !== s.width || temp.height !== cropH) {
          throw new Error('alloc-failed');
        }
        tctx.drawImage(s.canvas, 0, 0);
        source = temp;
        outH = cropH;
      }
      const format = msg.format === 'jpg' ? 'jpg' : 'png';
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const q = format === 'jpg' ? Math.min(1, Math.max(0.1, Number(msg.quality) || 1)) : undefined;
      const blob = await new Promise((resolve) => source.toBlob(resolve, mime, q));
      if (temp) { temp.width = 0; temp.height = 0; }
      if (!blob) throw new Error('encode-failed');
      const record = {
        id,
        blob,
        width: s.width,
        height: outH,
        at: Number(rec.at) || Date.now(),
        bytes: blob.size,
      };
      if (Number(rec.partIndex) > 0) record.partIndex = Number(rec.partIndex);
      if (Number(rec.partTotal) > 0) record.partTotal = Number(rec.partTotal);
      if (rec.groupId) record.groupId = String(rec.groupId);
      if (rec.groupOpen) record.groupOpen = true;
      await putCaptureRecord(record);
      return { ok: true, id, bytes: blob.size, width: record.width, height: record.height, tiles: s.tiles };
    } finally {
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
  }

  function stitchAbort() {
    const s = stitchSession;
    stitchSession = null;
    if (s) {
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
    return { ok: true };
  }

  /* Single-shot stitching removed (H2): the worker now uses the
   * STITCH_BEGIN / STITCH_TILE / STITCH_END session protocol above so a
   * long page never travels as one giant runtime message. */

  /**
   * FIX 4.3: report the offscreen document's JS heap so peak memory
   * during stitching can be measured (used by the e2e suite).
   */
  function memorySample() {
    const m =
      typeof performance !== 'undefined' && performance.memory ? performance.memory : null;
    return {
      ok: true,
      usedJSHeapSize: m ? Math.round(m.usedJSHeapSize) : 0,
      totalJSHeapSize: m ? Math.round(m.totalJSHeapSize) : 0,
    };
  }

  async function supportsAvif() {
    try {
      // Probe with a real encode (toBlob + MIME check), not just toDataURL,
      // some browsers silently fall back to PNG for toDataURL.
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 16, 16);
      grad.addColorStop(0, '#ff0000');
      grad.addColorStop(1, '#0000ff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 16, 16);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/avif', 0.8));
      return { ok: !!blob && blob.type === 'image/avif' };
    } catch {
      return { ok: false };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen' || typeof msg.type !== 'string') return false;
    // M6: the offscreen document only takes orders from our own extension.
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: 'foreign-sender' });
      return true;
    }
    (async () => {
      try {
        let result;
        switch (msg.type) {
          case 'CONVERT_IMAGE':
            result = await convertImage(msg);
            break;
          case 'STRIP_METADATA':
            result = await stripMetadata(msg);
            break;
          case 'SNIFF_TYPE':
            result = await sniffType(msg);
            break;
          case 'CLIPBOARD_WRITE':
            result = await clipboardWrite(msg);
            break;
          case 'CLIPBOARD_IMAGE':
            result = await clipboardImage(msg);
            break;
          case 'BUILD_ZIP':
            result = await buildZip(msg);
            break;
          case 'ZIP_ABORT':
            // N2: the worker sends this on any chunk failure or cancel so
            // accumulated chunks are released immediately, not kept until
            // the offscreen document closes.
            result = zipAbort(msg);
            break;
          case 'REVOKE_URL':
            result = revokeObjectUrl(msg);
            break;
          case 'CONVERT_BMP':
            result = await convertBmp(msg);
            break;
          case 'CONVERT_SVG':
            result = await convertSvg(msg);
            break;
          case 'SANITIZE_SVG':
            result = await sanitizeSvg(msg);
            break;
          case 'CONVERT_GIF':
            result = await convertGif(msg);
            break;
          case 'STITCH_BEGIN':
            result = stitchBegin(msg);
            break;
          case 'STITCH_TILE':
            result = await stitchTile(msg);
            break;
          case 'STITCH_END':
            result = stitchEnd(msg);
            break;
          case 'STITCH_END_BLOB':
            result = await stitchEndBlob(msg);
            break;
          case 'STITCH_PROBE':
            result = await stitchProbe(msg);
            break;
          case 'STITCH_EXTEND':
            result = stitchExtend(msg);
            break;
          case 'CAPTURE_GROUP_FINALIZE':
            result = await captureGroupFinalize(msg);
            break;
          case 'STITCH_ABORT':
            result = stitchAbort();
            break;
          case 'SUPPORTS_AVIF':
            result = await supportsAvif();
            break;
          case 'MEMORY_SAMPLE':
            // FIX 4.3: heap sample for memory measurement (e2e + diagnostics).
            result = memorySample();
            break;
          default:
            throw new Error('unknown');
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
      }
    })();
    return true;
  });
})();
