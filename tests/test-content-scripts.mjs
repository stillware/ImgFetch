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
 * ImgFetch, tests/test-content-scripts.mjs
 *
 * Content-script contract (handoff 4.4): content/overlay.js is injected via
 * chrome.scripting.executeScript({ files }) and therefore runs as a classic
 * script: it must contain NO static import/export statement. Its picker
 * functions take an optional `hints` object (English defaults when omitted),
 * and the service worker must pass localized hints through executeScript
 * args at every injection site.
 *
 * Run: node tests/test-content-scripts.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(HERE, '..');

let passed = 0;
let failed = 0;
function ok(cond, name, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const overlay = readFileSync(join(PROJ, 'content/overlay.js'), 'utf8');
const worker = readFileSync(join(PROJ, 'background/service-worker.js'), 'utf8');

// 1. No static import/export in the content script. Dynamic import() and
// import.meta are not import statements; `export` must be followed by
// whitespace so words like "Exposes" in comments cannot match.
const STATIC_IMPORT = /^\s*import(?:\s+[^('"\s]|\s*['"])/m;
const STATIC_EXPORT = /^\s*export\s/m;
ok(!STATIC_IMPORT.test(overlay), 'content/overlay.js has no static import');
ok(!STATIC_EXPORT.test(overlay), 'content/overlay.js has no static export');
ok(!/\bimport\s*\(/.test(overlay), 'content/overlay.js has no dynamic import() either');

// 2. The three picker functions accept an optional hints parameter.
for (const fn of ['selectArea', 'selectElement', 'pickElement']) {
  ok(
    new RegExp(`function ${fn}\\s*\\(\\s*hints\\s*\\)`).test(overlay),
    `content/overlay.js ${fn}(hints) accepts the hints param`,
  );
}

// 3. Each hint falls back to the exact English default when omitted.
const DEFAULTS = {
  select: 'Drag to select: arrows move, Shift+arrows resize, Enter confirms, Esc cancels',
  capture: 'Click an element to capture it, Esc to cancel',
  inspect: 'Click an element to inspect its image, Esc to cancel',
};
for (const [field, text] of Object.entries(DEFAULTS)) {
  ok(
    overlay.includes(`(hints && hints.${field}) || '${text}'`),
    `content/overlay.js hints.${field} defaults to the English string`,
  );
}

// 4. The service worker passes localized hints at the injection sites.
ok(/async function overlayHints\(\)/.test(worker), 'service worker defines overlayHints()');
for (const key of ['overlay_selectHint', 'overlay_captureHint', 'overlay_inspectHint']) {
  ok(worker.includes(`t('${key}')`), `service worker resolves t('${key}')`);
}
ok(/args:\s*\[hints\]/.test(worker), 'service worker passes hints via executeScript args');
const hintCallSites = (worker.match(/args:\s*\[hints\]/g) || []).length;
ok(hintCallSites >= 2, `hints passed at ${hintCallSites} executeScript call sites (>= 2)`, 'captureRegion + handleSelectElement');
ok(
  /window\.__imgfetch\.selectArea\(hints\)/.test(worker) &&
    /window\.__imgfetch\.selectElement\(hints\)/.test(worker) &&
    /window\.__imgfetch\.pickElement\(hints\)/.test(worker),
  'service worker calls selectArea/selectElement/pickElement with hints',
);

// 5. The worker never top-level-awaits i18n startup (it kills the MV3 worker).
ok(!/^await\s+i18nReady/m.test(worker), 'service worker has no top-level await i18nReady');
ok(/(const|let) i18nReady = initI18n\(\);/.test(worker), 'service worker starts i18n without awaiting (let: refreshed on language change)');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);