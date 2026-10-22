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
 * ImgFetch e2e, tests/test-e2e/growing-e2e.mjs
 * Round 4: full-page capture of a GROWING page. The fixture
 * (/growing?start=6000&step=6000&max=36000) appends unique-colour rows
 * whenever the reader scrolls near the bottom, like an infinite-scroll
 * feed, and stops growing at 36,000 CSS px. The real worker capture
 * (driven exactly like tileloop-e2e, through a temporary extension
 * copy whose manifest gains <all_urls>) must:
 *  A  answer ok
 *  B  cover the FINAL height exactly: stored Blob parts tile the
 *     36,000px page with no gaps, every part within the stitch
 *     limits, every row's unique colour in order (nothing skipped,
 *     duplicated or seamed at a growth boundary)
 *  C  stop when growth stops: the fixture reached its max and the
 *     page height is unchanged after the capture settles
 *  D  open no tab during the capture and exactly one Parts overview
 *     tab at the end
 *  E  restore the page (scroll position, no candidate marks)
 *  F  produce zero console.error / pageerror in any context
 *  G  leave the source tree's manifest.json byte-identical
 *
 * Run:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/growing-e2e.mjs [--proj=<tree>]
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
import { planFullPageCapture, isStitchSizeAccepted } from '../../core/fullpage-capture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const SRC = path.resolve(String(args.proj || path.resolve(HERE, '..', '..')));
const HEADED = args.headed !== undefined ? !!args.headed : true;
const START_H = 6000;
const MAX_H = 36000;
const ORIG_SCROLL_Y = 1200;
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;

const results = { proj: SRC, phases: [], errors: [] };
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


