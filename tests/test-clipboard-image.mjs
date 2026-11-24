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
 * ImgFetch: tests/test-clipboard-image.mjs
 * Pure Node unit tests for core/clipboard-image.js planCopy() and
 * planVisibleCopy(). Phase 5 item C: the planner NEVER downscales; an
 * image past the clipboard-safe size is reported as tooLarge so the
 * caller copies the visible part instead.
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import {
  planCopy,
  planVisibleCopy,
  isClipboardSizeSafe,
  CLIPBOARD_MAX_SIDE,
  CLIPBOARD_MAX_AREA,
} from '../core/clipboard-image.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

// 1. Safe-size constants are the Phase 5 conservative canvas limits.
check('max side is 16384', CLIPBOARD_MAX_SIDE === 16384);
check('max area is 268435456', CLIPBOARD_MAX_AREA === 268_435_456);
check('max area equals side squared', CLIPBOARD_MAX_AREA === CLIPBOARD_MAX_SIDE * CLIPBOARD_MAX_SIDE);

// 2. Under the safe size: full copy, never downscaled.
{
  const p = planCopy(640, 480);
  check('under safe size keeps width', p.width === 640);
  check('under safe size keeps height', p.height === 480);
  check('under safe size full=true', p.full === true);
  check('under safe size tooLarge=false', p.tooLarge === false);
}

// 3. Tiny image: full copy.
{
  const p = planCopy(1, 1);
  check('1x1 full copy', p.width === 1 && p.height === 1 && p.full === true);
}

// 4. Exact boundary: 16384x16384 (exactly the area cap) is a full copy.
{
  const p = planCopy(16384, 16384);
  check('16384x16384 full copy', p.full === true && p.tooLarge === false,
    `area=${16384 * 16384}`);
}

// 5. One pixel over the side limit: tooLarge, but the size is NOT shrunk.
{
  const p = planCopy(16385, 100);
  check('one pixel over side is tooLarge', p.tooLarge === true && p.full === false);
  check('tooLarge keeps the original width', p.width === 16385);
  check('tooLarge keeps the original height', p.height === 100);
}

// 6. One pixel over the area limit: tooLarge, size unchanged.
{
  const p = planCopy(16384, 16385);
  check('over area is tooLarge', p.tooLarge === true);
  check('over area keeps size', p.width === 16384 && p.height === 16385);
}

// 7. The old 12 MP downscale case is now a full copy: 1440x20000 fits
//    the area cap, and its height is over the side cap only when it is a
//    single image; a 1440x16000 part (the planner's largest for this
//    width) copies full size.
{
  const p = planCopy(1440, 16000);
  check('1440x16000 part is a full copy', p.full === true, JSON.stringify(p));
  const q = planCopy(2880, 16000);
  check('2880x16000 part is a full copy', q.full === true, JSON.stringify(q));
}

// 8. A long single image past the side cap is never shrunk by the planner.
{
  const p = planCopy(1440, 40000);
  check('1440x40000 tooLarge', p.tooLarge === true);
  check('1440x40000 size unchanged (no downscale)', p.width === 1440 && p.height === 40000);
}

// 9. isClipboardSizeSafe agrees with planCopy.
check('safe helper true in bounds', isClipboardSizeSafe(16384, 16384) === true);
check('safe helper false over side', isClipboardSizeSafe(16385, 100) === false);
check('safe helper false over area', isClipboardSizeSafe(16384, 16385) === false);
check('safe helper false on invalid', isClipboardSizeSafe(0, 100) === false);

// 10. planVisibleCopy: a view that fits is returned unchanged.
{
  const r = planVisibleCopy({ x: 100, y: 200, w: 800, h: 600 }, { width: 1440, height: 40000 });
  check('fitting view unchanged', r.x === 100 && r.y === 200 && r.w === 800 && r.h === 600,
    JSON.stringify(r));
}

// 11. planVisibleCopy: an oversize view is clamped to the safe size,
//     anchored at the view origin, never resampled (1:1 crop).
{
  const r = planVisibleCopy({ x: 0, y: 0, w: 2880, h: 40000 }, { width: 2880, height: 40000 });
  check('oversize view clamped to side cap', r.h === 16384 && r.w === 2880, JSON.stringify(r));
  check('clamped rect within safe area', r.w * r.h <= CLIPBOARD_MAX_AREA);
  check('clamped rect anchored at view origin', r.x === 0 && r.y === 0);
}

// 12. planVisibleCopy: a view past the image edge is clamped inside it.
{
  const r = planVisibleCopy({ x: 1400, y: 39900, w: 800, h: 600 }, { width: 1440, height: 40000 });
  check('edge view clamped inside image', r.x + r.w <= 1440 && r.y + r.h <= 40000, JSON.stringify(r));
  check('edge view keeps at least 1px', r.w >= 1 && r.h >= 1);
}

// 13. planVisibleCopy: a huge square view is clamped by area, not just side.
{
  const r = planVisibleCopy({ x: 0, y: 0, w: 40000, h: 40000 }, { width: 40000, height: 40000 });
  check('huge view within safe area', r.w * r.h <= CLIPBOARD_MAX_AREA, JSON.stringify(r));
  check('huge view within safe side', r.w <= 16384 && r.h <= 16384);
}

// 14. Invalid inputs throw a plain Error.
for (const [w, h] of [[0, 100], [100, 0], [-5, 100], [100, -1], [NaN, 100], [100, NaN],
    [Infinity, 100], [100, Infinity], ['640', 480], [640, '480'], [null, 480],
    [undefined, 100], [{}, 100]]) {
  let threw = false;
  let isError = false;
  try {
    planCopy(w, h);
  } catch (e) {
    threw = true;
    isError = e instanceof Error;
  }
  check(`planCopy throws on (${String(w)}, ${String(h)})`, threw && isError);
}
{
  let threw = false;
  try { planVisibleCopy({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 10 }); }
  catch { threw = true; }
  check('planVisibleCopy throws on empty image', threw);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
