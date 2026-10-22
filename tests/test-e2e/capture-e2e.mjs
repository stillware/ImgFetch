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
 * ImgFetch e2e, tests/test-e2e/capture-e2e.mjs
 * Real-browser suite for FIX 3 (screenshots on every tab the browser
 * allows) and FIX 4 (full-fidelity screenshots). Run under a virtual
 * display:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/capture-e2e.mjs --dpr=1
 *
 * DPR 1 runs every phase; other DPR values run only the DPR-sensitive
 * phases (C3 seams, C9 crops).
 *
 * Honest automation limit: chrome.tabs.captureVisibleTab needs the
 * <all_urls> or activeTab permission grant, which this automated browser
 * does not provide (no user gesture is synthesizable), so the final
 * tile-capture call inside the worker is replaced by a Playwright
 * viewport screenshot. Everything else is the REAL path, driven exactly
 * like the worker drives it: the real planner (core/fullpage-capture.js),
 * the real in-page logic (content/scanner.js: describeScrollContext,
 * scrollCaptureTarget, waitForViewportStable, setFixedHidden,
 * ensureTargetVisible, restoreCaptureTarget), and the REAL offscreen
 * stitcher (STITCH_BEGIN/TILE/END) in the extension's own offscreen
 * document. C1/C2 exercise the real worker message path
 * (CAPTURE_VISIBLE / CAPTURE_FULL) on restricted pages.
 *
 * Phases:
 *  P0  extension loads, service worker alive, offscreen up
 *  C1  FIX 3: CAPTURE_VISIBLE and CAPTURE_FULL on chrome://newtab (empty
 *      URL): the browser refuses; the worker answers with the localized
 *      error, captures nothing, and never captures another tab.
 *  C2  FIX 3: the extension's own options page: script injection is
 *      forbidden by the browser, and the visible capture is refused too,
 *      so CAPTURE_FULL answers with the honest localized refusal.
 *  C3  FIX 4: seam-free stitching on a 20,000px synthetic page, verified
 *      pixel-accurately at DPR 1, 1.25, 1.5, 2 and 3: every 100px row in
 *      order, none duplicated or missing, plus a reference-rendering
 *      comparison.
 *  C4  FIX 4: inner scroll container (/scrollbox) captured whole at full
 *      resolution, rows in order; page state restored.
 *  C5  FIX 4: sticky header and fixed banner appear exactly once.
 *  C6  FIX 4: lazy-loaded images are decoded in the stitched output.
 *  C7  FIX 4: page state fully restored after capture, on success and on
 *      a simulated mid-capture failure.
 *  C8  FIX 4: a 40,000px page is split into parts, every part at full
 *      resolution, the whole page covered (no truncation).
 *  C9  Area crop byte-exact at DPR 1, 1.25, 1.5, 2 and 3 on the
 *      realistic fixture (gradients, text, photo noise): 0 diff pixels
 *      and equal unique colour counts. Fails on the pre-fix tree.
 *  C10 FIX 4: peak JS heap measured during a 64 MP stitch.
 *  C11 FIX 4: the annotate editor with an 8000x8000 image: drawing speed,
 *      Undo, Redo, Save, Copy, Discard, zero page errors.
 *
 * Fails the run on ANY phase failure and on any console.error / pageerror
 * / unhandled rejection in the service worker, the control page, the
 * offscreen document or any test page. Writes
 * tests/test-e2e/results-capture-<browser>-dpr<N>.json with raw evidence.
 */
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = _require('playwright'));
} catch {
  // ESM ignores NODE_PATH; point PLAYWRIGHT_PACKAGE at the install, e.g.
  // PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright
  const pwPath = process.env.PLAYWRIGHT_PACKAGE;
  if (!pwPath) throw new Error('playwright not resolvable: set PLAYWRIGHT_PACKAGE to the installed package path');
  ({ chromium } = _require(pwPath));
}
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, makePng } from './fixture-server.mjs';
import { planFullPageCapture, pickScrollTarget } from '../../core/fullpage-capture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const PROJ = path.resolve(String(args.proj || DEFAULT_PROJ)); // --proj= measures another tree (fail-on-old proof)
const DPR = Number(args.dpr || '1');
const FULL = DPR === 1; // DPR 1 runs every phase; others run C3/C9 only
// New tree crops in the worker (core/crop-image.js); the old tree has no
// such module, C9 then drives the old offscreen CROP_IMAGE path instead.
const HAS_WORKER_CROP = fs.existsSync(path.join(PROJ, 'core', 'crop-image.js'));
const HEADED = args.headed !== undefined ? !!args.headed : true;
const BROWSER = (args.browser || 'chromium').toLowerCase();
const EDGE_PATH = '/usr/bin/microsoft-edge-stable';

const results = { dpr: DPR, headed: HEADED, browser: BROWSER, phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `, ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const ihdrDims = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

/**
 * Count unique RGB colors in a decoded-PNG region. Sort-based (not a Set)
 * so multi-megapixel regions stay fast and lean.
 */
function uniqueColors(img, x0, y0, w, h) {
  const n = w * h;
  const arr = new Uint32Array(n);
  let k = 0;
  for (let y = 0; y < h; y += 1) {
    let o = ((y0 + y) * img.w + x0) * 4;
    for (let x = 0; x < w; x += 1, o += 4) {
      arr[k++] = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
    }
  }
  arr.sort();
  let uniq = n > 0 ? 1 : 0;
  for (let i = 1; i < n; i += 1) if (arr[i] !== arr[i - 1]) uniq += 1;
  return uniq;
}

/** Unique solid color of fixture row i (mirrors fixture-server.mjs). */
const rowColor = (i) => [(i * 67) % 256, (i * 131) % 256, (i * 197) % 256];

/**
 * Minimal PNG decoder (8-bit RGB/RGBA only, which is all Playwright and
 * canvas produce). Returns { w, h, data } with data as RGBA bytes.
 */
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

/**
 * Row-sequence check on a stitched part of a /rows page: every 100 CSS px
 * row inside the part must carry its unique color, in order, with none
 * duplicated, missing or shifted. Returns { bad, checked }.
 */
function seqCheckPart(partBuf, part, dpr) {
  const { w, h, data } = decodePng(partBuf);
  const i0 = Math.floor((part.y0 / dpr) / 100);
  const i1 = Math.ceil(((part.y0 + part.h) / dpr) / 100) - 1;
  let bad = 0; let checked = 0;
  for (let i = i0; i <= i1; i += 1) {
    const devY = Math.round((i * 100 + 50) * dpr) - part.y0;
    if (devY < 0 || devY >= h) continue;
    const o = (devY * w + 10) * 4;
    const [er, eg, eb] = rowColor(i);
    if (data[o] !== er || data[o + 1] !== eg || data[o + 2] !== eb) bad += 1;
    checked += 1;
  }
  return { bad, checked, rows: [i0, i1] };
}

/** Localized refusal text the worker must use (read from the en locale). */
function expectedRefusal() {
  const en = JSON.parse(fs.readFileSync(path.join(PROJ, '_locales/en/messages.json'), 'utf8'));
  return en.cap_captureRefused && en.cap_captureRefused.message;
}
/** True when a worker error string looks localized (no raw i18n key). */
function looksLocalized(s) {
  return typeof s === 'string' && s.length > 0 && !/[a-z][a-z0-9_]*_[a-zA-Z][a-zA-Z0-9_]*/.test(s);
}

const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}   dpr=${DPR} headed=${HEADED} full=${FULL}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-cap-e2e-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-cap-dl-'));

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
  const launchOpts = {
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${PROJ}`,
      `--load-extension=${PROJ}`,
      '--no-sandbox',
      // Containers often have a tiny /dev/shm; Chromium keeps canvas
      // backing stores there, and an 8000x8000 canvas (C11) would crash
      // the renderer. /tmp backs it instead; rendering is unaffected.
      '--disable-dev-shm-usage',
    ],
  };
  if (BROWSER === 'edge') launchOpts.executablePath = EDGE_PATH;
  ctx = await chromium.launchPersistentContext(userDataDir, launchOpts);
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');

