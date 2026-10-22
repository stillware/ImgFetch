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
 * ImgFetch, tests/test-html-modules.mjs
 *
 * Script-loading contract (handoff 4.4): an HTML page whose JS uses a
 * static `import` statement MUST load it with <script type="module">,
 * otherwise the page dies with "Cannot use import statement outside a
 * module". Classic scripts (content scripts, pages using dynamic
 * import()) may load either way.
 *
 * For every extension HTML page, parse its <script src> tags; for each
 * referenced .js file check for static imports. Static import without
 * type="module" fails the run.
 *
 * Run: node tests/test-html-modules.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(HERE, '..');

const PAGES = [
  'popup/popup.html',
  'options/options.html',
  'pages/welcome.html',
  'pages/rename.html',
  'pages/capture.html',
  'pages/annotate.html',
  'pages/info.html',
  'offscreen/offscreen.html',
];

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

// Static import statement at the start of a line: `import x from`,
// `import {`, `import '...'`. Dynamic import() is fine in classic scripts,
// and import.meta is not an import statement; neither may match.
const STATIC_IMPORT = /^\s*import(?:\s+[^('"\s]|\s*['"])/m;

const SCRIPT_TAG = /<script\b([^>]*)>/gi;
const SRC_ATTR = /\bsrc\s*=\s*"([^"]+)"/i;
const TYPE_ATTR = /\btype\s*=\s*"([^"]+)"/i;

for (const page of PAGES) {
  const htmlPath = join(PROJ, page);
  let html;
  try {
    html = readFileSync(htmlPath, 'utf8');
  } catch (e) {
    ok(false, `${page} readable`, e.message);
    continue;
  }
  const pageDir = dirname(htmlPath);
  let tag;
  SCRIPT_TAG.lastIndex = 0;
  let sawScript = false;
  while ((tag = SCRIPT_TAG.exec(html)) !== null) {
    const attrs = tag[1];
    const srcM = SRC_ATTR.exec(attrs);
    if (!srcM) continue; // inline script, out of scope
    sawScript = true;
    const src = srcM[1];
    const typeM = TYPE_ATTR.exec(attrs);
    const isModule = typeM && typeM[1].toLowerCase() === 'module';
    let js;
    try {
      js = readFileSync(resolve(pageDir, src), 'utf8');
    } catch (e) {
      ok(false, `${page} -> ${src} readable`, e.message);
      continue;
    }
    const hasStaticImport = STATIC_IMPORT.test(js);
    ok(
      !hasStaticImport || isModule,
      `${page}: ${src} ${hasStaticImport ? 'has static import' : 'is classic'} -> ${isModule ? 'type=module' : 'classic script tag'}`,
      hasStaticImport && !isModule ? 'static import without type="module"' : '',
    );
  }
  ok(sawScript, `${page} has at least one external script`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);