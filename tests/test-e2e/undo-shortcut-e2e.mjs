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
 * ImgFetch: tests/test-e2e/undo-shortcut-e2e.mjs
 * Playwright tests for the round 8 Undo keyboard shortcut in
 * pages/annotate.html (Ctrl+Z on Windows and Linux, Cmd+Z on macOS via
 * the handler's metaKey handling), with Redo on Ctrl+Y, Ctrl+Shift+Z
 * and Cmd+Shift+Z unchanged.
 *
 * Seeding and editor opening follow the crop-e2e harness: a capture
 * record is written straight into the extension's IndexedDB and
 * SAVE_ANNOTATED is stubbed. Stroke state is read back as red pixel
 * counts on the live editor canvas (the default pen colour), compared
 * against the baseline count of the stroke-free fixture, so an undo
 * step is proven by the canvas pixels returning to the previous state.
 *
 * Phases:
 *  U1  Undo button carries the undo_title tooltip and aria-label
 *  U2  Ctrl+Z with an empty history does nothing harmful
 *  U3  Ctrl+Z and Meta+Z undo strokes, Ctrl+Y, Meta+Shift+Z and
 *      Ctrl+Shift+Z redo them
 *  U4  crop applied, then Ctrl+Z restores the full image and strokes
 *  U5  typing in the text annotation box: Ctrl+Z is the browser's
 *      native text undo there and does NOT undo strokes
 *  U6  Ctrl+Z during a pending (unapplied) crop rectangle undoes the
 *      last committed step, never applies the rectangle, and leaves a
 *      consistent state (full size, overlay gone, Redo enabled)
 *
 * Fails on the round 7 tree, where Ctrl+Z has no handler at all.
 * Fails the run on ANY console.error / pageerror in any watched page.
 * Run: PLAYWRIGHT_PACKAGE=<install>/node_modules/playwright xvfb-run -a node tests/test-e2e/undo-shortcut-e2e.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const _require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = _require('playwright'));
} catch {
  ({ chromium } = _require(process.env.PLAYWRIGHT_PACKAGE || 'playwright'));
}
const PROJ = process.env.IMGFETCH_PROJ || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEADED = process.env.HEADED !== '0';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`); }
}
const approx = (a, b, tol = 12) => Math.abs(a - b) <= tol;

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
  ihdr[8] = 8;
  ihdr[9] = 6;
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

/* ---------------- error watching ---------------- */
const errorLog = [];
function watchErrors(page, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errorLog.push(`${label}: console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errorLog.push(`${label}: pageerror: ${err.message}`));
}

/* ---------------- browser + seeding + helpers ---------------- */
let mainCtx = null;
try {
const profile = mkdtempSync(join(tmpdir(), 'imgfetch-undo-e2e-'));
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

async function seedRecord(pngBuf, w, h) {
  const id = 'cap-undo-1';
  const b64 = pngBuf.toString('base64');
  await sw.evaluate(async ({ rid, b64: data, w: wd, h: ht }) => {
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
        partIndex: 0, partTotal: 0, groupId: '', groupOpen: false,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { rid: id, b64, w, h });
  return id;
}

async function openAnnotate(id) {
  const page = await ctx.newPage();
  watchErrors(page, 'undo-editor');
  await page.addInitScript(() => {
    window.__saved = null;
    try { window.close = () => {}; } catch { /* noop */ }
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === 'SAVE_ANNOTATED') {
        window.__saved = { id: msg.id, dataUrl: msg.dataUrl };
        setTimeout(() => cb({ ok: true }), 0);
        return;
      }
      return origSend(msg, cb);
    };
  });
  await page.goto(`chrome-extension://${extId}/pages/annotate.html#${id}`);
  await page.waitForSelector('#content:not([hidden])', { timeout: 30000 });
  await page.bringToFront();
  await page.waitForTimeout(1200);
  return page;
}

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
async function drawStroke(page, y) {
  const box = await canvasBox(page);
  await mouseDrag(page, toClient(box, 50, y), toClient(box, 350, y));
  await page.waitForTimeout(80);
}
async function countRed(page) {
  return page.evaluate(() => {
    const e = document.getElementById('editor');
    const d = e.getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 50 && d[i + 1] < 110 && d[i + 2] > 50 && d[i + 2] < 110) n += 1;
    }
    return n;
  });
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
async function key(page, combo) {
  await page.keyboard.press(combo);
  await page.waitForTimeout(90);
}