// Control channel: the extension's own popup page (kind='extension').
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
const send = (msg) => ctrl.evaluate((m) => chrome.runtime.sendMessage(m), msg);

// Downloads go to our directory.
{
  const cdp = await ctx.newCDPSession(ctrl);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
}

// The REAL offscreen stitcher, in the extension's own offscreen document.
await sw.evaluate(() => chrome.offscreen.createDocument({
  url: 'offscreen/offscreen.html', reasons: ['BLOBS', 'CLIPBOARD'],
  justification: 'capture e2e stitch test',
}).catch(() => {}));
await sleep(1500);
const sendOff = (msg) => sw.evaluate((m) => chrome.runtime.sendMessage(m), { target: 'offscreen', ...msg });
{
  let begin = null;
  for (let a = 0; a < 6 && (!begin || !begin.ok); a += 1) {
    if (a) await sleep(400 * a);
    begin = await sendOff({ type: 'STITCH_BEGIN', width: 8, height: 8 }).catch(() => null);
  }
  await sendOff({ type: 'STITCH_ABORT' }).catch(() => {});
  if (!begin || !begin.ok) {
    console.log('FATAL: offscreen stitcher did not answer');
    process.exit(2);
  }
}

// ---- P0: worker alive + offscreen up ----
phase('P0 worker alive + offscreen up', !!sw, { extId });

/**
 * Arm a page for the requested DPR. This Chromium build ignores
 * --force-device-scale-factor, so the device scale factor is set through
 * CDP Emulation.setDeviceMetricsOverride (verified: window.devicePixelRatio
 * and bitmap sizes follow it). Returns a screenshot function; pass a CSS
 * px height for a full-page reference rendering, or 0 for the viewport.
 * Screenshots go through CDP Page.captureScreenshot, because Playwright's
 * page.screenshot() ignores the emulated scale factor.
 */
async function armDpr(page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: DPR, mobile: false,
  });
  const shot = async (fullCssH = 0) => {
    const params = { format: 'png' };
    if (fullCssH > 0) {
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: 1280, height: fullCssH, scale: 1 };
    }
    const { data } = await cdp.send('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  };
  return shot;
}

/**
 * Inject content/scanner.js into a page the same way the worker does
 * (classic script, no imports). Playwright cannot call
 * chrome.scripting.executeScript, so the file content is added as a
 * script tag; the code path under test (window.__imgfetch.*) is identical.
 */
const scannerSrc = fs.readFileSync(path.join(PROJ, 'content/scanner.js'), 'utf8');
async function injectScanner(page) {
  await page.addScriptTag({ content: scannerSrc });
  const ok = await page.evaluate(() => !!(window.__imgfetch && window.__imgfetch.describeScrollContext));
  if (!ok) throw new Error('scanner injection failed');
}

/**
 * Mirror of the worker's captureFullPageInner, driven exactly the same
 * way, except the tile-capture call (chrome.tabs.captureVisibleTab, which
 * this automated browser refuses) is a Playwright viewport screenshot.
 * Returns { plan, target, notices, parts, dpr, tileCount } where each part
 * is { buf, w, h, plan }.
 */
async function fullCaptureFlow(page, opts = {}) {
  const failAfter = opts.failAfterTiles || 0;
  const shot = opts.shot || (async () => page.screenshot({ type: 'png' }));
  await injectScanner(page);
  const desc = await page.evaluate(() => window.__imgfetch.describeScrollContext());
  if (!desc || !desc.doc) throw new Error('no scroll context');
  const picked = pickScrollTarget(desc);
  const target = picked.target;
  const dpr = Number(desc.dpr) > 0 ? Number(desc.dpr) : 1;
  let fullW; let fullH; let boxW; let boxH;
  if (target.kind === 'document') {
    fullW = desc.doc.scrollW; fullH = desc.doc.scrollH;
    boxW = desc.viewportW; boxH = desc.viewportH;
  } else {
    const list = target.kind === 'frame' ? (desc.frames || []) : (desc.containers || []);
    const rep = list.find((c) => c.token === target.token);
    if (!rep) throw new Error('no target report');
    fullW = rep.scrollW; fullH = rep.scrollH;
    boxW = rep.clientW; boxH = rep.clientH;
  }
  const origWinScroll = await page.evaluate(() => ({ x: window.scrollX || 0, y: window.scrollY || 0 }));
  let box = null;
  if (target.kind !== 'document') {
    box = await page.evaluate((t) => window.__imgfetch.ensureTargetVisible(t), target);
    if (!box) throw new Error('ensureTargetVisible failed');
    const visW = Math.min(box.x + box.w, desc.viewportW) - Math.max(box.x, 0);
    const visH = Math.min(box.y + box.h, desc.viewportH) - Math.max(box.y, 0);
    if (!(visW >= 50 && visH >= 50)) throw new Error('target not visible enough');
    boxW = visW; boxH = visH;
  }
  const plan = planFullPageCapture({ fullW, fullH, viewportW: boxW, viewportH: boxH, dpr });
  const origTargetScroll = await page.evaluate((t) => window.__imgfetch.readCaptureTargetScroll(t), target);
  // Device-px crop of the target's visible box inside each viewport tile
  // (container/frame targets; the document needs no crop).
  const crop = box ? {
    x: Math.max(0, Math.round(Math.max(box.x, 0) * dpr)),
    y: Math.max(0, Math.round(Math.max(box.y, 0) * dpr)),
    w: Math.max(1, Math.round(boxW * dpr)),
    h: Math.max(1, Math.round(boxH * dpr)),
  } : null;
  const stableBox = box
    ? { x: Math.max(box.x, 0), y: Math.max(box.y, 0), w: boxW, h: boxH }
    : { x: 0, y: 0, w: desc.viewportW, h: desc.viewportH };
  const parts = [];
  let tileNo = 0;
  try {
    for (const part of plan.parts) {
      let begin = null;
      for (let a = 0; a < 6 && (!begin || !begin.ok); a += 1) {
        if (a) await sleep(400 * a);
        begin = await sendOff({ type: 'STITCH_BEGIN', width: part.w, height: part.h });
      }
      if (!begin || !begin.ok) throw new Error(`STITCH_BEGIN part ${part.index} rejected`);
      let partDone = false;
      try {
        for (const tile of part.tiles) {
          if (failAfter && tileNo >= failAfter) throw new Error('e2e-simulated-mid-capture-failure');
          // Scroll the target; read back the ACTUAL position and derive
          // exact integer device-px offsets from it, exactly like the worker.
          const actual = await page.evaluate(
            ([t, x, y]) => window.__imgfetch.scrollCaptureTarget(t, x, y),
            [target, tile.sx, tile.sy],
          );
          if (!actual) throw new Error('scrollCaptureTarget failed');
          const ax = Math.round((actual.x || 0) * dpr);
          const ay = Math.round((actual.y || 0) * dpr);
          if (tileNo === 1) await page.evaluate(() => window.__imgfetch.setFixedHidden(true));
          await page.evaluate(
            ([b, ms]) => window.__imgfetch.waitForViewportStable(b, ms),
            [stableBox, 2500],
          ).catch(() => null);
          const tileShot = await shot();
          tileNo += 1;
          const msg = {
            type: 'STITCH_TILE',
            dataUrl: `data:image/png;base64,${tileShot.toString('base64')}`,
            dx: ax - part.x0,
            dy: ay - part.y0,
            pageUrl: page.url(),
          };
          if (crop) Object.assign(msg, { sx: crop.x, sy: crop.y, sw: crop.w, sh: crop.h });
          const res = await sendOff(msg);
          if (!res || !res.ok) throw new Error(`STITCH_TILE failed: ${JSON.stringify(res)}`);
        }
        partDone = true;
      } finally {
        if (!partDone) await sendOff({ type: 'STITCH_ABORT' }).catch(() => null);
      }
      const end = await sendOff({ type: 'STITCH_END', format: 'png' });
      if (!end || !end.ok || !end.dataUrl) throw new Error(`STITCH_END part ${part.index} failed`);
      const buf = Buffer.from(end.dataUrl.split(',')[1], 'base64');
      const dims = ihdrDims(buf);
      if (!pngMagic(buf) || dims.w !== part.w || dims.h !== part.h) {
        throw new Error(`part ${part.index} dims ${dims.w}x${dims.h} != planned ${part.w}x${part.h}`);
      }
      parts.push({ buf, w: end.width, h: end.height, plan: part });
    }
  } finally {
    // The worker's finally: always restore the page, even on failure.
    const ox = (origTargetScroll && origTargetScroll.x) || 0;
    const oy = (origTargetScroll && origTargetScroll.y) || 0;
    await page.evaluate(([t, x, y]) => window.__imgfetch.scrollCaptureTarget(t, x, y),
      [target, ox, oy]).catch(() => {});
    await page.evaluate(() => window.__imgfetch.restoreCaptureTarget()).catch(() => {});
    const wx = (origWinScroll && origWinScroll.x) || 0;
    const wy = (origWinScroll && origWinScroll.y) || 0;
    await page.evaluate(([x, y]) => window.scrollTo(x, y), [wx, wy]).catch(() => {});
    await page.evaluate(() => window.__imgfetch.setFixedHidden(false)).catch(() => {});
  }
  return { plan, target, notices: picked.notices || {}, parts, dpr, tileCount: tileNo };
}

