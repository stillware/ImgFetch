/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch e2e: tests/test-e2e/parts-e2e.mjs
 * Real-browser suite (Playwright + Chromium) for the round-4 Parts
 * overview page (pages/parts.html). Capture groups are seeded straight
 * into the extension's IndexedDB (the same 'imgfetch'/'captures' store
 * the offscreen stitcher writes), as Blob records in the exact stored
 * shape; every action is then exercised through the real page and the
 * real service worker (SAVE_CAPTURE / DISCARD_CAPTURE /
 * DISCARD_CAPTURE_GROUP), with downloads verified on disk by PNG magic
 * bytes and IHDR dimensions.
 *
 * Phases:
 *  P1  overview renders the seeded group: heading, summary, 3 cards in
 *      part order with labels, dimensions and file sizes
 *  P2  lazy thumbnails decode (IntersectionObserver + createImageBitmap
 *      resize) and are not blank
 *  P3  Edit opens pages/annotate.html for the right part in a NEW tab
 *      and the editor keeps its "Part i of N" title
 *  P4  Windows clipboard note: hidden on this (Linux) platform, shown
 *      verbatim when the platform reports Windows
 *  P5  Copy writes the part to the real clipboard as a valid PNG of
 *      the part's own size
 *  P6  Save downloads the part (PNG bytes verified), removes its card
 *      and its stored record
 *  P7  Discard removes the part's card and its stored record
 *  P8  Save all (fresh group): one verified download per part, then
 *      the "all saved" empty state and an empty group in storage
 *  P9  Discard all (fresh group): empty state, group fully cleared
 *  P10 Arabic (RTL): dir/lang, translated heading, card labels and
 *      buttons, thumbnails still decode
 *  P0  zero console.error / pageerror in any context
 *
 * Run under a virtual display, like the other suites:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/parts-e2e.mjs
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const HEADED = args.headed !== undefined ? !!args.headed : true;

