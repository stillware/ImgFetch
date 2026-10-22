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
 * ImgFetch e2e, tests/test-e2e/tileloop-e2e.mjs
 * Real-browser regression test for the multi-part full-page capture bug
 * (ROUND 4 headline bug):
 *
 *   background/service-worker.js captureFullPageInner() loops over
 *   plan.parts. After EACH part it called finishCapture(), which opens a
 *   NEW ACTIVE result tab (openResultTab -> chrome.tabs.create). On the
 *   next part's first tile, assertTabStillActive() then threw
 *   friendlyError('capture-failed') because the source tab was no longer
 *   the active tab, so parts 2..N were never captured. A part is capped
 *   by PART_MAX_SIDE = 32767 device px (core/fullpage-capture.js), so on
 *   a very tall page only the first part ever landed.
 *
 * Unlike capture-e2e.mjs (which mirrors the tile loop because automated
 * browsers get no activeTab gesture), this suite drives the REAL worker
 * path end to end: the real CAPTURE_FULL runtime message, the real
 * captureFullPageInner tile loop, the real chrome.tabs.captureVisibleTab
 * and the real offscreen stitcher. That is possible because the test
 * first builds a TEMPORARY COPY of the extension (outside the repo) and
 * adds "<all_urls>" to host_permissions in the COPY's manifest only, so
 * captureVisibleTab is permitted without a toolbar-click gesture. The
 * repo manifest (and any --proj source tree) is never modified; the
 * test hashes the source manifest before and after and asserts it is
 * byte-identical.
 *
 * Fixture: the fixture server's /rows page at 48,000 CSS px tall. With
 * the 1280x800 test viewport at DPR 1 that is 60 viewport heights and,
 * per the real planner, 2 balanced parts of 24,000 device px each
 * (PART_MAX_SIDE is 32767 device px and the 100 MP area cap does not
 * bind at this width). Parts are stored as Blob records (round 4);
 * the record reader below converts each Blob back to bytes inside the
 * page, so the row-by-row verification is exactly as strict as the
 * dataUrl version was. Every 100px row carries a unique colour, so
 * each stored part is verified row by row, in order.
 *
 * Assertions (the run FAILS if any fails):
 *  T2  fixture really spans more than one planned part (setup sanity)
 *  A   CAPTURE_FULL answers ok (no 'capture-failed')
 *  B   more than one part is captured: stored parts == planned parts
 *  C   parts are in order (partIndex 1..N), each with partTotal == N
 *      and dimensions exactly matching the plan
 *  D   captured content matches the fixture: every row of every part
 *      carries its unique colour, in order, none missing/duplicated
 *  E   no result/editor/overview tab (pages/capture.html,
 *      pages/annotate.html or pages/parts.html) was opened WHILE the
 *      capture was still in flight
 *  E2  exactly ONE tab appears at the end: the Parts overview
 *      (pages/parts.html#<groupId of the stored records>); no editor
 *      or preview tab is opened for a multi-part capture at all
 *  F   page state restored: scroll position back to the pre-capture
 *      value and no capture candidate marks left behind
 *  G   zero console.error / pageerror in any context
 *  H   the source tree's manifest.json is unchanged by the run
 *
 * Run under a virtual display, like the other suites:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/tileloop-e2e.mjs [--proj=<tree>]
 * --proj=<tree>  tree to copy the extension from (default: this repo).
 * --out=<file>   optionally write the raw results JSON there (default:
 *                no file is written, keeping the repo tree clean).
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
const PAGE_H = 48000; // CSS px: 60 viewport heights at the 800px test viewport
const ORIG_SCROLL_Y = 1200;
const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;

const results = { proj: SRC, phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `, ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const ihdrDims = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

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

// ---- Build the temporary extension copy (the ONLY manifest ever edited) ----
const srcManifest = path.join(SRC, 'manifest.json');
const manifestHashBefore = sha256(srcManifest);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-tileloop-'));
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-tileloop-profile-'));
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

// Control channel: the extension's own popup page (kind='extension'),
// the same sender the other suites use for worker messages.
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
await sleep(500);

// ---- Fixture page: 60 viewport heights of unique-colour rows ----
const pg = await ctx.newPage();
watchErrors(pg, 'rows-fixture');
await pg.goto(`${BASE}/rows?h=${PAGE_H}`);
await pg.bringToFront();
await sleep(600);
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
console.log(`page metrics: ${JSON.stringify(metrics)} plan: parts=${plan.parts.length} tiles=${plan.totalTiles} partDims=${plan.parts.map((p) => `${p.w}x${p.h}`).join(',')}`);
phase('T2 fixture spans more than one planned part', plan.parts.length > 1 && metrics.sh === PAGE_H, {
  metrics, plannedParts: plan.parts.length, totalTiles: plan.totalTiles,
  partDims: plan.parts.map((p) => `${p.w}x${p.h}`),
  note: `plannedParts=${plan.parts.length} totalTiles=${plan.totalTiles} pageH=${metrics.sh}`,
});

// Pre-capture page state that must be restored afterwards.
await pg.evaluate((y) => window.scrollTo(0, y), ORIG_SCROLL_Y);
await sleep(300);
const scrollBefore = await pg.evaluate(() => Math.round(window.scrollY || 0));

// Watch for result/editor tabs from BEFORE the capture starts.
// Two witnesses run side by side. The Node-side page poller below is
// the primary witness for phase E2: it records every distinct result
// page with its first seen time and cannot silently lose a tab that
// stayed open. The chrome.tabs events recorded INSIDE the service
// worker (globalThis.__tlTabEvents) are kept as extra evidence only
// for E2: the instrumentation can be lost, leaving the list empty,
// so an empty or missing service worker list never passes or fails
// E2 by itself. The service worker list still feeds the phase E
// timing check, where its browser side timestamps are the precise
// witness for whether a tab opened while the capture was in flight.
await sw.evaluate((id) => {
  globalThis.__tlTabEvents = [];
  const isR = (u) => typeof u === 'string'
    && (u.startsWith(`chrome-extension://${id}/pages/capture.html`)
      || u.startsWith(`chrome-extension://${id}/pages/annotate.html`)
      || u.startsWith(`chrome-extension://${id}/pages/parts.html`));
  chrome.tabs.onCreated.addListener((t) => {
    const u = t.url || t.pendingUrl || '';
    if (isR(u)) globalThis.__tlTabEvents.push({ kind: 'created', at: Date.now(), id: t.id, url: u });
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    const u = (tab && tab.url) || info.url || '';
    if (isR(u)) globalThis.__tlTabEvents.push({ kind: 'updated', at: Date.now(), id: tabId, url: u });
  });
}, extId);
// Primary witness for phase E2: Node-side polling of the context's
// pages. Every distinct result page is recorded once, as a {url, at}
// entry holding the page URL and its first seen epoch ms, so two
// tabs that share one URL still count as two tabs.
const isResultUrl = (u) => u.startsWith(`chrome-extension://${extId}/pages/capture.html`)
  || u.startsWith(`chrome-extension://${extId}/pages/annotate.html`)
  || u.startsWith(`chrome-extension://${extId}/pages/parts.html`);
