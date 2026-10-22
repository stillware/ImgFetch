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
 * ImgFetch, tests/test-no-lossy-pipeline.mjs
 * Static scan: no internal capture-pipeline step may encode with a quality
 * below 1. The Area/Element bug was a hard-coded `quality: 0.92` on the
 * internal crop call, which the offscreen encoder treated as the
 * user-facing PNG quality-slider feature (median-cut colour reduction:
 * slow and lossy). The slider stays for the Save flow the user chooses in
 * Settings; it must never leak into an internal intermediate image.
 * Run: node tests/test-no-lossy-pipeline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argProj = process.argv.find((a) => a.startsWith('--proj='));
const PROJ = argProj ? path.resolve(argProj.slice('--proj='.length)) : path.resolve(HERE, '..');

const DIRS = ['background', 'offscreen', 'pages', 'content', 'core', 'popup', 'options', 'shared'];
const SKIP_FILES = new Set([
  // The slider feature itself: legitimately maps 0.1-1 to palette sizes.
  'core/png-quantize.js',
  // User-facing quality plumbing (Settings sliders, clamps, migration).
  'core/export.js',
  'core/settings.js',
]);

function jsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name)) out.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(PROJ, d));
  return out;
}

/** Strip block and line comments so prose cannot trip identifier checks. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

let passed = 0;
let failed = 0;
// Each numbered check below counts as one test, so the output follows the
// project convention ("N passed, 0 failed") that scripts/validate.py lints.
const check = (name, fn) => {
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

// 1. No hard-coded fractional quality in any production call or assignment.
check('no hard-coded quality below 1 in production calls', (fail) => {
  for (const f of jsFiles()) {
    const rel = path.relative(PROJ, f).replace(/\\/g, '/');
    if (SKIP_FILES.has(rel)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/[{,]\s*quality\s*:\s*0\.\d+/.test(line) || /\bquality\s*=\s*0\.\d+/.test(line)) {
        fail(`${rel}:${i + 1}: hard-coded quality below 1: ${line.trim().slice(0, 120)}`);
      }
    });
  }
});

// 2. quantizePngRgba is only ever called by the offscreen encoder, which
// serves the user-facing Save flow (PNG slider / format conversion).
check('quantizePngRgba only called by offscreen encoder', (fail) => {
  for (const f of jsFiles()) {
    const rel = path.relative(PROJ, f).replace(/\\/g, '/');
    if (rel === 'core/png-quantize.js' || rel === 'offscreen/offscreen.js') continue;
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    if (/quantizePngRgba\s*\(/.test(src)) {
      fail(`${rel}: calls quantizePngRgba outside offscreen/offscreen.js`);
    }
  }
});

// 3. The in-worker crop takes no quality parameter at all: lossless by
// construction, so the slider path cannot leak back in.
check('in-worker crop takes no quality parameter', (fail) => {
  const cropFile = path.join(PROJ, 'core/crop-image.js');
  if (fs.existsSync(cropFile)) {
    const src = stripComments(fs.readFileSync(cropFile, 'utf8'));
    if (/\bquality\b/i.test(src)) {
      fail('core/crop-image.js mentions quality: the crop must stay lossless by construction');
    }
  }
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