const results = { phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `: ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const ihdrDims = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

function msg(lang, key) {
  const file = path.join(PROJ, '_locales', lang, 'messages.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json[key] || typeof json[key].message !== 'string') throw new Error(`missing key ${key} in ${lang}`);
  return json[key].message;
}
const fill = (tpl, vars) => tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m));

/* ---------------- pure-Node flat PNG writer (from clipboard-e2e) ---------------- */
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- browser setup ---------------- */
const errorWatch = [];
function watchErrors(target, label) {
  target.on('console', (m) => {
    if (m.type() === 'error') errorWatch.push({ label, kind: 'console.error', text: m.text().slice(0, 300) });
    else if (m.type() === 'warning') errorWatch.push({ label, kind: 'console.warning', text: m.text().slice(0, 300) });
  });
  target.on('pageerror', (err) => {
    errorWatch.push({ label, kind: 'pageerror', text: String((err && err.message) || err).slice(0, 300) });
  });
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-parts-e2e-'));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${PROJ}`,
      `--load-extension=${PROJ}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
ctx.on('page', (p) => watchErrors(p, `page:${p.url().slice(0, 60)}`));

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');

const ctrl = await ctx.newPage();
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
await sleep(500);

/* ---------------- seeding + storage reads (the extension's own IDB) ---------------- */
let seedSeq = 0;
async function seedGroup(specs) {
  seedSeq += 1;
  const groupId = `grp-1700000000000-${700 + seedSeq}`;
  const parts = specs.map((s, i) => ({
    id: `cap-1700000000000-${seedSeq * 100 + i}`,
    partIndex: i + 1,
    width: s.w,
    height: s.h,
    b64: flatPng(s.w, s.h, s.rgb[0], s.rgb[1], s.rgb[2]).toString('base64'),
  }));
  await sw.evaluate(async ({ gid, list }) => {
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
    await new Promise((resolve, reject) => {
      const tx = db.transaction('captures', 'readwrite');
      const store = tx.objectStore('captures');
      for (const p of list) {
        const bin = atob(p.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/png' });
        store.put({
          id: p.id, blob, width: p.width, height: p.height, at: Date.now(),
          bytes: blob.size, partIndex: p.partIndex, partTotal: list.length,
          groupId: gid, groupOpen: false,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { gid: groupId, list: parts });
  return { groupId, ids: parts.map((p) => p.id) };
}

async function groupRecords(groupId) {
  return ctrl.evaluate((gid) => new Promise((resolve) => {
    try {
      const req = indexedDB.open('imgfetch', 1);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('captures')) { resolve([]); return; }
          const rq = db.transaction('captures', 'readonly').objectStore('captures').getAll();
          rq.onsuccess = () => resolve((rq.result || []).filter((r) => r && r.groupId === gid)
            .map((r) => ({ id: r.id, partIndex: r.partIndex || 0 })));
          rq.onerror = () => resolve([]);
        } catch { resolve([]); }
      };
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  }), groupId);
}

async function completedDownloads() {
  return ctrl.evaluate(() => chrome.downloads.search({ state: 'complete' })
    .then((items) => items.map((d) => ({ id: d.id, filename: d.filename }))));
}
async function newDownloadsSince(beforeIds, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const now = await completedDownloads();
    const fresh = now.filter((d) => !beforeIds.has(d.id));
    if (fresh.length) return fresh;
    await sleep(400);
  }
  return [];
}
function verifyPngFile(filename, w, h) {
  try {
    const buf = fs.readFileSync(filename);
    if (!pngMagic(buf)) return { ok: false, note: 'not a PNG' };
    const d = ihdrDims(buf);
    return { ok: d.w === w && d.h === h, note: `${d.w}x${d.h} ${buf.length}B` };
  } catch (e) {
    return { ok: false, note: e.message.slice(0, 80) };
  }
}

async function setTestLanguage(lang) {
  await sw.evaluate(async (l) => {
    const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
    const next = { ...cur, language: l };
    await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
  }, lang);
  await sleep(800);
}
await setTestLanguage('en');

/* ================= group A: render, thumbs, edit, note, copy, save, discard ===== */
const A = await seedGroup([
  { w: 200, h: 120, rgb: [220, 40, 40] },
  { w: 200, h: 120, rgb: [40, 200, 40] },
  { w: 200, h: 120, rgb: [40, 40, 220] },
]);
const pageA = await ctx.newPage();
await pageA.goto(`chrome-extension://${extId}/pages/parts.html#${A.groupId}`);
await pageA.waitForSelector('#content:not([hidden])', { timeout: 15000 });
await pageA.waitForSelector('.part-card', { timeout: 15000 });

// P1: heading, summary, cards in order with labels/dims/size
try {
  const info = await pageA.evaluate(() => ({
    heading: document.getElementById('partsHeading').textContent,
    summary: document.getElementById('partsSummary').textContent,
    cards: [...document.querySelectorAll('.part-card')].map((c) => ({
      title: c.querySelector('.part-title').textContent,
      meta: c.querySelector('.part-meta').textContent,
      editHref: c.querySelector('a.btn').getAttribute('href'),
      editTarget: c.querySelector('a.btn').getAttribute('target'),
      editRel: c.querySelector('a.btn').getAttribute('rel'),
      buttons: [...c.querySelectorAll('.part-actions .btn')].map((b) => b.textContent.trim()),
    })),
  }));
  const wantSummary = fill(msg('en', 'parts_summarySame_other'), { count: 3, width: 200, height: 120 });
  const titlesOk = info.cards.every((c, i) => c.title === fill(msg('en', 'part_title_other'), { count: i + 1, total: 3 }));
  const metasOk = info.cards.every((c) => c.meta.includes('200') && c.meta.includes('120') && /KB|B/.test(c.meta));
  const editOk = info.cards.every((c, i) => c.editHref === `annotate.html#${A.ids[i]}` && c.editTarget === '_blank' && c.editRel === 'noopener noreferrer');
  phase('P1 overview renders heading, summary and 3 ordered cards',
    info.heading === msg('en', 'parts_heading') && info.summary === wantSummary && titlesOk && metasOk && editOk,
    { note: `heading=${JSON.stringify(info.heading)} summary=${JSON.stringify(info.summary)} titlesOk=${titlesOk} metasOk=${metasOk} editOk=${editOk}` });
} catch (e) { phase('P1 overview renders', false, { note: e.message.slice(0, 200) }); }

// P2: lazy thumbnails decoded and non-blank
try {
  await pageA.waitForFunction(() => [...document.querySelectorAll('.part-thumb')]
    .every((c) => c.dataset.loaded === '1'), null, { timeout: 15000 });
  const px = await pageA.evaluate(() => [...document.querySelectorAll('.part-thumb')].map((c) => {
    const g = c.getContext('2d');
    const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  }));
  const want = [[220, 40, 40], [40, 200, 40], [40, 40, 220]];
  const okPx = px.every((p, i) => Math.abs(p[0] - want[i][0]) < 12 && Math.abs(p[1] - want[i][1]) < 12 && Math.abs(p[2] - want[i][2]) < 12);
  phase('P2 lazy thumbnails decode with the right pixels', okPx, { note: `pixels=${JSON.stringify(px)}` });
} catch (e) { phase('P2 lazy thumbnails', false, { note: e.message.slice(0, 200) }); }

// P3: Edit opens the annotate editor for part 2 in a new tab, title kept
try {
  const before = ctx.pages().length;
  const [editor] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 15000 }),
    pageA.locator('.part-card').nth(1).locator('a.btn').click(),
  ]);
  await editor.waitForSelector('#content:not([hidden])', { timeout: 20000 });
  await editor.waitForFunction(() => document.title.startsWith('Part'), null, { timeout: 10000 });
  const wantTitle = fill(msg('en', 'part_title_other'), { count: 2, total: 3 });
  const got = await editor.evaluate(() => ({
    title: document.title,
    sub: document.querySelector('.brand-sub').textContent,
    url: location.href,
  }));
  phase('P3 Edit opens the right part in a new tab with its Part title',
    ctx.pages().length === before + 1 && got.url.includes(`annotate.html#${A.ids[1]}`) &&
    got.title === wantTitle && got.sub === wantTitle,
    { note: `title=${JSON.stringify(got.title)} url=${got.url.slice(-40)}` });
  await editor.close();
} catch (e) { phase('P3 Edit opens editor', false, { note: e.message.slice(0, 200) }); }