const resultTabsSeen = []; // one {url, at} entry per distinct result page
const resultTabPages = new Set();
let polling = true;
const poller = (async () => {
  while (polling) {
    for (const p of ctx.pages()) {
      const u = p.url();
      if (isResultUrl(u) && !resultTabPages.has(p)) {
        resultTabPages.add(p);
        resultTabsSeen.push({ url: u, at: Date.now() });
      }
    }
    await sleep(200);
  }
})();

// ---- Trigger the REAL full-page capture through the worker message path ----
// The sendMessage promise is parked on the control page so the test can
// keep polling tabs while the capture runs (a blocking evaluate would
// also hit Playwright timeouts on a 60-tile capture).
await ctrl.evaluate(() => {
  window.__tileloop = { done: false };
  chrome.runtime.sendMessage({ type: 'CAPTURE_FULL' })
    .then((r) => { window.__tileloop = { done: true, at: Date.now(), resp: r }; })
    .catch((e) => { window.__tileloop = { done: true, at: Date.now(), threw: String((e && e.message) || e) }; });
});
const t0 = Date.now();
let tile = null;
while (Date.now() - t0 < CAPTURE_TIMEOUT_MS) {
  tile = await ctrl.evaluate(() => window.__tileloop).catch(() => null);
  if (tile && tile.done) break;
  await sleep(500);
}
const settleObservedAt = Date.now();
await sleep(1200); // let any end-of-capture result tabs appear before classifying
polling = false;
await poller.catch(() => {});
const captureMs = settleObservedAt - t0;
console.log(`capture settled after ~${captureMs}ms: ${JSON.stringify(tile).slice(0, 300)}`);

