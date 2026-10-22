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
 * ImgFetch: tests/test-parts-overview.mjs
 * Node unit tests for the Parts overview helpers in shared/platform.js:
 * Windows platform detection (injectable, so no real navigator is
 * needed) and the "large copy" rule behind the Windows clipboard
 * history note. Prints "N passed, M failed", exits nonzero on failure.
 * Run: node tests/test-parts-overview.mjs
 */
import {
  isWindowsPlatformString,
  platformStringOf,
  isWindowsPlatform,
  isLargeCopy,
  shouldShowWindowsClipboardNote,
  LARGE_COPY_AREA_PX,
  copySuccessToastKind,
  LARGE_COPY_TOAST_BYTES,
  LARGE_COPY_TOAST_MS,
} from '../shared/platform.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

// --- isWindowsPlatformString ---
check('Win32 is Windows', isWindowsPlatformString('Win32') === true);
check('Windows is Windows', isWindowsPlatformString('Windows') === true);
check('lowercase win is Windows', isWindowsPlatformString('win32') === true);
check('MacIntel is not Windows', isWindowsPlatformString('MacIntel') === false);
check('Linux is not Windows', isWindowsPlatformString('Linux x86_64') === false);
check('empty string is not Windows', isWindowsPlatformString('') === false);
check('null is not Windows', isWindowsPlatformString(null) === false);
check('number is not Windows', isWindowsPlatformString(42) === false);

// --- platformStringOf ---
check('userAgentData platform wins', platformStringOf({ userAgentData: { platform: 'Win32' }, platform: 'Linux' }) === 'Win32');
check('legacy platform is the fallback', platformStringOf({ platform: 'Win32' }) === 'Win32');
check('empty userAgentData platform falls back', platformStringOf({ userAgentData: { platform: '' }, platform: 'MacIntel' }) === 'MacIntel');
check('no platform anywhere gives empty', platformStringOf({}) === '');
check('null navigator gives empty', platformStringOf(null) === '');
check('non-object gives empty', platformStringOf('Win32') === '');

// --- isWindowsPlatform (injected navigator) ---
check('injected Win32 userAgentData', isWindowsPlatform({ userAgentData: { platform: 'Win32' } }) === true);
check('injected Win32 legacy platform', isWindowsPlatform({ platform: 'Win32' }) === true);
check('userAgentData overrides a Windows legacy value', isWindowsPlatform({ userAgentData: { platform: 'Linux' }, platform: 'Win32' }) === false);
check('injected Mac is not Windows', isWindowsPlatform({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }) === false);
check('null navigator is not Windows', isWindowsPlatform(null) === false);
check('empty navigator is not Windows', isWindowsPlatform({}) === false);

// --- isLargeCopy: the ~2 MP rule, multi-part always counts ---
check('area budget is about 2 MP', LARGE_COPY_AREA_PX === 2_000_000);
check('small single image is not large', isLargeCopy(100, 100, false) === false);
check('4 MP single image is large', isLargeCopy(2000, 2000, false) === true);
check('exactly 2 MP is not large', isLargeCopy(1000, 2000, false) === false);
check('just over 2 MP is large', isLargeCopy(1001, 2000, false) === true);
check('tiny part of a multi-part capture is large', isLargeCopy(10, 10, true) === true);
check('zero-size part of a multi-part capture is large', isLargeCopy(0, 0, true) === true);
check('invalid dims are not large', isLargeCopy(NaN, 100, false) === false);
check('missing dims are not large', isLargeCopy(undefined, undefined, false) === false);

// --- shouldShowWindowsClipboardNote ---
const WIN = { userAgentData: { platform: 'Win32' } };
const LINUX = { userAgentData: { platform: 'Linux' } };
check('Windows + large shows the note', shouldShowWindowsClipboardNote(WIN, 3000, 3000, false) === true);
check('Windows + multi-part shows the note', shouldShowWindowsClipboardNote(WIN, 10, 10, true) === true);
check('Windows + small hides the note', shouldShowWindowsClipboardNote(WIN, 100, 100, false) === false);
check('Linux + large hides the note', shouldShowWindowsClipboardNote(LINUX, 3000, 3000, false) === false);
check('Linux + multi-part hides the note', shouldShowWindowsClipboardNote(LINUX, 10, 10, true) === false);

// --- copySuccessToastKind: the copy toast hint decision (Phase C3) ---
// Editor context: the annotate editor applies the same note rule to a
// loaded record (Windows + large/part shows, everything else hides).
check('editor context: Windows + large record shows the note',
  shouldShowWindowsClipboardNote(WIN, 2560, 1440, false) === true);
check('editor context: Windows + part record shows the note',
  shouldShowWindowsClipboardNote(WIN, 800, 600, true) === true);
check('editor context: Windows + small record hides the note',
  shouldShowWindowsClipboardNote(WIN, 800, 600, false) === false);
check('editor context: non-Windows + large record hides the note',
  shouldShowWindowsClipboardNote(LINUX, 2560, 1440, false) === false);

check('toast byte threshold is about 3.5 MB', LARGE_COPY_TOAST_BYTES === 3_500_000);
check('toast duration is longer than the normal toast', LARGE_COPY_TOAST_MS > 2600);
check('Windows + PNG over threshold gets the windows-large toast',
  copySuccessToastKind(WIN, 3_500_001, false) === 'windows-large');
check('Windows + PNG exactly at threshold keeps the normal toast',
  copySuccessToastKind(WIN, 3_500_000, false) === 'normal');
check('Windows + small PNG keeps the normal toast',
  copySuccessToastKind(WIN, 120_000, false) === 'normal');
check('non-Windows + large PNG keeps the normal toast',
  copySuccessToastKind(LINUX, 9_000_000, false) === 'normal');
check('no navigator + large PNG keeps the normal toast',
  copySuccessToastKind(null, 9_000_000, false) === 'normal');
check('Windows + large but downscaled keeps the downscaled toast',
  copySuccessToastKind(WIN, 9_000_000, true) === 'downscaled');
check('non-Windows + downscaled is downscaled',
  copySuccessToastKind(LINUX, 9_000_000, true) === 'downscaled');
check('Windows + unknown byte size keeps the normal toast',
  copySuccessToastKind(WIN, undefined, false) === 'normal');
check('Windows + NaN byte size keeps the normal toast',
  copySuccessToastKind(WIN, NaN, false) === 'normal');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