/* ---------------- fixture ---------------- */
const photo400 = photoPng(400, 300, 11);
const idPhoto = await seedRecord(photo400, 400, 300);
const page = await openAnnotate(idPhoto);

/* ---------------- U1: tooltip and aria-label ---------------- */
console.log('--- U1 undo tooltip ---');
{
  const info = await page.evaluate(() => {
    const u = document.getElementById('btnUndo');
    const r = document.getElementById('btnRedo');
    return {
      undoTitle: u.title, undoAria: u.getAttribute('aria-label'), undoDisabled: u.disabled,
      redoTitle: r.title, redoAria: r.getAttribute('aria-label'),
    };
  });
  check('U1 Undo button title and aria-label are "Undo (Ctrl+Z)"',
    info.undoTitle === 'Undo (Ctrl+Z)' && info.undoAria === 'Undo (Ctrl+Z)', JSON.stringify(info));
  check('U1 Redo button tooltip is unchanged ("Redo (Ctrl+Y)")',
    info.redoTitle === 'Redo (Ctrl+Y)' && info.redoAria === 'Redo (Ctrl+Y)', JSON.stringify(info));
}

/* ---------------- U2: Ctrl+Z with empty history ---------------- */
console.log('--- U2 empty history ---');
const c0 = await countRed(page);
{
  const disabledBefore = await page.evaluate(() => document.getElementById('btnUndo').disabled);
  await key(page, 'Control+z');
  const after = await countRed(page);
  const disabledAfter = await page.evaluate(() => document.getElementById('btnUndo').disabled);
  check('U2 Undo starts disabled and Ctrl+Z on empty history changes nothing',
    disabledBefore && disabledAfter && approx(after, c0),
    `disabledBefore=${disabledBefore} disabledAfter=${disabledAfter} red ${c0} -> ${after}`);
}

/* ---------------- U3: undo and redo shortcuts ---------------- */
console.log('--- U3 Ctrl+Z / Meta+Z / redo variants ---');
await drawStroke(page, 60);
const c1 = await countRed(page);
await drawStroke(page, 240);
const c2 = await countRed(page);
check('U3 two pen strokes are drawn', c1 > c0 + 400 && c2 > c1 + 400, `c0=${c0} c1=${c1} c2=${c2}`);

await key(page, 'Control+z');
let c = await countRed(page);
let redoEnabled = await page.evaluate(() => !document.getElementById('btnRedo').disabled);
check('U3 Ctrl+Z removes the second stroke (canvas pixels return)', approx(c, c1) && redoEnabled, `red=${c} want~${c1} redoEnabled=${redoEnabled}`);

await key(page, 'Meta+z');
c = await countRed(page);
const undoDisabled = await page.evaluate(() => document.getElementById('btnUndo').disabled);
check('U3 Meta+Z removes the first stroke too', approx(c, c0) && undoDisabled, `red=${c} want~${c0} undoDisabled=${undoDisabled}`);

await key(page, 'Control+y');
c = await countRed(page);
check('U3 Ctrl+Y redoes the first stroke', approx(c, c1), `red=${c} want~${c1}`);

await key(page, 'Meta+Shift+Z');
c = await countRed(page);
check('U3 Meta+Shift+Z redoes the second stroke', approx(c, c2), `red=${c} want~${c2}`);

await key(page, 'Control+z');
c = await countRed(page);
check('U3 Ctrl+Z again removes the second stroke', approx(c, c1), `red=${c} want~${c1}`);

await key(page, 'Control+Shift+Z');
c = await countRed(page);
check('U3 Ctrl+Shift+Z redoes the second stroke', approx(c, c2), `red=${c} want~${c2}`);