const resp = tile && tile.resp;
const settleAt = tile && tile.at ? tile.at : settleObservedAt;
// Result tabs by first browser-side event time per tab id (SW witness),
// with the Node-observed pages as corroboration.
const swTabEvents = await sw.evaluate(() => globalThis.__tlTabEvents || []).catch(() => []);

// ---- Stored capture records (the worker's own IndexedDB) ----
const records = await ctrl.evaluate(() => new Promise((resolve) => {
  try {
    const req = indexedDB.open('imgfetch', 1);
    req.onsuccess = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains('captures')) { resolve([]); return; }
        const rq = db.transaction('captures', 'readonly').objectStore('captures').getAll();
        rq.onsuccess = async () => {
          // Round 4 records carry a Blob, not a dataUrl. Convert the
          // blob to a base64 dataUrl-shaped string HERE, in the page,
          // so every downstream check (IHDR dims, row sequence) runs
          // on the exact stored bytes, unchanged in strictness.
          const out = [];
          for (const r of rq.result || []) {
            const plain = { ...r };
            delete plain.blob;
            if (r.blob) {
              const buf = new Uint8Array(await r.blob.arrayBuffer());
              let bin = '';
              const CH = 0x8000;
              for (let i = 0; i < buf.length; i += CH) {
                bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
              }
              plain.dataUrl = `data:image/png;base64,${btoa(bin)}`;
              plain.blobBytes = r.blob.size;
            }
            out.push(plain);
          }
          resolve(out);
        };
        rq.onerror = () => resolve([]);
      } catch { resolve([]); }
    };
    req.onerror = () => resolve([]);
  } catch { resolve([]); }
}));
const sorted = [...records].sort((a, b) => (a.partIndex || 0) - (b.partIndex || 0));
console.log(`stored capture records: ${sorted.length} partIndexes=${sorted.map((r) => r.partIndex).join(',')}`);

// A: the worker answered ok
phase('A CAPTURE_FULL answers ok', !!(resp && resp.ok === true), {
  resp: JSON.stringify(resp || (tile && tile.threw) || null).slice(0, 300),
  captureMs,
  note: `resp=${JSON.stringify(resp || null).slice(0, 160)}`,
});

// B: more than one part, and all planned parts
phase('B all planned parts captured (>1)', sorted.length === plan.parts.length && sorted.length > 1, {
  capturedParts: sorted.length, plannedParts: plan.parts.length,
  partIndexes: sorted.map((r) => r.partIndex || 0),
  note: `captured ${sorted.length} of ${plan.parts.length} planned parts`,
});

// C: order, numbering, dimensions
{
  let ok = sorted.length === plan.parts.length;
  const notes = [];
  sorted.forEach((r, i) => {
    const p = plan.parts[i];
    const dims = r.dataUrl ? ihdrDims(Buffer.from(r.dataUrl.split(',')[1], 'base64')) : { w: 0, h: 0 };
    const good = p && r.partIndex === i + 1 && r.partTotal === plan.parts.length
      && r.width === p.w && r.height === p.h && dims.w === p.w && dims.h === p.h;
    if (!good) ok = false;
    notes.push(`part${r.partIndex}: rec=${r.width}x${r.height} ihdr=${dims.w}x${dims.h} plan=${p ? `${p.w}x${p.h}` : '?'} total=${r.partTotal}`);
  });
  phase('C parts in order, partTotal and dimensions match the plan', ok, {
    parts: notes, count: `${sorted.length}/${plan.parts.length}`,
    note: `count ${sorted.length}/${plan.parts.length}; ${notes.join(' | ')}`,
  });
}

