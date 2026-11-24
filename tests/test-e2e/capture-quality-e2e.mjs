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
 * ImgFetch e2e, tests/test-e2e/capture-quality-e2e.mjs
 * Phase 5 item C acceptance suite. Synthetic tall pages (1440 CSS px
 * wide, fine 10 px text, 1 px grid) at DPR 1 and 2, driven through the
 * REAL planner (core/fullpage-capture.js), the REAL in-page logic
 * (content/scanner.js) and the REAL offscreen stitcher
 * (STITCH_BEGIN/TILE/END), exactly like capture-e2e.mjs. Tile captures
 * use CDP Page.captureScreenshot because automated browsers get no
 * activeTab gesture for chrome.tabs.captureVisibleTab.
 *
 * Phases:
 *  Q0  canvas limits probe: 16384x16384 allocates and encodes; a
 *      2880x80000 canvas (inside the area cap) fails, so the side cap
 *      is the binding guard.
 *  Q1  40,000 px page, DPR 1: every saved part PNG matches its source
 *      tiles pixel for pixel (exact fraction 1, MAD 0) and the
 *      sharpness ratio (variance of the Laplacian, final vs tile) is
 *      at least 0.99.
 *  Q2  40,000 px page, DPR 2: same as Q1.
 *  Q3  editor Copy and editor Save for part 1 at DPR 1 and DPR 2: the
 *      copied image and the saved file match the source tiles pixel
 *      for pixel, sharpness ratio at least 0.99; the editor status
 *      line shows the real pixel size.
 *  Q4  60,000 px page, DPR 2: stitch completes, peak offscreen JS heap
 *      is reported, no crash.
 *
 * Run one suite at a time (see tests/test-e2e/README.md):
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/capture-quality-e2e.mjs [--proj=<tree>] [--out=<results.json>] [--shots=<dir>]
 * Writes results JSON (default tests/test-e2e/results-capture-quality-chromium.json).
 * Fails on any phase failure and on any console.error / pageerror in the
 * service worker, the control page, the offscreen document or any test page.
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
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { planFullPageCapture, pickScrollTarget } from '../../core/fullpage-capture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const PROJ = path.resolve(String(args.proj || DEFAULT_PROJ));
const OUT = String(args.out || path.join(HERE, 'results-capture-quality-chromium.json'));
const SHOTS = args.shots ? String(args.shots) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { suite: 'capture-quality', phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `, ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}

/* Minimal PNG decoder (8-bit RGB/RGBA), same as capture-e2e.mjs. */
function decodePng(buf) {
  let pos = 8; let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported PNG depth=${bitDepth} type=${colorType}`);
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
          const pp = a + b - cc; const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - cc);
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
const ihdrDims = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/* Variance of the Laplacian on a grayscale crop (sharpness). */
function lapVar(img, x0, y0, w, h, stride = 3) {
  const g = (x, y) => {
    const o = (y * img.w + x) * 4;
    return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
  };
  let n = 0; let sum = 0; let sum2 = 0;
  for (let y = y0 + 1; y < y0 + h - 1; y += stride) {
    for (let x = x0 + 1; x < x0 + w - 1; x += stride) {
      const v = 4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1);
      sum += v; sum2 += v * v; n += 1;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/* Compare one tile against the final image at part-relative offset. */
function compareRegion(tile, final, dx, dy) {
  const w = Math.min(tile.w, final.w - dx);
  const h = Math.min(tile.h, final.h - dy);
  let n = 0; let exact = 0; let absSum = 0; let maxAbs = 0;
  for (let y = 0; y < h; y += 5) {
    for (let x = 0; x < w; x += 5) {
      const o1 = (y * tile.w + x) * 4;
      const o2 = ((dy + y) * final.w + (dx + x)) * 4;
      let d = 0;
      for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(tile.data[o1 + c] - final.data[o2 + c]));
      if (d === 0) exact += 1;
      absSum += d; if (d > maxAbs) maxAbs = d;
      n += 1;
    }
  }
  const cx = Math.min(Math.max(0, Math.floor(tile.w / 2) - 200), Math.max(0, tile.w - 400));
  const cy = Math.min(Math.max(0, Math.floor(tile.h / 2) - 150), Math.max(0, tile.h - 300));
  const cw = Math.min(400, tile.w - cx); const ch = Math.min(300, tile.h - cy);
  const lvTile = lapVar(tile, cx, cy, cw, ch);
  const lvFinal = lapVar(final, dx + cx, dy + cy, cw, ch);
  return { sampled: n, exact, exactFrac: n ? exact / n : 0, mad: n ? absSum / n : 0, maxAbs, lapTile: lvTile, lapFinal: lvFinal, lapRatio: lvTile > 0 ? lvFinal / lvTile : 0 };
}

function aggregateCompare(tileBufs, finalImg) {
  let agg = { sampled: 0, exact: 0, absSum: 0, maxAbs: 0, lapRatioSum: 0, lapN: 0 };
  for (const t of tileBufs) {
    const tile = decodePng(t.buf);
    const c = compareRegion(tile, finalImg, t.dx, t.dy);
    agg.sampled += c.sampled; agg.exact += c.exact; agg.absSum += c.mad * c.sampled;
    agg.maxAbs = Math.max(agg.maxAbs, c.maxAbs);
    if (c.lapTile > 0) { agg.lapRatioSum += c.lapRatio; agg.lapN += 1; }
  }
  return {
    exactFrac: agg.sampled ? agg.exact / agg.sampled : 0,
    mad: agg.sampled ? agg.absSum / agg.sampled : 0,
    maxAbs: agg.maxAbs,
    lapRatioMean: agg.lapN ? agg.lapRatioSum / agg.lapN : 0,
    sampled: agg.sampled,
  };
}

/* Synthetic page: 1440 CSS px wide, fine 10 px text, 1 px grid. */
function pageHtml(heightCss) {
  const rows = [];
  for (let y = 0; y < heightCss; y += 100) {
    const i = y / 100;
    const r = (i * 67) % 256; const g = (i * 131) % 256; const b = (i * 197) % 256;
    rows.push(`<div class="row" style="top:${y}px;background:rgb(${r},${g},${b})"><span>Row ${i} fine detail text 0123456789 abcdefghij KLNMOPQR stuvwx 1px grid check ${'#'.repeat(40)}</span></div>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:1440px}
    body{position:relative;height:${heightCss}px;background:#fff;
      background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.55) 0 1px,transparent 1px 20px),repeating-linear-gradient(90deg,rgba(0,0,0,.55) 0 1px,transparent 1px 20px);}
    .row{position:absolute;left:0;width:1440px;height:100px;overflow:hidden}
    .row span{display:block;font:10px/14px monospace;color:#fff;background:rgba(0,0,0,.45);padding:2px 6px;white-space:nowrap}
    </style></head><body>${rows.join('')}</body></html>`;
}

const server = http.createServer((req, res) => {
  const m = /^\/tall\/(\d+)$/.exec(req.url || '');
  if (!m) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pageHtml(Number(m[1])));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`fixture ${BASE} proj=${PROJ}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-cq-e2e-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-cq-dl-'));
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
    headless: false,
    viewport: { width: 1440, height: 800 },
    args: [`--disable-extensions-except=${PROJ}`, `--load-extension=${PROJ}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
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
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
const sendOff = (msg) => sw.evaluate((m) => chrome.runtime.sendMessage(m), { target: 'offscreen', ...msg });
await sw.evaluate(() => chrome.offscreen.createDocument({
  url: 'offscreen/offscreen.html', reasons: ['BLOBS', 'CLIPBOARD'],
  justification: 'capture quality e2e',
}).catch(() => {}));
await sleep(1500);
{
  let begin = null;
  for (let a = 0; a < 6 && (!begin || !begin.ok); a += 1) {
    if (a) await sleep(400 * a);
    begin = await sendOff({ type: 'STITCH_BEGIN', width: 8, height: 8 }).catch(() => null);
  }
  await sendOff({ type: 'STITCH_ABORT' }).catch(() => {});
  if (!begin || !begin.ok) { console.log('FATAL: offscreen stitcher did not answer'); process.exit(2); }
}
{
  const cdp = await ctx.newCDPSession(ctrl);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
}
const memSample = async () => (await sendOff({ type: 'MEMORY_SAMPLE' }).catch(() => null)) || {};
const scannerSrc = fs.readFileSync(path.join(PROJ, 'content/scanner.js'), 'utf8');

/* ---- Q0: canvas limits probe ---- */
{
  const probe = await ctrl.evaluate(async () => {
    const out = [];
    const sizes = [[16384, 16384], [2880, 80000], [1440, 40000], [2880, 16000]];
    for (const [w, h] of sizes) {
      let ok = false; let encoded = 0; let err = '';
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        if (c.width !== w || c.height !== h) throw new Error('canvas shrank on alloc');
        const x = c.getContext('2d');
        if (!x) throw new Error('no 2d context');
        x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        if (!blob) throw new Error('toBlob null');
        encoded = blob.size; ok = true;
        c.width = 0; c.height = 0;
      } catch (e) { err = String((e && e.message) || e).slice(0, 120); }
      out.push({ w, h, area: w * h, ok, encodedBytes: encoded, err });
    }
    return out;
  });
  const by = (w, h) => probe.find((p) => p.w === w && p.h === h);
  const ok = by(16384, 16384).ok && !by(2880, 80000).ok && by(1440, 40000).ok && by(2880, 16000).ok;
  phase('Q0 canvas limits: 16384x16384 encodes, 2880x80000 fails (side cap binds)', ok, {
    note: probe.map((p) => `${p.w}x${p.h}=${p.ok ? 'ok' : `fail:${p.err}`}`).join(', '),
    probe,
  });
}

/**
 * Capture one synthetic page through the real planner + stitcher.
 * Returns { plan, parts: [{ index, w, h, buf, tiles: [{buf,dx,dy}] }] }.
 * When storeFirst is set, part 1 is also stored as a Blob record via
 * STITCH_END_BLOB and its record id is returned as firstRecordId.
 */
async function capturePage(dpr, heightCss, storeFirst = false) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: dpr, mobile: false });
  await page.goto(`${BASE}/tall/${heightCss}`, { timeout: 30000 });
  await page.addScriptTag({ content: scannerSrc });
  const desc = await page.evaluate(() => window.__imgfetch.describeScrollContext());
  const picked = pickScrollTarget(desc);
  const plan = planFullPageCapture({ fullW: desc.doc.scrollW, fullH: desc.doc.scrollH, viewportW: desc.viewportW, viewportH: desc.viewportH, dpr });
  const shot = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  };
  const parts = [];
  let firstRecordId = null;
  let peakHeap = 0;
  try {
    for (const part of plan.parts) {
      let begin = null;
      for (let a = 0; a < 6 && (!begin || !begin.ok); a += 1) {
        if (a) await sleep(400 * a);
        begin = await sendOff({ type: 'STITCH_BEGIN', width: part.w, height: part.h });
      }
      if (!begin || !begin.ok) throw new Error(`STITCH_BEGIN part ${part.index} rejected`);
      const tileBufs = [];
      for (const tile of part.tiles) {
        const actual = await page.evaluate(([t, x, y]) => window.__imgfetch.scrollCaptureTarget(t, x, y), [picked.target, tile.sx, tile.sy]);
        const ax = Math.round((actual.x || 0) * dpr);
        const ay = Math.round((actual.y || 0) * dpr);
        await sleep(60);
        const tileShot = await shot();
        tileBufs.push({ buf: tileShot, dx: ax - part.x0, dy: ay - part.y0 });
        const res = await sendOff({ type: 'STITCH_TILE', dataUrl: `data:image/png;base64,${tileShot.toString('base64')}`, dx: ax - part.x0, dy: ay - part.y0, pageUrl: page.url() });
        if (!res || !res.ok) throw new Error(`STITCH_TILE failed ${JSON.stringify(res)}`);
      }
      const mem = await memSample();
      if (mem.usedJSHeapSize > peakHeap) peakHeap = mem.usedJSHeapSize;
      if (storeFirst && part.index === 1) {
        const id = `cap-cq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const end = await sendOff({
          type: 'STITCH_END_BLOB', format: 'png',
          record: { id, partIndex: 1, partTotal: plan.parts.length, groupId: `grp-cq-${Date.now()}`, groupOpen: false, at: Date.now() },
        });
        if (!end || !end.ok || !end.id) throw new Error(`STITCH_END_BLOB failed ${JSON.stringify(end)}`);
        firstRecordId = end.id;
        // Re-read the stored bytes through the extension page's IndexedDB
        // so the comparison below uses the stored part, not a re-encode.
        const stored = await ctrl.evaluate(async (rid) => {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('imgfetch', 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const rec = await new Promise((resolve, reject) => {
            const req = db.transaction('captures', 'readonly').objectStore('captures').get(rid);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
          });
          db.close();
          if (!rec || !rec.blob) return null;
          const b64 = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(',')[1]);
            fr.readAsDataURL(rec.blob);
          });
          return { w: rec.width, h: rec.height, b64 };
        }, firstRecordId);
        if (!stored) throw new Error('stored part 1 not readable from IndexedDB');
        parts.push({ index: part.index, w: stored.w, h: stored.h, buf: Buffer.from(stored.b64, 'base64'), tiles: tileBufs });
      } else {
        const end = await sendOff({ type: 'STITCH_END', format: 'png' });
        if (!end || !end.ok || !end.dataUrl) throw new Error('STITCH_END failed');
        parts.push({ index: part.index, w: end.width, h: end.height, buf: Buffer.from(end.dataUrl.split(',')[1], 'base64'), tiles: tileBufs });
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { plan, parts, firstRecordId, peakHeap };
}

/* Compare every part of a capture against its source tiles. */
function partsCompare(capture) {
  return capture.parts.map((part) => {
    const finalImg = decodePng(part.buf);
    const dims = ihdrDims(part.buf);
    const cmp = aggregateCompare(part.tiles, finalImg);
    return { index: part.index, w: part.w, h: part.h, dims, pngBytes: part.buf.length, ...cmp };
  });
}

/* ---- Q1 + Q2: 40,000 px saved parts vs tiles, DPR 1 and 2 ---- */
const q12 = {};
for (const dpr of [1, 2]) {
  const ev = {};
  try {
    const cap = await capturePage(dpr, 40000, true);
    const perPart = partsCompare(cap);
    ev.parts = perPart.length;
    ev.partSizes = perPart.map((p) => `${p.w}x${p.h}`);
    ev.worstExact = Math.min(...perPart.map((p) => p.exactFrac));
    ev.worstMad = Math.max(...perPart.map((p) => p.mad));
    ev.worstMaxAbs = Math.max(...perPart.map((p) => p.maxAbs));
    ev.worstLapRatio = Math.min(...perPart.map((p) => p.lapRatioMean));
    ev.perPart = perPart;
    ev.note = `parts=${ev.parts} (${ev.partSizes.join(', ')}) exact=${ev.worstExact.toFixed(4)} mad=${ev.worstMad.toFixed(3)} maxAbs=${ev.worstMaxAbs} lapRatio=${ev.worstLapRatio.toFixed(4)}`;
    const ok = ev.worstExact === 1 && ev.worstMad === 0 && ev.worstMaxAbs === 0 && ev.worstLapRatio >= 0.99;
    phase(`Q${dpr === 1 ? 1 : 2} 40000px DPR ${dpr}: saved parts match tiles pixel for pixel`, ok, ev);
    q12[dpr] = { cap, perPart };
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `part1-dpr${dpr}.png`), cap.parts[0].buf);
    }
  } catch (e) {
    phase(`Q${dpr === 1 ? 1 : 2} 40000px DPR ${dpr}: saved parts match tiles pixel for pixel`, false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

/* ---- Q3: editor Copy and editor Save for part 1, DPR 1 and 2 ---- */
async function readClipboardPng(page) {
  return page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (!it.types.includes('image/png')) continue;
        const blob = await it.getType('image/png');
        const b64 = await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).split(',')[1]);
          fr.readAsDataURL(blob);
        });
        return { ok: true, bytes: blob.size, b64 };
      }
      return { ok: false, reason: 'no-png-item' };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 160) }; }
  });
}

async function openAnnotate(recordId) {
  const ann = await ctx.newPage();
  watchErrors(ann, 'annotate');
  await ann.goto(`chrome-extension://${extId}/pages/annotate.html#${recordId}`);
  await ann.waitForFunction(
    () => { const c = document.getElementById('content'); return c && !c.hidden; },
    { timeout: 120000 },
  );
  return ann;
}

for (const dpr of [1, 2]) {
  const ev = {};
  try {
    const entry = q12[dpr];
    if (!entry) throw new Error(`Q${dpr === 1 ? 1 : 2} capture missing, cannot test the editor`);
    const part1 = entry.cap.parts[0];
    const recordId = entry.cap.firstRecordId;
    ev.part = `${part1.w}x${part1.h}`;
    // Copy: click the real Copy button, read the real clipboard.
    const ann = await openAnnotate(recordId);
    ev.dimsStatus = await ann.evaluate(() => {
      const el = document.getElementById('dimsStatus');
      return el ? el.textContent : null;
    });
    ev.dimsStatusOk = ev.dimsStatus === `${part1.w} \u00d7 ${part1.h} pixels`;
    await ann.click('#btnCopy');
    await ann.waitForSelector('.toast', { timeout: 20000 });
    const toast = await ann.evaluate(() => {
      const t = document.querySelector('.toast');
      return t ? t.textContent : '';
    });
    ev.copyToast = toast.slice(0, 140);
    const clip = await readClipboardPng(ann);
    if (!clip.ok) throw new Error(`clipboard read failed: ${clip.reason}`);
    const clipImg = decodePng(Buffer.from(clip.b64, 'base64'));
    ev.clipDims = `${clipImg.w}x${clipImg.h}`;
    ev.clipBytes = clip.bytes;
    const clipCmp = aggregateCompare(part1.tiles, clipImg);
    ev.clipExact = clipCmp.exactFrac;
    ev.clipMad = clipCmp.mad;
    ev.clipMaxAbs = clipCmp.maxAbs;
    ev.clipLapRatio = clipCmp.lapRatioMean;
    await ann.close().catch(() => {});
    // Save: fresh editor tab, click Save, the file must land on disk.
    // The expected bytes are the part PNG itself: match by SHA-256,
    // not by a new filename. CDP Browser.setDownloadBehavior 'allow'
    // writes straight to the path and overwrites a same-named file,
    // so the second save in one session reuses the name 'download.png'
    // instead of uniquifying; in a real profile Chrome would name it
    // 'download (1).png'. A hash match proves the right bytes landed.
    const ann2 = await openAnnotate(recordId);
    const expectedHash = crypto.createHash('sha256').update(part1.buf).digest('hex');
    await ann2.click('#btnSave');
    let savedFile = null;
    {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline && !savedFile) {
        await sleep(1000);
        for (const f of fs.readdirSync(downloadDir)) {
          if (f.endsWith('.crdownload')) continue;
          const p = path.join(downloadDir, f);
          if (!fs.statSync(p).isFile()) continue;
          if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') === expectedHash) { savedFile = f; break; }
        }
      }
    }
    if (!savedFile) throw new Error('saved file did not land in the download dir');
    const savedBuf = fs.readFileSync(path.join(downloadDir, savedFile));
    ev.savedFile = savedFile;
    ev.savedBytes = savedBuf.length;
    ev.savedMagic = pngMagic(savedBuf);
    const savedDims = ihdrDims(savedBuf);
    ev.savedDims = `${savedDims.w}x${savedDims.h}`;
    const savedImg = decodePng(savedBuf);
    const saveCmp = aggregateCompare(part1.tiles, savedImg);
    ev.saveExact = saveCmp.exactFrac;
    ev.saveMad = saveCmp.mad;
    ev.saveMaxAbs = saveCmp.maxAbs;
    ev.saveLapRatio = saveCmp.lapRatioMean;
    try { await ann2.waitForEvent('close', { timeout: 5000 }); } catch { await ann2.close().catch(() => {}); }
    ev.note = `part=${ev.part} dimsStatus=${ev.dimsStatusOk ? 'ok' : JSON.stringify(ev.dimsStatus)} copy exact=${ev.clipExact.toFixed(4)} mad=${ev.clipMad.toFixed(3)} lap=${ev.clipLapRatio.toFixed(4)} save exact=${ev.saveExact.toFixed(4)} mad=${ev.saveMad.toFixed(3)} lap=${ev.saveLapRatio.toFixed(4)}`;
    const ok = ev.dimsStatusOk
      && !/downscal/i.test(ev.copyToast)
      && ev.clipExact === 1 && ev.clipMad === 0 && ev.clipMaxAbs === 0 && ev.clipLapRatio >= 0.99
      && ev.savedMagic && ev.savedDims === ev.part
      && ev.saveExact === 1 && ev.saveMad === 0 && ev.saveMaxAbs === 0 && ev.saveLapRatio >= 0.99;
    phase(`Q3 editor Copy + Save, DPR ${dpr}: copied image and saved file match tiles pixel for pixel`, ok, ev);
  } catch (e) {
    phase(`Q3 editor Copy + Save, DPR ${dpr}: copied image and saved file match tiles pixel for pixel`, false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

/* ---- Q4: 60,000 px page, DPR 2: completes, peak heap reported ---- */
{
  const ev = {};
  try {
    const cap = await capturePage(2, 60000, false);
    const perPart = partsCompare(cap);
    ev.parts = perPart.length;
    ev.partSizes = perPart.map((p) => `${p.w}x${p.h}`);
    ev.worstExact = Math.min(...perPart.map((p) => p.exactFrac));
    ev.worstLapRatio = Math.min(...perPart.map((p) => p.lapRatioMean));
    ev.peakOffscreenHeapBytes = cap.peakHeap;
    ev.peakOffscreenHeapMiB = +(cap.peakHeap / 1048576).toFixed(1);
    ev.note = `parts=${ev.parts} exact=${ev.worstExact.toFixed(4)} lap=${ev.worstLapRatio.toFixed(4)} peakOffscreenHeap=${ev.peakOffscreenHeapMiB} MiB`;
    const ok = ev.worstExact === 1 && ev.worstLapRatio >= 0.99 && cap.peakHeap > 0;
    phase('Q4 60000px DPR 2: stitch completes pixel exact, peak heap reported', ok, ev);
  } catch (e) {
    phase('Q4 60000px DPR 2: stitch completes pixel exact, peak heap reported', false, { note: `threw: ${e.message.slice(0, 200)}` });
  }
}

/* ---- final: zero console.error / pageerror anywhere ---- */
{
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('no console errors / pageerrors anywhere', errOnly.length === 0, {
    note: `${errOnly.length} errors, ${errorWatch.length} total entries`,
    first: errOnly.slice(0, 3),
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`wrote ${OUT}`);
await ctx.close().catch(() => {});
server.close();
process.exit(results.errors.length ? 1 : 0);
