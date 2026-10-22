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
 * ImgFetch, tests/test-contract-fullpage.mjs
 * FIX 4 contract: the full-page planner's parts MUST all be accepted by
 * the offscreen stitcher, and together they MUST cover the whole page.
 * The planner and the stitcher share one rule
 * (isStitchSizeAccepted in core/fullpage-capture.js), so they can never
 * disagree: no more "bad-size" on tall pages at high DPR.
 *
 * Contract grid: page heights 1,000..60,000 CSS px, several viewports,
 * DPR 1 / 1.25 / 1.5 / 2 / 3.
 */
import { planFullPageCapture, isStitchSizeAccepted } from '../core/fullpage-capture.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push(`${name}${extra ? `, ${extra}` : ''}`); }
}

const heights = [1000, 3000, 6000, 8000, 12000, 20000, 30000, 40000, 60000];
const viewports = [[1280, 800], [1920, 900], [390, 844]];
const dprs = [1, 1.25, 1.5, 2, 3];

for (const h of heights) {
  for (const [vw, vh] of viewports) {
    for (const dpr of dprs) {
      const plan = planFullPageCapture({ fullW: vw, fullH: h, viewportW: vw, viewportH: vh, dpr });
      const label = `${vw}x${h} dpr=${dpr}`;
      // 1) every part is accepted by the stitcher's one shared rule.
      const allOk = plan.parts.every((p) => isStitchSizeAccepted(p.w, p.h));
      check(`contract parts accepted ${label}`, allOk,
        `rejected part in ${plan.parts.map((p) => `${p.w}x${p.h}`).join(',')}`);
      // 2) the parts cover the whole page: no truncation, no gaps.
      let y = 0;
      let contiguous = true;
      for (const p of plan.parts) {
        if (p.y0 !== y) contiguous = false;
        y = p.y0 + p.h;
      }
      check(`contract whole page covered ${label}`, contiguous && y === plan.devH,
        `covered=${y} devH=${plan.devH}`);
      // 3) tile offsets are exact integers (seam-free stitching).
      let exact = true;
      for (const p of plan.parts) {
        for (const t of p.tiles) {
          if (!Number.isInteger(t.dx) || !Number.isInteger(t.dy)) exact = false;
        }
      }
      check(`contract integer tile offsets ${label}`, exact);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('Failures (first 10):');
  for (const f of failures.slice(0, 10)) console.log(`  FAIL ${f}`);
}
process.exit(fail ? 1 : 0);