/* ---------------- U4: crop, then Ctrl+Z ---------------- */
console.log('--- U4 crop then Ctrl+Z ---');
{
  await selectTool(page, 'crop');
  const box = await canvasBox(page);
  await mouseDrag(page, toClient(box, 100, 75), toClient(box, 300, 225));
  await page.click('#cropApply');
  await page.waitForTimeout(80);
  let size = await editorSize(page);
  check('U4 crop applies (editor becomes 200 x 150)', size.w === 200 && size.h === 150, JSON.stringify(size));
  await key(page, 'Control+z');
  size = await editorSize(page);
  c = await countRed(page);
  check('U4 Ctrl+Z after crop restores the full image size', size.w === 400 && size.h === 300, JSON.stringify(size));
  check('U4 Ctrl+Z after crop restores both strokes', approx(c, c2), `red=${c} want~${c2}`);
}

/* ---------------- U5: text box keeps native undo ---------------- */
console.log('--- U5 text box native undo ---');
{
  await selectTool(page, 'text');
  const box = await canvasBox(page);
  const [tx, ty] = toClient(box, 60, 40);
  await page.mouse.click(tx, ty);
  await page.waitForTimeout(150);
  await page.click('#textInput');
  await page.keyboard.type('Hello');
  const typed = await page.evaluate(() => document.getElementById('textInput').value);
  check('U5 typed text is in the text box before Ctrl+Z', typed === 'Hello', `value=${typed}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(90);
  const value = await page.evaluate(() => document.getElementById('textInput').value);
  // Chromium coalesces fast typing into one native undo unit, so the
  // native undo may remove the whole word, not just the last letter.
  // What matters: the value shrank (native text undo fired) instead of
  // staying "Hello" (which is what an editor-level undo would leave).
  check('U5 Ctrl+Z inside the text box is native text undo (typed text is consumed)',
    value !== 'Hello' && 'Hello'.startsWith(value), `value=${value}`);
  c = await countRed(page);
  check('U5 Ctrl+Z inside the text box does NOT undo strokes', approx(c, c2), `red=${c} want~${c2}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
}

/* ---------------- U6: Ctrl+Z during a pending crop ---------------- */
console.log('--- U6 pending crop ---');
{
  await selectTool(page, 'pen');
  await drawStroke(page, 120);
  const c3 = await countRed(page);
  check('U6 a third stroke is committed before the pending crop', c3 > c2 + 400, `c2=${c2} c3=${c3}`);
  await selectTool(page, 'crop');
  const box = await canvasBox(page);
  await mouseDrag(page, toClient(box, 50, 50), toClient(box, 250, 200));
  const label = await page.evaluate(() => document.getElementById('cropSize').textContent);
  const overlayShown = await page.evaluate(() => !document.getElementById('cropOverlay').hidden);
  check('U6 pending crop rectangle exists (200 x 150, overlay visible)',
    label === '200 x 150' && overlayShown, `label=${label} overlayShown=${overlayShown}`);
  await key(page, 'Control+z');
  c = await countRed(page);
  check('U6 Ctrl+Z during the pending crop undoes the last committed stroke', approx(c, c2), `red=${c} want~${c2}`);
  const size = await editorSize(page);
  const overlayHidden = await page.evaluate(() => document.getElementById('cropOverlay').hidden);
  const redoOn = await page.evaluate(() => !document.getElementById('btnRedo').disabled);
  check('U6 state stays consistent: crop not applied, overlay closed, Redo enabled',
    size.w === 400 && size.h === 300 && overlayHidden && redoOn,
    `size=${JSON.stringify(size)} overlayHidden=${overlayHidden} redoOn=${redoOn}`);
  await page.close();
}

/* ---------------- final: zero console errors ---------------- */
check('zero console.error / pageerror across all undo e2e pages', errorLog.length === 0, errorLog.slice(0, 5).join(' | '));

await ctx.close();
mainCtx = null;
} catch (err) {
  check('suite runs to completion without an uncaught exception', false,
    err && err.message ? err.message : String(err));
  console.log(`undo-shortcut-e2e crashed: ${err && err.stack ? err.stack : err}`);
  if (mainCtx) { try { await mainCtx.close(); } catch { /* best effort on the crash path */ } }
}
console.log(`\nundo-shortcut-e2e: ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failures: ${failures.join('; ')}`);
process.exit(fail === 0 ? 0 : 1);
