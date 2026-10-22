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
 * ImgFetch, core/crop-image.js
 * Lossless in-worker crop for screenshot captures (Area / Element).
 *
 * The Area/Element path used to send the whole screenshot to the offscreen
 * document as a crop message with a hard-coded quality of 0.92, which the
 * offscreen encoder treated as the PNG quality-slider feature: a median-cut
 * colour reduction that cost over a second and destroyed colours nobody
 * asked to lose. Cropping here, in the service worker, with
 * createImageBitmap plus OffscreenCanvas is lossless by construction (the
 * crop takes no such parameter) and skips the offscreen cold start and both
 * base64 message round trips. No DOM and no chrome.* APIs are used, so the
 * function also runs in e2e test drivers.
 */

import { dataUrlToBlob } from './data-url.js';

/** Largest crop side accepted, mirrors the offscreen crop guard. */
export const CROP_MAX_SIDE = 16000;
/** Largest screenshot data URL accepted, mirrors the offscreen guard. */
export const CROP_MAX_DATA_URL = 25_000_000;

/**
 * Read PNG dimensions from the IHDR chunk without decoding the image.
 * Throws 'bad-source' when the header is missing or insane.
 */
function pngSize(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const bin = atob(dataUrl.slice(comma + 1, comma + 33));
  if (bin.length < 24) throw new Error('bad-source');
  let w = 0;
  let h = 0;
  for (let i = 0; i < 4; i += 1) {
    w = (w << 8) | bin.charCodeAt(16 + i);
    h = (h << 8) | bin.charCodeAt(20 + i);
  }
  if (!(w > 0 && h > 0 && w <= 100000 && h <= 100000)) throw new Error('bad-source');
  return { w, h };
}

/**
 * Crop a rectangle out of a screenshot data URL, losslessly.
 * rect is in device pixels, as the overlay reports; it is clamped to the
 * bitmap, never resampled. Resolves { dataUrl, width, height } with a PNG
 * data URL. Throws 'bad-source', 'too-large' or 'bad-rect' on bad input.
 */
export async function cropPngDataUrl(dataUrl, rect) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('bad-source');
  }
  if (dataUrl.length > CROP_MAX_DATA_URL) throw new Error('too-large');
  const r = rect || {};
  const w = Math.round(Number(r.width) || 0);
  const h = Math.round(Number(r.height) || 0);
  if (!(w > 0 && h > 0 && w <= CROP_MAX_SIDE && h <= CROP_MAX_SIDE)) {
    throw new Error('bad-rect');
  }
  const x = Math.max(0, Math.round(Number(r.x) || 0));
  const y = Math.max(0, Math.round(Number(r.y) || 0));
  // F6: decode the screenshot data URL locally (chunked atob via
  // core/data-url.js); a fetch of the data URL is never used here.
  const blob = dataUrlToBlob(dataUrl);
  // Clamp against the real dimensions, read from the PNG header so the
  // image is decoded exactly once, already cropped.
  let pw = 0;
  let ph = 0;
  try {
    ({ w: pw, h: ph } = pngSize(dataUrl));
  } catch {
    const probe = await createImageBitmap(blob);
    pw = probe.width;
    ph = probe.height;
    probe.close();
  }
  const sx = Math.min(x, pw - 1);
  const sy = Math.min(y, ph - 1);
  const sw = Math.min(w, pw - sx);
  const sh = Math.min(h, ph - sy);
  if (sw <= 0 || sh <= 0) throw new Error('bad-rect');
  // Crop while decoding: 1:1, no resampling, and the full bitmap is never
  // allocated.
  const bitmap = await createImageBitmap(blob, sx, sy, sw, sh);
  try {
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const out = await canvas.convertToBlob({ type: 'image/png' });
    const outUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('encode-failed'));
      fr.readAsDataURL(out);
    });
    // Format fidelity: never return a mislabeled file.
    if (!outUrl.startsWith('data:image/png')) throw new Error('encode-unsupported');
    return { dataUrl: outUrl, width: sw, height: sh };
  } finally {
    bitmap.close();
  }
}
