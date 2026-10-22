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
 * ImgFetch e2e, tests/test-e2e/first-tile-e2e.mjs
 * Round 5 regression test for the STALE FIRST TILE bug:
 *
 *   In captureFullPageInner's tile loop, lastCaptureAt starts at 0, so
 *   the rate-limit gap is skipped for tile 1, and waitForViewportStable
 *   returned immediately when no image was pending. Nothing waited for
 *   the scroll to be PAINTED, so the first screenshot could still show
 *   the compositor frame from BEFORE the scroll (the user's original
 *   scroll position) while the read-back already reported the new
 *   position. On the round 4 tree, growing-e2e failed intermittently
 *   (about 1 run in 3) with bad rows 0..7, the first tile only, each
 *   bad row's colour off by exactly rowColor(i+12)-rowColor(i) for
 *   ORIG_SCROLL_Y=1200.
 *
 * Why this suite repeats the capture: the race is a scheduling race
 * between the worker's scroll -> stability-check -> screenshot
 * pipeline (a few ms) and the browser's next presented frame (up to
 * one frame later). A deliberately late-painting fixture (a
 * requestAnimationFrame busy-wait of ~110 ms per frame) was tried
 * first: it reproduced the exact failure signature in this sandbox,
 * but LESS often than the plain rows page (1 failure in 7 runs vs 2
 * in 8), because the busy-wait delays the worker's own stability
 * call by the same amount as the paint. The plain /rows page is
 * therefore the sharper instrument here: each capture from a scrolled
 * start is an independent trial of the same race, so the suite runs
 * 20 short captures (1600 px page, 2 tiles each) and requires EVERY
 * first tile to be exact. On the round 4 code, one capture in about
 * four comes back with the whole first tile stale (all 8 rows bad);
 * the chance of 20 clean captures in a row on that code is under 1%.
 * On the fixed code every capture waits for two painted frames plus
 * a 120 ms floor before the first screenshot, so the stale frame can
 * never be captured and the suite is green by construction.
 *
 * The real worker path is driven end to end (real CAPTURE_FULL
 * message, real tile loop, real captureVisibleTab, real offscreen
 * stitcher) through a TEMPORARY COPY of the extension whose manifest
 * gains "<all_urls>" (the copy only; the source tree's manifest is
 * hashed before/after and asserted byte-identical), exactly like
 * tileloop-e2e.mjs.
 *
 * Assertions (the run FAILS if any fails):
 *  T2  the fixture plans one part of 2 tiles (sanity)
 *  A   every CAPTURE_FULL answers ok
 *  B   every part is stored with the planned dimensions
 *  C   content exact in all 20 attempts: 0 bad rows anywhere, and
 *      specifically 0 bad rows in each FIRST tile (the stale rows)
 *  D   page state restored after the last capture
 *  E   zero console.error / pageerror in any context
 *  F   the source tree's manifest.json is unchanged by the run
 *
 * Run under a virtual display, like the other suites:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/first-tile-e2e.mjs [--proj=<tree>]
 * --proj=<tree>  tree to copy the extension from (default: this repo).
 * --out=<file>   optionally write the raw results JSON there.
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
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';
import { planFullPageCapture } from '../../core/fullpage-capture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const SRC = path.resolve(String(args.proj || path.resolve(HERE, '..', '..')));
const HEADED = args.headed !== undefined ? !!args.headed : true;
const PAGE_H = 1600; // CSS px: 16 rows, 2 tiles at the 800px test viewport
const ORIG_SCROLL_Y = 800; // 8 rows: a stale first tile is wrong in all 8 rows
const ATTEMPTS = 20;
const CAPTURE_TIMEOUT_MS = 60 * 1000;

const results = { proj: SRC, phases: [], errors: [], attempts: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `, ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Unique solid color of fixture row i (mirrors fixture-server.mjs). */
const rowColor = (i) => [(i * 67) % 256, (i * 131) % 256, (i * 197) % 256];

/** Minimal PNG decoder (8-bit RGB/RGBA), copied from capture-e2e.mjs. */
function decodePng(buf) {
  let pos = 8;
  let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} type=${colorType}`);
  }
  const ch = colorType === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const f = raw[p++];
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < ch; c += 1) {
        const v = raw[p++];
        const a = x > 0 ? out[(y * w + x - 1) * 4 + c] : 0;
        const b = y > 0 ? out[((y - 1) * w + x) * 4 + c] : 0;
        const cc = (x > 0 && y > 0) ? out[((y - 1) * w + x - 1) * 4 + c] : 0;
        let val = v;
        if (f === 1) val = (v + a) & 255;
        else if (f === 2) val = (v + b) & 255;
        else if (f === 3) val = (v + ((a + b) >> 1)) & 255;
        else if (f === 4) {
          const pp = a + b - cc;
          const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - cc);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : cc);
          val = (v + pr) & 255;
        }
        out[(y * w + x) * 4 + c] = val;
      }
      if (ch === 3) out[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { w, h, data: out };
}

