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
 * ImgFetch, tests/test-welcome-dots.mjs
 *
 * Phase 6 item 5.1: the welcome progress dots must match the step on
 * all four steps, in LTR and RTL, after fast Next and Back clicks and
 * after keyboard use. Loads the real pages/welcome.html plus the real
 * shared/ui.js and pages/welcome.js in jsdom with a stubbed chrome
 * API, then drives the real Next and Back buttons and reads the real
 * dots. The dot index is the DOM index: in RTL the row mirrors
 * visually, but the first dot in the DOM is still step 0.
 *
 * Requires jsdom: kept out of the shipped zip. Self-skips when jsdom
 * cannot be required.
 * Run: NODE_PATH=$IMGFETCH_TESTDEPS/node_modules node tests/test-welcome-dots.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIPPED: jsdom not installed (npm i jsdom to run the real-DOM suite)');
  process.exit(0);
}
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}
function eq(actual, want, name) {
  ok(actual === want, `${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`);
}

// The source pins the rule the test guards: the dot whose index equals
// the step is on, every other dot is off. An off-by-one here (i + 1,
// i - 1, or a stale index) is the bug the owner reported.
const welcomeJs = readFileSync(join(PROJ, 'pages/welcome.js'), 'utf8');
ok(welcomeJs.includes("dots().forEach((d, i) => d.classList.toggle('on', i === step));"),
  'welcome.js toggles the dot whose index equals the step');
ok(welcomeJs.includes("steps().forEach((s, i) => s.classList.toggle('active', i === step));"),
  'welcome.js activates the step whose index equals the step');

const html = readFileSync(join(PROJ, 'pages/welcome.html'), 'utf8');
const settings = {
  theme: 'light',
  annotateAfterCapture: false,
  askFilename: false,
  subfolder: '',
  useSubfolder: false,
  afterDownload: 'silent',
};

const dom = await new JSDOM(html, {
  url: `file://${join(PROJ, 'pages/welcome.html')}`,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    });
    window.close = () => {};
    window.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage(msg, cb) {
          if (msg && msg.type === 'GET_SETTINGS') {
            setTimeout(() => cb({ ok: true, settings }), 0);
            return;
          }
          setTimeout(() => cb({ ok: true }), 0);
        },
      },
      storage: {
        local: {
          get(_keys, cb) { setTimeout(() => cb({}), 0); },
          set(_items, cb) { if (cb) setTimeout(() => cb(), 0); },
        },
      },
      commands: {
        getAll: async () => [],
      },
      tabs: {
        create: () => {},
      },
    };
  },
});
const { window } = dom;
const { document } = window;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// Wait for the page scripts (theme-init, ui.js, welcome.js) and the
// async GET_SETTINGS round trip to finish painting.
await new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else window.addEventListener('load', resolve);
});
await tick(50);

const steps = () => [...document.querySelectorAll('.step')];
const dots = () => [...document.querySelectorAll('.dots i')];
const activeStep = () => steps().findIndex((s) => s.classList.contains('active'));
const onDots = () => dots().map((d) => d.classList.contains('on'));

function checkDots(step, label) {
  eq(activeStep(), step, `${label}: active step is ${step}`);
  eq(JSON.stringify(onDots()), JSON.stringify([0, 1, 2, 3].map((i) => i === step)),
    `${label}: exactly the dot for step ${step} is on`);
}

eq(steps().length, 4, 'welcome has four steps');
eq(dots().length, 4, 'welcome has four dots');
checkDots(0, 'initial');

const next = document.getElementById('btnNext');
const back = document.getElementById('btnBack');

// Fast Next clicks, no waiting between them.
next.click(); next.click(); next.click();
await tick(20);
checkDots(3, 'three fast Next clicks');

// Fast Back clicks back to the start.
back.click(); back.click(); back.click();
await tick(20);
checkDots(0, 'three fast Back clicks');

// One step at a time, forwards and back.
next.click();
await tick(20);
checkDots(1, 'one Next click');
back.click();
await tick(20);
checkDots(0, 'one Back click');

// Keyboard: welcome.js adds no key handler of its own, so keyboard
// use depends on native button activation. jsdom has no activation
// behaviour for synthetic key events, so the Enter advance itself is
// proven in the real browser harness; here the test pins the
// properties it depends on: Next is a real focusable button, and a
// click on the focused button (the event native Enter/Space
// activation fires) advances the step and the dot together.
eq(next.tagName, 'BUTTON', 'Next is a real button, not a clickable div');
ok(!next.disabled, 'Next is enabled');
ok(next.tabIndex >= 0, 'Next is in the tab order');
next.focus();
eq(document.activeElement, next, 'Next takes focus');
next.click();
await tick(20);
checkDots(1, 'click on the focused Next advances one step');
next.click();
await tick(20);
checkDots(2, 'click on the focused Next advances a second step');

// RTL: the DOM dot index must still match the step.
document.documentElement.dir = 'rtl';
back.click(); back.click();
await tick(20);
checkDots(0, 'RTL back to step 0');
next.click(); next.click(); next.click();
await tick(20);
checkDots(3, 'RTL three fast Next clicks');
document.documentElement.dir = 'ltr';

console.log(`welcome dots: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
