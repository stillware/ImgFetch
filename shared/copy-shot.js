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
 * ImgFetch: shared/copy-shot.js
 * UI glue for the annotate editor's Copy button: copies the flattened,
 * currently edited canvas to the clipboard as image/png.
 *
 * Direct-write decision: offscreen/offscreen.js has a clipboardImage
 * handler because the background service worker has no DOM and no user
 * gesture of its own, so it cannot touch navigator.clipboard directly and
 * the offscreen document performs the write on the worker's behalf.
 * pages/annotate.html is a visible, focused extension page and this handler
 * runs inside the click's user gesture (the manifest already grants
 * clipboardWrite), so navigator.clipboard.write is called directly here.
 * Routing through the offscreen document would only add hops and lose the
 * gesture; the page already has everything it needs.
 *
 * Contract: initCopyButton(button, getEditor, deps). getEditor returns the
 * CURRENT flattened canvas; the caller (pages/annotate.js) calls redraw()
 * first so selection chrome and drag previews are never copied. deps is an
 * optional test seam { t, toast }; it defaults to the real i18n t() and to
 * window.ImgFetchUI.toast (guarded, toast is best-effort).
 *
 * Failure contract: the click handler never throws, never crashes the
 * editor, never modifies the editor canvas (the screenshot is never lost),
 * and never fails silently: every outcome ends in a toast. Phase 5 item C:
 * a failed copy is never retried at a smaller size; the user gets an
 * honest error that suggests Save instead. A copy is either full
 * resolution or, when the image is past the clipboard-safe size, the
 * currently shown part at full resolution with a toast that says so.
 */
import { t as translate } from './i18n.js';
import { planCopy, planVisibleCopy } from '../core/clipboard-image.js';
import {
  copySuccessToastKind,
  LARGE_COPY_TOAST_MS,
} from './platform.js';

function defaultToast(message, ms, icon) {
  try {
    const ui = typeof window !== 'undefined' ? window.ImgFetchUI : null;
    if (ui && typeof ui.toast === 'function') ui.toast(message, ms, icon);
  } catch {
    /* toast is best-effort; the copy result must not depend on it */
  }
}

/**
 * Success toast for a copy whose PNG is already written: the shared
 * decision in shared/platform.js picks the long Windows hint (with its
 * longer display time) for a large PNG on Windows, and the short
 * success toast everywhere else. Phase 5 item C: there are no downscaled
 * copies any more, so this helper is the only success path.
 */
function toastCopySuccess(t, toast, pngBlob) {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const kind = copySuccessToastKind(nav, pngBlob && pngBlob.size, false);
  if (kind === 'windows-large') {
    toast(t('copy_windowsToast'), LARGE_COPY_TOAST_MS);
    return;
  }
  toast(t('copySuccess'), undefined, 'check');
}

/**
 * Start a clipboard write for one PNG source. Called synchronously from
 * the click handler with a promise-backed ClipboardItem, so the write
 * is registered inside the user gesture even when the PNG encode (or a
 * resized decode) finishes later. `pngPromise` resolves with the PNG
 * Blob to write.
 */
function startClipboardWrite(pngPromise) {
  // The promise's rejection is the clipboard's failure signal. Attach a
  // handler up front so a synchronous failure below (or a stubbed
  // clipboard in tests) can never leave that rejection unhandled; the
  // promise's state, which the ClipboardItem reads, is unchanged.
  Promise.resolve(pngPromise).catch(() => {});
  if (typeof ClipboardItem === 'undefined') throw new Error('ClipboardItem unavailable');
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || !nav.clipboard || typeof nav.clipboard.write !== 'function') {
    throw new Error('clipboard write unavailable');
  }
  return nav.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
}