// D: content matches the fixture, row by row, across every part
{
  let badTotal = 0; let checkedTotal = 0;
  const notes = [];
  sorted.forEach((r, i) => {
    const p = plan.parts[i];
    if (!p || !r.dataUrl) { notes.push(`part${r.partIndex}: missing`); return; }
    const buf = Buffer.from(r.dataUrl.split(',')[1], 'base64');
    if (!pngMagic(buf)) { notes.push(`part${r.partIndex}: not a PNG`); badTotal += 1; return; }
    const s = seqCheckPart(buf, p, metrics.dpr);
    badTotal += s.bad; checkedTotal += s.checked;
    notes.push(`part${p.index}: rows checked=${s.checked} bad=${s.bad} [${s.rows[0]}..${s.rows[1]}]`);
  });
  const expectedRows = PAGE_H / 100;
  phase('D captured content matches fixture rows in every part', badTotal === 0 && checkedTotal === expectedRows, {
    badTotal, checkedTotal, expectedRows, parts: notes,
    note: `rows checked=${checkedTotal}/${expectedRows} bad=${badTotal}; ${notes.join(' | ')}`,
  });
}

// "During the capture" is judged against the LAST part's own store
// timestamp (the `at` the worker stamped on the record when the
// offscreen document stored it), read back from the finished records:
// the worker opens result tabs only after every part is stored and
// the group is finalized, so a legitimate end tab is at or after
// that stamp (50 ms of clock/messaging slack allowed). A tab opened
// after an EARLY part (the original bug) precedes the last part's
// stamp by the whole remainder of the capture and still fails.
// Polling IndexedDB from the service worker during the capture was
// tried as a live witness and is deliberately NOT used: concurrent
// store reads from the worker measurably disturb the offscreen
// document's Blob writes at part boundaries in this environment.
const storeWatermark = records.reduce((m, r) => Math.max(m, r.at || 0), 0);
console.log(`store watermark (last part's record stamp): ${storeWatermark ? `${storeWatermark - t0}ms after start` : 'no records'}`);
const firstEventByTab = new Map();
for (const e of swTabEvents) {
  if (!firstEventByTab.has(e.id) || e.at < firstEventByTab.get(e.id).at) firstEventByTab.set(e.id, e);
}
const swTabs = [...firstEventByTab.values()].sort((a, b) => a.at - b.at);
// During = before the last part was stored (watermark minus the 50 ms
// poll+messaging slack documented at the witness). With no watermark,
// any result tab counts as during (the capture never completed).
const duringTabs = swTabs.filter((e) => !storeWatermark || e.at < storeWatermark - 50)
  .map((e) => ({ via: 'sw-tabs-event', url: e.url, tabId: e.id, atMsAfterStart: e.at - t0, msBeforeWatermark: storeWatermark - e.at }));
const endTabs = swTabs.filter((e) => storeWatermark && e.at >= storeWatermark - 50)
  .map((e) => ({ via: 'sw-tabs-event', url: e.url, tabId: e.id, atMsAfterStart: e.at - t0 }));
const nodeSeenTabs = resultTabsSeen
  .map((e) => ({ url: e.url, at: e.at, firstSeenMsAfterStart: e.at - t0, beforeSettleStamp: e.at < settleAt }));
console.log(`result tabs (SW events): ${JSON.stringify(swTabs)} settleAtMsAfterStart=${settleAt - t0}`);

