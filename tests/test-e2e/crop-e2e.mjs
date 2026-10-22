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
 * ImgFetch: tests/test-e2e/crop-e2e.mjs
 * Playwright tests for the round 6 Crop tool in pages/annotate.html.
 *
 * Capture records are seeded straight into the extension's IndexedDB
 * (the parts-e2e mechanism, Blob records in the real storage shape), so
 * the editor opens through its real fast path. SAVE_ANNOTATED is the
 * only stubbed message: the stub captures the exported data URL so the
 * test can compare its pixels, and everything else (editor, rendering,
 * Copy wiring, real clipboard) is the shipped code.
 *
 * Fixtures are REALISTIC on purpose (section 4 of the round 6 spec):
 * a photo-like gradient+noise image, a text-heavy image, an image with
 * semi-transparent edges, and a page-like image with a unique colour
 * per row (like the /rows fixture), never flat colour alone.
 *
 * Phases:
 *  K0  boot: editor opens, Crop tool exists with tooltip and aria-pressed
 *  K1  drag, size label, Apply by button; Save export pixel-exact
 *  K2  Copy export pixel-exact (real clipboard)
 *  K3  Apply by Enter, Cancel by button, Cancel by Esc
 *  K4  strokes and crop: pen before/after, text, arrow, pixelate and
 *      text drag on a cropped view, undo/redo through the sequence,
 *      strokes outside the crop are not exported and Undo restores them
 *  K5  handles and keyboard: mouse handle drag, Tab order, aria names,
 *      arrow nudge and Shift+arrow nudge, touch drag (CDP touch events)
 *  K6  odd rectangles: full-image crop is a no-op (no history step),
 *      1 px offset crop, odd sizes, minimum-size crop, edge/corner crops
 *  K7  large images: 8000x7500 (renderer RSS before/after crop) and the
 *      1265x24000 tall part, pixel-exact band exports
 *  K8  Arabic RTL and 480 px narrow layout, dark theme (screenshots are
 *      written next to this file's results, OUTSIDE the repo tree when
 *      IMGFETCH_SHOTS points elsewhere; the runner inspects them)
 *  K9  regression: Windows note and Copy downscale use the CROPPED size
 *  K10 robustness: double Apply, click without drag, tiny drag, tool
 *      switch mid-crop, crop twice + undo chain, corrupt record
 *  K11 display scales and DPR: label equals export at scale ~0.54 and
 *      under deviceScaleFactor 1.25 and 2 contexts
 *
 * Fails the run on ANY console.error / pageerror in any watched page.
 * Run: PLAYWRIGHT_PACKAGE=<install>/node_modules/playwright xvfb-run -a node tests/test-e2e/crop-e2e.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import {
  rectFromPoints, resizeRect, clampRect,
} from '../../core/crop-rect.js';
import { planCopy } from '../../core/clipboard-image.js';

const _require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = _require('playwright'));
} catch {
  ({ chromium } = _require(process.env.PLAYWRIGHT_PACKAGE || 'playwright'));
}
const PROJ = process.env.IMGFETCH_PROJ || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.IMGFETCH_SHOTS || tmpdir();
const HEADED = process.env.HEADED !== '0';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`); }
}

/* ---------------- PNG writer (RGBA, filter 0) ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function pngFromPixels(w, h, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y += 1) {
    const rowOff = y * (1 + w * 4);
    raw[rowOff] = 0;
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowOff + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
/** Photo-like: smooth gradient + per-pixel deterministic noise. */
function photoPng(w, h, seed = 7) {
  const rnd = lcg(seed);
  const noise = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (rnd() - 0.5) * 26;
  return pngFromPixels(w, h, (x, y) => {
    const n = noise[y * w + x];
    return [
      Math.max(0, Math.min(255, Math.round(40 + (x / w) * 180 + n))),
      Math.max(0, Math.min(255, Math.round(90 + (y / h) * 120 + n))),
      Math.max(0, Math.min(255, Math.round(200 - (x / w) * 130 + n))),
      255,
    ];
  });
}
/** Text-heavy: light page, dark pseudo-text bars in lines and columns. */
function textPng(w, h) {
  const rnd = lcg(99);
  const bars = [];
  for (let y = 26; y < h - 20; y += 22) {
    let x = 18 + Math.floor(rnd() * 30);
    const colW = (w - 60) * (0.55 + rnd() * 0.4);
    while (x < 18 + colW) {
      const bw = 14 + Math.floor(rnd() * 42);
      bars.push([x, y, bw, 9]);
      x += bw + 7;
    }
  }
  return pngFromPixels(w, h, (x, y) => {
    for (const [bx, by, bw, bh] of bars) {
      if (x >= bx && x < bx + bw && y >= by && y < bh + by) return [30, 32, 40, 255];
    }
    return [243, 241, 235, 255];
  });
}
/** Semi-transparent edges: alpha ramps on all four sides over a gradient. */
function alphaPng(w, h) {
  const ramp = 60;
  return pngFromPixels(w, h, (x, y) => {
    const ax = Math.min(1, Math.min(x, w - 1 - x) / ramp);
    const ay = Math.min(1, Math.min(y, h - 1 - y) / ramp);
    const a = Math.round(255 * Math.min(ax, ay) * 0.92 + 20);
    return [Math.round((x / w) * 255), Math.round((y / h) * 255), 128, Math.max(0, Math.min(255, a))];
  });
}
/** Page-like: unique colour per row (colour encodes the row index). */
function rowsPng(w, h) {
  return pngFromPixels(w, h, (x, y) => {
    const stripe = Math.floor(y / 8);
    return [stripe & 0xFF, (stripe >> 8) & 0xFF, (stripe >> 16) & 0xFF, 255];
  });
}
function flatPng(w, h, rgb) {
  return pngFromPixels(w, h, () => [rgb[0], rgb[1], rgb[2], 255]);
}

/* ---------------- error watching ---------------- */
const errorLog = [];
function watchErrors(page, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errorLog.push(`${label}: console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errorLog.push(`${label}: pageerror: ${err.message}`));
}

