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
 * ImgFetch e2e, tests/test-e2e/perf-e2e.mjs
 * Phase B perf suite. Times the Area/Element capture pipeline from
 * "selection finished" to "editor canvas drawn": screenshot, crop, store,
 * result-tab open, page load and canvas draw, with a per-step breakdown.
 * Runs at DPR 1 and 2, on a realistic 1920x1080 page and on a large page
 * (2560x1440 viewport, tall DOM), >=10 measured runs per config, plus
 * Visible and FullPage-tail runs to prove no regression there.
 *
 * Fidelity notes (honest automation limits, same as capture-e2e.mjs):
 * - chrome.tabs.captureVisibleTab has no permission grant in this automated
 *   browser, so the screenshot step is a CDP Page.captureScreenshot, the
 *   same mechanism captureVisibleTab uses internally.
 * - The overlay drag/click itself is user time and is not measured; t0 is
 *   the first post-selection step, exactly where the worker starts.
 * - Every other step is the REAL production code of the tree under test:
 *   the real crop (in-worker cropPngDataUrl on the new tree, the real
 *   offscreen CROP_IMAGE call with quality 0.92 on the old tree), the real
 *   IndexedDB store (same extension origin, same prune logic), the real
 *   tab open (with the production reuse behaviour) and the real result
 *   page loading the real record.
 * - The step ORDER mirrors each tree: the new tree opens the result tab
 *   before cropping (early-open, overlapping page load); the old tree
 *   opens it after storing.
 * - The result tab is fresh per run (production reuses one tab via
 *   update+reload, which cannot be observed race-free from outside); the
 *   create cost is identical for both trees, so the comparison stays fair.
 *
 * Run:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     node tests/test-e2e/perf-e2e.mjs --dpr=1 [--proj=/path/to/tree]
 *   --proj measures a different tree (e.g. the unmodified baseline) with
 *   the same harness; --out overrides the results JSON path.
 * Writes tests/test-e2e/results-perf-<browser>-dpr<N>.json by default.
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
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const DPR = Number(args.dpr || '1');
const HEADED = args.headed !== undefined ? !!args.headed : true;
const BROWSER = (args.browser || 'chromium').toLowerCase();
const EDGE_PATH = '/usr/bin/microsoft-edge-stable';
const PROJ = path.resolve(String(args.proj || DEFAULT_PROJ));
const HOME_DIR = os.homedir();
const PROJ_LABEL = PROJ.startsWith(HOME_DIR + path.sep) ? '~' + PROJ.slice(HOME_DIR.length) : PROJ;
const RUNS = Number(args.runs || '10');
const WARMUP = Number(args.warmup || '2');
const HAS_WORKER_CROP = fs.existsSync(path.join(PROJ, 'core', 'crop-image.js'));
const CROP_PATH = HAS_WORKER_CROP ? 'worker' : 'offscreen';
const EARLY_OPEN = HAS_WORKER_CROP; // new tree opens the tab before crop+store
const OUT = args.out || path.join(HERE, `results-perf-${BROWSER}-dpr${DPR}.json`);

const results = {
  tool: 'perf-e2e', dpr: DPR, headed: HEADED, browser: BROWSER,
  proj: PROJ_LABEL, cropPath: CROP_PATH, earlyOpen: EARLY_OPEN,
  startedAt: new Date().toISOString(), configs: {}, errors: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}   dpr=${DPR} proj=${PROJ} cropPath=${CROP_PATH}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-perf-e2e-'));
