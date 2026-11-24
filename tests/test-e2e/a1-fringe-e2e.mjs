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
 * ImgFetch e2e: tests/test-e2e/a1-fringe-e2e.mjs
 * Real-browser suite for the Phase 6 item 6 A1 rule: the outermost 12 px
 * of the popup home view must equal the app background, except the known
 * shadow fringe (the Scan button and hero drop shadows bleeding into the
 * band) of up to 16 levels per channel. The literal tolerance-0 assertion
 * from Phase 5 is gone; this is the rule that replaces it.
 *
 * The band is checked by the shared checkOuterBand rule from
 * tests/test-a1-fringe.mjs (unit-tested there on synthetic pixels), here
 * applied to real popup screenshots at DPR 1, 1.25, 1.5 and 2, dark and
 * light. Screenshots are decoded in Node with a minimal PNG decoder
 * (8-bit, non-interlaced, colour types 0/2/4/6).
 *
 * Measured on the Phase 5 baseline tree (2026-11-24, Chromium under
 * Xvfb): dark peaks at 15/16/16/17 levels across DPR 1/1.25/1.5/2, light
 * at 13/14/14/15. The dark DPR 2 peak of 17 is one level past the
 * accepted 16: it is the Scan button's designed box-shadow
 * (rgba(91, 80, 230, 0.35), 12 px blur) at CSS (11.5, 317), the same
 * spot at every DPR, and it is reported here as a failure of the
 * as-written rule rather than hidden. If the owner accepts 17, the
 * bound in this file is the one place to change.
 *
 * Run under a virtual display:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/a1-fringe-e2e.mjs [--out=results.json]
 */
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = _require('playwright'));
} catch {
  const pwPath = process.env.PLAYWRIGHT_PACKAGE;
  if (!pwPath) throw new Error('playwright not resolvable: set PLAYWRIGHT_PACKAGE to the installed package path');
  ({ chromium } = _require(pwPath));
}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { checkOuterBand } from '../test-a1-fringe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const HEADED = args.headed !== undefined ? !!args.headed : true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Owner-accepted fringe: 16 levels per channel in the outer 12 CSS px. */
const MAX_LEVELS = 16;
const BAND_CSS_PX = 12;

/* Minimal PNG decoder: 8-bit, non-interlaced, colour types 0/2/4/6. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let w; let h; let bitDepth; let colorType;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG');
    }
    if (type === 'IDAT') idats.push(data);
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const f = raw[p]; p += 1;
    const row = raw.subarray(p, p + stride); p += stride;
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= ch && prev ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      cur[x] = v;
    }
  }
  return { w, h, ch, data: out };
}

async function launch(dsf) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-a1-e2e-'));
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: !HEADED,
      viewport: { width: 400, height: 600 },
      deviceScaleFactor: dsf,
      args: [
        `--disable-extensions-except=${PROJ}`,
        `--load-extension=${PROJ}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--force-device-scale-factor=${dsf}`,
      ],
    });
  } catch (e) {
    // One retry on a flaky first launch, reported not hidden.
    console.log(`launch retry (dsf ${dsf}): ${e.message.slice(0, 120)}`);
    return chromium.launchPersistentContext(userDataDir, {
      headless: !HEADED,
      viewport: { width: 400, height: 600 },
      deviceScaleFactor: dsf,
      args: [
        `--disable-extensions-except=${PROJ}`,
        `--load-extension=${PROJ}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--force-device-scale-factor=${dsf}`,
      ],
    });
  }
}

const results = [];
for (const theme of ['dark', 'light']) {
  for (const dsf of [1, 1.25, 1.5, 2]) {
    const ctx = await launch(dsf);
    try {
      let sw = ctx.serviceWorkers()[0];
      if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
      const extId = new URL(sw.url()).host;
      const page = await ctx.newPage();
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`chrome-extension://${extId}/popup/popup.html`);
      await sleep(1500);
      const bg = await page.evaluate(() => ({
        bodyBg: getComputedStyle(document.body).backgroundColor,
        w: window.innerWidth, h: window.innerHeight, dsf: window.devicePixelRatio,
      }));
      const shot = await page.screenshot();
      const img = decodePng(shot);
      const m = bg.bodyBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) throw new Error(`unparsed background ${bg.bodyBg}`);
      const bgRgb = [Number(m[1]), Number(m[2]), Number(m[3])];
      const bandPx = Math.round(BAND_CSS_PX * dsf);
      const r = checkOuterBand(img.data, img.w, img.h, img.ch, bgRgb, bandPx, MAX_LEVELS);
      const row = {
        theme, dsf, image: `${img.w}x${img.h}`, bg: bgRgb,
        maxDev: r.maxDev, deviating: r.deviating, bandPixels: r.total,
        worst: r.worst, ok: r.ok,
      };
      results.push(row);
      console.log(`${r.ok ? 'PASS' : 'FAIL'} A1 ${theme} dpr${dsf}: maxDev=${r.maxDev} (bound ${MAX_LEVELS}) deviating=${r.deviating}/${r.total} worst=${JSON.stringify(r.worst)}`);
      await page.close();
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} A1 combos passed (outer 12 px within ${MAX_LEVELS} levels of background)`);
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify({ rule: `outer ${BAND_CSS_PX}px within ${MAX_LEVELS} levels`, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