/** Number of capture records in the worker's IndexedDB (extension origin). */
async function captureRecordCount() {
  return ctrl.evaluate(() => new Promise((resolve) => {
    const done = (v) => resolve(v);
    try {
      // Never create the database as a side effect: if it does not exist
      // yet, there are no captures.
      const listP = indexedDB.databases ? indexedDB.databases() : Promise.resolve(null);
      Promise.resolve(listP).then((list) => {
        try {
          if (Array.isArray(list) && !list.some((d) => d && d.name === 'imgfetch')) return done(0);
          const req = indexedDB.open('imgfetch', 1);
          req.onsuccess = () => {
            try {
              const db = req.result;
              if (!db.objectStoreNames.contains('captures')) { done(0); return; }
              const tx = db.transaction('captures', 'readonly');
              const rq = tx.objectStore('captures').count();
              rq.onsuccess = () => done(Number(rq.result) || 0);
              rq.onerror = () => done(-1);
            } catch { done(-1); }
          };
          req.onerror = () => done(-1);
        } catch { done(-1); }
      }, () => done(-1));
    } catch { done(-1); }
  }));
}

// ---- C1: chrome://newtab (empty URL) ----
if (FULL) {
  const ev = {};
  try {
    const tabsBefore = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
    const recsBefore = await captureRecordCount();
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'newtab');
    let navUrl = '';
    try {
      await pg.goto('chrome://newtab/', { timeout: 10000 });
    } catch (e) {
      ev.navNote = `chrome://newtab goto failed (${String(e.message).slice(0, 60)}), using about:blank`;
    }
    await pg.bringToFront();
    await sleep(600);
    navUrl = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return (tabs[0] && tabs[0].url) || '';
    });
    ev.tabUrl = navUrl || '(empty)';
    const ask = async (type) => {
      try {
        const r = await send({ type });
        return { resp: r };
      } catch (e) {
        return { threw: String((e && e.message) || e).slice(0, 200) };
      }
    };
    const vis = await ask('CAPTURE_VISIBLE');
    const full = await ask('CAPTURE_FULL');
    ev.visible = JSON.stringify(vis.resp || vis).slice(0, 200);
    ev.full = JSON.stringify(full.resp || full).slice(0, 200);
    const tabsAfter = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
    const recsAfter = await captureRecordCount();
    ev.tabsDelta = tabsAfter - tabsBefore - 1; // minus the newtab page itself
    ev.newCaptures = recsAfter - recsBefore;
    const refusal = expectedRefusal();
    const honest = (r) => {
      if (r.resp && r.resp.ok === false && r.resp.error === refusal) return 'refused-localized';
      if (r.resp && r.resp.ok === true && typeof r.resp.id === 'string') return 'captured';
      return `unexpected:${JSON.stringify(r).slice(0, 120)}`;
    };
    ev.visibleVerdict = honest(vis);
    ev.fullVerdict = honest(full);
    const ok = (ev.visibleVerdict === 'refused-localized' || ev.visibleVerdict === 'captured')
      && (ev.fullVerdict === 'refused-localized' || ev.fullVerdict === 'captured')
      && ev.tabsDelta === 0 && ev.newCaptures <= 0;
    ev.note = `visible=${ev.visibleVerdict} full=${ev.fullVerdict} tabsDelta=${ev.tabsDelta} newCaptures=${ev.newCaptures}`;
    phase('C1 chrome://newtab: honest localized outcome, nothing from another tab', ok, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C1 chrome://newtab: honest localized outcome, nothing from another tab', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C2: the extension's own options page ----
if (FULL) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'options-page');
    await pg.goto(`chrome-extension://${extId}/options/options.html`);
    await pg.bringToFront();
    await sleep(600);
    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0] && tabs[0].id;
    });
    // Probe: can the browser inject a script into the extension's own page?
    const inj = await sw.evaluate(async (tid) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tid }, files: ['content/scanner.js'] });
        return { ok: true };
      } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 160) }; }
    }, tabId);
    ev.injection = JSON.stringify(inj);
    const tabsBefore = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
    const recsBefore = await captureRecordCount();
    let fullResp = null;
    try {
      fullResp = await send({ type: 'CAPTURE_FULL' });
    } catch (e) {
      fullResp = { threw: String((e && e.message) || e).slice(0, 200) };
    }
    ev.full = JSON.stringify(fullResp).slice(0, 220);
    const tabsAfter = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
    const recsAfter = await captureRecordCount();
    const refusal = expectedRefusal();
    const refusedHonestly = fullResp && fullResp.ok === false && fullResp.error === refusal;
    // Injection into chrome-extension:// pages is forbidden by the
    // browser (even the extension's own pages); the visible capture is
    // refused too, so the honest outcome is the localized refusal, with
    // no result tab opened and no capture recorded.
    const ok = inj && inj.ok === false && refusedHonestly
      && (tabsAfter - tabsBefore) === 0 && (recsAfter - recsBefore) <= 0
      && looksLocalized(fullResp.error);
    ev.note = `injectionOk=${inj && inj.ok} refusedHonestly=${refusedHonestly} tabsDelta=${tabsAfter - tabsBefore}`;
    phase('C2 extension page: injection forbidden, honest localized refusal', ok, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C2 extension page: injection forbidden, honest localized refusal', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C3: seam-free stitching at every DPR, pixel-verified ----
{
  const ev = {};
  try {
    const H = 20000;
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, `rows-dpr${DPR}`);
    await pg.goto(`${BASE}/rows?h=${H}`);
    await pg.bringToFront();
    await sleep(500);
    const t0 = Date.now();
    const flow = await fullCaptureFlow(pg, { shot });
    ev.ms = Date.now() - t0;
    const { plan, parts } = flow;
    ev.planTiles = plan.totalTiles;
    ev.parts = parts.length;
    // Row-sequence check on every part: exact, in order, no dup/missing.
    let badTotal = 0; let checkedTotal = 0;
    const seqNotes = [];
    for (const p of parts) {
      const s = seqCheckPart(p.buf, p.plan, flow.dpr);
      badTotal += s.bad; checkedTotal += s.checked;
      seqNotes.push(`part${p.plan.index}: rows=${s.checked} bad=${s.bad} [${s.rows[0]}..${s.rows[1]}]`);
    }
    ev.seq = seqNotes.join(' | ');
    // Reference comparison: a CDP full-page rendering at the same DPR.
    // Every part must match its region closely (catches blank tiles,
    // shifts and resampling, not sub-pixel AA). The reference itself is
    // self-checked first: at very tall DPR 3 captures Chromium's CDP
    // renderer corrupts rows past a height limit, so only the
    // self-consistent region is compared; the row-sequence check above
    // remains the strict, complete verification everywhere.
    const refShot = await shot(H);
    const ref = decodePng(refShot);
    // Reference self-check: a row counts as trustworthy only if the
    // reference is that row's exact colour across a grid of samples
    // (several heights within the row, across the full width). A
    // single centre sample is not enough: at DPR 3 the CDP renderer
    // corrupts row 128 over ~30% of its area while its centre pixel
    // still matches, which once hid inside a large part's average and,
    // with balanced parts, can dominate a small compared region. The
    // strict verification of OUR output stays the row-sequence check
    // above; this grid only decides which reference rows may be used.
    let refGoodRows = 0;
    for (let i = 0; i < 200; i += 1) {
      const [er, eg, eb] = rowColor(i);
      let rowOk = true;
      for (const yFrac of [20, 50, 80]) {
        const devY = Math.round((i * 100 + yFrac) * DPR);
        if (devY >= ref.h) { rowOk = false; break; }
        for (let x = 5; x < ref.w; x += 379) {
          const o = (devY * ref.w + x) * 4;
          if (ref.data[o] !== er || ref.data[o + 1] !== eg || ref.data[o + 2] !== eb) { rowOk = false; break; }
        }
        if (!rowOk) break;
      }
      if (!rowOk) break;
      refGoodRows = i + 1;
    }
    ev.refGoodRows = `${refGoodRows}/200`;
    let maxDiffPct = 0; let sumAbs = 0; let pxTotal = 0; let pxSkipped = 0;
    const refNotes = [];
    for (const p of parts) {
      const img = decodePng(p.buf);
      let diff = 0; let abs = 0; let skipped = 0;
      const total = p.w * p.h;
      for (let y = 0; y < p.h; y += 1) {
        const ry = p.plan.y0 + y;
        if (ry >= ref.h) { skipped += p.w; continue; }
        // Skip rows where the reference itself is corrupt.
        const rowIdx = Math.floor(ry / DPR / 100);
        if (rowIdx >= refGoodRows) { skipped += p.w; continue; }
        for (let x = 0; x < p.w; x += 1) {
          const rx = p.plan.x0 + x;
          if (rx >= ref.w) { skipped += 1; continue; }
          const ro = (ry * ref.w + rx) * 4;
          const po = (y * p.w + x) * 4;
          const dr = Math.abs(img.data[po] - ref.data[ro]);
          const dg = Math.abs(img.data[po + 1] - ref.data[ro + 1]);
          const db = Math.abs(img.data[po + 2] - ref.data[ro + 2]);
          abs += dr + dg + db;
          if (dr > 0 || dg > 0 || db > 0) diff += 1;
        }
      }
      const cmpTotal = total - skipped;
      const pct = cmpTotal > 0 ? (100 * diff) / cmpTotal : 0;
      if (pct > maxDiffPct) maxDiffPct = pct;
      sumAbs += abs; pxTotal += cmpTotal; pxSkipped += skipped;
      refNotes.push(`part${p.plan.index}: diff=${diff}/${cmpTotal} (${pct.toFixed(3)}%)${skipped ? ` skipped=${skipped}` : ''}`);
    }
    ev.refDiff = refNotes.join(' | ');
    ev.maxDiffPct = Math.round(maxDiffPct * 1000) / 1000;
    ev.meanAbs = pxTotal > 0 ? Math.round((sumAbs / (pxTotal * 3)) * 100) / 100 : 0;
    ev.refSkippedPx = pxSkipped;
    // No truncation: the parts cover the whole page height.
    const coveredH = parts.reduce((n, p) => n + p.plan.h, 0);
    ev.wholePageCovered = coveredH === plan.devH;
    ev.note = `${parts.length} parts, ${plan.totalTiles} tiles, seq bad=${badTotal}/${checkedTotal}, maxDiff=${ev.maxDiffPct}%`;
    const ok = badTotal === 0 && checkedTotal === 200 && ev.wholePageCovered && maxDiffPct < 2;
    phase(`C3 seam-free stitching at DPR ${DPR}`, ok, ev);
    const f = `stitch-c3-dpr${DPR}-p${parts[0].plan.index}.png`;
    fs.writeFileSync(path.join(downloadDir, f), parts[0].buf);
    await pg.close().catch(() => {});
  } catch (e) {
    phase(`C3 seam-free stitching at DPR ${DPR}`, false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C4: inner scroll container ----
if (FULL) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'scrollbox');
    await pg.goto(`${BASE}/scrollbox`);
    await pg.bringToFront();
    await sleep(500);
    const flow = await fullCaptureFlow(pg, { shot });
    ev.target = flow.target.kind;
    ev.notices = JSON.stringify(flow.notices);
    const { plan, parts } = flow;
    ev.parts = parts.length;
    ev.planTiles = plan.totalTiles;
    // The container holds 6000 CSS px of rows; the stitched image must be
    // exactly that tall at full device resolution (dpr=1 here).
    const gotH = parts.reduce((n, p) => n + p.plan.h, 0);
    ev.expectedH = 6000;
    ev.gotH = gotH;
    let badTotal = 0; let checkedTotal = 0;
    for (const p of parts) {
      const s = seqCheckPart(p.buf, p.plan, flow.dpr);
      badTotal += s.bad; checkedTotal += s.checked;
    }
    ev.seqOk = badTotal === 0 && checkedTotal === 60;
    // Page state: no candidate marks left, window never scrolled.
    const marks = await pg.evaluate(() => document.querySelectorAll('[data-imgfetch-scroll-candidate]').length);
    const winScroll = await pg.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const boxScroll = await pg.evaluate(() => {
      const b = document.getElementById('box');
      return b ? { top: b.scrollTop, left: b.scrollLeft } : null;
    });
    ev.marksLeft = marks;
    ev.winScroll = winScroll;
    ev.boxScrollRestored = boxScroll && boxScroll.top === 0 && boxScroll.left === 0;
    ev.note = `target=${ev.target} h=${gotH} seq bad=${badTotal}/${checkedTotal}`;
    const ok = flow.target.kind === 'container' && flow.notices.innerCaptured === true
      && gotH === 6000 && ev.seqOk && marks === 0 && boxScroll && boxScroll.top === 0;
    phase('C4 inner scroll container captured whole, rows in order', ok, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C4 inner scroll container captured whole, rows in order', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C5: sticky header + fixed banner appear exactly once ----
if (FULL) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'stickytest');
    await pg.goto(`${BASE}/stickytest`);
    await pg.bringToFront();
    await sleep(500);
    const flow = await fullCaptureFlow(pg, { shot });
    const { parts } = flow;
    if (parts.length !== 1) throw new Error(`expected 1 part, got ${parts.length}`);
    const { w, h, data } = decodePng(parts[0].buf);
    let redRows = 0; let blueRows = 0;
    for (let y = 0; y < h; y += 1) {
      const o = (y * w + 10) * 4;
      if (data[o] === 255 && data[o + 1] === 0 && data[o + 2] === 0) redRows += 1;
      if (data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 255) blueRows += 1;
    }
    ev.redRows = redRows; ev.expRed = 60;
    ev.blueRows = blueRows; ev.expBlue = 80;
    ev.note = `red=${redRows}/60 blue=${blueRows}/80`;
    const ok = redRows === 60 && blueRows === 80;
    phase('C5 sticky header + fixed banner appear exactly once', ok, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C5 sticky header + fixed banner appear exactly once', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C6: lazy images decoded ----
if (FULL) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'lazyrows');
    await pg.goto(`${BASE}/lazyrows`);
    await pg.bringToFront();
    await sleep(500);
    const flow = await fullCaptureFlow(pg, { shot });
    const { parts } = flow;
    // The page is 21,000px tall, so the planner splits it into parts;
    // locate each image's center pixel in the part that contains it.
    // Image i: 300x200 at CSS y = i*2100+1900, centered horizontally
    // (margin: 0 auto) in the 1280 CSS px viewport.
    let loaded = 0; let blank = 0;
    const notes = [];
    for (let i = 0; i < 10; i += 1) {
      const cx = 640; const cy = i * 2100 + 1900 + 100;
      const p = parts.find((pp) => cy >= pp.plan.y0 && cy < pp.plan.y0 + pp.plan.h);
      if (!p) { notes.push(`img${i}: no part covers y=${cy}`); continue; }
      const { w, data } = decodePng(p.buf);
      const ly = cy - p.plan.y0;
      const o = (ly * w + cx) * 4;
      const [br, bg, bb] = rowColor(i + 200);
      const f = 0.7 + (0.3 * (100 % 256)) / 256;
      const er = Math.min(255, br * f) | 0;
      const eg = Math.min(255, bg * f) | 0;
      const eb = Math.min(255, bb * f) | 0;
      const dr = Math.abs(data[o] - er); const dg = Math.abs(data[o + 1] - eg); const db = Math.abs(data[o + 2] - eb);
      const isBlank = data[o] === 255 && data[o + 1] === 255 && data[o + 2] === 255;
      if (isBlank) blank += 1;
      else if (dr <= 3 && dg <= 3 && db <= 3) loaded += 1;
      else notes.push(`img${i}: color off (${data[o]},${data[o + 1]},${data[o + 2]}) vs (${er},${eg},${eb})`);
    }
    ev.checked = 10; ev.loaded = loaded; ev.blank = blank;
    ev.note = `loaded=${loaded}/10 blank=${blank} ${notes.slice(0, 2).join('; ')}`;
    const ok = loaded === 10 && blank === 0;
    phase('C6 lazy images decoded in stitched output', ok, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C6 lazy images decoded in stitched output', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C7: page state restored, success and failure ----
if (FULL) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'tall-restore');
    await pg.goto(`${BASE}/tall?h=3000`);
    await pg.bringToFront();
    await sleep(500);
    await pg.evaluate(() => window.scrollTo(0, 400));
    const before = await pg.evaluate(() => ({
      x: window.scrollX, y: window.scrollY,
      bannerDisplay: document.getElementById('cookie').style.display,
      marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
    }));
    await fullCaptureFlow(pg, { shot });
    const after = await pg.evaluate(() => ({
      x: window.scrollX, y: window.scrollY,
      bannerDisplay: document.getElementById('cookie').style.display,
      bannerVisible: getComputedStyle(document.getElementById('cookie')).display,
      hdrVisibility: document.querySelector('header').style.visibility,
      marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
    }));
    ev.afterSuccess = after;
    const okSuccess = after.x === before.x && after.y === before.y
      && after.marks === 0 && after.bannerVisible !== 'none' && after.hdrVisibility !== 'hidden';
    // Failure path: a simulated mid-capture throw must still restore.
    await pg.evaluate(() => window.scrollTo(0, 400));
    let threw = false;
    try {
      await fullCaptureFlow(pg, { shot, failAfterTiles: 2 });
    } catch { threw = true; }
    const afterFail = await pg.evaluate(() => ({
      x: window.scrollX, y: window.scrollY,
      bannerVisible: getComputedStyle(document.getElementById('cookie')).display,
      hdrVisibility: document.querySelector('header').style.visibility,
      marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
    }));
    ev.afterFailure = afterFail;
    ev.simulatedThrow = threw;
    const okFail = threw && afterFail.x === 0 && afterFail.y === 400
      && afterFail.marks === 0 && afterFail.bannerVisible !== 'none' && afterFail.hdrVisibility !== 'hidden';
    ev.note = `success restored=${okSuccess}, failure restored=${okFail}`;
    phase('C7 page state fully restored', okSuccess && okFail, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C7 page state fully restored', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C8: very long page split into parts, all full resolution ----
if (FULL) {
  const ev = {};
  try {
    const H = 40000;
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'rows-40k');
    await pg.goto(`${BASE}/rows?h=${H}`);
    await pg.bringToFront();
    await sleep(500);
    const t0 = Date.now();
    const flow = await fullCaptureFlow(pg, { shot });
    ev.ms = Date.now() - t0;
    const { plan, parts } = flow;
    ev.parts = parts.length;
    ev.tiles = plan.totalTiles;
    ev.expDevH = plan.devH;
    const gotDevH = parts.reduce((n, p) => n + p.plan.h, 0);
    ev.gotDevH = gotDevH;
    ev.partDims = parts.map((p) => `${p.w}x${p.h}`).join(',');
    // Every part at full resolution: full page width, dims match the plan.
    const fullRes = parts.every((p) => p.w === plan.devW && p.w === p.plan.w && p.h === p.plan.h);
    ev.fullRes = fullRes;
    // Row sequence across all parts, in order.
    let badTotal = 0; let checkedTotal = 0;
    for (const p of parts) {
      const s = seqCheckPart(p.buf, p.plan, flow.dpr);
      badTotal += s.bad; checkedTotal += s.checked;
    }
    ev.seqOk = badTotal === 0 && checkedTotal === 400;
    ev.note = `${parts.length} parts, ${plan.totalTiles} tiles, devH ${gotDevH}/${plan.devH}, seq bad=${badTotal}/${checkedTotal}`;
    const ok = parts.length > 1 && gotDevH === plan.devH && fullRes && ev.seqOk;
    phase('C8 long page: parts, all full resolution', ok, ev);
    const f = `stitch-c8-p${parts[0].plan.index}.png`;
    fs.writeFileSync(path.join(downloadDir, f), parts[0].buf);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C8 long page: parts, all full resolution', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C9: area crop byte-exact at every DPR, realistic fixture ----
{
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, `crop-dpr${DPR}`);
    await pg.goto(`${BASE}/realistic`);
    await pg.bringToFront();
    await sleep(800); // let the seeded noise canvas paint
    const srcShot = await shot();
    const srcDims = ihdrDims(srcShot);
    // Device-px rect, like the overlay reports (FIX 4.6). Built from the
    // real layout so it always covers the gradient hero, anti-aliased
    // text cards and the photo-noise canvas: hundreds of thousands of
    // unique colors, where the old 0.92 median-cut could not hide.
    const box = await pg.evaluate(() => {
      const pr = document.querySelector('.photorow').getBoundingClientRect();
      return {
        top: 40, left: 60, width: 1200,
        bottom: Math.min(pr.bottom + 24, window.innerHeight - 20),
      };
    });
    const rx = Math.round(box.left * DPR);
    const ry = Math.round(box.top * DPR);
    const rect = {
      x: rx,
      y: ry,
      width: Math.min(Math.round(box.width * DPR), srcDims.w - rx),
      height: Math.min(Math.round((box.bottom - box.top) * DPR), srcDims.h - ry),
    };
    if (!(rect.width > 0 && rect.height > 0)) throw new Error('bad test rect');
    const srcUrl = `data:image/png;base64,${srcShot.toString('base64')}`;
    // Each tree's REAL production crop. New tree: the lossless in-worker
    // crop (core/crop-image.js): the exact module the worker imports,
    // driven here from the control page, because Playwright cannot dynamic
    // import() inside the worker scope. The pixel pipeline (decode, 1:1
    // drawImage, PNG encode) is identical. Old tree: no such module, so
    // drive its real production call, the offscreen CROP_IMAGE with the
    // hard-coded quality 0.92.
    let cropDataUrl;
    if (HAS_WORKER_CROP) {
      ev.cropPath = 'worker/core/crop-image.js';
      const r = await ctrl.evaluate(async ({ dataUrl, rc }) => {
        const m = await import(chrome.runtime.getURL('core/crop-image.js'));
        return m.cropPngDataUrl(dataUrl, rc);
      }, { dataUrl: srcUrl, rc: rect });
      if (!r || !r.dataUrl) throw new Error('worker crop failed');
      cropDataUrl = r.dataUrl;
    } else {
      ev.cropPath = 'offscreen/CROP_IMAGE@0.92';
      const r = await sendOff({
        type: 'CROP_IMAGE', dataUrl: srcUrl, rect, format: 'png', quality: 0.92, pageUrl: pg.url(),
      });
      if (!r || !r.ok || !r.dataUrl) throw new Error(`CROP_IMAGE failed: ${JSON.stringify(r)}`);
      cropDataUrl = r.dataUrl;
    }
    const b = Buffer.from(cropDataUrl.split(',')[1], 'base64');
    if (!pngMagic(b)) throw new Error('crop is not a PNG');
    const d = ihdrDims(b);
    ev.rect = JSON.stringify(rect);
    ev.dim = `${d.w}x${d.h}`;
    if (d.w !== rect.width || d.h !== rect.height) {
      throw new Error(`crop dims ${d.w}x${d.h} != rect ${rect.width}x${rect.height}`);
    }
    // Ground truth: cropped pixels must equal the source region, byte for byte.
    const src = decodePng(srcShot);
    const out = decodePng(b);
    let diffPixels = 0;
    for (let y = 0; y < out.h; y += 1) {
      for (let x = 0; x < out.w; x += 1) {
        const so = ((rect.y + y) * src.w + (rect.x + x)) * 4;
        const oo = (y * out.w + x) * 4;
        if (src.data[so] !== out.data[oo] || src.data[so + 1] !== out.data[oo + 1]
            || src.data[so + 2] !== out.data[oo + 2] || src.data[so + 3] !== out.data[oo + 3]) {
          diffPixels += 1;
        }
      }
    }
    // Unique colour counts must match too: lossy reduction changes them.
    const srcColors = uniqueColors(src, rect.x, rect.y, rect.width, rect.height);
    const outColors = uniqueColors(out, 0, 0, out.w, out.h);
    ev.diffPixels = diffPixels;
    ev.srcColors = srcColors;
    ev.outColors = outColors;
    ev.note = `rect ${ev.rect} -> ${ev.dim} via ${ev.cropPath}, diffPixels=${diffPixels}, colors ${outColors}/${srcColors}`;
    const ok = diffPixels === 0 && outColors === srcColors;
    phase(`C9 area crop byte-exact at DPR ${DPR}`, ok, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase(`C9 area crop byte-exact at DPR ${DPR}`, false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C10: peak heap during a 64 MP stitch ----
if (FULL) {
  const ev = {};
  try {
    const mem = async () => sendOff({ type: 'MEMORY_SAMPLE' });
    const m0 = await mem();
    const begin = await sendOff({ type: 'STITCH_BEGIN', width: 8000, height: 8000 });
    if (!begin || !begin.ok) throw new Error(`STITCH_BEGIN 8000x8000 rejected: ${JSON.stringify(begin)}`);
    const tilePng = makePng(1000, 1000, [120, 140, 160]);
    const tileUrl = `data:image/png;base64,${tilePng.toString('base64')}`;
    let peak = (m0 && m0.usedJSHeapSize) || 0;
    for (let i = 0; i < 64; i += 1) {
      const res = await sendOff({
        type: 'STITCH_TILE', dataUrl: tileUrl,
        dx: (i % 8) * 1000, dy: Math.floor(i / 8) * 1000,
        pageUrl: `${BASE}/rows?h=2000`,
      });
      if (!res || !res.ok) throw new Error(`tile ${i} failed`);
      if (i % 16 === 15) {
        const m = await mem();
        if (m && m.usedJSHeapSize > peak) peak = m.usedJSHeapSize;
      }
    }
    const end = await sendOff({ type: 'STITCH_END', format: 'png' });
    if (!end || !end.ok || !end.dataUrl) throw new Error('STITCH_END failed');
    const b = Buffer.from(end.dataUrl.split(',')[1], 'base64');
    const dims = ihdrDims(b);
    const mAfter = await mem();
    ev.tiles = 64;
    ev.outDims = `${dims.w}x${dims.h}`;
    ev.offscreenPeakMB = Math.round(peak / 1048576);
    ev.offscreenAfterMB = Math.round(((mAfter && mAfter.usedJSHeapSize) || 0) / 1048576);
    ev.pngBytes = b.length;
    ev.note = `64 tiles -> ${ev.outDims}, peak JS heap ${ev.offscreenPeakMB} MB`;
    const ok = pngMagic(b) && dims.w === 8000 && dims.h === 8000;
    phase('C10 64MP stitch peak memory measured', ok, ev);
  } catch (e) {
    phase('C10 64MP stitch peak memory measured', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C12: 100 MP part allocation + blob encode + IndexedDB store ----
if (FULL) {
  const ev = {};
  try {
    const begin = await sendOff({ type: 'STITCH_BEGIN', width: 10000, height: 10000 });
    if (!begin || !begin.ok) throw new Error(`STITCH_BEGIN 10000x10000 rejected: ${JSON.stringify(begin)}`);
    const tilePng = makePng(1000, 1000, [90, 120, 150]);
    const tileUrl = `data:image/png;base64,${tilePng.toString('base64')}`;
    // Corner + centre tiles only: the point is the 100 MP canvas, the
    // encode and the Blob store, not painting every pixel.
    const spots = [[0, 0], [9000, 0], [0, 9000], [9000, 9000], [4500, 4500]];
    for (const [dx, dy] of spots) {
      const res = await sendOff({
        type: 'STITCH_TILE', dataUrl: tileUrl, dx, dy, pageUrl: `${BASE}/rows?h=2000`,
      });
      if (!res || !res.ok) throw new Error(`tile ${dx},${dy} failed`);
    }
    const t0 = Date.now();
    const end = await sendOff({
      type: 'STITCH_END_BLOB', format: 'png',
      record: { id: 'e2e-c12', partIndex: 1, partTotal: 1, groupId: 'e2e-c12-group', groupOpen: true, at: Date.now() },
    });
    ev.encodeMs = Date.now() - t0;
    if (!end || !end.ok || !end.id) throw new Error(`STITCH_END_BLOB failed: ${JSON.stringify(end)}`);
    ev.bytes = end.bytes;
    // Read the record back from IndexedDB in the control page: the
    // Blob must be there, sized as reported, a real PNG at 10000x10000,
    // and decodable to a bitmap of the planned dimensions.
    const back = await ctrl.evaluate(async () => {
      const rec = await new Promise((resolve) => {
        try {
          const req = indexedDB.open('imgfetch', 1);
          req.onsuccess = () => {
            try {
              const rq = req.result.transaction('captures', 'readonly').objectStore('captures').get('e2e-c12');
              rq.onsuccess = () => resolve(rq.result || null);
              rq.onerror = () => resolve(null);
            } catch { resolve(null); }
          };
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
      if (!rec || !rec.blob) return { found: false };
      const head = new Uint8Array(await rec.blob.slice(0, 24).arrayBuffer());
      const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const dims = { w: dv.getUint32(16), h: dv.getUint32(20) };
      const bmp = await createImageBitmap(rec.blob);
      const bitmapOk = bmp.width === 10000 && bmp.height === 10000;
      bmp.close();
      return {
        found: true, size: rec.blob.size, dims, bitmapOk,
        width: rec.width, height: rec.height, groupId: rec.groupId,
      };
    });
    ev.back = back;
    const ok = back.found && back.size === end.bytes && back.dims.w === 10000 && back.dims.h === 10000
      && back.bitmapOk && back.width === 10000 && back.height === 10000;
    ev.note = `10000x10000 blob=${end.bytes}B encode=${ev.encodeMs}ms bitmapOk=${back.bitmapOk}`;
    phase('C12 100MP part: allocation, blob encode and IDB store', ok, ev);
  } catch (e) {
    phase('C12 100MP part: allocation, blob encode and IDB store', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C13: realistic fixture across several parts, pixel-exact ----
if (FULL) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    const shot = await armDpr(pg);
    watchErrors(pg, 'realistic-parts');
    await pg.goto(`${BASE}/realistic?h=4320`);
    await pg.bringToFront();
    await sleep(800); // seeded noise canvases paint
    await injectScanner(pg);
    const desc = await pg.evaluate(() => window.__imgfetch.describeScrollContext());
    const dpr13 = Number(desc.dpr) > 0 ? Number(desc.dpr) : 1;
    // Force several parts with a tight (test-only) area budget through
    // the REAL planner option; the stitcher limits are the defaults.
    const plan = planFullPageCapture({
      fullW: desc.doc.scrollW, fullH: desc.doc.scrollH,
      viewportW: desc.viewportW, viewportH: desc.viewportH, dpr: dpr13,
      maxArea: 4_000_000,
    });
    ev.parts = plan.parts.length;
    if (plan.parts.length < 2) throw new Error(`expected several parts, planned ${plan.parts.length}`);
    const target = { kind: 'document' };
    const origScroll = await pg.evaluate(() => ({ x: window.scrollX || 0, y: window.scrollY || 0 }));
    let tileNo = 0;
    let totalDiff = 0;
    const notes = [];
    try {
      for (const part of plan.parts) {
        const begin = await sendOff({ type: 'STITCH_BEGIN', width: part.w, height: part.h });
        if (!begin || !begin.ok) throw new Error(`STITCH_BEGIN part ${part.index} rejected`);
        // Expected composition: white canvas + the source tiles blitted
        // at their exact planned offsets (what a lossless stitch is).
        const expected = Buffer.alloc(part.w * part.h * 4, 255);
        let partDone = false;
        try {
          for (const tile of part.tiles) {
            const actual = await pg.evaluate(
              ([t, x, y]) => window.__imgfetch.scrollCaptureTarget(t, x, y),
              [target, tile.sx, tile.sy],
            );
            if (!actual) throw new Error('scrollCaptureTarget failed');
            const ax = Math.round((actual.x || 0) * dpr13);
            const ay = Math.round((actual.y || 0) * dpr13);
            if (tileNo === 1) await pg.evaluate(() => window.__imgfetch.setFixedHidden(true));
            await pg.evaluate(
              ([b, ms]) => window.__imgfetch.waitForViewportStable(b, ms),
              [{ x: 0, y: 0, w: desc.viewportW, h: desc.viewportH }, 2500],
            ).catch(() => null);
            const tileBuf = await shot();
            tileNo += 1;
            const dx = ax - part.x0;
            const dy = ay - part.y0;
            const res = await sendOff({
              type: 'STITCH_TILE',
              dataUrl: `data:image/png;base64,${tileBuf.toString('base64')}`,
              dx, dy, pageUrl: pg.url(),
            });
            if (!res || !res.ok) throw new Error(`STITCH_TILE part ${part.index} failed`);
            const tileImg = decodePng(tileBuf);
            for (let y = 0; y < tileImg.h && dy + y < part.h; y += 1) {
              for (let x = 0; x < tileImg.w && dx + x < part.w; x += 1) {
                const so = (y * tileImg.w + x) * 4;
                const oo = ((dy + y) * part.w + (dx + x)) * 4;
                expected[oo] = tileImg.data[so];
                expected[oo + 1] = tileImg.data[so + 1];
                expected[oo + 2] = tileImg.data[so + 2];
                expected[oo + 3] = tileImg.data[so + 3];
              }
            }
          }
          partDone = true;
        } finally {
          if (!partDone) await sendOff({ type: 'STITCH_ABORT' }).catch(() => null);
        }
        const end = await sendOff({ type: 'STITCH_END', format: 'png' });
        if (!end || !end.ok || !end.dataUrl) throw new Error(`STITCH_END part ${part.index} failed`);
        const out = decodePng(Buffer.from(end.dataUrl.split(',')[1], 'base64'));
        if (out.w !== part.w || out.h !== part.h) throw new Error(`part ${part.index} dims ${out.w}x${out.h} != ${part.w}x${part.h}`);
        let diff = 0;
        for (let i = 0; i < expected.length; i += 4) {
          if (expected[i] !== out.data[i] || expected[i + 1] !== out.data[i + 1]
            || expected[i + 2] !== out.data[i + 2] || expected[i + 3] !== out.data[i + 3]) diff += 1;
        }
        totalDiff += diff;
        const expColors = uniqueColors({ w: part.w, h: part.h, data: expected }, 0, 0, part.w, part.h);
        const outColors = uniqueColors(out, 0, 0, out.w, out.h);
        notes.push(`part${part.index}: diff=${diff} colors=${outColors}/${expColors}`);
        if (diff !== 0 || expColors !== outColors) {
          throw new Error(`part ${part.index} not pixel-exact: diff=${diff} colors ${outColors}/${expColors}`);
        }
      }
    } finally {
      await pg.evaluate(() => window.__imgfetch.restoreCaptureTarget()).catch(() => {});
      await pg.evaluate(([x, y]) => window.scrollTo(x, y), [origScroll.x, origScroll.y]).catch(() => {});
      await pg.evaluate(() => window.__imgfetch.setFixedHidden(false)).catch(() => {});
    }
    ev.notes = notes.join(' | ');
    ev.totalDiff = totalDiff;
    ev.tiles = tileNo;
    ev.note = `${plan.parts.length} parts, ${tileNo} tiles, total diff=${totalDiff}; ${notes.join(' | ')}`;
    phase('C13 realistic fixture across parts is pixel-exact per part', totalDiff === 0, ev);
    await pg.close().catch(() => {});
  } catch (e) {
    phase('C13 realistic fixture across parts is pixel-exact per part', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- C11: annotate editor with an 8000x8000 image ----
if (FULL) {
  const ev = {};
  try {
    // The worker cannot produce a capture here (captureVisibleTab is
    // refused by this automated browser), so seed the record through the
    // worker's own IndexedDB store: the exact path a worker restart
    // recovery takes (recallCapture falls back to idb).
    const bigPng = makePng(8000, 8000, [200, 200, 210]);
    const dataUrl = `data:image/png;base64,${bigPng.toString('base64')}`;
    ev.pngMB = Math.round(bigPng.length / 1048576 * 10) / 10;
    const seedCapture = (seedId) => ctrl.evaluate(([du, sid]) => new Promise((resolve) => {
      try {
        const req = indexedDB.open('imgfetch', 1);
        let upgraded = false;
        // The worker's idb.js creates this store on its first open; when
        // the test page gets here first, create the identical schema
        // (store 'captures', keyPath 'id') so the worker finds it later.
        req.onupgradeneeded = () => {
          upgraded = true;
          const db = req.result;
          if (!db.objectStoreNames.contains('captures')) db.createObjectStore('captures', { keyPath: 'id' });
        };
        req.onsuccess = () => {
          try {
            const db = req.result;
            const stores = Array.from(db.objectStoreNames || []).join(',');
            const tx = db.transaction('captures', 'readwrite');
            const pr = tx.objectStore('captures').put({ id: sid, dataUrl: du, width: 8000, height: 8000, at: Date.now() });
            pr.onerror = () => resolve(`put-error:${pr.error && pr.error.name}|stores=${stores}|upgraded=${upgraded}`);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(`tx-error:${tx.error && tx.error.name}|stores=${stores}|upgraded=${upgraded}`);
          } catch (e) { resolve(`tx-throw:${String(e).slice(0, 80)}|upgraded=${upgraded}`); }
        };
        req.onerror = () => resolve('open-error');
        req.onblocked = () => resolve('blocked');
      } catch (e) { resolve(`sync-throw:${String(e).slice(0, 80)}`); }
    }), [dataUrl, seedId]);
    let seeded = await seedCapture('e2e-c11');
    if (seeded !== true) {
      await sleep(2000);
      seeded = await seedCapture('e2e-c11');
    }
    if (seeded !== true) throw new Error(`idb seed failed: ${seeded}`);
    const ann = await ctx.newPage();
    watchErrors(ann, 'annotate');
    await ann.goto(`chrome-extension://${extId}/pages/annotate.html#e2e-c11`);
    await ann.waitForFunction(
      () => { const c = document.getElementById('content'); return c && !c.hidden; },
      { timeout: 60000 },
    );
    const box = await ann.$eval('#editor', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    ev.editorBox = `${Math.round(box.w)}x${Math.round(box.h)} css`;
    // Draw three strokes; measure wall time on the 64 MP canvas.
    const t0 = Date.now();
    for (let s = 0; s < 3; s += 1) {
      const y0 = box.y + 80 + s * 50;
      await ann.mouse.move(box.x + 80, y0);
      await ann.mouse.down();
      for (let i = 1; i <= 12; i += 1) {
        await ann.mouse.move(box.x + 80 + i * 30, y0 + (i % 2) * 10, { steps: 1 });
      }
      await ann.mouse.up();
    }
    ev.strokeMs = Date.now() - t0;
    const st1 = await ann.evaluate(() => ({
      undo: document.getElementById('btnUndo').disabled,
      redo: document.getElementById('btnRedo').disabled,
    }));
    await ann.click('#btnUndo');
    await sleep(300);
    const st2 = await ann.evaluate(() => ({
      undo: document.getElementById('btnUndo').disabled,
      redo: document.getElementById('btnRedo').disabled,
    }));
    await ann.click('#btnRedo');
    await sleep(300);
    const st3 = await ann.evaluate(() => ({
      undo: document.getElementById('btnUndo').disabled,
      redo: document.getElementById('btnRedo').disabled,
    }));
    // A new drawing action clears the redo stack.
    await ann.mouse.move(box.x + 80, box.y + 300);
    await ann.mouse.down();
    await ann.mouse.move(box.x + 200, box.y + 320, { steps: 3 });
    await ann.mouse.up();
    await sleep(300);
    const st4 = await ann.evaluate(() => ({ redo: document.getElementById('btnRedo').disabled }));
    ev.undoRedo = { afterDraw: st1, afterUndo: st2, afterRedo: st3, redoCleared: st4 };
    // Copy: the 64 MP image exceeds the 12 MP clipboard budget, so the
    // editor must downscale honestly and still produce a valid PNG.
    await ann.click('#btnCopy');
    await sleep(2000);
    const clip = await ann.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes('image/png')) {
            const blob = await it.getType('image/png');
            const ab = await blob.arrayBuffer();
            const b = new Uint8Array(ab);
            const magic = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
            return {
              ok: true, len: b.length, magic,
              w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19],
              h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23],
            };
          }
        }
        return { ok: false, reason: 'no-png-item' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; }
    });
    ev.clipboard = clip;
    const copyOk = clip && clip.ok === true && clip.magic === true && (clip.w * clip.h) <= 12000000 + 100000;
    // Save: full 8000x8000 PNG must land on disk.
    const before = new Set(fs.readdirSync(downloadDir));
    await ann.click('#btnSave');
    let savedFile = null;
    {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && !savedFile) {
        await sleep(1000);
        const landed = fs.readdirSync(downloadDir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
        if (landed.length) savedFile = landed[0];
      }
    }
    let savedDims = null;
    if (savedFile) {
      const b = fs.readFileSync(path.join(downloadDir, savedFile));
      savedDims = pngMagic(b) ? ihdrDims(b) : null;
    }
    ev.savedFile = savedFile;
    ev.savedDims = savedDims ? `${savedDims.w}x${savedDims.h}` : null;
    const saveOk = !!(savedDims && savedDims.w === 8000 && savedDims.h === 8000);
    let closedAfterSave = false;
    try {
      await ann.waitForEvent('close', { timeout: 5000 });
      closedAfterSave = true;
    } catch { /* stayed open */ }
    ev.closedAfterSave = closedAfterSave;
    if (!closedAfterSave) await ann.close().catch(() => {});
    // Discard: re-seed, open, cancel, the tab must close.
    const seeded2 = await seedCapture('e2e-c11b');
    if (seeded2 !== true) throw new Error(`idb re-seed failed: ${seeded2}`);
    let discardClosed = false;
    if (seeded2) {
      const ann2 = await ctx.newPage();
      watchErrors(ann2, 'annotate-discard');
      await ann2.goto(`chrome-extension://${extId}/pages/annotate.html#e2e-c11b`);
      await ann2.waitForFunction(
        () => { const c = document.getElementById('content'); return c && !c.hidden; },
        { timeout: 60000 },
      );
      const closedP = ann2.waitForEvent('close', { timeout: 8000 }).then(() => true).catch(() => false);
      await ann2.click('#btnCancel');
      discardClosed = await closedP;
      if (!discardClosed) await ann2.close().catch(() => {});
    }
    ev.discardClosed = discardClosed;
    const annErrs = errorWatch.filter((e) => e.label.startsWith('annotate')
      && (e.kind === 'console.error' || e.kind === 'pageerror'));
    ev.annErrors = annErrs.length;
    ev.note = `strokes ${ev.strokeMs}ms, copy ${clip && clip.w}x${clip && clip.h}, save ${ev.savedDims}, discardClosed=${discardClosed}`;
    const undoOk = st1.undo === false && st2.redo === false && st3.redo === true && st4.redo === true;
    const ok = undoOk && copyOk && saveOk && discardClosed && annErrs.length === 0;
    phase('C11 annotate 8000x8000: draw/undo/redo/save/copy/discard', ok, ev);
  } catch (e) {
    phase('C11 annotate 8000x8000: draw/undo/redo/save/copy/discard', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

// ---- final: zero console.error / pageerror anywhere ----
{
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('no console errors / pageerrors anywhere', errOnly.length === 0, {
    note: `${errOnly.length} errors, ${errorWatch.length} total entries`,
    first: errOnly.slice(0, 3),
  });
}

const resName = `results-capture-${BROWSER}-dpr${DPR}.json`;
fs.writeFileSync(path.join(HERE, resName), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
console.log(`results: tests/test-e2e/${resName}`);

await ctx.close().catch(() => {});
fixture.close();
process.exit(results.errors.length ? 1 : 0);
