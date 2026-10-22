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

function defaultToast(message) {
  try {
    const ui = typeof window !== 'undefined' ? window.ImgFetchUI : null;
    if (ui && typeof ui.toast === 'function') ui.toast(message);
  } catch {
    /* toast is best-effort; the copy result must not depend on it */
  }
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

function downscaleCanvas(canvas, width, height) {
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
  return tmp;
}

async function writePngToClipboard(canvas) {
  const blob = await encodePng(canvas);
  if (!blob) throw new Error('png encode failed');
  if (typeof ClipboardItem === 'undefined') throw new Error('ClipboardItem unavailable');
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || !nav.clipboard || typeof nav.clipboard.write !== 'function') {
    throw new Error('clipboard write unavailable');
  }
  await nav.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

async function runCopy(getEditor, t, toast) {
  const canvas = getEditor();
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) ||
      canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('no image to copy');
  }
  // First attempt: full size, or pre-downscaled when over the pixel budget.
  const plan = planCopy(canvas.width, canvas.height);
  const first = plan.downscaled ? downscaleCanvas(canvas, plan.width, plan.height) : canvas;
  try {
    await writePngToClipboard(first);
    toast(plan.downscaled
      ? t('copyDownscaled', { width: plan.width, height: plan.height })
      : t('copySuccess'));
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
  await writePngToClipboard(downscaleCanvas(canvas, w2, h2));
  toast(t('copyDownscaled', { width: w2, height: h2 }));
}

export function initCopyButton(button, getEditor, deps) {
  const t = (deps && deps.t) || translate;
  const toast = (deps && deps.toast) || defaultToast;
  button.addEventListener('click', async () => {
    // This handler never throws: every failure path ends in an honest
    // toast, and the editor canvas is never modified, so the screenshot
    // always survives a failed copy.
    try {
      await runCopy(getEditor, t, toast);
    } catch (err) {
      console.debug('[copy-shot] copy failed', err);
      try {
        toast(t('copyFailed'));
      } catch {
        /* the editor must keep working even if the toast itself fails */
      }
    }
  });
}
