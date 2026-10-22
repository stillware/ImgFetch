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
 * ImgFetch e2e: tests/test-e2e/clipboard-e2e.mjs
 * Real-browser suite (Playwright + Chromium) for Feature A, the annotate
 * editor's Copy button. Run under a virtual display:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/clipboard-e2e.mjs [--headed]
 *
 * Every fixture PNG is generated in Node (pure PNG writer below), no
 * internet needed. The annotate page's service-worker round trip is stubbed
 * via page.addInitScript (GET_CAPTURE returns the fixture, GET_SETTINGS
 * returns a light theme); the editor, the Copy button wiring and the real
 * clipboard are exercised for real.
 *
 * Phases:
 *  C0  extension loads, annotate page opens, Copy button is wired
 *  C1  direct path: draw an edit, click Copy, clipboard holds a valid PNG
 *      of the edited canvas size, edit pixels are present in the copy
 *  C2  downscale path: 5000x3000 fixture (over the pixel budget) copies at
 *      exactly planCopy()'s dims, toast reports the downscale
 *  C3  failure path: clipboard.write throws, error toast appears, the copy
 *      is retried once, no exception escapes, the screenshot stays intact
 *  C4  editor Windows clipboard note (Phase C3): shown for a large image
 *      and for a capture part under a Windows platform override, hidden
 *      for a small image and on the real (non-Windows) platform
 *  C5  large-copy toast (Phase C3): a multi-MB PNG copy on Windows shows
 *      the long Ctrl+V toast and outlives the normal toast duration;
 *      the same copy on non-Windows keeps the short success toast
 *
 * Fails the run on ANY console.error / pageerror in the annotate pages.
 * This test was written carefully but could not be executed here (no
 * Chromium in this environment); run it per README.md before trusting it.
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { planCopy } from '../../core/clipboard-image.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const HEADED = args.headed !== undefined ? !!args.headed : true;