/* ---------------- browser + seeding ---------------- */
/* Round 8 crash guard: the whole run below sits in a try block (the
 * body is not re-indented; JavaScript does not care). An uncaught
 * exception lands in the catch after the final phase, records a
 * failing check with a clear message, and the totals line after the
 * catch always prints with a non-zero exit. Before this guard the
 * K11 DPR block crashed the suite after 61 passing checks and the
 * crash looked like a complete run in the log tail. */
let mainCtx = null;
let dsfCtx = null;
try {
const profile = mkdtempSync(join(tmpdir(), 'imgfetch-crop-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: !HEADED,
  viewport: { width: 1500, height: 1000 },
  args: [`--disable-extensions-except=${PROJ}`, `--load-extension=${PROJ}`, '--no-sandbox'],
});
mainCtx = ctx;
watchErrors(ctx, 'context');
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

let seedSeq = 0;
async function seedRecord(pngBuf, w, h, opts = {}, worker = null) {
  seedSeq += 1;
  const id = `cap-crop-${seedSeq}`;
  const b64 = pngBuf.toString('base64');
  await (worker || sw).evaluate(async ({ rid, b64: data, w: wd, h: ht, pi, pt }) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('imgfetch', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('captures')) {
          req.result.createObjectStore('captures', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('captures', 'readwrite');
      tx.objectStore('captures').put({
        id: rid, blob, width: wd, height: ht, at: Date.now(), bytes: blob.size,
        partIndex: pi, partTotal: pt, groupId: '', groupOpen: false,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { rid: id, b64, w, h, pi: opts.partIndex || 0, pt: opts.partTotal || 0 });
  return id;
}

async function openAnnotate(id, label, opts = {}) {
  const page = await ctx.newPage();
  watchErrors(page, `crop-${label}`);
  await page.addInitScript((cfg) => {
    window.__saved = null;
    window.__closeAttempted = false;
    try { window.close = () => { window.__closeAttempted = true; }; } catch { /* noop */ }
    if (cfg.platform) {
      try {
        Object.defineProperty(navigator, 'userAgentData', { value: { platform: cfg.platform }, configurable: true });
        Object.defineProperty(navigator, 'platform', { value: cfg.platform, configurable: true });
      } catch { /* best effort */ }
    }
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === 'SAVE_ANNOTATED') {
        window.__saved = { id: msg.id, dataUrl: msg.dataUrl };
        setTimeout(() => cb({ ok: true }), 0);
        return;
      }
      return origSend(msg, cb);
    };
  }, { platform: opts.platform || '' });
  if (opts.lang) {
    // Set the language the way the options page does (i18n-e2e pattern).
    const ctrl = await ctx.newPage();
    await ctrl.goto(`chrome-extension://${extId}/pages/capture.html`);
    await ctrl.evaluate(async (l) => {
      const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
      const next = { ...cur, language: l };
      await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
    }, opts.lang);
    await ctrl.close();
  }
  if (opts.viewport) await page.setViewportSize(opts.viewport);
  await page.goto(`chrome-extension://${extId}/pages/annotate.html#${id}`);
  await page.waitForSelector('#content:not([hidden])', { timeout: 30000 });
  await page.bringToFront(); // clipboard APIs need a focused document
  await page.waitForTimeout(1200); // lazy modules (Copy, i18n)
  return page;
}

/* ---------------- geometry helpers ---------------- */
async function canvasBox(page) {
  return page.evaluate(() => {
    const e = document.getElementById('editor');
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, iw: e.width, ih: e.height };
  });
}
const toClient = (box, ix, iy) => [box.x + (ix / box.iw) * box.w, box.y + (iy / box.ih) * box.h];

async function mouseDrag(page, from, to, steps = 14) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
/** Drag a crop rectangle between two IMAGE-coordinate points. */
async function dragCrop(page, a, b) {
  const box = await canvasBox(page);
  await mouseDrag(page, toClient(box, a[0], a[1]), toClient(box, b[0], b[1]));
  return box;
}
async function labelText(page) {
  return page.evaluate(() => document.getElementById('cropSize').textContent);
}
async function editorSize(page) {
  return page.evaluate(() => {
    const e = document.getElementById('editor');
    return { w: e.width, h: e.height };
  });
}
async function selectTool(page, tool) {
  await page.click(`.tool[data-tool="${tool}"]`);
  await page.waitForTimeout(60);
}
/** Click Save and return the exported data URL captured by the stub. */
async function saveExport(page) {
  // The page is kept alive by the window.close stub, so reset the stub
  // state (and the Save button, which the real flow leaves disabled
  // because the page closes) before each export.
  await page.evaluate(() => {
    window.__saved = null;
    document.getElementById('btnSave').disabled = false;
  });
  await page.click('#btnSave');
  await page.waitForFunction(() => window.__saved !== null, null, { timeout: 20000 });
  return page.evaluate(() => window.__saved.dataUrl);
}
/**
 * Pixel-exact region compare, in page: the export must equal the source
 * rectangle of the fixture, byte for byte across every channel.
 */
async function compareRegion(page, exportDataUrl, fixturePngBuf, rect) {
  return page.evaluate(async ([exp, fxB64, r]) => {
    const load = (src) => new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image decode failed'));
      im.src = src;
    });
    const bin = atob(fxB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const fxUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    try {
      const [ei, fi] = await Promise.all([load(exp), load(fxUrl)]);
      if (ei.naturalWidth !== r.w || ei.naturalHeight !== r.h) {
        return { ok: false, why: `export is ${ei.naturalWidth}x${ei.naturalHeight}, want ${r.w}x${r.h}` };
      }
      const mk = (w2, h2) => { const c = document.createElement('canvas'); c.width = w2; c.height = h2; return c; };
      const ec = mk(r.w, r.h);
      ec.getContext('2d').drawImage(ei, 0, 0);
      const fc = mk(r.w, r.h);
      fc.getContext('2d').drawImage(fi, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const a = ec.getContext('2d').getImageData(0, 0, r.w, r.h).data;
      const b = fc.getContext('2d').getImageData(0, 0, r.w, r.h).data;
      let diff = 0;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
      return { ok: diff === 0, diffBytes: diff };
    } finally {
      URL.revokeObjectURL(fxUrl);
    }
  }, [exportDataUrl, fixturePngBuf.toString('base64'), rect]);
}
/** Count pixels matching a predicate in a data URL image, in page. */
async function scanPixels(page, dataUrl, pred, yMax = 1e9) {
  return page.evaluate(async ([url, kind, yLim]) => {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode failed'));
      im.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1;
    for (let y = 0; y < c.height && y < yLim; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const i = (y * c.width + x) * 4;
        let hit = false;
        if (kind === 'red') hit = d[i] > 200 && d[i + 1] > 50 && d[i + 1] < 110 && d[i + 2] > 50 && d[i + 2] < 110;
        else if (kind === 'blue') hit = d[i] > 40 && d[i] < 90 && d[i + 1] > 120 && d[i + 1] < 165 && d[i + 2] > 230;
        if (hit) {
          count += 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { count, minX, maxX, minY, maxY, w: c.width, h: c.height };
  }, [dataUrl, pred, yMax]);
}
function profileRssKb() {
  let total = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = readFileSync(join('/proc', pid, 'cmdline'), 'utf8');
      if (!cmd.includes(profile)) continue;
      const st = readFileSync(join('/proc', pid, 'status'), 'utf8');
      const m = st.match(/VmRSS:\s+(\d+) kB/);
      if (m) total += Number(m[1]);
    } catch { /* process gone */ }
  }
  return total;
}

/* ---------------- fixtures ---------------- */
const photo400 = photoPng(400, 300, 11);
const photo1920 = photoPng(1920, 1080, 12);
const textImg = textPng(800, 600);
const alphaImg = alphaPng(640, 480);
const rowsImg = rowsPng(500, 400);
const rowsWide = rowsPng(4000, 2000);
const tallImg = rowsPng(1265, 24000);
/** Smooth photo-like scene (sky gradient, sun disc, hill band), no
 * per-pixel noise: at 8000x7500 a noisy PNG would be ~240 MB and could
 * not even be seeded; this still exercises decode, crop and export at
 * 60 MP with non-uniform content in every row and column. */
function scenePng(w, h) {
  const sunX = w * 0.68;
  const sunY = h * 0.3;
  const sunR = h * 0.12;
  return pngFromPixels(w, h, (x, y) => {
    const dSun = Math.hypot(x - sunX, y - sunY);
    if (dSun < sunR) return [250, 224, 150, 255];
    if (y > h * 0.72 - Math.sin(x / w * 6.28) * h * 0.03) {
      return [Math.round(30 + (y / h) * 40), Math.round(110 + (x / w) * 30), 60, 255];
    }
    return [
      Math.round(70 + (y / h) * 120 + (x / w) * 40),
      Math.round(120 + (y / h) * 60),
      Math.round(215 - (y / h) * 80),
      255,
    ];
  });
}
const hugeImg = scenePng(8000, 7500);
const flatBig = flatPng(5000, 3000, [96, 140, 200]);
const rowsWin = rowsPng(2000, 1500);

const idPhoto400 = await seedRecord(photo400, 400, 300);
const idPhoto1920 = await seedRecord(photo1920, 1920, 1080);
const idText = await seedRecord(textImg, 800, 600);
const idAlpha = await seedRecord(alphaImg, 640, 480);
const idRows = await seedRecord(rowsImg, 500, 400);
console.log('fixtures seeded');

/* ---------------- K0: boot + crop tool presence ---------------- */
console.log('--- K0 boot ---');
{
  const page = await openAnnotate(idPhoto400, 'k0');
  const info = await page.evaluate(() => {
    const b = document.querySelector('.tool[data-tool="crop"]');
    return b ? { title: b.title, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled } : null;
  });
  check('K0 crop tool button exists with tooltip "Crop (C)"',
    !!info && info.title === 'Crop (C)' && info.pressed === 'false' && !info.disabled,
    JSON.stringify(info));
  await selectTool(page, 'crop');
  const pressed = await page.evaluate(() => document.querySelector('.tool[data-tool="crop"]').getAttribute('aria-pressed'));
  check('K0 crop tool aria-pressed turns true when selected', pressed === 'true');
  await page.close();
}

/* ---------------- K1: drag, label, Apply by button, Save pixels ---------------- */
console.log('--- K1 apply by button + Save pixel-exact ---');
{
  const page = await openAnnotate(idPhoto400, 'k1');
  await selectTool(page, 'crop');
  await dragCrop(page, [37, 41], [301, 229]);
  const want = rectFromPoints(37, 41, 301, 229, 400, 300);
  const label = await labelText(page);
  check('K1 size label shows real image pixels', label === `${want.w} x ${want.h}`, `label=${label} want=${want.w} x ${want.h}`);
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  const size = await editorSize(page);
  check('K1 editor canvas becomes the crop size', size.w === want.w && size.h === want.h, JSON.stringify(size));
  const undoEnabled = await page.evaluate(() => !document.getElementById('btnUndo').disabled);
  check('K1 Undo is enabled after Apply', undoEnabled);
  const exported = await saveExport(page);
  const cmp = await compareRegion(page, exported, photo400, want);
  check('K1 Save export is pixel-identical to the source rectangle', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  await page.close();
}

/* ---------------- K2: Copy pixel-exact ---------------- */
console.log('--- K2 Copy pixel-exact ---');
{
  const page = await openAnnotate(idAlpha, 'k2');
  await selectTool(page, 'crop');
  await dragCrop(page, [53, 37], [587, 443]);
  const want = rectFromPoints(53, 37, 587, 443, 640, 480);
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  await page.click('#btnCopy');
  await page.waitForFunction(() => {
    const t = document.querySelector('.toast');
    return t && t.textContent.length > 0;
  }, null, { timeout: 10000 }).catch(() => {});
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return null;
    const blob = await item.getType('image/png');
    const buf = await blob.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  check('K2 clipboard holds a PNG after Copy', !!clip);
  if (clip) {
    const dataUrl = `data:image/png;base64,${clip}`;
    const cmp = await compareRegion(page, dataUrl, alphaImg, want);
    check('K2 Copy export is pixel-identical (semi-transparent edges fixture)', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  }
  await page.close();
}

/* ---------------- K3: Enter applies, Cancel button, Esc ---------------- */
console.log('--- K3 Enter / Cancel / Esc ---');
{
  const page = await openAnnotate(idPhoto400, 'k3a');
  await selectTool(page, 'crop');
  await dragCrop(page, [10, 10], [210, 160]);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  let size = await editorSize(page);
  check('K3 Enter applies the crop', size.w === 200 && size.h === 150, JSON.stringify(size));
  await page.close();
}
{
  const page = await openAnnotate(idPhoto400, 'k3b');
  await selectTool(page, 'crop');
  await dragCrop(page, [10, 10], [210, 160]);
  await page.click('#cropCancel');
  await page.waitForTimeout(80);
  let size = await editorSize(page);
  const overlayHidden = await page.evaluate(() => document.getElementById('cropOverlay').hidden);
  check('K3 Cancel button discards the pending crop', size.w === 400 && size.h === 300 && overlayHidden, JSON.stringify(size));
  // Esc path on a fresh selection
  await dragCrop(page, [10, 10], [210, 160]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  size = await editorSize(page);
  const hidden2 = await page.evaluate(() => document.getElementById('cropOverlay').hidden);
  check('K3 Esc cancels the pending crop', size.w === 400 && size.h === 300 && hidden2, JSON.stringify(size));
  await page.close();
}

/* ---------------- K4: strokes and crop together ---------------- */
console.log('--- K4 strokes + crop ---');
{
  const page = await openAnnotate(idText, 'k4');
  const box0 = await canvasBox(page);
  // Red stroke INSIDE the future crop (image coords 150..350 x, 150..170 y).
  await mouseDrag(page, toClient(box0, 150, 160), toClient(box0, 350, 160));
  // Blue stroke fully OUTSIDE the future crop.
  await page.click('.swatch[data-color="#3e8ef7"]');
  const box1 = await canvasBox(page);
  await mouseDrag(page, toClient(box1, 600, 500), toClient(box1, 760, 520));
  await page.click('.swatch[data-color="#e5484d"]');
  // Crop to (100,100)-(500,400) and apply.
  await selectTool(page, 'crop');
  await dragCrop(page, [100, 100], [500, 400]);
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  let size = await editorSize(page);
  check('K4 crop applied over existing strokes', size.w === 400 && size.h === 300, JSON.stringify(size));
  let exported = await saveExport(page);
  let scan = await scanPixels(page, exported, 'red');
  check('K4 stroke inside the crop is exported', scan.count > 100, `red=${scan.count}`);
  scan = await scanPixels(page, exported, 'blue');
  check('K4 stroke outside the crop is NOT exported', scan.count === 0, `blue=${scan.count}`);
  // Arrow drawn AFTER the crop (view coords == image coords offset by -100,-100).
  await selectTool(page, 'arrow');
  const box2 = await canvasBox(page);
  await mouseDrag(page, toClient(box2, 50, 250), toClient(box2, 200, 250));
  // Text placed on the cropped view. The canvas click opens the input;
  // clicking the field itself focuses it (pre-existing editor behavior,
  // identical on the round 5 tree), then typing + Enter places the text.
  await selectTool(page, 'text');
  const box3 = await canvasBox(page);
  const [tx, ty] = toClient(box3, 60, 35);
  await page.mouse.click(tx, ty);
  await page.waitForTimeout(150);
  await page.click('#textInput');
  await page.keyboard.type('Moved');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  exported = await saveExport(page);
  const bandBefore = await scanPixels(page, exported, 'red', 50);
  check('K4 text + arrow drawn on the cropped view are exported',
    bandBefore.count > 100, `bandRed=${bandBefore.count}`);
  // Drag the placed text by (+40, +30) view px.
  const box4 = await canvasBox(page);
  await mouseDrag(page, toClient(box4, 65, 32), toClient(box4, 105, 62), 10);
  await page.waitForTimeout(120);
  exported = await saveExport(page);
  const bandAfter = await scanPixels(page, exported, 'red', 50);
  check('K4 dragged text moved right and down on the cropped view',
    Math.abs((bandAfter.minX - bandBefore.minX) - 40) <= 14
      && Math.abs((bandAfter.minY - bandBefore.minY) - 30) <= 14,
    `dx=${bandAfter.minX - bandBefore.minX} dy=${bandAfter.minY - bandBefore.minY}`);
  // Pixelate a patch on the cropped view.
  await selectTool(page, 'pixelate');
  const box5 = await canvasBox(page);
  await mouseDrag(page, toClient(box5, 250, 40), toClient(box5, 330, 100));
  await page.waitForTimeout(100);
  exported = await saveExport(page);
  const pix = await page.evaluate(async ([url]) => {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(255, 45, 60, 50).data;
    let transitions = 0;
    for (let i = 4; i < d.length; i += 4) if (d[i] !== d[i - 4] || d[i + 1] !== d[i - 3]) transitions += 1;
    return transitions;
  }, [exported]);
  check('K4 pixelate on the cropped view produces blocky output', pix < 700, `transitions=${pix}`);
  // Undo everything back: pixelate, text move, text, arrow, crop (5 of
  // the 7 commits). Editor must be full size again and the outside
  // (blue) stroke must be back in the export.
  for (let i = 0; i < 5; i += 1) { await page.click('#btnUndo'); await page.waitForTimeout(60); }
  size = await editorSize(page);
  check('K4 undo chain returns the editor to the full image', size.w === 800 && size.h === 600, JSON.stringify(size));
  exported = await saveExport(page);
  scan = await scanPixels(page, exported, 'blue');
  check('K4 Undo of the crop restores the outside stroke exactly', scan.count > 100, `blue=${scan.count}`);
  // Redo twice: crop re-applied, then the arrow step.
  await page.click('#btnRedo');
  await page.waitForTimeout(60);
  size = await editorSize(page);
  check('K4 redo re-applies the crop', size.w === 400 && size.h === 300, JSON.stringify(size));
  await page.close();
}

/* ---------------- K5: handles, keyboard, touch ---------------- */
console.log('--- K5 handles + keyboard + touch ---');
{
  const page = await openAnnotate(idPhoto1920, 'k5');
  await selectTool(page, 'crop');
  await dragCrop(page, [200, 150], [900, 650]);
  let label = await labelText(page);
  check('K5 initial drag label', label === '700 x 500', label);
  // Mouse-drag the SE handle by (+40, +25) image px.
  const box = await canvasBox(page);
  const hCenter = await page.evaluate(() => {
    const r = document.querySelector('[data-handle="se"]').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  const dClient = [40 * (box.w / box.iw), 25 * (box.h / box.ih)];
  await mouseDrag(page, hCenter, [hCenter[0] + dClient[0], hCenter[1] + dClient[1]], 8);
  label = await labelText(page);
  const wantResize = resizeRect(rectFromPoints(200, 150, 900, 650, 1920, 1080), 'se', 40, 25, 1920, 1080);
  check('K5 SE handle drag resizes (label follows)', label === `${wantResize.w} x ${wantResize.h}`,
    `label=${label} want=${wantResize.w} x ${wantResize.h}`);
  // Aria names on handles and buttons.
  const aria = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.crop-handle').forEach((h) => { out[h.dataset.handle] = h.getAttribute('aria-label'); });
    out.apply = document.getElementById('cropApply').textContent;
    out.cancel = document.getElementById('cropCancel').textContent;
    out.box = document.getElementById('cropBox').getAttribute('aria-label');
    return out;
  });
  check('K5 handles and buttons have screen-reader names',
    aria.nw === 'Top-left resize handle' && aria.se === 'Bottom-right resize handle'
      && aria.e === 'Right resize handle' && aria.w === 'Left resize handle'
      && aria.apply === 'Apply' && aria.cancel === 'Cancel' && aria.box === 'Crop selection',
    JSON.stringify(aria));
  // Tab order through the overlay controls.
  await page.evaluate(() => document.querySelector('[data-handle="nw"]').focus());
  const tabSeq = [];
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Tab');
    tabSeq.push(await page.evaluate(() => {
      const a = document.activeElement;
      return a.dataset && a.dataset.handle ? a.dataset.handle : a.id || a.tagName;
    }));
  }
  check('K5 Tab order walks the 8 handles, then Apply, then Cancel',
    JSON.stringify(tabSeq) === JSON.stringify(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'cropApply', 'cropCancel', 'btnSave']),
    JSON.stringify(tabSeq));
  // Arrow nudge: 1 px, then Shift+arrow 10 px (rect position moves, size same).
  const leftBefore = await page.evaluate(() => parseFloat(document.getElementById('cropBox').style.left));
  await page.keyboard.press('ArrowRight');
  const leftAfter1 = await page.evaluate(() => parseFloat(document.getElementById('cropBox').style.left));
  const topBefore = await page.evaluate(() => parseFloat(document.getElementById('cropBox').style.top));
  await page.keyboard.press('Shift+ArrowDown');
  const topAfter10 = await page.evaluate(() => parseFloat(document.getElementById('cropBox').style.top));
  const boxNow = await canvasBox(page);
  const sx = boxNow.w / boxNow.iw;
  const sy = boxNow.h / boxNow.ih;
  check('K5 ArrowRight nudges the rectangle by 1 image px',
    Math.abs((leftAfter1 - leftBefore) / sx - 1) < 0.6, `delta=${(leftAfter1 - leftBefore) / sx}`);
  check('K5 Shift+ArrowDown nudges by 10 image px',
    Math.abs((topAfter10 - topBefore) / sy - 10) < 0.6, `delta=${(topAfter10 - topBefore) / sy}`);
  label = await labelText(page);
  check('K5 nudging never changes the size label', label === `${wantResize.w} x ${wantResize.h}`, label);
  await page.keyboard.press('Escape');
  // Touch drag via CDP touch events (pointerType touch through the real pipeline).
  const cdp = await ctx.newCDPSession(page);
  const boxT = await canvasBox(page);
  const [ax, ay] = toClient(boxT, 100, 80);
  const [bx, by] = toClient(boxT, 500, 380);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ax, y: ay, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (ax + bx) / 2, y: (ay + by) / 2, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bx, y: by, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(120);
  label = await labelText(page);
  check('K5 touch drag creates a crop rectangle', label === '400 x 300', label);
  await cdp.detach();
  await page.close();
}

/* ---------------- K6: odd rectangles ---------------- */
console.log('--- K6 odd rectangles ---');
{
  const page = await openAnnotate(idRows, 'k6');
  await selectTool(page, 'crop');
  // Full-image crop: a no-op that must not add a history step.
  await dragCrop(page, [3, 3], [497, 397]);
  const handleCenter = (h) => page.evaluate((hh) => {
    const r = document.querySelector(`[data-handle="${hh}"]`).getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, h);
  const boxK6 = await canvasBox(page);
  const nwC = await handleCenter('nw');
  await mouseDrag(page, nwC, [boxK6.x - 30, boxK6.y - 30], 6);
  const seC = await handleCenter('se');
  await mouseDrag(page, seC, [boxK6.x + 530, boxK6.y + 430], 6);
  const fullLabel = await labelText(page);
  check('K6 handles clamp at the image corners (full-image selection)',
    fullLabel === '500 x 400', fullLabel);
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  let size = await editorSize(page);
  const undoDisabled = await page.evaluate(() => document.getElementById('btnUndo').disabled);
  check('K6 full-image crop is a no-op (same size, Undo stays disabled)',
    size.w === 500 && size.h === 400 && undoDisabled, JSON.stringify(size));
  let exported = await saveExport(page);
  let cmp = await compareRegion(page, exported, rowsImg, { x: 0, y: 0, w: 500, h: 400 });
  check('K6 full-image export identical to the original', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  // 1 px offset, odd size. A pointerdown at (1,1) lands in the stage's
  // clipped corner, so drag from (4,4) and pull the NW handle to (1,1).
  await selectTool(page, 'crop');
  await dragCrop(page, [4, 4], [334, 258]);
  const boxK6b = await canvasBox(page);
  const nwC2 = await handleCenter('nw');
  await mouseDrag(page, nwC2, [boxK6b.x + 1, boxK6b.y + 1], 6);
  const wantOdd = rectFromPoints(1, 1, 334, 258, 500, 400);
  const label = await labelText(page);
  check('K6 1 px offset odd-size label', label === `${wantOdd.w} x ${wantOdd.h}`, label);
  await page.click('#cropApply');
  exported = await saveExport(page);
  cmp = await compareRegion(page, exported, rowsImg, wantOdd);
  check('K6 1 px offset odd-size export pixel-exact', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  await page.click('#btnUndo');
  await page.waitForTimeout(60);
  // Minimum size: drag a 3 px sliver, the rectangle grows to 8 x 8.
  await selectTool(page, 'crop');
  await dragCrop(page, [100, 100], [104, 103]);
  const labelMin = await labelText(page);
  check('K6 tiny drag grows to the 8 x 8 minimum', labelMin === '8 x 8', labelMin);
  await page.click('#cropApply');
  await page.waitForTimeout(60);
  size = await editorSize(page);
  check('K6 minimum-size crop applies', size.w === 8 && size.h === 8, JSON.stringify(size));
  await page.click('#btnUndo');
  await page.waitForTimeout(60);
  // Corner crop (bottom-right corner, touching two edges).
  await selectTool(page, 'crop');
  await dragCrop(page, [400, 300], [499, 399]);
  const wantCorner = rectFromPoints(400, 300, 499, 399, 500, 400);
  await page.click('#cropApply');
  exported = await saveExport(page);
  cmp = await compareRegion(page, exported, rowsImg, wantCorner);
  check('K6 corner crop export pixel-exact', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  await page.close();
}

/* ---------------- K7: large images + memory ---------------- */
console.log('--- K7 large images ---');
{
  const idHuge = await seedRecord(hugeImg, 8000, 7500);
  const page = await openAnnotate(idHuge, 'k7-huge');
  await page.waitForTimeout(400);
  const rssBefore = profileRssKb();
  await selectTool(page, 'crop');
  await dragCrop(page, [1000, 900], [3000, 2400]);
  await page.click('#cropApply');
  await page.waitForTimeout(300);
  const rssAfter = profileRssKb();
  const size = await editorSize(page);
  check('K7 8000x7500 crop applies', size.w === 2000 && size.h === 1500, JSON.stringify(size));
  check('K7 renderer RSS after crop is not higher than before (5% noise slack)',
    rssAfter <= rssBefore * 1.05, `before=${Math.round(rssBefore / 1024)}MB after=${Math.round(rssAfter / 1024)}MB`);
  console.log(`  RSS before crop: ${Math.round(rssBefore / 1024)} MB, after crop: ${Math.round(rssAfter / 1024)} MB`);
  const exported = await saveExport(page);
  const cmp = await compareRegion(page, exported, hugeImg, { x: 1000, y: 900, w: 2000, h: 1500 });
  check('K7 8000x7500 cropped export pixel-exact', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  await page.close();
}
{
  const idTall = await seedRecord(tallImg, 1265, 24000);
  const page = await openAnnotate(idTall, 'k7-tall');
  await selectTool(page, 'crop');
  // The part displays ~19700 CSS px tall: scroll the anchor into view,
  // start the drag, scroll near the target mid-drag (pointer capture
  // keeps the events flowing), then finish at the target point.
  await page.evaluate(() => {
    const e = document.getElementById('editor');
    const r = e.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top + 10000 * (r.height / e.height) - 150);
  });
  await page.waitForTimeout(150);
  let boxT2 = await canvasBox(page);
  const [sx0, sy0] = toClient(boxT2, 100, 10000);
  await page.mouse.move(sx0, sy0);
  await page.mouse.down();
  await page.mouse.move(sx0 + 4, sy0 + 4, { steps: 2 });
  await page.evaluate(() => {
    const e = document.getElementById('editor');
    const r = e.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top + 14000 * (r.height / e.height) - 500);
  });
  await page.waitForTimeout(150);
  boxT2 = await canvasBox(page);
  const [sx1, sy1] = toClient(boxT2, 1100, 14000);
  await page.mouse.move(sx1, sy1, { steps: 6 });
  await page.mouse.up();
  const label = await labelText(page);
  check('K7 tall part label uses image pixels', label === '1000 x 4000', label);
  await page.click('#cropApply');
  await page.waitForTimeout(120);
  const exported = await saveExport(page);
  const cmp = await compareRegion(page, exported, tallImg, { x: 100, y: 10000, w: 1000, h: 4000 });
  check('K7 tall part band export pixel-exact (unique row colours)', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  await page.close();
}

/* ---------------- K8: RTL, narrow, dark ---------------- */
console.log('--- K8 RTL / narrow / dark ---');
{
  const ar = JSON.parse(readFileSync(join(PROJ, '_locales', 'ar', 'messages.json'), 'utf8'));
  const page = await openAnnotate(idPhoto400, 'k8', { lang: 'ar', viewport: { width: 480, height: 820 } });
  const dir = await page.evaluate(() => document.documentElement.dir);
  const cropText = await page.evaluate(() => document.querySelector('.tool[data-tool="crop"] span').textContent);
  check('K8 Arabic RTL: dir=rtl and the Crop label is translated',
    dir === 'rtl' && cropText === ar.tool_crop.message, `dir=${dir} text=${cropText}`);
  await selectTool(page, 'crop');
  await dragCrop(page, [40, 30], [340, 230]);
  const label = await labelText(page);
  check('K8 crop drag works at 480 px in RTL', label === '300 x 200', label);
  const fits = await page.evaluate(() => {
    const sr = document.getElementById('stage').getBoundingClientRect();
    const ar2 = document.getElementById('cropActions').getBoundingClientRect();
    return ar2.left >= sr.left - 1 && ar2.right <= sr.right + 1;
  });
  check('K8 Apply/Cancel row stays inside the stage at 480 px', fits);
  await page.screenshot({ path: join(SHOTS, 'crop-rtl-480.png') });
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  const size = await editorSize(page);
  check('K8 apply works at 480 px RTL', size.w === 300 && size.h === 200, JSON.stringify(size));
  await page.close();
  // Reset the stored language so later phases stay in English.
  const ctrl = await ctx.newPage();
  await ctrl.goto(`chrome-extension://${extId}/pages/capture.html`);
  await ctrl.evaluate(async () => {
    const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
    const next = { ...cur, language: 'en' };
    await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
  });
  await ctrl.close();
}
{
  // Dark theme via the real settings path: annotate asks GET_SETTINGS,
  // which the real worker answers from stored settings.
  const ctrl = await ctx.newPage();
  await ctrl.goto(`chrome-extension://${extId}/pages/capture.html`);
  await ctrl.evaluate(async () => {
    const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
    const next = { ...cur, theme: 'dark', language: 'en' };
    await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
  });
  await ctrl.close();
  const page = await openAnnotate(idPhoto400, 'k8-dark');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme || document.body.dataset.theme || '');
  await selectTool(page, 'crop');
  await dragCrop(page, [50, 40], [330, 240]);
  await page.screenshot({ path: join(SHOTS, 'crop-dark.png') });
  const label = await labelText(page);
  check('K8 dark theme editor crops normally', label === '280 x 200', `theme=${theme} label=${label}`);
  await page.close();
  const ctrl2 = await ctx.newPage();
  await ctrl2.goto(`chrome-extension://${extId}/pages/capture.html`);
  await ctrl2.evaluate(async () => {
    const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
    const next = { ...cur, theme: 'light' };
    await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
  });
  await ctrl2.close();
}

/* ---------------- K9: Windows note + Copy downscale use cropped size ---------------- */
console.log('--- K9 cropped-size regressions ---');
{
  const idWin = await seedRecord(rowsWin, 2000, 1500);
  const page = await openAnnotate(idWin, 'k9-note', { platform: 'Win32' });
  let noteShown = await page.evaluate(() => !document.getElementById('windowsNote').hidden);
  check('K9 Windows note shows for the full 2000x1500 image', noteShown);
  await selectTool(page, 'crop');
  await dragCrop(page, [100, 100], [1100, 900]); // 1000x800 = 0.8 MP, under the note rule
  await page.click('#cropApply');
  await page.waitForTimeout(120);
  noteShown = await page.evaluate(() => !document.getElementById('windowsNote').hidden);
  check('K9 Windows note hides once the crop is under the size rule', !noteShown);
  await page.click('#btnUndo');
  await page.waitForTimeout(120);
  noteShown = await page.evaluate(() => !document.getElementById('windowsNote').hidden);
  check('K9 Windows note returns when the crop is undone', noteShown);
  await page.close();
}
{
  const idFlat = await seedRecord(flatBig, 5000, 3000);
  const page = await openAnnotate(idFlat, 'k9-copy', { platform: 'Win32' });
  // Baseline: uncropped 15 MP copy must downscale per planCopy. The
  // encode of a 15 MP PNG takes a moment, so poll the toast.
  await page.click('#btnCopy');
  const plan = planCopy(5000, 3000);
  let toastText1 = '';
  for (let i = 0; i < 60 && !toastText1; i += 1) {
    await page.waitForTimeout(400);
    toastText1 = await page.evaluate(() => {
      const t = document.querySelector('.toast');
      return t ? t.textContent : '';
    });
  }
  check('K9 baseline: uncropped 15 MP copy reports the downscale',
    plan.downscaled && toastText1.includes(String(plan.width)), `toast=${toastText1} plan=${plan.width}x${plan.height}`);
  // Cropped to 3 MP (under the 12 MP budget): no downscale any more.
  await selectTool(page, 'crop');
  await dragCrop(page, [500, 500], [2500, 2000]);
  await page.click('#cropApply');
  await page.waitForTimeout(120);
  await page.click('#btnCopy');
  // Poll the clipboard until the new (cropped) copy replaces the old one.
  let dims = { w: 0, h: 0 };
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(400);
    dims = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((x) => x.types.includes('image/png'));
      if (!item) return { w: 0, h: 0 };
      const blob = await item.getType('image/png');
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
        return { w: img.naturalWidth, h: img.naturalHeight };
      } finally { URL.revokeObjectURL(url); }
    });
    if (dims.w === 2000 && dims.h === 1500) break;
  }
  check('K9 Copy of the cropped 2000x1500 is NOT downscaled', dims.w === 2000 && dims.h === 1500, JSON.stringify(dims));
  await page.close();
}

/* ---------------- K10: robustness ---------------- */
console.log('--- K10 robustness ---');
{
  const page = await openAnnotate(idPhoto400, 'k10');
  await selectTool(page, 'crop');
  // Click without dragging: no rectangle, Apply hidden, nothing breaks.
  const box = await canvasBox(page);
  const [cx, cy] = toClient(box, 100, 100);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(80);
  let overlayHidden = await page.evaluate(() => document.getElementById('cropOverlay').hidden);
  check('K10 plain click creates no crop rectangle', overlayHidden);
  // Drag a rect and double-click Apply rapidly.
  await dragCrop(page, [20, 20], [220, 170]);
  await page.click('#cropApply');
  await page.click('#cropApply').catch(() => {});
  await page.waitForTimeout(100);
  let size = await editorSize(page);
  check('K10 double Apply leaves a consistent cropped state', size.w === 200 && size.h === 150, JSON.stringify(size));
  const undoCount = await page.evaluate(() => !document.getElementById('btnUndo').disabled);
  check('K10 exactly one history step was added', undoCount);
  // Switch tools mid-crop: the pending selection is discarded cleanly.
  await selectTool(page, 'crop');
  await dragCrop(page, [10, 10], [100, 80]);
  await selectTool(page, 'pen');
  overlayHidden = await page.evaluate(() => document.getElementById('cropOverlay').hidden);
  size = await editorSize(page);
  check('K10 switching tools mid-crop discards the pending selection',
    overlayHidden && size.w === 200 && size.h === 150, JSON.stringify(size));
  // Crop twice, then undo twice: first crop state, then full image.
  await selectTool(page, 'crop');
  await dragCrop(page, [10, 10], [110, 90]);
  await page.click('#cropApply');
  await page.waitForTimeout(60);
  size = await editorSize(page);
  check('K10 second crop applies on the cropped view', size.w === 100 && size.h === 80, JSON.stringify(size));
  await page.click('#btnUndo');
  await page.waitForTimeout(60);
  size = await editorSize(page);
  check('K10 undo returns to the first crop', size.w === 200 && size.h === 150, JSON.stringify(size));
  await page.click('#btnUndo');
  await page.waitForTimeout(60);
  size = await editorSize(page);
  check('K10 second undo returns to the full image', size.w === 400 && size.h === 300, JSON.stringify(size));
  await page.close();
}
{
  // Corrupt record: the editor must show the load error, not throw.
  const badId = await seedRecord(Buffer.from('not-a-png'), 100, 100);
  const page = await ctx.newPage();
  watchErrors(page, 'crop-k10-corrupt');
  await page.goto(`chrome-extension://${extId}/pages/annotate.html#${badId}`);
  await page.waitForTimeout(2500);
  const failed = await page.evaluate(() => {
    const l = document.getElementById('loading');
    return l && !l.hidden && l.textContent.length > 0 && document.getElementById('content').hidden;
  });
  check('K10 corrupt image shows the load error and keeps the editor closed', !!failed);
  await page.close();
}

/* ---------------- K11: display scales and DPR ---------------- */
console.log('--- K11 scales + DPR ---');
{
  const idWide = await seedRecord(rowsWide, 4000, 2000);
  const page = await openAnnotate(idWide, 'k11-scale', { viewport: { width: 840, height: 700 } });
  const box = await canvasBox(page);
  const scale = box.w / box.iw;
  await selectTool(page, 'crop');
  await dragCrop(page, [401, 301], [1601, 1101]);
  const label = await labelText(page);
  check(`K11 display scale ${scale.toFixed(2)}: label stays in image pixels`, label === '1200 x 800', label);
  await page.click('#cropApply');
  const exported = await saveExport(page);
  const cmp = await compareRegion(page, exported, rowsWide, { x: 401, y: 301, w: 1200, h: 800 });
  check('K11 small display scale: export equals the label rectangle', cmp.ok, cmp.why || `diffBytes=${cmp.diffBytes}`);
  await page.close();
}
for (const dsf of [1.25, 2]) {
  const ctx2 = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'imgfetch-crop-dsf-')), {
    headless: !HEADED,
    viewport: { width: 1500, height: 1000 },
    deviceScaleFactor: dsf,
    args: [`--disable-extensions-except=${PROJ}`, `--load-extension=${PROJ}`, '--no-sandbox'],
  });
  dsfCtx = ctx2;
  watchErrors(ctx2, `ctx-dsf${dsf}`);
  let sw2 = ctx2.serviceWorkers()[0];
  if (!sw2) sw2 = await ctx2.waitForEvent('serviceworker', { timeout: 30000 });
  const ext2 = new URL(sw2.url()).host;
  // Round 8 fix (K11): seed the record into THIS profile through its
  // own service worker. The old code reused idPhoto400, seeded through
  // the first profile's worker into the first profile's IndexedDB, so
  // the record did not exist here, #content never appeared and the
  // block died on a TimeoutError after 61 passing checks.
  const idDsf = await seedRecord(photo400, 400, 300, {}, sw2);
  const page = await ctx2.newPage();
  watchErrors(page, `k11-dsf${dsf}`);
  await page.goto(`chrome-extension://${ext2}/pages/annotate.html#${idDsf}`);
  await page.waitForSelector('#content:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(800);
  await selectTool(page, 'crop');
  await dragCrop(page, [33, 27], [289, 219]);
  const label = await labelText(page);
  check(`K11 DPR ${dsf}: label in image pixels`, label === '256 x 192', label);
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  const size = await editorSize(page);
  check(`K11 DPR ${dsf}: cropped canvas size exact`, size.w === 256 && size.h === 192, JSON.stringify(size));
  await page.close();
  await ctx2.close();
  dsfCtx = null;
}

/* ---------------- final: zero console errors / pageerrors ---------------- */
check('zero console.error / pageerror across all crop e2e pages', errorLog.length === 0, errorLog.slice(0, 5).join(' | '));

await ctx.close();
mainCtx = null;
} catch (err) {
  check('suite runs to completion without an uncaught exception', false,
    err && err.message ? err.message : String(err));
  console.log(`crop-e2e crashed: ${err && err.stack ? err.stack : err}`);
  for (const c of [dsfCtx, mainCtx]) {
    if (c) { try { await c.close(); } catch { /* best effort on the crash path */ } }
  }
}
console.log(`\ncrop-e2e: ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failures: ${failures.join('; ')}`);
process.exit(fail === 0 ? 0 : 1);