let ctx;
try {
  const launchOpts = {
    headless: !HEADED,
    args: [
      `--disable-extensions-except=${PROJ}`,
      `--load-extension=${PROJ}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (BROWSER === 'edge') launchOpts.executablePath = EDGE_PATH;
  ctx = await chromium.launchPersistentContext(userDataDir, launchOpts);
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
const ctrl = await ctx.newPage();
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
const sendOff = (msg) => sw.evaluate((m) => chrome.runtime.sendMessage(m), { target: 'offscreen', ...msg });

for (const target of [sw, ctrl]) {
  target.on('pageerror', (err) => results.errors.push({ kind: 'pageerror', text: String((err && err.message) || err).slice(0, 300) }));
}

// Old tree: the production crop lives in the offscreen document; make sure
// it is up and warm (warm, so the cold start does not pollute the medians;
// this favours the old tree and keeps the comparison conservative).
if (!HAS_WORKER_CROP) {
  await sw.evaluate(() => chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html', reasons: ['BLOBS', 'CLIPBOARD'], justification: 'perf e2e',
  }).catch(() => {}));
  await sleep(1500);
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await sendOff({
    type: 'CROP_IMAGE', dataUrl: tiny, rect: { x: 0, y: 0, width: 1, height: 1 }, format: 'png', quality: 0.92,
  }).catch(() => {});
}

/** Viewport screenshot via CDP (what captureVisibleTab uses internally). */
async function armShot(page, vw, vh) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vw, height: vh, deviceScaleFactor: DPR, mobile: false,
  });
  const shot = async (fullCssH = 0) => {
    const params = { format: 'png' };
    if (fullCssH > 0) {
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: vw, height: fullCssH, scale: 1 };
    }
    const { data } = await cdp.send('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  };
  return shot;
}

const makeId = () => `cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Real crop of the tree under test: the exact core/crop-image.js module
 * the worker imports, driven from the control page (Playwright cannot
 * dynamic import() inside the worker scope; the pixel pipeline is
 * identical). Old tree: the real offscreen CROP_IMAGE production call. */
async function cropReal(dataUrl, rect) {
  if (HAS_WORKER_CROP) {
    return ctrl.evaluate(async ({ du, rc }) => {
      const m = await import(chrome.runtime.getURL('core/crop-image.js'));
      return m.cropPngDataUrl(du, rc);
    }, { du: dataUrl, rc: rect });
  }
  const r = await sendOff({ type: 'CROP_IMAGE', dataUrl, rect, format: 'png', quality: 0.92 });
  if (!r || !r.ok || !r.dataUrl) throw new Error(`CROP_IMAGE failed: ${JSON.stringify(r)}`);
  return r;
}

/**
 * Mirror of the worker's rememberCapture store+prune, using the REAL
 * background/idb.js module in the control page (same extension origin,
 * same database). The prune logic matches each tree: keys-only on the
 * new tree, idb.all on the old tree.
 */
async function storeMirror(id, record) {
  await ctrl.evaluate(async ({ id: rid, rec, workerCrop }) => {
    const { idb } = await import(chrome.runtime.getURL('background/idb.js'));
    await idb.put('captures', { id: rid, ...rec });
    const cutoff = Date.now() - 3600e3;
    if (workerCrop) {
      const keys = await idb.keys('captures');
      const stale = [];
      for (const k of keys) {
        const m = /^cap-(\d+)-\d+$/.exec(String(k));
        if (m && Number(m[1]) < cutoff) stale.push({ key: k, at: Number(m[1]) });
      }
      stale.sort((a, b) => a.at - b.at);
      await Promise.all(stale.slice(0, Math.max(0, keys.length - 5)).map((d) => idb.del('captures', d.key)));
    } else {
      const all = await idb.all('captures');
      const stale = all.filter((c) => c.at < cutoff).slice(0, Math.max(0, all.length - 5));
      await Promise.all(stale.map((c) => idb.del('captures', c.id)));
    }
    try { await chrome.storage.session.remove('imgfetch-caps'); } catch { /* ignore */ }
  }, { id, rec: record, workerCrop: HAS_WORKER_CROP });
}

/**
 * Open the result tab, fresh per run. Production reuses one tab
 * (update+reload); a fresh tab is used here because the reuse staleness
 * cannot be observed race-free from outside, and the create cost is the
 * same for both trees, so the comparison stays fair.
 */
async function openResultMirror(id) {
  await closeResultTab();
  const url = `chrome-extension://${extId}/pages/annotate.html#${id}`;
  await ctrl.evaluate(async (turl) => chrome.tabs.create({ url: turl }), url);
}

async function closeResultTab() {
  await ctrl.evaluate(async (eid) => {
    try {
      const tabs = await chrome.tabs.query({ url: `chrome-extension://${eid}/pages/annotate.html*` });
      await Promise.all(tabs.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
    } catch { /* ignore */ }
  }, extId).catch(() => {});
}

async function findResultPage(id) {
  for (let i = 0; i < 100; i += 1) {
    const pg = ctx.pages().find((p) => p.url().endsWith(`#${id}`));
    if (pg) return pg;
    await sleep(100);
  }
  throw new Error('result tab not found');
}

/**
 * Wait until the result page shows the freshly loaded capture: first the
 * loading state must be visible (guards against seeing the previous run's
 * reused tab), then the drawn canvas.
 */
async function waitDrawn(pg, label) {
  pg.on('pageerror', (err) => results.errors.push({ kind: 'result-pageerror', text: String((err && err.message) || err).slice(0, 200) }));
  try {
    await pg.waitForFunction(() => {
      const l = document.getElementById('loading');
      const c = document.getElementById('content');
      const e = document.getElementById('editor');
      return l && l.hidden && c && !c.hidden && e && e.width > 0;
    }, null, { timeout: 20000 });
  } catch (e) {
    const state = await pg.evaluate(() => ({
      url: location.href.slice(-40),
      loadingText: (document.getElementById('loading') || { textContent: '' }).textContent.slice(0, 120),
      loadingHidden: !!(document.getElementById('loading') || {}).hidden,
      contentHidden: !!(document.getElementById('content') || {}).hidden,
    })).catch((ee) => ({ evalErr: String(ee).slice(0, 100) }));
    throw new Error(`waitDrawn(${label}): drawn timeout, state=${JSON.stringify(state)}`);
  }
}

/** One measured Area/Element run. Step order mirrors each tree: the new
 * tree opens the result tab before crop+store (early-open), the old tree
 * after storing. Breakdown: shot, openCall (the tabs API call), crop,
 * store, drawWait (page load + record read + canvas draw), total. */
async function measureCapture(pg, shot, rect, cfgLabel) {
  const id = makeId();
  const t0 = Date.now();
  const shotBuf = await shot();
  const tShot = Date.now();
  const dataUrl = `data:image/png;base64,${shotBuf.toString('base64')}`;
  let tOpenDone = tShot;
  if (EARLY_OPEN) {
    await openResultMirror(id);
    tOpenDone = Date.now();
  }
  const cropped = await cropReal(dataUrl, rect);
  const tCrop = Date.now();
  await storeMirror(id, { dataUrl: cropped.dataUrl, width: cropped.width, height: cropped.height, at: Date.now() });
  const tStore = Date.now();
  if (!EARLY_OPEN) {
    await openResultMirror(id);
    tOpenDone = Date.now();
  }
  const rpg = await findResultPage(id);
  await waitDrawn(rpg, cfgLabel);
  const tDraw = Date.now();
  const openCallMs = EARLY_OPEN ? tOpenDone - tShot : tOpenDone - tStore;
  return {
    shotMs: tShot - t0,
    cropMs: EARLY_OPEN ? tCrop - tOpenDone : tCrop - tShot,
    storeMs: tStore - tCrop,
    openMs: openCallMs,
    drawMs: tDraw - (EARLY_OPEN ? tStore : tOpenDone),
    totalMs: tDraw - t0,
  };
}

/** One measured Visible run: shot, store, open, drawn (no crop). */
async function measureVisible(pg, shot, cfgLabel) {
  const id = makeId();
  const t0 = Date.now();
  const shotBuf = await shot();
  const tShot = Date.now();
  const dataUrl = `data:image/png;base64,${shotBuf.toString('base64')}`;
  await storeMirror(id, { dataUrl, width: 0, height: 0, at: Date.now() });
  const tStore = Date.now();
  await openResultMirror(id);
  const tOpenDone = Date.now();
  const rpg = await findResultPage(id);
  await waitDrawn(rpg, cfgLabel);
  const tDraw = Date.now();
  return {
    shotMs: tShot - t0, cropMs: 0, storeMs: tStore - tShot,
    openMs: tOpenDone - tStore, drawMs: tDraw - tOpenDone, totalMs: tDraw - t0,
  };
}

/** FullPage-tail run: store a large stitched-size capture, open, drawn. */
async function measureFullTail(pg, shot, cfgLabel) {
  const id = makeId();
  const t0 = Date.now();
  const big = await shot(6000); // 6000 CSS px tall, like one stitched part
  const tShot = Date.now();
  const dataUrl = `data:image/png;base64,${big.toString('base64')}`;
  await storeMirror(id, { dataUrl, width: 1920 * DPR, height: 6000 * DPR, at: Date.now() });
  const tStore = Date.now();
  await openResultMirror(id);
  const tOpenDone = Date.now();
  const rpg = await findResultPage(id);
  await waitDrawn(rpg, cfgLabel);
  const tDraw = Date.now();
  return {
    shotMs: tShot - t0, cropMs: 0, storeMs: tStore - tShot,
    openMs: tOpenDone - tStore, drawMs: tDraw - tOpenDone, totalMs: tDraw - t0,
  };
}

function stats(name, runs) {
  const totals = runs.map((r) => r.totalMs).sort((a, b) => a - b);
  const stepMed = {};
  for (const k of ['shotMs', 'cropMs', 'storeMs', 'openMs', 'drawMs']) {
    const s = runs.map((r) => r[k]).sort((a, b) => a - b);
    stepMed[k] = s[Math.floor(s.length / 2)];
  }
  results.configs[name] = {
    runs: runs.length,
    medianMs: totals[Math.floor(totals.length / 2)],
    worstMs: totals[totals.length - 1],
    bestMs: totals[0],
    stepMedians: stepMed,
    samples: runs,
  };
  const c = results.configs[name];
  console.log(`${name}: median=${c.medianMs}ms worst=${c.worstMs}ms (n=${c.runs}) `
    + `[shot ${stepMed.shotMs} crop ${stepMed.cropMs} store ${stepMed.storeMs} open ${stepMed.openMs} draw ${stepMed.drawMs}]`);
}

// Configs: realistic 1920x1080 page, and a large page (2560x1440 viewport,
// tall heavy DOM). Area uses a fixed rect like the old benchmark; Element
// uses a real element's box, like selectElement reports.
const PAGES = [
  { name: 'realistic', vw: 1920, vh: 1080, url: `${BASE}/realistic` },
  { name: 'large', vw: 2560, vh: 1440, url: `${BASE}/realistic?h=6000` },
];

for (const pageCfg of PAGES) {
  for (const mode of ['area', 'element']) {
    const cfgName = `${mode}-${pageCfg.name}-dpr${DPR}`;
    const pg = await ctx.newPage();
    const shot = await armShot(pg, pageCfg.vw, pageCfg.vh);
    await pg.goto(pageCfg.url);
    await pg.bringToFront();
    await sleep(800);
    let rect;
    if (mode === 'area') {
      const rw = pageCfg.name === 'large' ? pageCfg.vw : 1200;
      const rh = pageCfg.name === 'large' ? pageCfg.vh : 800;
      const dims = await pg.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      rect = {
        x: Math.round(120 * DPR), y: Math.round(80 * DPR),
        width: Math.min(Math.round(rw * DPR), Math.round(dims.w * DPR) - Math.round(120 * DPR)),
        height: Math.min(Math.round(rh * DPR), Math.round(dims.h * DPR) - Math.round(80 * DPR)),
      };
    } else {
      await pg.evaluate(() => document.querySelector('.card.dark').scrollIntoView({ block: 'center' }));
      await sleep(300);
      rect = await pg.evaluate(() => {
        const r = document.querySelector('.card.dark').getBoundingClientRect();
        const d = window.devicePixelRatio || 1;
        const vw2 = window.innerWidth * d; const vh2 = window.innerHeight * d;
        const x = Math.max(0, Math.round(r.x * d)); const y = Math.max(0, Math.round(r.y * d));
        return {
          x, y,
          width: Math.min(Math.round(r.width * d), vw2 - x),
          height: Math.min(Math.round(r.height * d), vh2 - y),
        };
      });
    }
    console.log(`${cfgName}: rect=${JSON.stringify(rect)}`);
    const samples = [];
    for (let i = 0; i < WARMUP + RUNS; i += 1) {
      try {
        const m = await measureCapture(pg, shot, rect, cfgName);
        if (i >= WARMUP) samples.push(m);
        else console.log(`${cfgName}: warmup ${i + 1} total=${m.totalMs}ms`);
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 300);
        results.errors.push({ kind: 'run-failed', cfg: cfgName, text: msg });
        console.log(`${cfgName}: run ${i + 1} FAILED: ${msg}`);
      }
    }
    if (samples.length < RUNS) throw new Error(`${cfgName}: only ${samples.length}/${RUNS} runs completed`);
    stats(cfgName, samples);
    await closeResultTab();
    await pg.close().catch(() => {});
  }
}

// Visible + FullPage-tail on the realistic page (regression guard).
{
  const pg = await ctx.newPage();
  const shot = await armShot(pg, 1920, 1080);
  await pg.goto(`${BASE}/realistic`);
  await pg.bringToFront();
  await sleep(800);
  for (const [cfgName, fn] of [['visible-realistic', measureVisible], ['fullpage-tail-realistic', measureFullTail]]) {
    const name = `${cfgName}-dpr${DPR}`;
    if (cfgName.startsWith('fullpage')) {
      await pg.goto(`${BASE}/realistic?h=6000`);
      await pg.bringToFront();
      await sleep(800);
    }
    const samples = [];
    for (let i = 0; i < 2 + (cfgName.startsWith('visible') ? 5 : 3); i += 1) {
      try {
        const m = await fn(pg, shot, name);
        if (i >= 2) samples.push(m);
      } catch (e) {
        results.errors.push({ kind: 'run-failed', cfg: name, text: String((e && e.message) || e).slice(0, 200) });
      }
    }
    stats(name, samples);
    await closeResultTab();
  }
  await pg.close().catch(() => {});
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
console.log(`results: ${OUT}`);
await closeResultTab().catch(() => {});
await ctrl.close().catch(() => {});
await ctx.close().catch(() => {});
fixture.close();
if (results.errors.length) {
  console.log(`errors: ${results.errors.length}`);
  process.exitCode = 1;
}