// P4: Windows clipboard note hidden on Linux, shown verbatim on Windows
try {
  const hiddenHere = await pageA.evaluate(() => document.getElementById('windowsNote').hidden);
  const pageW = await ctx.newPage();
  await pageW.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'Win32' }, configurable: true });
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    } catch { /* best effort */ }
  });
  await pageW.goto(`chrome-extension://${extId}/pages/parts.html#${A.groupId}`);
  await pageW.waitForSelector('#content:not([hidden])', { timeout: 15000 });
  await pageW.waitForFunction(() => !document.getElementById('windowsNote').hidden, null, { timeout: 10000 });
  const noteText = await pageW.textContent('#windowsNote');
  phase('P4 Windows clipboard note gated by platform',
    hiddenHere === true && noteText.trim() === msg('en', 'copy_windowsNote'),
    { note: `hiddenOnLinux=${hiddenHere} noteShownOnWin=${noteText.trim().slice(0, 40)}...` });
  await pageW.close();
} catch (e) { phase('P4 Windows clipboard note', false, { note: e.message.slice(0, 200) }); }

// P5: Copy part 1 to the real clipboard
try {
  await pageA.bringToFront();
  await pageA.locator('.part-card').nth(0).locator('button.btn-ghost').click();
  await pageA.waitForSelector('.toast', { timeout: 10000 });
  const clip = await pageA.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return { ok: false, reason: 'no image/png item' };
    const blob = await item.getType('image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bmp = await createImageBitmap(blob);
    const dims = { w: bmp.width, h: bmp.height };
    bmp.close();
    return { ok: bytes[0] === 0x89 && bytes[1] === 0x50, ...dims };
  });
  phase('P5 Copy writes a valid PNG of the part size to the clipboard',
    clip.ok === true && clip.w === 200 && clip.h === 120,
    { note: JSON.stringify(clip) });
} catch (e) { phase('P5 Copy part', false, { note: e.message.slice(0, 200) }); }

// P6: Save part 2: verified download, card + record removed
try {
  const beforeIds = new Set((await completedDownloads()).map((d) => d.id));
  await pageA.locator('.part-card').nth(1).locator('button.btn-primary').click();
  await pageA.waitForFunction(() => document.querySelectorAll('.part-card').length === 2, null, { timeout: 20000 });
  const fresh = await newDownloadsSince(beforeIds);
  const v = fresh.length ? verifyPngFile(fresh[0].filename, 200, 120) : { ok: false, note: 'no download' };
  const recs = await groupRecords(A.groupId);
  phase('P6 Save downloads the part (PNG verified), card and record removed',
    v.ok && recs.length === 2 && recs.every((r) => r.id !== A.ids[1]),
    { note: `download=${v.note} recordsLeft=${recs.length}` });
} catch (e) { phase('P6 Save part', false, { note: e.message.slice(0, 200) }); }

// P7: Discard part 1 (now the first card): card + record removed
try {
  await pageA.locator('.part-card').nth(0).locator('button.btn-danger').click();
  await pageA.waitForFunction(() => document.querySelectorAll('.part-card').length === 1, null, { timeout: 15000 });
  const recs = await groupRecords(A.groupId);
  phase('P7 Discard removes the part card and its record',
    recs.length === 1 && recs[0].id === A.ids[2],
    { note: `recordsLeft=${recs.length} remaining=${recs.map((r) => r.partIndex).join(',')}` });
} catch (e) { phase('P7 Discard part', false, { note: e.message.slice(0, 200) }); }
await pageA.close();

