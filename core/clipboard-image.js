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
 * ImgFetch: core/clipboard-image.js
 * Pure copy-size planner for the annotate editor's Copy button.
 * No DOM, no chrome.*: unit-testable in Node.
 *
 * Phase 5 item C: this module NEVER plans a downscale. The old 12 MP
 * budget silently shrank every long screenshot on Copy (a 1440x20000
 * part was copied at 0.65 scale, a 1440x29600 part at 0.53), which is
 * exactly the blur the owner saw when pasting into a viewer and zooming:
 * fine text and 1 px grid lines cannot survive a 0.5 scale. The capture
 * and stitch are pixel exact (measured: tile vs stitched PNG exact
 * fraction 1.0000 at every height and DPR), and a full-resolution PNG
 * written to the clipboard and read back is also pixel exact (measured
 * up to 2160x30000), so there is no quality reason to shrink.
 *
 * planCopy(width, height) answers: can this image be written to the
 * clipboard at full resolution, or is it past the clipboard-safe size?
 * The safe size is the conservative canvas limit from the Phase 5 brief
 * (16384 px per side, 268,435,456 total pixels), verified against the
 * real browser: a 16384x16384 canvas allocates and PNG-encodes, and a
 * full-resolution clipboard write/read round-trips pixel exact up to
 * 2160x30000. When the image is past the safe size the caller must NOT
 * shrink it: it copies the part currently shown instead (see
 * planVisibleCopy) and tells the user why.
 */

export const CLIPBOARD_MAX_SIDE = 16384;
export const CLIPBOARD_MAX_AREA = 268_435_456;

/** True when width x height fits the clipboard-safe size. */
export function isClipboardSizeSafe(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return w <= CLIPBOARD_MAX_SIDE && h <= CLIPBOARD_MAX_SIDE && w * h <= CLIPBOARD_MAX_AREA;
}

/**
 * Compute the copy plan for a width x height image.
 * Returns { width, height, full, tooLarge }.
 *   - within the safe size: the size is returned unchanged (full true).
 *   - past the safe size: the size is still returned unchanged, with
 *     full false and tooLarge true. The caller copies the visible part
 *     (planVisibleCopy) instead of shrinking; nothing here ever returns
 *     a smaller size.
 * Throws a plain Error on non-finite or non-positive inputs; the UI layer
 * catches it and shows an honest toast.
 */
export function planCopy(width, height) {
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) {
    throw new Error('planCopy: width and height must be positive finite numbers');
  }
  const full = isClipboardSizeSafe(width, height);
  return { width, height, full, tooLarge: !full };
}

/**
 * The rectangle to copy when the whole image is too large for the
 * clipboard: the part currently shown, clamped to the clipboard-safe
 * size. view is { x, y, w, h } in full-image pixels (the editor's
 * current view: the crop, or the whole image); full is
 * { width, height } of the image. Returns { x, y, w, h }, always inside
 * the image, always within the safe size, always at least 1x1, and
 * never resampled: the caller draws this source rectangle 1:1.
 * The rectangle is anchored at the view origin, so the user gets the
 * top-left of what they are looking at.
 */
export function planVisibleCopy(view, full) {
  const rawW = Number((full && full.width) || 0);
  const rawH = Number((full && full.height) || 0);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    throw new Error('planVisibleCopy: full image size must be positive');
  }
  const fw = Math.max(1, Math.floor(rawW));
  const fh = Math.max(1, Math.floor(rawH));
  const vx = Math.max(0, Math.floor(Number((view && view.x) || 0)));
  const vy = Math.max(0, Math.floor(Number((view && view.y) || 0)));
  const vw = Math.max(1, Math.floor(Number((view && view.w) || 0)));
  const vh = Math.max(1, Math.floor(Number((view && view.h) || 0)));
  const x = Math.min(vx, fw - 1);
  const y = Math.min(vy, fh - 1);
  let w = Math.min(vw, fw - x, CLIPBOARD_MAX_SIDE);
  let h = Math.min(vh, fh - y, CLIPBOARD_MAX_SIDE);
  if (w * h > CLIPBOARD_MAX_AREA) {
    const scale = Math.sqrt(CLIPBOARD_MAX_AREA / (w * h));
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
  }
  return { x, y, w, h };
}
