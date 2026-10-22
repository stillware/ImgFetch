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
 * ImgFetch e2e, tests/test-e2e/stop-e2e.mjs
 * Round 4: stopping a multi-part full-page capture early, two ways:
 *  S1  CANCEL_CAPTURE while part 1 is still being captured
 *  S2  the user switching to another tab mid-capture
 * In both cases the worker must stop cleanly and DELIVER what was
 * really captured: the parts finished so far plus the in-progress
 * part cropped to the tile rows actually captured (verified row by
 * row against the fixture), the page restored, exactly one Parts
 * overview tab at the end, and zero console errors.
 *
 * Run:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/stop-e2e.mjs [--proj=<tree>]
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const SRC = path.resolve(String(args.proj || path.resolve(HERE, '..', '..')));
const HEADED = args.headed !== undefined ? !!args.headed : true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const results = { proj: SRC, phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `, ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}

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


async function readRecords(ctrl) {
  return ctrl.evaluate(() => new Promise((resolve) => {
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
}

async function runScenario(label, stopAction) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-stop-'));
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-stop-profile-'));
  const errs = [];
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const extId = new URL(sw.url()).host;
    const watch = (t, name) => {
      t.on('console', (msg) => { if (msg.type() === 'error') errs.push(`${name}: ${msg.text().slice(0, 160)}`); });
      t.on('pageerror', (e) => errs.push(`${name}: ${String((e && e.message) || e).slice(0, 160)}`));
    };
    ctx.on('page', (p) => watch(p, 'page'));
    watch(sw, 'sw');
    const ctrl = await ctx.newPage();
    await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
    await sleep(500);
    const pg = await ctx.newPage();
    await pg.goto(`${fixtureBase}/rows?h=48000`);
    await pg.bringToFront();
    await sleep(500);
    await pg.evaluate(() => window.scrollTo(0, 1200));
    await sleep(250);
    await ctrl.evaluate(() => {
      window.__stop = { done: false };
      chrome.runtime.sendMessage({ type: 'CAPTURE_FULL' })
        .then((r) => { window.__stop = { done: true, resp: r }; })
        .catch((e) => { window.__stop = { done: true, threw: String((e && e.message) || e) }; });
    });
    // Let several tiles land, then stop the capture the scenario's way.
    await sleep(6000);
    await stopAction({ ctx, ctrl, pg });
    let cap = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      cap = await ctrl.evaluate(() => window.__stop).catch(() => null);
      if (cap && cap.done) break;
      await sleep(400);
    }
    await sleep(1200);
    const resp = cap && cap.resp;
    const records = await readRecords(ctrl);
    const sorted = [...records].sort((a, b) => (a.partIndex || 0) - (b.partIndex || 0));
    // Verify saved content: records tile [0, coveredH) with exact rows.
    let covered = 0;
    let bad = 0;
    let checked = 0;
    for (const r of sorted) {
      if (!r.dataUrl || !pngMagic(Buffer.from(r.dataUrl.split(',')[1], 'base64'))) { bad += 1; continue; }
      const buf = Buffer.from(r.dataUrl.split(',')[1], 'base64');
      const s = seqCheckPart(buf, { y0: covered, h: r.height }, 1);
      bad += s.bad; checked += s.checked;
      if (s.bad) {
        const img = decodePng(buf);
        const badRows = [];
        for (let ri = 0; ri < r.height / 100; ri += 1) {
          const y = Math.round(ri * 100 + 50);
          const o = (y * img.w + Math.floor(img.w / 4)) * 4;
          const [er, eg, eb] = rowColor(covered / 100 + ri);
          if (img.data[o] !== er || img.data[o + 1] !== eg || img.data[o + 2] !== eb) badRows.push(covered / 100 + ri);
        }
        console.log(`  bad rows in part ${r.partIndex}: ${badRows.join(',')}`);
      }
      covered += r.height;
    }
    const groupOk = sorted.length > 0 && sorted.every((r, i) => r.partIndex === i + 1 && r.partTotal === sorted.length && r.groupId === sorted[0].groupId);
    const restored = await pg.evaluate(() => ({
      y: Math.round(window.scrollY || 0),
      marks: document.querySelectorAll('[data-imgfetch-scroll-candidate]').length,
    })).catch(() => ({ y: -1, marks: -1 }));
    const pages = ctx.pages().map((p) => p.url());
    const overview = pages.filter((u) => u.includes('/pages/parts.html'));
    const gid = sorted.length ? sorted[0].groupId : '';
    const okResp = !!(resp && resp.ok === true && resp.stopped === true);
    phase(`${label} stop delivers the really-captured rows and restores the page`,
      okResp && groupOk && bad === 0 && checked > 0 && covered > 0 && covered < 48000
        && restored.y === 1200 && restored.marks === 0
        && overview.length === 1 && overview[0].endsWith(`#${gid}`) && errs.length === 0, {
        resp: JSON.stringify(resp || (cap && cap.threw) || null).slice(0, 220),
        parts: sorted.map((r) => `${r.width}x${r.height}`).join(','),
        covered, checked, bad, restored, overview, errs: errs.slice(0, 3),
        note: `stopped=${resp ? String(resp.stopped) : '?'} covered=${covered}px rows=${checked} bad=${bad} parts=${sorted.length}`,
      });
  } finally {
    await ctx.close().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* disposable */ }
  }
}

const manifestHashBefore = sha256(path.join(SRC, 'manifest.json'));
const { server: fixture, port: fport } = await startFixtureServer(0);
const fixtureBase = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${fixtureBase}`);

await runScenario('S1 cancel', async ({ ctrl }) => {
  await ctrl.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL_CAPTURE' }).catch(() => null));
});
await runScenario('S2 tab switch', async ({ ctx }) => {
  const other = await ctx.newPage();
  await other.goto(`${fixtureBase}/rows?h=2000`);
  await other.bringToFront();
});

const manifestHashAfter = sha256(path.join(SRC, 'manifest.json'));
phase('G source manifest unchanged', manifestHashAfter === manifestHashBefore, { note: `sha256 ${manifestHashAfter.slice(0, 16)}...` });
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
fixture.close();
process.exit(results.errors.length ? 1 : 0);