const results = { headed: HEADED, phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `: ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

function msg(lang, key) {
  const file = path.join(PROJ, '_locales', lang, 'messages.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json[key] || typeof json[key].message !== 'string') throw new Error(`missing key ${key} in ${lang}`);
  return json[key].message;
}

/* ---------------- pure-Node flat PNG writer ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const td = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([td, data])), 0);
  return Buffer.concat([len, td, data, crc]);
}

/** Solid-color truecolor PNG, compresses well even at large sizes. */
function flatPng(w, h, r, g, b) {
  const stride = w * 3;
  const row = Buffer.alloc(1 + stride);
  for (let x = 0; x < w; x += 1) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.alloc((1 + stride) * h);
  for (let y = 0; y < h; y += 1) row.copy(raw, y * (1 + stride));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // truecolor
  const body = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  if (!pngMagic(body)) throw new Error('fixture PNG writer produced bad magic');
  return body;
}

/**
 * Noise PNG (crypto-random pixels): incompressible, so a modest pixel
 * size still produces a multi-MB file, which the Phase C3 large-copy
 * toast rule keys on (the written PNG's byte size, not its area). A
 * simple LCG will NOT do here: its byte stream is linear, so deflate
 * crushes it to a few percent of the raw size.
 */
function noisePng(w, h) {
  const stride = w * 3;
  const raw = crypto.randomBytes((1 + stride) * h);
  for (let y = 0; y < h; y += 1) raw[y * (1 + stride)] = 0; // filter: none
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const body = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  if (!pngMagic(body)) throw new Error('noise PNG writer produced bad magic');
  return body;
}

/* ---------------- browser setup (follows e2e.mjs) ---------------- */

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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-clipboard-e2e-'));

let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    args: [
      `--disable-extensions-except=${PROJ}`,
      `--load-extension=${PROJ}`,
      '--no-sandbox',
    ],
  });
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');

/**
 * Open the annotate page with a fixture screenshot. The worker round trip
 * is stubbed: GET_CAPTURE returns our fixture data URL, GET_SETTINGS a
 * light theme. Everything else (editor, lazy Copy module, clipboard) is
 * the real shipped code.
 */
async function openAnnotate(pngBase64, label, opts = {}) {
  const page = await ctx.newPage();
  watchErrors(page, `annotate-${label}`);
  await page.addInitScript((cfg) => {
    window.__capDataUrl = `data:image/png;base64,${cfg.b64}`;
    // Platform override (the parts-e2e precedent): report a Windows
    // platform to the page's own navigator before any page script runs.
    if (cfg.platform) {
      try {
        Object.defineProperty(navigator, 'userAgentData', { value: { platform: cfg.platform }, configurable: true });
        Object.defineProperty(navigator, 'platform', { value: cfg.platform, configurable: true });
      } catch { /* best effort */ }
    }
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === 'GET_CAPTURE') {
        setTimeout(() => cb({
          ok: true,
          dataUrl: window.__capDataUrl,
          width: cfg.width || 0,
          height: cfg.height || 0,
          partIndex: cfg.partIndex || 0,
          partTotal: cfg.partTotal || 0,
        }), 0);
        return;
      }
      if (msg && msg.type === 'GET_SETTINGS') {
        setTimeout(() => cb({ ok: true, settings: { theme: 'light' } }), 0);
        return;
      }
      return origSend(msg, cb);
    };
  }, {
    b64: pngBase64,
    platform: opts.platform || '',
    width: opts.width || 0,
    height: opts.height || 0,
    partIndex: opts.partIndex || 0,
    partTotal: opts.partTotal || 0,
  });
  await page.goto(`chrome-extension://${extId}/pages/annotate.html#e2e-cap`);
  await page.waitForSelector('#content:not([hidden])', { timeout: 15000 });
  // The Copy module loads lazily; give it a moment, then require success.
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const b = document.getElementById('btnCopy');
    return b ? { disabled: b.disabled, title: b.title } : null;
  });
  if (!state) throw new Error('C0: #btnCopy missing from pages/annotate.html');
  if (state.disabled) {
    throw new Error(`C0: Copy button disabled (module failed to load), title=${JSON.stringify(state.title)}. ` +
      'Check shared/copy-shot.js and shared/i18n.js.');
  }
  return page;
}

/** Read the clipboard's image/png item and decode it in-page. */
async function readClipboardPng(page) {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return { ok: false, reason: 'no image/png item on clipboard' };
    const blob = await item.getType('image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const magic = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('clipboard PNG did not decode'));
        im.src = url;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 180 && d[i + 1] < 110 && d[i + 2] < 110) red += 1;
      }
      return {
        ok: true, magic, bytes: bytes.length,
        width: img.naturalWidth, height: img.naturalHeight, redPixels: red,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}

async function lastToast(page) {
  return page.locator('.toast').last().innerText();
}

/* ---------------- C0: page loads, Copy button wired ---------------- */

const smallB64 = flatPng(640, 480, 0, 200, 0).toString('base64');
let p1;
try {
  p1 = await openAnnotate(smallB64, 'direct');
  phase('C0 annotate loads, Copy button wired', true);
} catch (e) {
  phase('C0 annotate loads, Copy button wired', false, { note: e.message.slice(0, 200) });
}

/* ---------------- C1: direct path, edits included ---------------- */

if (p1) {
  try {
    // Draw a red pen stroke across the middle (pen + red are the defaults).
    const box = await p1.locator('#editor').boundingBox();
    await p1.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
    await p1.mouse.down();
    await p1.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, { steps: 20 });
    await p1.mouse.up();
    await p1.click('#btnCopy');
    await p1.waitForSelector('.toast', { timeout: 10000 });
    const shot = await readClipboardPng(p1);
    phase('C1 clipboard holds a valid PNG', !!(shot.ok && shot.magic),
      { note: shot.ok ? `${shot.width}x${shot.height}, ${shot.bytes} bytes` : shot.reason });
    phase('C1 copied size matches the edited canvas',
      shot.ok && shot.width === 640 && shot.height === 480,
      { note: shot.ok ? `${shot.width}x${shot.height}` : shot.reason });
    phase('C1 edit pixels present in the copy',
      shot.ok && shot.redPixels > 50,
      { note: shot.ok ? `${shot.redPixels} red pixels` : shot.reason });
    const toast = await lastToast(p1);
    phase('C1 success toast shown', /copied to the clipboard/i.test(toast),
      { note: toast.slice(0, 120) });
  } catch (e) {
    phase('C1 direct copy path', false, { note: e.message.slice(0, 200) });
  }
}

