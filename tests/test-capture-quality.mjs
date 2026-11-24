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
 * ImgFetch: tests/test-capture-quality.mjs
 * Phase 5 item C unit tests: the conservative canvas limits
 * (16384 px per side, 268,435,456 total pixels) and the part counts
 * they imply for the prompt's synthetic pages, with no truncation and
 * no downscale anywhere in the plan. The real-browser pixel proof
 * lives in tests/test-e2e/capture-quality-e2e.mjs.
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import {
  planFullPageCapture,
  isStitchSizeAccepted,
  PART_MAX_SIDE,
  PART_MAX_AREA,
} from '../core/fullpage-capture.js';
import { planCopy } from '../core/clipboard-image.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

function checkPlan(name, opts, expectedParts) {
  const p = planFullPageCapture(opts);
  check(`${name}: ${expectedParts} part(s)`, p.parts.length === expectedParts,
    `got ${p.parts.length} (${p.parts.map((pt) => `${pt.w}x${pt.h}`).join(', ')})`);
  check(`${name}: every part within the canvas limits`,
    p.parts.every((pt) => isStitchSizeAccepted(pt.w, pt.h)),
    p.parts.map((pt) => `${pt.w}x${pt.h}`).join(', '));
  let y = 0;
  let contiguous = true;
  for (const pt of p.parts) {
    if (pt.y0 !== y) contiguous = false;
    y += pt.h;
  }
  check(`${name}: parts tile the page exactly, no gaps, no truncation`,
    contiguous && y === p.devH, `covered=${y} devH=${p.devH}`);
  check(`${name}: not sanity capped`, p.sanityCapped === false);
  return p;
}

// The prompt's synthetic pages: 1440 CSS px wide, 800 CSS px viewport.
checkPlan('8000px DPR 1', { fullW: 1440, fullH: 8000, viewportW: 1440, viewportH: 800, dpr: 1 }, 1);
checkPlan('20000px DPR 1', { fullW: 1440, fullH: 20000, viewportW: 1440, viewportH: 800, dpr: 1 }, 2);
checkPlan('40000px DPR 1', { fullW: 1440, fullH: 40000, viewportW: 1440, viewportH: 800, dpr: 1 }, 3);
checkPlan('60000px DPR 1', { fullW: 1440, fullH: 60000, viewportW: 1440, viewportH: 800, dpr: 1 }, 4);
checkPlan('40000px DPR 2', { fullW: 1440, fullH: 40000, viewportW: 1440, viewportH: 800, dpr: 2 }, 5);
checkPlan('60000px DPR 2', { fullW: 1440, fullH: 60000, viewportW: 1440, viewportH: 800, dpr: 2 }, 8);
checkPlan('40000px DPR 1.25', { fullW: 1440, fullH: 40000, viewportW: 1440, viewportH: 800, dpr: 1.25 }, 4);
checkPlan('40000px DPR 1.5', { fullW: 1440, fullH: 40000, viewportW: 1440, viewportH: 800, dpr: 1.5 }, 4);

// A wide page: the area cap never lets a part past the limits either.
{
  const p = planFullPageCapture({ fullW: 4000, fullH: 20000, viewportW: 2000, viewportH: 1000, dpr: 1 });
  check('wide page: every part within limits',
    p.parts.every((pt) => isStitchSizeAccepted(pt.w, pt.h)));
  check('wide page: whole page covered',
    p.parts.reduce((n, pt) => n + pt.h, 0) === p.devH);
}

// The limits themselves are the Phase 5 conservative values.
check('side limit is 16384', PART_MAX_SIDE === 16384);
check('area limit is 268435456', PART_MAX_AREA === 268_435_456);

// Every part the planner emits for the acceptance pages fits the
// clipboard-safe size, so editor Copy is a full-resolution copy.
for (const [h, dpr] of [[40000, 1], [40000, 2]]) {
  const p = planFullPageCapture({ fullW: 1440, fullH: h, viewportW: 1440, viewportH: 800, dpr });
  const allFull = p.parts.every((pt) => planCopy(pt.w, pt.h).full === true);
  check(`acceptance ${h}px DPR ${dpr}: every part copies full size`, allFull,
    p.parts.map((pt) => `${pt.w}x${pt.h}`).join(', '));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
