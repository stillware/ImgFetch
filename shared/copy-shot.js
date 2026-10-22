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
 * and never fails silently: every outcome ends in a toast. On failure the
 * copy is retried once at a smaller size; if that fails too the user gets
 * an honest error that suggests Save instead.
 */
import { t as translate } from './i18n.js';
import { planCopy } from '../core/clipboard-image.js';
import {
  copySuccessToastKind,
  LARGE_COPY_TOAST_MS,
} from './platform.js';

function defaultToast(message, ms) {
  try {
    const ui = typeof window !== 'undefined' ? window.ImgFetchUI : null;
    if (ui && typeof ui.toast === 'function') ui.toast(message, ms);
  } catch {
    /* toast is best-effort; the copy result must not depend on it */
  }
}

/**
 * Success toast for a copy whose PNG is already written: the shared
 * decision in shared/platform.js picks the long Windows hint (with its
 * longer display time) for a large PNG on Windows, and the short
 * success toast everywhere else. Downscaled copies never reach this
 * helper; their own toast already reports the size.
 */
function toastCopySuccess(t, toast, pngBlob) {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const kind = copySuccessToastKind(nav, pngBlob && pngBlob.size, false);
  if (kind === 'windows-large') {
    toast(t('copy_windowsToast'), LARGE_COPY_TOAST_MS);
    return;
  }
  toast(t('copySuccess'));
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
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Encode the flattened editor canvas as a PNG at width x height. A copy
 * that must shrink draws the (already allocated) editor canvas into a
 * target-size canvas only: no second full-size canvas is allocated, and
 * the full-size image is never encoded or decoded just to shrink it.
 * (The blob path below, whose source is a stored Blob rather than a
 * canvas, uses createImageBitmap resize options to the same end.)
 */
async function encodeCanvasPng(canvas, width, height) {
  if (width === canvas.width && height === canvas.height) {
    const blob = await encodePng(canvas);
    if (!blob) throw new Error('png encode failed');
    return blob;
  }
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const ctx = tmp.getContext('2d');
  try {
    ctx.imageSmoothingQuality = 'high';
  } catch {
    /* older canvas implementations ignore the quality hint */
  }
  ctx.drawImage(canvas, 0, 0, width, height);
  const blob = await encodePng(tmp);
  if (!blob) throw new Error('png encode failed');
  return blob;
}

async function runCopy(getEditor, t, toast) {
  const canvas = getEditor();
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) ||
      canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('no image to copy');
  }
  // First attempt: full size, or pre-downscaled when over the pixel budget.
  // navigator.clipboard.write is called synchronously (the caller is the
  // click handler) with a promise-backed ClipboardItem, so the encode
  // can take its time without ever losing the user gesture.
  const plan = planCopy(canvas.width, canvas.height);
  const firstPng = encodeCanvasPng(canvas, plan.width, plan.height);
  let written = null;
  const tracked = firstPng.then((blob) => { written = blob; return blob; });
  try {
    await startClipboardWrite(tracked);
    if (plan.downscaled) {
      toast(t('copyDownscaled', { width: plan.width, height: plan.height }));
    } else {
      toastCopySuccess(t, toast, written);
    }
    return;
  } catch (firstErr) {
    console.debug('[copy-shot] first copy attempt failed', firstErr);
    if (plan.downscaled) throw firstErr; // already shrunk: nothing smaller to try
  }
  // Second attempt: halve the longest side (aspect preserved) and retry once.
  const longest = Math.max(canvas.width, canvas.height);
  const factor = (longest / 2) / longest;
  const w2 = Math.max(1, Math.floor(canvas.width * factor));
  const h2 = Math.max(1, Math.floor(canvas.height * factor));
  await startClipboardWrite(encodeCanvasPng(canvas, w2, h2));
  toast(t('copyDownscaled', { width: w2, height: h2 }));
}

export function initCopyButton(button, getEditor, deps) {
  const t = (deps && deps.t) || translate;
  const toast = (deps && deps.toast) || defaultToast;
  button.addEventListener('click', () => {
    // This handler never throws: every failure path ends in an honest
    // toast, and the editor canvas is never modified, so the screenshot
    // always survives a failed copy. The copy itself starts
    // synchronously in this handler (see runCopy), so the clipboard
    // write is registered inside the click's user gesture.
    runCopy(getEditor, t, toast).catch((err) => {
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
 * clipboard. The blob is decoded with createImageBitmap resize options
 * when the copy plan downscales it, so a huge part is never drawn into
 * a full-size canvas just to shrink it; a PNG blob that already fits
 * the plan is written as-is, with no canvas at all. On a failed write
 * the copy is retried once at half size (unless it was already
 * downscaled), mirroring the editor path. Never throws: every outcome
 * ends in a toast. deps is the same { t, toast } test seam as above.
 */
export async function copyImageBlob(blob, deps) {
  const t = (deps && deps.t) || translate;
  const toast = (deps && deps.toast) || defaultToast;
  try {
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
      throw new Error('no image to copy');
    }
    // One decode just for the dimensions (the bitmap is closed right
    // away; nothing is drawn from it).
    const probe = await createImageBitmap(blob);
    const fullW = probe.width;
    const fullH = probe.height;
    try { probe.close(); } catch { /* already closed */ }
    const plan = planCopy(fullW, fullH);
    // Prepare the PNG for one attempt without touching the clipboard:
    // the stored blob itself on the byte-for-byte fast path, otherwise
    // a resized decode (never a full-size canvas) encoded at the target
    // size. Resolves with the PNG Blob to write.
    const preparePng = async (target, width, height) => {
      if (target) return target;
      const resized = await createImageBitmap(blob, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(resized, 0, 0);
        const out = await encodePng(canvas);
        if (!out) throw new Error('png encode failed');
        return out;
      } finally {
        try { resized.close(); } catch { /* already closed */ }
      }
    };
    // Fast path: a PNG blob within the plan is copied byte for byte.
    const direct = !plan.downscaled && blob.type === 'image/png' ? blob : null;
    try {
      // The write starts synchronously with a promise-backed
      // ClipboardItem (caller is the click handler), so the resized
      // decode and encode can finish after the gesture without losing
      // it. `written` captures the PNG that actually got written, for
      // the success toast's size decision.
      let written = null;
      const pngPromise = preparePng(direct, plan.width, plan.height)
        .then((png) => { written = png; return png; });
      await startClipboardWrite(pngPromise);
      if (plan.downscaled) {
        toast(t('copyDownscaled', { width: plan.width, height: plan.height }));
      } else {
        toastCopySuccess(t, toast, written);
      }
      return;
    } catch (firstErr) {
      console.debug('[copy-shot] blob copy attempt failed', firstErr);
      if (plan.downscaled || direct === null) throw firstErr;
    }
    // Retry once at half size via a resized decode, never a big canvas.
    const w2 = Math.max(1, Math.floor(fullW / 2));
    const h2 = Math.max(1, Math.floor(fullH / 2));
    await startClipboardWrite(preparePng(null, w2, h2));
    toast(t('copyDownscaled', { width: w2, height: h2 }));
  } catch (err) {
    console.debug('[copy-shot] blob copy failed', err);
    try { toast(t('copyFailed')); } catch { /* a toast must not throw */ }
  }
}