/* ---------------- C2: downscale path ---------------- */

try {
  const bigB64 = flatPng(5000, 3000, 0, 120, 200).toString('base64');
  const p2 = await openAnnotate(bigB64, 'downscale');
  const plan = planCopy(5000, 3000);
  if (!plan.downscaled) throw new Error('fixture error: 5000x3000 did not exceed the pixel budget');
  await p2.click('#btnCopy');
  await p2.waitForSelector('.toast', { timeout: 20000 });
  const big = await readClipboardPng(p2);
  phase('C2 downscaled copy is a valid PNG', !!(big.ok && big.magic),
    { note: big.ok ? `${big.width}x${big.height}` : big.reason });
  phase('C2 downscaled dims match planCopy()',
    big.ok && big.width === plan.width && big.height === plan.height,
    { note: big.ok ? `got ${big.width}x${big.height}, want ${plan.width}x${plan.height}` : big.reason });
  const toast = await lastToast(p2);
  phase('C2 toast reports the downscale', /downscal/i.test(toast),
    { note: toast.slice(0, 140) });
  await p2.close();
} catch (e) {
  phase('C2 downscale copy path', false, { note: e.message.slice(0, 200) });
}

/* ---------------- C3: failure path ---------------- */

try {
  const p3 = await openAnnotate(smallB64, 'failure');
  await p3.evaluate(() => {
    window.__writeCalls = 0;
    const failing = async () => {
      window.__writeCalls += 1;
      throw new DOMException('denied by test', 'NotAllowedError');
    };
    Object.defineProperty(navigator.clipboard, 'write', { value: failing, configurable: true });
  });
  await p3.click('#btnCopy');
  await p3.waitForSelector('.toast', { timeout: 10000 });
  const toast = await lastToast(p3);
  phase('C3 honest error toast on clipboard failure', /could not copy/i.test(toast),
    { note: toast.slice(0, 140) });
  const calls = await p3.evaluate(() => window.__writeCalls);
  phase('C3 copy retried once (2 attempts total)', calls === 2, { note: `write calls: ${calls}` });
  const intact = await p3.evaluate(() => {
    const c = document.getElementById('editor');
    if (!c || c.width !== 640 || c.height !== 480) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let green = 0;
    for (let i = 0; i < d.length; i += 16) {
      if (d[i + 1] > 150) green += 1;
    }
    return green > 100;
  });
  phase('C3 screenshot stays intact after failure', intact === true);
  await p3.close();
} catch (e) {
  phase('C3 clipboard failure path', false, { note: e.message.slice(0, 200) });
}

/* ------------- C4: editor Windows clipboard note (Phase C3) ------------- */

