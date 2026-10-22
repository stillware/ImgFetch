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
 * ImgFetch, core/crop-rect.js
 * Pure crop-rectangle geometry for the annotate editor's Crop tool.
 * No DOM, no chrome.*: unit-testable in Node.
 *
 * Rectangles are plain { x, y, w, h } objects in integer image pixels.
 * Every function validates and clamps its inputs (values are never
 * trusted from the DOM or from storage): non-finite or missing fields
 * make the result null (or false for isValidRect), sizes are kept inside
 * the image, and the minimum crop size is enforced. The editor stores
 * the applied crop in original-image coordinates and the pending crop
 * selection in view coordinates (the current crop, or the full image
 * when no crop is applied); the view/image converters translate between
 * the two without any scaling, so the exported rectangle is always
 * exactly the rectangle the size label showed.
 */

/** Smallest crop width or height, in image pixels. */
export const MIN_CROP_SIZE = 8;

/** The 8 resize handles, clockwise from the top-left corner. */
export const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function intOrNaN(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

function imageSize(imgW, imgH) {
  const w = intOrNaN(imgW);
  const h = intOrNaN(imgH);
  if (!(w > 0 && h > 0)) return null;
  return { w, h };
}

/** The full-image rectangle, or null for an invalid image size. */
export function fullRect(imgW, imgH) {
  const s = imageSize(imgW, imgH);
  return s ? { x: 0, y: 0, w: s.w, h: s.h } : null;
}

/**
 * True when rect is a structurally sound crop for the image: integer
 * fields, positive size, fully inside the image. This is a sanity gate
 * for values coming from outside the module, not the minimum-size rule
 * (clampRect enforces that on top).
 */
export function isValidRect(rect, imgW, imgH) {
  const s = imageSize(imgW, imgH);
  if (!s || !rect || typeof rect !== 'object') return false;
  const x = intOrNaN(rect.x);
  const y = intOrNaN(rect.y);
  const w = intOrNaN(rect.w);
  const h = intOrNaN(rect.h);
  if ([x, y, w, h].some(Number.isNaN)) return false;
  return x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= s.w && y + h <= s.h;
}

/**
 * Validate and clamp a rectangle into the image: fields are rounded to
 * integers, the size is grown to the minimum (or shrunk to the image),
 * and the position slides so the rectangle lies fully inside. Returns
 * null when the image size or any field is not a finite number.
 */
export function clampRect(rect, imgW, imgH) {
  const s = imageSize(imgW, imgH);
  if (!s || !rect || typeof rect !== 'object') return null;
  let x = intOrNaN(rect.x);
  let y = intOrNaN(rect.y);
  let w = intOrNaN(rect.w);
  let h = intOrNaN(rect.h);
  if ([x, y, w, h].some(Number.isNaN)) return null;
  const minW = Math.min(MIN_CROP_SIZE, s.w);
  const minH = Math.min(MIN_CROP_SIZE, s.h);
  w = Math.min(Math.max(w, minW), s.w);
  h = Math.min(Math.max(h, minH), s.h);
  x = Math.min(Math.max(x, 0), s.w - w);
  y = Math.min(Math.max(y, 0), s.h - h);
  return { x, y, w, h };
}

/**
 * Rectangle spanned by two drag corners. The corners are first clamped
 * into the image (a drag that leaves the canvas stops at the border, it
 * does not slide the anchored edge), then the span is normalized and
 * clamped like any other rectangle.
 */
export function rectFromPoints(ax, ay, bx, by, imgW, imgH) {
  const s = imageSize(imgW, imgH);
  if (!s) return null;
  const cx = (v) => Math.min(Math.max(v, 0), s.w);
  const cy = (v) => Math.min(Math.max(v, 0), s.h);
  const x0 = intOrNaN(ax);
  const y0 = intOrNaN(ay);
  const x1 = intOrNaN(bx);
  const y1 = intOrNaN(by);
  if ([x0, y0, x1, y1].some(Number.isNaN)) return null;
  return clampRect({
    x: Math.min(cx(x0), cx(x1)),
    y: Math.min(cy(y0), cy(y1)),
    w: Math.abs(cx(x1) - cx(x0)),
    h: Math.abs(cy(y1) - cy(y0)),
  }, imgW, imgH);
}

/** Move a rectangle by an integer delta, sliding at the image edges. */
export function moveRect(rect, dx, dy, imgW, imgH) {
  if (!rect || typeof rect !== 'object') return null;
  const mx = intOrNaN(dx);
  const my = intOrNaN(dy);
  if (Number.isNaN(mx) || Number.isNaN(my)) return null;
  return clampRect({
    x: Number(rect.x) + mx,
    y: Number(rect.y) + my,
    w: rect.w,
    h: rect.h,
  }, imgW, imgH);
}

/** Keyboard nudge: the same clamped move, named for its call site. */
export function nudgeRect(rect, dx, dy, imgW, imgH) {
  return moveRect(rect, dx, dy, imgW, imgH);
}

/**
 * Resize a rectangle by dragging one handle by an integer delta. The
 * opposite edge stays put; the dragged edge stops at the image border
 * and at the minimum size. Unknown handles return the clamped input.
 */
export function resizeRect(rect, handle, dx, dy, imgW, imgH) {
  const s = imageSize(imgW, imgH);
  const base = clampRect(rect, imgW, imgH);
  if (!s || !base) return null;
  const mx = intOrNaN(dx);
  const my = intOrNaN(dy);
  if (Number.isNaN(mx) || Number.isNaN(my)) return null;
  if (!CROP_HANDLES.includes(handle)) return base;
  const minW = Math.min(MIN_CROP_SIZE, s.w);
  const minH = Math.min(MIN_CROP_SIZE, s.h);
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;
  if (handle.includes('w')) {
    left += mx;
    left = Math.min(Math.max(left, 0), right - minW);
  }
  if (handle.includes('e')) {
    right += mx;
    right = Math.max(Math.min(right, s.w), left + minW);
  }
  if (handle.includes('n')) {
    top += my;
    top = Math.min(Math.max(top, 0), bottom - minH);
  }
  if (handle.includes('s')) {
    bottom += my;
    bottom = Math.max(Math.min(bottom, s.h), top + minH);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** True when both rectangles are the same (null equals only null). */
export function rectsEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function offsetOf(crop) {
  if (!crop || typeof crop !== 'object') return { x: 0, y: 0 };
  const x = intOrNaN(crop.x);
  const y = intOrNaN(crop.y);
  return { x: Number.isNaN(x) ? 0 : x, y: Number.isNaN(y) ? 0 : y };
}

/** View point to original-image point (adds the applied crop offset). */
export function viewToImagePoint(x, y, crop) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const o = offsetOf(crop);
  return [px + o.x, py + o.y];
}

/** Original-image point to view point (subtracts the crop offset). */
export function imageToViewPoint(x, y, crop) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const o = offsetOf(crop);
  return [px - o.x, py - o.y];
}

/**
 * A rectangle picked in the current view becomes a crop in original
 * image coordinates: offset by the applied crop, clamped to the image.
 */
export function viewToImageRect(viewRect, crop, imgW, imgH) {
  if (!viewRect || typeof viewRect !== 'object') return null;
  const o = offsetOf(crop);
  return clampRect({
    x: Number(viewRect.x) + o.x,
    y: Number(viewRect.y) + o.y,
    w: viewRect.w,
    h: viewRect.h,
  }, imgW, imgH);
}

/**
 * An original-image rectangle expressed in the current view: offset
 * removed, clamped to the view size (the applied crop, or the image).
 */
export function imageToViewRect(imageRect, crop, imgW, imgH) {
  const s = imageSize(imgW, imgH);
  if (!s || !imageRect || typeof imageRect !== 'object') return null;
  const view = (crop && isValidRect(crop, s.w, s.h))
    ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h }
    : { x: 0, y: 0, w: s.w, h: s.h };
  return clampRect({
    x: Number(imageRect.x) - view.x,
    y: Number(imageRect.y) - view.y,
    w: imageRect.w,
    h: imageRect.h,
  }, view.w, view.h);
}