function encodePng(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png encode failed'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Encode a 1:1 crop of the flattened editor canvas as a PNG. Source and
 * destination sizes always match, so this never resamples: a crop that
 * covers the whole canvas encodes the canvas itself, with no temp canvas
 * at all. (The blob path below never touches a canvas for a PNG blob.)
 */
async function encodeCropPng(canvas, rect) {
  if (rect.x === 0 && rect.y === 0 && rect.w === canvas.width && rect.h === canvas.height) {
    return encodePng(canvas);
  }
  const tmp = document.createElement('canvas');
  tmp.width = rect.w;
  tmp.height = rect.h;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return encodePng(tmp);
}

async function runCopy(getEditor, t, toast, getViewRect) {
  const canvas = getEditor();
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) ||
      canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('no image to copy');
  }
  // Phase 5 item C: copy at full resolution, never downscaled.
  // navigator.clipboard.write is called synchronously (the caller is the
  // click handler) with a promise-backed ClipboardItem, so the encode
  // can take its time without ever losing the user gesture.
  const plan = planCopy(canvas.width, canvas.height);
  if (plan.full) {
    const firstPng = encodePng(canvas);
    let written = null;
    const tracked = firstPng.then((blob) => { written = blob; return blob; });
    await startClipboardWrite(tracked);
    toastCopySuccess(t, toast, written);
    return;
  }
  // Past the clipboard-safe size: copy the part currently shown, at
  // full resolution, and say so. Never silently shrink the image.
  const view = typeof getViewRect === 'function' ? getViewRect() : null;
  const rect = planVisibleCopy(
    view || { x: 0, y: 0, w: canvas.width, h: canvas.height },
    { width: canvas.width, height: canvas.height });
  const visiblePng = encodeCropPng(canvas, rect);
  await startClipboardWrite(visiblePng);
  toast(t('copyVisiblePart', { width: rect.w, height: rect.h }));
}

export function initCopyButton(button, getEditor, deps) {
  const t = (deps && deps.t) || translate;
  const toast = (deps && deps.toast) || defaultToast;
  // Optional: the editor's current view rectangle in full-image pixels
  // (pages/annotate.js passes viewRect). Used only when the whole image
  // is past the clipboard-safe size, to copy the part currently shown.
  const getViewRect = (deps && typeof deps.getViewRect === 'function') ? deps.getViewRect : null;
  button.addEventListener('click', () => {
    // This handler never throws: every failure path ends in an honest
    // toast, and the editor canvas is never modified, so the screenshot
    // always survives a failed copy. The copy itself starts
    // synchronously in this handler (see runCopy), so the clipboard
    // write is registered inside the click's user gesture.
    runCopy(getEditor, t, toast, getViewRect).catch((err) => {
      console.debug('[copy-shot] copy failed', err);
      try {
        toast(t('copyFailed'));
      } catch {
        /* the editor must keep working even if the toast itself fails */
      }
    });
  });
}
/**
 * Copy a stored capture image (a Blob, e.g. one stitched part) to the
 * clipboard. Phase 5 item C: a PNG blob is written byte for byte, with
 * no canvas at all; any other format is decoded and re-encoded as PNG
 * at its native size. There is no size budget, no downscale and no
 * half-size retry: a failed write is an honest failure, never a smaller
 * copy. Never throws: every outcome ends in a toast. deps is the same
 * { t, toast } test seam as above.
 */
export async function copyImageBlob(blob, deps) {
  const t = (deps && deps.t) || translate;
  const toast = (deps && deps.toast) || defaultToast;
  try {
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
      throw new Error('no image to copy');
    }
    // Prepare the PNG to write: the stored blob itself on the
    // byte-for-byte fast path, otherwise a full-size decode encoded at
    // native size. Resolves with the PNG Blob to write.
    let pngPromise;
    if (blob.type === 'image/png') {
      pngPromise = Promise.resolve(blob);
    } else {
      pngPromise = (async () => {
        const bitmap = await createImageBitmap(blob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return encodePng(canvas);
        } finally {
          try { bitmap.close(); } catch { /* already closed */ }
        }
      })();
    }
    // The write starts with a promise-backed ClipboardItem (the caller
    // is the click handler), so the decode and encode can finish after
    // the gesture without losing it. `written` captures the PNG that
    // actually got written, for the success toast's size decision.
    let written = null;
    const tracked = pngPromise.then((png) => { written = png; return png; });
    await startClipboardWrite(tracked);
    toastCopySuccess(t, toast, written);
  } catch (err) {
    console.debug('[copy-shot] blob copy failed', err);
    try { toast(t('copyFailed')); } catch { /* a toast must not throw */ }
  }
}
