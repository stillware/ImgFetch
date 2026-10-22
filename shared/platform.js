/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch, shared/platform.js
 * Tiny platform helpers shared by the result pages. The detection logic
 * is pure and injectable (pass a navigator-shaped object, or a bare
 * platform string to the *FromString core) so it is unit-testable in
 * Node, where no navigator exists.
 */

/**
 * Pixel area above which a single copied image counts as "large" for
 * the Windows clipboard-history note: about 2 megapixels. Below this a
 * copy is an ordinary screenshot and the note would just be noise.
 */
export const LARGE_COPY_AREA_PX = 2_000_000;

/** True when a platform string names Windows ("Win32", "Windows", ...). */
export function isWindowsPlatformString(platform) {
  return typeof platform === 'string' && /win/i.test(platform);
}

/**
 * Best platform string a navigator-shaped object can offer:
 * userAgentData.platform (the modern, honest value) wins, the legacy
 * navigator.platform string is the fallback. Returns '' when neither
 * is available. Pure: the object is passed in, never read globally.
 */
export function platformStringOf(nav) {
  if (!nav || typeof nav !== 'object') return '';
  const uad = nav.userAgentData;
  if (uad && typeof uad.platform === 'string' && uad.platform) return uad.platform;
  if (typeof nav.platform === 'string' && nav.platform) return nav.platform;
  return '';
}

/**
 * True when the user is on Windows. `nav` defaults to the global
 * navigator; tests pass a fake. Detection only: no side effects.
 */
export function isWindowsPlatform(nav) {
  const target = nav !== undefined
    ? nav
    : (typeof navigator !== 'undefined' ? navigator : null);
  return isWindowsPlatformString(platformStringOf(target));
}

/**
 * Whether the Windows clipboard-history note applies to one image:
 * the image is part of a multi-part capture (always large in spirit),
 * or a single image whose area passes the ~2 MP rule.
 */
export function isLargeCopy(width, height, isMultiPart) {
  if (isMultiPart) return true;
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return w * h > LARGE_COPY_AREA_PX;
}

/** The note shows only on Windows, and only for a large copy. */
export function shouldShowWindowsClipboardNote(nav, width, height, isMultiPart) {
  return isWindowsPlatform(nav) && isLargeCopy(width, height, isMultiPart);
}

/**
 * Byte size above which a successfully written PNG earns the longer
 * Windows copy toast (about 3.5 MB). Windows clipboard history cannot
 * show images anywhere near this size, so a large copy deserves the
 * explicit "paste with Ctrl+V" hint; a small copy keeps the short
 * success toast everywhere.
 */
export const LARGE_COPY_TOAST_BYTES = 3_500_000;

/** How long the large-copy Windows toast stays up (the normal toast is ~2.6 s). */
export const LARGE_COPY_TOAST_MS = 6000;

/**
 * Which success toast a completed copy gets: 'windows-large' only when
 * the platform is Windows AND the PNG that was actually written is
 * larger than LARGE_COPY_TOAST_BYTES. `downscaled` copies already say
 * their size in their own toast, so they never take this branch. Pure
 * and injectable like the rest of this module (nav may be a fake).
 */
export function copySuccessToastKind(nav, pngBytes, downscaled) {
  if (downscaled) return 'downscaled';
  const bytes = Number(pngBytes);
  if (isWindowsPlatform(nav) && Number.isFinite(bytes) && bytes > LARGE_COPY_TOAST_BYTES) {
    return 'windows-large';
  }
  return 'normal';
}