// E: no result/editor/overview tab during the capture
phase('E no result/editor/overview tab opened during capture', duringTabs.length === 0, {
  duringTabs, endTabs, nodeSeenTabs, settleMsAfterStart: settleAt - t0,
  note: `result tabs during capture=${duringTabs.length} (${JSON.stringify(duringTabs).slice(0, 240)}), at/after end=${endTabs.length}`,
});

// E2: exactly one tab at the end, the Parts overview for this group,
// and no editor/preview tab at all. The Node-side poller decides this
// phase: it must have seen exactly one pages/parts.html tab, that
// tab's URL hash must equal the capture group id, its first seen time
// must be at or after the last part record's store stamp (with the
// same 50 ms slack phase E allows the service worker list), and no
// pages/capture.html or pages/annotate.html tab may appear at any
// point in the run. If the poller saw nothing at all the phase fails:
// missing evidence is never a pass. The service worker tab list is
// included below as extra evidence only and never decides the phase.
{
  const gid = sorted.length && sorted[0].groupId ? sorted[0].groupId : '';
  const sameGroup = sorted.length > 0 && sorted.every((r) => r.groupId === gid);
  const pollerOverviewTabs = resultTabsSeen.filter((e) => e.url.includes('/pages/parts.html'));
  const pollerEditorTabs = resultTabsSeen.filter((e) => e.url.includes('/pages/capture.html') || e.url.includes('/pages/annotate.html'));
  const pollerOverviewForGroup = pollerOverviewTabs.filter((e) => !!gid && e.url.endsWith(`#${gid}`));
  const overviewAfterWatermark = pollerOverviewForGroup.length === 1 && storeWatermark > 0
    && pollerOverviewForGroup[0].at >= storeWatermark - 50;
  const pollerSawData = resultTabsSeen.length > 0;
  const okE2 = pollerSawData && pollerOverviewTabs.length === 1 && pollerOverviewForGroup.length === 1
    && overviewAfterWatermark && pollerEditorTabs.length === 0 && sameGroup;
  phase('E2 one Parts overview tab at the end, no editor tabs', okE2, {
    overviewTabs: pollerOverviewTabs, editorTabs: pollerEditorTabs, nodeSeenTabs: resultTabsSeen,
    swTabEvents, swTabs, endTabs, groupId: gid, sameGroup, storeWatermark, pollerSawData,
    note: `poller overview=${pollerOverviewTabs.length} forGroup=${pollerOverviewForGroup.length} afterWatermark=${overviewAfterWatermark} editorTabs=${pollerEditorTabs.length} sameGroup=${sameGroup} pollerEntries=${resultTabsSeen.length} swEvents=${swTabEvents.length} (service worker list is extra evidence only)`,
  });
}

// F: page state restored
{
  const after = await pg.evaluate(() => ({
    y: Math.round(window.scrollY || 0),
    marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
  })).catch(() => ({ y: -1, marks: -1 }));
  phase('F page state restored after capture', after.y === scrollBefore && after.marks === 0, {
    scrollBefore, after,
    note: `scroll ${after.y} (was ${scrollBefore}), candidate marks left=${after.marks}`,
  });
}

// G: zero console.error / pageerror
{
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('G zero console.error/pageerror', errOnly.length === 0, {
    errors: errOnly.slice(0, 5), totalWatchEntries: errorWatch.length,
    note: `${errOnly.length} errors, ${errorWatch.length} total watch entries`,
  });
}

// H: source manifest untouched
{
  const afterHash = sha256(srcManifest);
  phase('H source manifest unchanged', afterHash === manifestHashBefore, {
    manifestHashBefore, afterHash,
    note: `sha256 ${afterHash.slice(0, 16)}... before=${manifestHashBefore.slice(0, 16)}...`,
  });
}

results.capture = { resp: resp || null, captureMs, capturedParts: sorted.length, plannedParts: plan.parts.length, duringTabs, endTabs };
results.errorWatch = errorWatch;
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
await ctx.close().catch(() => {});
fixture.close();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp copy is disposable */ }
process.exit(results.errors.length ? 1 : 0);