/** Row-sequence check for one stored part (copied from capture-e2e.mjs). */
function seqCheckPart(partBuf, part, dpr) {
  const { w, h, data } = decodePng(partBuf);
  const i0 = Math.floor((part.y0 / dpr) / 100);
  const i1 = Math.ceil(((part.y0 + part.h) / dpr) / 100) - 1;
  let bad = 0; let checked = 0;
  const badRows = [];
  for (let i = i0; i <= i1; i += 1) {
    const devY = Math.round((i * 100 + 50) * dpr) - part.y0;
    if (devY < 0 || devY >= h) continue;
    const o = (devY * w + 10) * 4;
    const [er, eg, eb] = rowColor(i);
    if (data[o] !== er || data[o + 1] !== eg || data[o + 2] !== eb) { bad += 1; badRows.push(i); }
    checked += 1;
  }
  return { bad, checked, badRows, rows: [i0, i1] };
}

// ---- Build the temporary extension copy (the ONLY manifest ever edited) ----
const srcManifest = path.join(SRC, 'manifest.json');
const manifestHashBefore = sha256(srcManifest);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-firsttile-'));
const extDir = path.join(tmpRoot, 'ext');
fs.cpSync(SRC, extDir, { recursive: true });
{
  const mp = path.join(extDir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const hp = Array.isArray(m.host_permissions) ? m.host_permissions : [];
  if (!hp.includes('<all_urls>')) hp.push('<all_urls>');
  m.host_permissions = hp;
  fs.writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
}
console.log(`source tree: ${SRC}`);
console.log(`temporary extension copy: ${extDir} (host_permissions += <all_urls> in the copy only)`);

const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-firsttile-profile-'));
const errorWatch = [];
function watchErrors(target, label) {
  target.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errorWatch.push({ label, kind: `console.${msg.type()}`, text: msg.text().slice(0, 300) });
    }
  });
  target.on('pageerror', (err) => {
    errorWatch.push({ label, kind: 'pageerror', text: String((err && err.message) || err).slice(0, 300) });
  });
}

let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}
ctx.on('page', (p) => watchErrors(p, `page:${p.url().slice(0, 80)}`));

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');
phase('T1 extension (temp copy) loads, service worker alive', !!sw, { extId, note: `extId=${extId}` });

// Control channel: the extension's own popup page (kind='extension').
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
await sleep(500);

// ---- Fixture page ----
const pg = await ctx.newPage();
watchErrors(pg, 'rows-fixture');
await pg.goto(`${BASE}/rows?h=${PAGE_H}`);
await pg.bringToFront();
await sleep(800);
const metrics = await pg.evaluate(() => ({
  vw: window.innerWidth,
  vh: window.innerHeight,
  dpr: window.devicePixelRatio,
  sw: document.documentElement.scrollWidth,
  sh: document.documentElement.scrollHeight,
}));
const plan = planFullPageCapture({
  fullW: metrics.sw, fullH: metrics.sh,
  viewportW: metrics.vw, viewportH: metrics.vh, dpr: metrics.dpr,
});
console.log(`page metrics: ${JSON.stringify(metrics)} plan: parts=${plan.parts.length} tiles=${plan.totalTiles}`);
phase('T2 fixture plans one part of 2 tiles', plan.parts.length === 1 && plan.totalTiles === 2 && metrics.sh === PAGE_H, {
  metrics, plannedParts: plan.parts.length, totalTiles: plan.totalTiles,
  note: `plannedParts=${plan.parts.length} totalTiles=${plan.totalTiles} pageH=${metrics.sh}`,
});

/** Read ONE capture record by id from the worker's IndexedDB. */
async function readRecord(id) {
  return ctrl.evaluate((recId) => new Promise((resolve) => {
    try {
      const req = indexedDB.open('imgfetch', 1);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('captures')) { resolve(null); return; }
          const rq = db.transaction('captures', 'readonly').objectStore('captures').get(recId);
          rq.onsuccess = async () => {
            const r = rq.result;
            if (!r) { resolve(null); return; }
            const plain = { width: r.width, height: r.height };
            if (r.blob) {
              const buf = new Uint8Array(await r.blob.arrayBuffer());
              let bin = '';
              const CH = 0x8000;
              for (let i = 0; i < buf.length; i += CH) {
                bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
              }
              plain.dataUrl = `data:image/png;base64,${btoa(bin)}`;
            } else if (r.dataUrl) {
              plain.dataUrl = r.dataUrl;
            }
            resolve(plain);
          };
          rq.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  }), id);
}

