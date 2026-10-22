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
 * planCopy(width, height) answers: can this canvas be encoded and written
 * to the clipboard as-is, or must it be downscaled first to stay under the
 * pixel budget? The UI layer (shared/copy-shot.js) does the actual canvas
 * work; this module only computes sizes, so it is safe to test in Node.
 */

/**
 * Pixel budget for the clipboard PNG: 12,000,000 px (12 MP).
 *
 * Why this number: a 4K screenshot (3840 x 2160 = 8.3 MP) passes through
 * untouched, which covers every realistic screenshot on current displays.
 * Anything larger is downscaled before toBlob and the clipboard write, so
 * the visible page never allocates a giant canvas or blocks the UI on a
 * huge encode. The offscreen document's clipboardImage handler (used by the
 * background worker, which has no user gesture of its own) allows more
 * (8000 px side, 32 MP), because the capture pipeline must accept whatever
 * the screen produces; the visible page can afford to be more conservative.
 */
export const COPY_PIXEL_BUDGET = 12_000_000;

/**
 * Compute the output size for a clipboard copy of a width x height image.
 * Returns { width, height, downscaled, scale }.
 *   - area within budget: the size is returned unchanged (downscaled false).
 *   - area over budget: aspect-preserving downscale so the output area fits
 *     the budget; scale is the linear factor applied to each side, in (0, 1).
 * Throws a plain Error on non-finite or non-positive inputs; the UI layer
 * catches it and shows an honest toast.
 */
export function planCopy(width, height) {
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) {
    throw new Error('planCopy: width and height must be positive finite numbers');
  }
  const area = width * height;
  if (area <= COPY_PIXEL_BUDGET) {
    return { width, height, downscaled: false, scale: 1 };
  }
  const scale = Math.sqrt(COPY_PIXEL_BUDGET / area);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    downscaled: true,
    scale,
  };
}