// ---- temporary extension copy (the ONLY manifest ever edited) ----
const srcManifest = path.join(SRC, 'manifest.json');
const manifestHashBefore = sha256(srcManifest);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-growing-'));
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
const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}`);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-growing-profile-'));
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
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}
ctx.on('page', (p) => watchErrors(p, `page:${p.url().slice(0, 80)}`));
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
watchErrors(sw, 'service-worker');
phase('T1 extension (temp copy) loads, service worker alive', !!sw, { extId, note: `extId=${extId}` });
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
await sleep(500);
const pg = await ctx.newPage();
watchErrors(pg, 'growing-fixture');
await pg.goto(`${BASE}/growing?start=${START_H}&step=6000&max=${MAX_H}`);
await pg.bringToFront();
await sleep(600);
const h0 = await pg.evaluate(() => document.documentElement.scrollHeight);
phase('T2 fixture starts at the start height', h0 === START_H, { h0, note: `initial height=${h0}` });
await pg.evaluate((y) => window.scrollTo(0, y), ORIG_SCROLL_Y);
await sleep(300);
const scrollBefore = await pg.evaluate(() => Math.round(window.scrollY || 0));
await sw.evaluate((id) => {
  globalThis.__grTabEvents = [];
  const isR = (u) => typeof u === 'string'
    && (u.startsWith(`chrome-extension://${id}/pages/capture.html`)
      || u.startsWith(`chrome-extension://${id}/pages/annotate.html`)
      || u.startsWith(`chrome-extension://${id}/pages/parts.html`));
  chrome.tabs.onCreated.addListener((t) => {
    const u = t.url || t.pendingUrl || '';
    if (isR(u)) globalThis.__grTabEvents.push({ kind: 'created', at: Date.now(), id: t.id, url: u });
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    const u = (tab && tab.url) || info.url || '';
    if (isR(u)) globalThis.__grTabEvents.push({ kind: 'updated', at: Date.now(), id: tabId, url: u });
  });
}, extId);
// Primary witness for phase D: Node-side polling of the context's
// pages, the same pattern tileloop-e2e uses. Every distinct result
// page is recorded once, as a {url, at} entry holding the page URL
// and its first seen epoch ms, so two tabs that share one URL still
// count as two tabs. The service worker tab list above
// (globalThis.__grTabEvents) is extra evidence only for phase D: the
// instrumentation can be lost, leaving the list empty, so an empty
// or missing service worker list never passes or fails D by itself.
const isResultUrl = (u) => typeof u === 'string'
  && (u.includes('/pages/parts.html') || u.includes('/pages/capture.html') || u.includes('/pages/annotate.html'));
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
await ctrl.evaluate(() => {
  window.__growing = { done: false };
  chrome.runtime.sendMessage({ type: 'CAPTURE_FULL' })
    .then((r) => { window.__growing = { done: true, at: Date.now(), resp: r }; })
    .catch((e) => { window.__growing = { done: true, at: Date.now(), threw: String((e && e.message) || e) }; });
});
const t0 = Date.now();
let cap = null;
while (Date.now() - t0 < CAPTURE_TIMEOUT_MS) {
  cap = await ctrl.evaluate(() => window.__growing).catch(() => null);
  if (cap && cap.done) break;
  await sleep(500);
}
const settleAt = cap && cap.at ? cap.at : Date.now();
await sleep(1500);
const captureMs = settleAt - t0;
const resp = cap && cap.resp;
console.log(`capture settled after ~${captureMs}ms: ${JSON.stringify(resp || (cap && cap.threw) || null).slice(0, 200)}`);
phase('A CAPTURE_FULL answers ok', !!(resp && resp.ok === true), {
  resp: JSON.stringify(resp || (cap && cap.threw) || null).slice(0, 300), captureMs,
  note: `resp=${JSON.stringify(resp || null).slice(0, 160)}`,
});
const records = await ctrl.evaluate(() => new Promise((resolve) => {
  try {
    const req = indexedDB.open('imgfetch', 1);
    req.onsuccess = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains('captures')) { resolve([]); return; }
        const rq = db.transaction('captures', 'readonly').objectStore('captures').getAll();
        rq.onsuccess = async () => {
          const out = [];
          for (const r of rq.result || []) {
            const plain = { ...r };
            delete plain.blob;
            if (r.blob) {
              const buf = new Uint8Array(await r.blob.arrayBuffer());
              let bin = '';
              const CH = 0x8000;
              for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
              plain.dataUrl = `data:image/png;base64,${btoa(bin)}`;
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
console.log(`stored parts: ${sorted.length} dims=${sorted.map((r) => `${r.width}x${r.height}`).join(',')}`);
{
  // Rebuild the expected part layout from the records themselves:
  // parts must tile [0, MAX_H) contiguously in partIndex order.
  let y = 0;
  let contiguous = sorted.length > 0;
  const fakeParts = [];
  for (const r of sorted) {
    fakeParts.push({ y0: y, h: r.height });
    y += r.height;
  }
  if (y !== MAX_H) contiguous = false;
  let badTotal = 0; let checkedTotal = 0;
  const notes = [];
  sorted.forEach((r, i) => {
    const p = fakeParts[i];
    if (!r.dataUrl) { notes.push(`part${r.partIndex}: missing bytes`); badTotal += 1; return; }
    const buf = Buffer.from(r.dataUrl.split(',')[1], 'base64');
    if (!pngMagic(buf)) { notes.push(`part${r.partIndex}: not a PNG`); badTotal += 1; return; }
    const s = seqCheckPart(buf, p, 1);
    badTotal += s.bad; checkedTotal += s.checked;
    notes.push(`part${r.partIndex}: rows=${s.checked} bad=${s.bad}`);
  });
  const limitsOk = sorted.every((r) => isStitchSizeAccepted(r.width, r.height));
  const numberingOk = sorted.every((r, i) => r.partIndex === i + 1 && r.partTotal === sorted.length);
  phase('B capture covers the final grown height, rows exact, limits respected',
    contiguous && badTotal === 0 && checkedTotal === MAX_H / 100 && limitsOk && numberingOk, {
      coveredH: y, badTotal, checkedTotal, limitsOk, numberingOk, parts: notes,
      note: `covered=${y}/${MAX_H} rows=${checkedTotal}/${MAX_H / 100} bad=${badTotal} limitsOk=${limitsOk}`,
    });
}
{
  const g1 = await pg.evaluate(() => ({
    h: document.documentElement.scrollHeight,
    state: window.__growState || null,
  }));
  await sleep(1500);
  const g2 = await pg.evaluate(() => document.documentElement.scrollHeight);
  const stopped = g1.h === MAX_H && g2 === MAX_H && g1.state && g1.state.currentH === MAX_H;
  phase('C growth reached the fixture max and the height settled', !!stopped, {
    g1, g2, captureMs,
    note: `final height=${g1.h} after settle=${g2} growState=${JSON.stringify(g1.state)}`,
  });
}
polling = false;
await poller.catch(() => {});
{
  const evs = await sw.evaluate(() => globalThis.__grTabEvents || []).catch(() => []);
  // Watermark = the last part's own store timestamp, read back from
  // the finished records (see tileloop-e2e for why a live IndexedDB
  // poll from the service worker is not used as the witness).
  const wm = sorted.reduce((m, r) => Math.max(m, r.at || 0), 0);
  const firstByTab = new Map();
  for (const e of evs) if (!firstByTab.has(e.id) || e.at < firstByTab.get(e.id).at) firstByTab.set(e.id, e);
  const tabs = [...firstByTab.values()].sort((a, b) => a.at - b.at);
  // Service worker timing split, kept as extra evidence only: during
  // is before the final store watermark (50 ms slack); with no
  // watermark, any result tab counts as during.
  const during = tabs.filter((e) => !wm || e.at < wm - 50);
  const end = tabs.filter((e) => wm && e.at >= wm - 50);
  const gid = sorted.length && sorted[0].groupId ? sorted[0].groupId : '';
  // The Node-side poller decides this phase: it must have seen
  // exactly one pages/parts.html tab, that tab's URL hash must equal
  // the capture group id, its first seen time must be at or after the
  // watermark (with the same 50 ms slack), and no pages/capture.html
  // or pages/annotate.html tab may appear at any point in the run.
  // If the poller saw nothing at all the phase fails: missing
  // evidence is never a pass.
  const pollerOverviewTabs = resultTabsSeen.filter((e) => e.url.includes('/pages/parts.html'));
  const pollerEditorTabs = resultTabsSeen.filter((e) => e.url.includes('/pages/capture.html') || e.url.includes('/pages/annotate.html'));
  const pollerOverviewForGroup = pollerOverviewTabs.filter((e) => !!gid && e.url.endsWith(`#${gid}`));
  const overviewAfterWatermark = pollerOverviewForGroup.length === 1 && wm > 0
    && pollerOverviewForGroup[0].at >= wm - 50;
  const pollerSawData = resultTabsSeen.length > 0;
  const overviewOk = pollerSawData && pollerOverviewTabs.length === 1 && pollerOverviewForGroup.length === 1
    && overviewAfterWatermark && pollerEditorTabs.length === 0;
  phase('D no tab during capture, one Parts overview tab at the end', overviewOk, {
    during, end, swTabEvents: evs, pollerOverviewTabs, pollerEditorTabs,
    nodeSeenTabs: resultTabsSeen, groupId: gid, storeWatermark: wm, pollerSawData,
    note: `poller overview=${pollerOverviewTabs.length} forGroup=${pollerOverviewForGroup.length} afterWatermark=${overviewAfterWatermark} editorTabs=${pollerEditorTabs.length} pollerEntries=${resultTabsSeen.length} swDuring=${during.length} swEnd=${end.length} (service worker list is extra evidence only)`,
  });
}
{
  const after = await pg.evaluate(() => ({
    y: Math.round(window.scrollY || 0),
    marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
    styleLocks: document.querySelectorAll('[data-imgfetch-capture-style]').length,
  })).catch(() => ({ y: -1, marks: -1, styleLocks: -1 }));
  phase('E page state restored after capture', after.y === scrollBefore && after.marks === 0 && after.styleLocks === 0, {
    scrollBefore, after,
    note: `scroll ${after.y} (was ${scrollBefore}), marks=${after.marks}, styleLocks=${after.styleLocks}`,
  });
}
{
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('F zero console.error/pageerror', errOnly.length === 0, {
    errors: errOnly.slice(0, 5), totalWatchEntries: errorWatch.length,
    note: `${errOnly.length} errors`,
  });
}
{
  const afterHash = sha256(srcManifest);
  phase('G source manifest unchanged', afterHash === manifestHashBefore, {
    note: `sha256 ${afterHash.slice(0, 16)}...`,
  });
}
results.capture = { resp: resp || null, captureMs, capturedParts: sorted.length };
results.errorWatch = errorWatch;
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
await ctx.close().catch(() => {});
fixture.close();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* disposable */ }
process.exit(results.errors.length ? 1 : 0);
