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
 * Pure Node unit tests for core/clipboard-image.js planCopy().
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { planCopy, COPY_PIXEL_BUDGET } from '../core/clipboard-image.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

// 1. Budget constant is sane and exported.
check('budget exported and positive', Number.isFinite(COPY_PIXEL_BUDGET) && COPY_PIXEL_BUDGET > 0);
check('4K screenshot fits the budget', 3840 * 2160 <= COPY_PIXEL_BUDGET);

// 2. Under budget: passthrough, not downscaled.
{
  const p = planCopy(640, 480);
  check('under budget keeps width', p.width === 640);
  check('under budget keeps height', p.height === 480);
  check('under budget downscaled=false', p.downscaled === false);
  check('under budget scale=1', p.scale === 1);
}

// 3. Tiny image: passthrough.
{
  const p = planCopy(1, 1);
  check('1x1 passthrough', p.width === 1 && p.height === 1 && p.downscaled === false);
}

// 4. Exact boundary: area == budget passes through unchanged.
{
  const w = 4000;
  const h = Math.floor(COPY_PIXEL_BUDGET / w); // w*h <= budget by construction
  const p = planCopy(w, h);
  check('exact boundary passthrough', p.downscaled === false && p.width === w && p.height === h,
    `w=${w} h=${h} area=${w * h} budget=${COPY_PIXEL_BUDGET}`);
}

// 5. One pixel over the boundary downscales.
{
  const w = 4000;
  const h = Math.floor(COPY_PIXEL_BUDGET / w) + 1; // area > budget
  const p = planCopy(w, h);
  check('one pixel over downscales', p.downscaled === true, `area=${w * h}`);
}

// 6. Over budget: aspect-preserving downscale, ratio kept within 1 px.
{
  const w = 6000;
  const h = 4000; // 24 MP, over a 12 MP budget
  const p = planCopy(w, h);
  check('over budget downscaled=true', p.downscaled === true);
  check('scale in (0,1)', p.scale > 0 && p.scale < 1, `scale=${p.scale}`);
  check('scale matches sqrt(budget/area)',
    Math.abs(p.scale - Math.sqrt(COPY_PIXEL_BUDGET / (w * h))) < 1e-12);
  check('output width is floor(w*scale)', p.width === Math.max(1, Math.floor(w * p.scale)));
  check('output height is floor(h*scale)', p.height === Math.max(1, Math.floor(h * p.scale)));
  check('output area within budget', p.width * p.height <= COPY_PIXEL_BUDGET,
    `area=${p.width * p.height}`);
  const expectedW = (w / h) * p.height; // aspect of the input, solved for width
  check('aspect preserved within 1px', Math.abs(p.width - expectedW) <= 1,
    `out=${p.width}x${p.height} expectedW=${expectedW}`);
}

// 7. Extreme panorama still fits the budget after downscale.
{
  const p = planCopy(30000, 1000); // 30 MP, very wide
  check('panorama downscaled', p.downscaled === true);
  check('panorama area within budget', p.width * p.height <= COPY_PIXEL_BUDGET);
  check('panorama dims >= 1', p.width >= 1 && p.height >= 1);
}

// 8. Invalid inputs throw a plain Error.
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
  check(`throws on (${String(w)}, ${String(h)})`, threw && isError);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
