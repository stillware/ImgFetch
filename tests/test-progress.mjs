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
 * ImgFetch test: round 5 capture progress contracts.
 *
 * Section 1 pins the CAPTURE_PROGRESS / GET_CAPTURE_PROGRESS message
 * contract in core/validation.js: a well-formed progress payload is
 * valid, malformed payloads (missing or unknown phase, non-integer,
 * negative, out-of-range, or inconsistent counts) are rejected, and
 * the sender rules keep both types extension-only, so a content
 * script can never forge capture progress.
 *
 * Section 2 pins UI.toast de-duplication in shared/ui.js (round 5):
 * a repeated identical text replaces the visible toast and restarts
 * its timer instead of stacking; distinct texts still stack up to
 * the cap of 3. Uses jsdom's real DOM like test-svg-real-dom.mjs and
 * self-skips when jsdom is not installed.
 *
 * Run: node tests/test-progress.mjs
 * (jsdom via NODE_PATH=$IMGFETCH_TESTDEPS/node_modules, optional.)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isValidMessage,
  SENDER_RULES,
  MESSAGE_TYPES,
} from '../core/validation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? `, ${extra}` : ''}`);
  }
}

/* ================================================== 1. message contract */
console.log('1. CAPTURE_PROGRESS / GET_CAPTURE_PROGRESS validation');

const good = { type: 'CAPTURE_PROGRESS', part: 1, partTotal: 2, tile: 3, tileCount: 30, phase: 'capturing' };
check('well-formed capturing progress is valid', isValidMessage(good) === true);
for (const p of ['done', 'stopped', 'error']) {
  check(`end phase "${p}" is valid`, isValidMessage({ ...good, phase: p }) === true);
}
check('boundary counts are valid', isValidMessage({
  type: 'CAPTURE_PROGRESS', part: 1_000_000, partTotal: 1_000_000, tile: 1_000_000, tileCount: 1_000_000, phase: 'capturing',
}) === true);
check('tile 0 (not started) is valid', isValidMessage({ ...good, tile: 0 }) === true);

const badCases = [
  ['missing phase', { type: 'CAPTURE_PROGRESS', part: 1, partTotal: 1, tile: 1, tileCount: 1 }],
  ['unknown phase', { ...good, phase: 'exploded' }],
  ['non-string phase', { ...good, phase: 7 }],
  ['missing tile', { type: 'CAPTURE_PROGRESS', part: 1, partTotal: 1, tileCount: 1, phase: 'capturing' }],
  ['string tile', { ...good, tile: '3' }],
  ['float tile', { ...good, tile: 1.5 }],
  ['negative tile', { ...good, tile: -1 }],
  ['NaN part', { ...good, part: NaN }],
  ['infinite tileCount', { ...good, tileCount: Infinity }],
  ['count over the sane bound', { ...good, part: 1_000_001, partTotal: 1_000_001 }],
  ['partTotal zero', { ...good, part: 0, partTotal: 0 }],
  ['tileCount zero', { ...good, tile: 0, tileCount: 0 }],
  ['part beyond partTotal', { ...good, part: 3, partTotal: 2 }],
  ['tile beyond tileCount', { ...good, tile: 31, tileCount: 30 }],
  ['null payload fields', { ...good, part: null }],
];
for (const [name, msg] of badCases) {
  check(`rejected: ${name}`, isValidMessage(msg) === false);
}

check('GET_CAPTURE_PROGRESS bare request is valid', isValidMessage({ type: 'GET_CAPTURE_PROGRESS' }) === true);
check('MESSAGE_TYPES knows CAPTURE_PROGRESS', MESSAGE_TYPES.has('CAPTURE_PROGRESS'));
check('MESSAGE_TYPES knows GET_CAPTURE_PROGRESS', MESSAGE_TYPES.has('GET_CAPTURE_PROGRESS'));
check('CAPTURE_PROGRESS is extension-only',
  Array.isArray(SENDER_RULES.CAPTURE_PROGRESS) && SENDER_RULES.CAPTURE_PROGRESS.length === 1
  && SENDER_RULES.CAPTURE_PROGRESS[0] === 'extension',
  JSON.stringify(SENDER_RULES.CAPTURE_PROGRESS));
check('GET_CAPTURE_PROGRESS is extension-only',
  Array.isArray(SENDER_RULES.GET_CAPTURE_PROGRESS) && SENDER_RULES.GET_CAPTURE_PROGRESS.length === 1
  && SENDER_RULES.GET_CAPTURE_PROGRESS[0] === 'extension',
  JSON.stringify(SENDER_RULES.GET_CAPTURE_PROGRESS));
check('NOTICE_TEXT is still not a valid inbound message',
  isValidMessage({ type: 'NOTICE_TEXT', text: 'hi' }) === false);

/* ================================================== 2. toast de-dup */
console.log('2. UI.toast de-duplication (jsdom)');

const require = createRequire(import.meta.url);
let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIPPED toast section: jsdom not installed (npm i jsdom to run it)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (JSDOM) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.invalid/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'ui.js'), 'utf8');
  window.eval(src);
  const UI = window.ImgFetchUI;
  check('ImgFetchUI loads in jsdom', !!UI && typeof UI.toast === 'function');
  const toasts = () => [...window.document.querySelectorAll('.toast')];
  const texts = () => toasts().map((el) => el.textContent);

  UI.toast('Same text', 5000);
  UI.toast('Same text', 5000);
  UI.toast('Same text', 5000);
  check('identical text never stacks', toasts().length === 1, `saw ${toasts().length}`);
  check('the single toast keeps the text', texts()[0] === 'Same text');

  UI.toast('Other text', 5000);
  check('distinct texts do stack', toasts().length === 2, `saw ${toasts().length}`);

  UI.toast('Third text', 5000);
  UI.toast('Fourth text', 5000);
  check('stack cap of 3 still holds', toasts().length === 3, `saw ${toasts().length}`);

  // Timer restart: a repeat must extend the visible life of the toast.
  const dom2 = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.invalid/',
    runScripts: 'outside-only',
  });
  dom2.window.eval(src);
  const UI2 = dom2.window.ImgFetchUI;
  const toasts2 = () => [...dom2.window.document.querySelectorAll('.toast')];
  UI2.toast('Short lived', 250);
  await sleep(150);
  UI2.toast('Short lived', 250); // restarts the 250 ms timer
  await sleep(150); // 300 ms after the first call: gone without the restart
  check('a repeat restarts the dismiss timer', toasts2().length === 1, `saw ${toasts2().length}`);
  await sleep(250); // 400 ms after the repeat: expired
  check('the restarted toast still expires', toasts2().length === 0, `saw ${toasts2().length}`);
  dom2.window.close();
  window.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
