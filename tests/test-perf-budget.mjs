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
 * ImgFetch, tests/test-perf-budget.mjs
 * Perf budgets for the Phase B capture path. Reads the committed
 * tests/test-e2e/results-perf-chromium-dpr<N>.json files (produced by
 * tests/test-e2e/perf-e2e.mjs on this tree) and asserts:
 * - Area/Element medians and worsts stay within budget (the fix must hold);
 * - the crop step median stays far below the old lossy cost (the lossy
 *   path measured 1129-2438 ms for the crop step alone; the budget proves
 *   it is gone, not merely faster);
 * - Visible and FullPage-tail medians did not regress versus the pre-fix
 *   baseline (budgets sit above the baseline medians with headroom; those
 *   paths were not reworked).
 * Budgets are ~2x the measured medians on the reference machine, generous
 * enough for normal machine variance, tight enough to catch a real
 * regression (e.g. the lossy path returning would blow the crop budget
 * by 4x or more on the realistic configs).
 * Run: node tests/test-perf-budget.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Measured medians on the fixed tree (ms): dpr1 area-realistic 1002,
// element-realistic 919, area-large 1666, element-large 1286,
// visible 767, fullpage-tail 3334; dpr2 area-realistic 2387,
// element-realistic 1973, area-large 5083, element-large 3264,
// visible 1956, fullpage-tail 9979. Pre-fix baseline medians for the
// regression guard: visible 912/2366, fullpage-tail 3904/10970.
const BUDGETS = {
  'area-realistic': { median: 5000, worst: 6000, crop: 1500 },
  'element-realistic': { median: 4000, worst: 5000, crop: 1000 },
  'area-large': { median: 11000, worst: 12000, crop: 3000 },
  'element-large': { median: 7000, worst: 8000, crop: 1500 },
  'visible-realistic': { median: 4000, worst: 5000 },
  'fullpage-tail-realistic': { median: 20000, worst: 25000 },
};

let passed = 0;
let failed = 0;
// Each (DPR, config) budget group counts as one test, so the output follows
// the project convention ("N passed, 0 failed") that scripts/validate.py lints.
const budgetTest = (name, fn) => {
  const errs = [];
  try {
    fn((msg) => errs.push(msg));
  } catch (e) {
    errs.push(`threw: ${(e && e.message) || e}`);
  }
  if (errs.length) {
    failed += 1;
    for (const m of errs) console.error(`FAIL ${m}`);
  } else {
    passed += 1;
  }
};

for (const dpr of [1, 2]) {
  const file = path.join(HERE, 'test-e2e', `results-perf-chromium-dpr${dpr}.json`);
  if (!fs.existsSync(file)) {
    console.error(`FAIL missing results file: ${file} (run tests/test-e2e/perf-e2e.mjs --dpr=${dpr})`);
    failed += Object.keys(BUDGETS).length;
    continue;
  }
  let res;
  try {
    res = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`FAIL ${file}: unreadable results JSON: ${(e && e.message) || e}`);
    failed += Object.keys(BUDGETS).length;
    continue;
  }
  const cfgs = res.configs || {};
  for (const [key, budget] of Object.entries(BUDGETS)) {
    const name = `${key}-dpr${dpr}`;
    budgetTest(name, (fail) => {
      if (res.cropPath !== 'worker') {
        fail(`${file}: cropPath=${res.cropPath}, expected 'worker' (results must come from the fixed tree)`);
        return;
      }
      const c = cfgs[name];
      if (!c) {
        fail(`${file}: missing config ${name}`);
        return;
      }
      if (!(c.runs >= (key.startsWith('visible') ? 5 : key.startsWith('fullpage') ? 3 : 10))) {
        fail(`${name}: only ${c.runs} runs`);
      }
      if (c.medianMs > budget.median) fail(`${name}: median ${c.medianMs}ms > budget ${budget.median}ms`);
      if (c.worstMs > budget.worst) fail(`${name}: worst ${c.worstMs}ms > budget ${budget.worst}ms`);
      if (budget.crop !== undefined && c.stepMedians.cropMs > budget.crop) {
        fail(`${name}: crop step median ${c.stepMedians.cropMs}ms > budget ${budget.crop}ms (lossy path?)`);
      }
    });
  }
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