// ---- ATTEMPTS independent captures, each starting scrolled down ----
const part = plan.parts[0];
const firstTileRows = new Set();
{
  const t0 = part.tiles[0];
  const ti0 = Math.floor(t0.sy / 100);
  const ti1 = Math.ceil((t0.sy + metrics.vh) / 100) - 1;
  for (let i = ti0; i <= ti1; i += 1) firstTileRows.add(i);
}
let okCount = 0; let storedCount = 0; let totalBad = 0; let totalFirstBad = 0; let checkedRows = 0;
for (let a = 1; a <= ATTEMPTS; a += 1) {
  // The previous capture's result tab may have taken focus; the
  // fixture page must be the active tab again before capturing.
  await pg.bringToFront();
  // The user starts scrolled down: a stale first tile shows the
  // content from THIS position (rows starting at ORIG_SCROLL_Y/100).
  await pg.evaluate((y) => window.scrollTo(0, y), ORIG_SCROLL_Y);
  await sleep(350);
  await ctrl.evaluate(() => {
    window.__ft = { done: false };
    chrome.runtime.sendMessage({ type: 'CAPTURE_FULL' })
      .then((r) => { window.__ft = { done: true, at: Date.now(), resp: r }; })
      .catch((e) => { window.__ft = { done: true, at: Date.now(), threw: String((e && e.message) || e) }; });
  });
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < CAPTURE_TIMEOUT_MS) {
    st = await ctrl.evaluate(() => window.__ft).catch(() => null);
    if (st && st.done) break;
    await sleep(200);
  }
  const resp = st && st.resp;
  const respOk = !!(resp && resp.ok === true && Array.isArray(resp.partIds) && resp.partIds.length === 1);
  if (respOk) okCount += 1;
  let bad = -1; let firstBad = -1; let dims = 'none'; let checked = 0;
  if (respOk) {
    const rec = await readRecord(resp.partIds[0]);
    if (rec && rec.width === part.w && rec.height === part.h && rec.dataUrl) {
      storedCount += 1;
      dims = `${rec.width}x${rec.height}`;
      const buf = Buffer.from(rec.dataUrl.split(',')[1], 'base64');
      if (pngMagic(buf)) {
        const s = seqCheckPart(buf, part, metrics.dpr);
        bad = s.bad; checked = s.checked; checkedRows += s.checked;
        firstBad = s.badRows.filter((i) => firstTileRows.has(i)).length;
        totalBad += s.bad; totalFirstBad += firstBad;
      }
    }
  }
  results.attempts.push({ attempt: a, respOk, dims, bad, firstBad, checked });
  console.log(`attempt ${a}/${ATTEMPTS}: respOk=${respOk} dims=${dims} bad=${bad} firstTileBad=${firstBad}`);
}

phase('A every CAPTURE_FULL answers ok', okCount === ATTEMPTS, {
  okCount, attempts: ATTEMPTS, note: `${okCount}/${ATTEMPTS} ok`,
});
phase('B every part stored with the planned dimensions', storedCount === ATTEMPTS, {
  storedCount, attempts: ATTEMPTS, plan: `${part.w}x${part.h}`,
  note: `${storedCount}/${ATTEMPTS} stored at ${part.w}x${part.h}`,
});
phase('C content exact in every attempt (first tile included)', totalBad === 0 && totalFirstBad === 0 && checkedRows === ATTEMPTS * (PAGE_H / 100), {
  totalBad, totalFirstBad, checkedRows,
  note: `attempts=${ATTEMPTS} rowsChecked=${checkedRows} bad=${totalBad} firstTileBad=${totalFirstBad}`,
});

// D: page state restored after the last capture
{
  const after = await pg.evaluate(() => ({
    y: Math.round(window.scrollY || 0),
    marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
  })).catch(() => ({ y: -1, marks: -1 }));
  phase('D page state restored after capture', after.y === ORIG_SCROLL_Y && after.marks === 0, {
    after, note: `scroll ${after.y} (expected ${ORIG_SCROLL_Y}), candidate marks left=${after.marks}`,
  });
}

// E: zero console.error / pageerror
{
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('E zero console.error/pageerror', errOnly.length === 0, {
    errors: errOnly.slice(0, 5), totalWatchEntries: errorWatch.length,
    note: `${errOnly.length} errors`,
  });
}

// F: source manifest untouched
{
  const afterHash = sha256(srcManifest);
  phase('F source manifest unchanged', afterHash === manifestHashBefore, {
    note: `sha256 ${afterHash.slice(0, 16)}...`,
  });
}

results.errorWatch = errorWatch;
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
await ctx.close().catch(() => {});
fixture.close();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp copy is disposable */ }
process.exit(results.errors.length ? 1 : 0);