/* ================= group B: Save all ================================= */
try {
  const B = await seedGroup([
    { w: 160, h: 90, rgb: [200, 200, 40] },
    { w: 160, h: 90, rgb: [40, 200, 200] },
    { w: 160, h: 90, rgb: [200, 40, 200] },
  ]);
  const pageB = await ctx.newPage();
  await pageB.goto(`chrome-extension://${extId}/pages/parts.html#${B.groupId}`);
  await pageB.waitForSelector('.part-card', { timeout: 15000 });
  const beforeIds = new Set((await completedDownloads()).map((d) => d.id));
  await pageB.click('#btnSaveAll');
  await pageB.waitForSelector('#emptyState:not([hidden])', { timeout: 60000 });
  const emptyText = await pageB.textContent('#emptyText');
  const fresh = await newDownloadsSince(beforeIds);
  // Save-all downloads arrive sequentially; wait until all 3 are complete.
  let all = fresh;
  const t0 = Date.now();
  while (all.length < 3 && Date.now() - t0 < 30000) {
    await sleep(500);
    all = (await completedDownloads()).filter((d) => !beforeIds.has(d.id));
  }
  const verified = all.slice(0, 3).map((d) => verifyPngFile(d.filename, 160, 90));
  const recs = await groupRecords(B.groupId);
  phase('P8 Save all: one verified download per part, empty state, storage cleared',
    emptyText.trim() === msg('en', 'parts_allSaved') && all.length >= 3 &&
    verified.every((v) => v.ok) && recs.length === 0,
    { note: `downloads=${all.length} verified=${verified.map((v) => v.note).join('|')} recordsLeft=${recs.length}` });
  await pageB.close();
} catch (e) { phase('P8 Save all', false, { note: e.message.slice(0, 200) }); }

/* ================= group C: Discard all ============================== */
try {
  const C = await seedGroup([
    { w: 120, h: 80, rgb: [90, 90, 90] },
    { w: 120, h: 80, rgb: [150, 150, 150] },
  ]);
  const pageC = await ctx.newPage();
  await pageC.goto(`chrome-extension://${extId}/pages/parts.html#${C.groupId}`);
  await pageC.waitForSelector('.part-card', { timeout: 15000 });
  await pageC.click('#btnDiscardAll');
  await pageC.waitForSelector('#emptyState:not([hidden])', { timeout: 15000 });
  const emptyText = await pageC.textContent('#emptyText');
  const recs = await groupRecords(C.groupId);
  phase('P9 Discard all: empty state and group storage fully cleared',
    emptyText.trim() === msg('en', 'parts_empty') && recs.length === 0,
    { note: `recordsLeft=${recs.length}` });
  await pageC.close();
} catch (e) { phase('P9 Discard all', false, { note: e.message.slice(0, 200) }); }

/* ================= Arabic (RTL) ====================================== */
try {
  await setTestLanguage('ar');
  const D = await seedGroup([
    { w: 200, h: 120, rgb: [220, 40, 40] },
    { w: 200, h: 120, rgb: [40, 200, 40] },
  ]);
  const pageD = await ctx.newPage();
  await pageD.goto(`chrome-extension://${extId}/pages/parts.html#${D.groupId}`);
  await pageD.waitForFunction(() => document.documentElement.getAttribute('dir') === 'rtl', null, { timeout: 15000 });
  await pageD.waitForSelector('.part-card', { timeout: 15000 });
  await pageD.waitForFunction(() => [...document.querySelectorAll('.part-thumb')]
    .every((c) => c.dataset.loaded === '1'), null, { timeout: 15000 });
  const info = await pageD.evaluate(() => ({
    dir: document.documentElement.getAttribute('dir'),
    lang: document.documentElement.getAttribute('lang'),
    heading: document.getElementById('partsHeading').textContent,
    firstTitle: document.querySelector('.part-title').textContent,
    saveAll: document.getElementById('btnSaveAll').textContent,
  }));
  phase('P10 Arabic RTL: translated heading, labels and buttons, thumbnails load',
    info.dir === 'rtl' && info.lang === 'ar' &&
    info.heading === msg('ar', 'parts_heading') &&
    info.firstTitle === fill(msg('ar', 'part_title_one'), { count: 1, total: 2 }) &&
    info.saveAll === msg('ar', 'parts_saveAll'),
    { note: `dir=${info.dir} lang=${info.lang} heading=${JSON.stringify(info.heading)}` });
  await pageD.close();
  await setTestLanguage('en');
} catch (e) { phase('P10 Arabic RTL', false, { note: e.message.slice(0, 200) }); }

/* ================= errors ============================================ */
const hard = errorWatch.filter((e) => e.kind !== 'console.warning');
phase('P0 zero console.error/pageerror', hard.length === 0,
  { note: hard.length ? JSON.stringify(hard.slice(0, 4)) : 'clean' });

console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
await ctx.close().catch(() => {});
process.exit(results.errors.length ? 1 : 0);