try {
  const largeB64 = flatPng(2000, 1500, 30, 60, 90).toString('base64'); // 3 MP, over the ~2 MP rule
  const pWinLarge = await openAnnotate(largeB64, 'note-win-large', { platform: 'Win32', width: 2000, height: 1500 });
  const noteShown = await pWinLarge.evaluate(() => {
    const n = document.getElementById('windowsNote');
    return n ? { hidden: n.hidden, text: n.textContent } : null;
  });
  phase('C4 editor note shown for a large image on Windows',
    !!noteShown && noteShown.hidden === false && noteShown.text === msg('en', 'copy_windowsNote'),
    { note: noteShown ? `hidden=${noteShown.hidden} text=${String(noteShown.text).slice(0, 50)}...` : 'note element missing' });
  await pWinLarge.close();

  const pWinSmall = await openAnnotate(smallB64, 'note-win-small', { platform: 'Win32', width: 640, height: 480 });
  const smallHidden = await pWinSmall.evaluate(() => document.getElementById('windowsNote').hidden);
  phase('C4 editor note hidden for a small image on Windows', smallHidden === true,
    { note: `hidden=${smallHidden}` });
  await pWinSmall.close();

  const pLinuxLarge = await openAnnotate(largeB64, 'note-linux-large', { width: 2000, height: 1500 });
  const linuxHidden = await pLinuxLarge.evaluate(() => document.getElementById('windowsNote').hidden);
  phase('C4 editor note hidden for a large image on non-Windows', linuxHidden === true,
    { note: `hidden=${linuxHidden}` });
  await pLinuxLarge.close();

  const partB64 = flatPng(200, 120, 90, 60, 30).toString('base64');
  const pWinPart = await openAnnotate(partB64, 'note-win-part', {
    platform: 'Win32', width: 200, height: 120, partIndex: 1, partTotal: 3,
  });
  const partShown = await pWinPart.evaluate(() => document.getElementById('windowsNote').hidden);
  phase('C4 editor note shown for a capture part on Windows', partShown === false,
    { note: `hidden=${partShown}` });
  await pWinPart.close();
} catch (e) {
  phase('C4 editor Windows clipboard note', false, { note: e.message.slice(0, 200) });
}

/* ------------- C5: large-copy toast on Windows (Phase C3) ------------- */

try {
  const noise = noisePng(1600, 1200); // 1.92 MP (no downscale), multi-MB PNG
  if (noise.length <= 3_500_000) throw new Error(`fixture error: noise PNG only ${noise.length} bytes`);
  const noiseB64 = noise.toString('base64');
  const pWin = await openAnnotate(noiseB64, 'toast-win-large', { platform: 'Win32', width: 1600, height: 1200 });
  await pWin.click('#btnCopy');
  await pWin.waitForSelector('.toast', { timeout: 20000 });
  const toastWin = await lastToast(pWin);
  phase('C5 large-copy toast text on Windows',
    toastWin === msg('en', 'copy_windowsToast'),
    { note: `png=${noise.length}B toast=${toastWin.slice(0, 90)}` });
  // The normal toast is gone after ~2.6 s; this one must outlive it.
  await pWin.waitForTimeout(3200);
  const stillThere = await pWin.evaluate(() => {
    const els = document.querySelectorAll('.toast');
    return els.length ? els[els.length - 1].textContent : null;
  });
  phase('C5 large-copy toast outlives the normal toast duration',
    stillThere === msg('en', 'copy_windowsToast'),
    { note: stillThere ? 'still visible after 3.2s' : 'toast already gone after 3.2s' });
  await pWin.close();

  const pLin = await openAnnotate(noiseB64, 'toast-linux-large', { width: 1600, height: 1200 });
  await pLin.click('#btnCopy');
  await pLin.waitForSelector('.toast', { timeout: 20000 });
  const toastLin = await lastToast(pLin);
  phase('C5 large copy on non-Windows keeps the short toast',
    toastLin === msg('en', 'copySuccess'),
    { note: toastLin.slice(0, 90) });
  await pLin.close();
} catch (e) {
  phase('C5 large-copy toast', false, { note: e.message.slice(0, 200) });
}

/* ---------------- C8: zero console/page errors ---------------- */

const bad = errorWatch.filter((e) => e.kind !== 'console.warning');
phase('C8 zero console.error / pageerror', bad.length === 0,
  { note: bad.length ? JSON.stringify(bad.slice(0, 3)) : 'clean' });

if (p1) await p1.close();
await ctx.close();

console.log(`${results.phases.filter((p) => p.ok).length} passed, ${results.errors.length} failed`);
process.exit(results.errors.length === 0 ? 0 : 1);
