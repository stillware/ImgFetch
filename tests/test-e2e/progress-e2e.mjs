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
 * ImgFetch e2e, tests/test-e2e/progress-e2e.mjs
 * Round 5 regression test for the STACKED PROGRESS TOASTS bug:
 *
 *   During a full-page capture the worker broadcast one NOTICE_TEXT
 *   per tile and the popup turned each into a toast; toasts stack 3
 *   high for 2600 ms while tiles arrive every ~520 ms, covering the
 *   Visible / Area / Element / Full page buttons and truncating the
 *   text. The fix: tile progress is a CAPTURE_PROGRESS broadcast,
 *   rendered by the popup as ONE live status row under the shot
 *   buttons (text updated in place, a determinate progress bar, a
 *   Stop button), the shot buttons lock while a capture runs, and a
 *   reopened popup asks GET_CAPTURE_PROGRESS and shows the current
 *   progress at once. NOTICE_TEXT stays for one-off notices, and
 *   UI.toast now replaces a repeated identical text instead of
 *   stacking it.
 *
 * Method: same temporary-copy technique as tileloop-e2e.mjs (the
 * copy's manifest gains "<all_urls>" so captureVisibleTab works
 * without a gesture; the source manifest is hashed before/after).
 * The REAL popup page (popup/popup.html in a tab) is the surface
 * under test; the capture is triggered from that page with the same
 * chrome.runtime.sendMessage the popup's own Full page button sends,
 * so every broadcast lands in the real popup listener. A sampler
 * installed in the popup page records the DOM every ~120 ms for the
 * whole capture (toast count, progress element identity and text,
 * bar values, button disabled states), which is stricter than
 * spot-checking from Node.
 *
 * Assertions (the run FAILS if any fails):
 *  P1  during a 20-tile capture: .toast count never exceeds 1, the
 *      progress row is visible, its text element is ONE element whose
 *      text changes in place, the bar's aria-valuenow rises
 *      monotonically to aria-valuemax, the progress area never
 *      overlaps the four shot buttons, the buttons are disabled
 *      during the capture and enabled after, and the row hides at
 *      the end. (On the round 4 tree: toasts stack to 3 and no
 *      progress row exists, so this phase fails.)
 *  P2  Stop: clicking the popup's Stop button mid-capture shows the
 *      Stopping state, ends the capture early, keeps the finished
 *      parts (records in IndexedDB, Parts overview tab opens) and
 *      re-enables the buttons.
 *  P3  Reopen: reloading the popup page mid-capture shows the
 *      current progress immediately (via GET_CAPTURE_PROGRESS) with
 *      the buttons disabled. The reopen is a reload of the existing
 *      background popup page, NOT a new tab: a new tab would become
 *      the window's active tab, and the worker stops a capture whose
 *      tab loses activation BY DESIGN (round 4 tab-switch stop), so
 *      a new tab cannot simulate a real popup reopen. A real popup
 *      opening never changes the active tab; a background reload is
 *      the faithful equivalent (fresh document, init() runs again).
 *  P4  Arabic (RTL): the popup is dir=rtl, the progress text is
 *      Arabic, toasts still never exceed 1.
 *  G   zero console.error / pageerror in any context
 *  H   the source tree's manifest.json is unchanged by the run
 *
 * Screenshots of the popup mid-capture (English from P1, Arabic
 * from P4) are written ONLY when --shots=<dir> is given; the dir
 * must be outside the repo (evidence for the report, never shipped).
 *
 * Run under a virtual display, like the other suites:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/progress-e2e.mjs [--proj=<tree>] [--shots=<dir>]
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
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const SRC = path.resolve(String(args.proj || path.resolve(HERE, '..', '..')));
const HEADED = args.headed !== undefined ? !!args.headed : true;
const SHOTS = args.shots ? String(args.shots) : null;
const CAPTURE_TIMEOUT_MS = 4 * 60 * 1000;

const results = { proj: SRC, phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `, ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- Build the temporary extension copy (the ONLY manifest ever edited) ----
const srcManifest = path.join(SRC, 'manifest.json');
const manifestHashBefore = sha256(srcManifest);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-progress-'));
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
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-progress-profile-'));
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

async function setTestLanguage(lang) {
  await sw.evaluate(async (l) => {
    const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
    const next = { ...cur, language: l };
    await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
  }, lang);
  await sleep(900);
}

/** Open the REAL popup page in a tab (the surface under test). */
async function openPopup() {
  const p = await ctx.newPage();
  watchErrors(p, 'popup-under-test');
  await p.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(700);
  return p;
}

/** Open a fixture tab and make it the window's active tab. */
async function openFixture(url) {
  const p = await ctx.newPage();
  watchErrors(p, 'fixture');
  await p.goto(url);
  await p.bringToFront();
  await sleep(500);
  return p;
}

/** Park a CAPTURE_FULL call on the given extension page; poll .__prog. */
async function startCapture(page) {
  await page.evaluate(() => {
    window.__prog = { done: false };
    chrome.runtime.sendMessage({ type: 'CAPTURE_FULL' })
      .then((r) => { window.__prog = { done: true, at: Date.now(), resp: r }; })
      .catch((e) => { window.__prog = { done: true, at: Date.now(), threw: String((e && e.message) || e) }; });
  });
}

async function waitCapture(page, timeoutMs = CAPTURE_TIMEOUT_MS) {
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < timeoutMs) {
    st = await page.evaluate(() => window.__prog).catch(() => null);
    if (st && st.done) return { st, ms: Date.now() - t0 };
    await sleep(400);
  }
  return { st, ms: Date.now() - t0 };
}

/** Install the ~120 ms DOM sampler in the popup page. */
async function installSampler(page) {
  await page.evaluate(() => {
    window.__psamples = [];
    window.__progTextEl = null;
    window.__pidentityOk = true;
    const BTNS = ['btnShotVisible', 'btnShotArea', 'btnShotElement', 'btnShotFull'];
    const sample = () => {
      const cont = document.getElementById('captureProgress');
      const text = document.getElementById('captureProgressText');
      if (text) {
        if (!window.__progTextEl) window.__progTextEl = text;
        else if (window.__progTextEl !== text) window.__pidentityOk = false;
      }
      const bar = document.getElementById('captureProgressBarWrap');
      window.__psamples.push({
        at: Date.now(),
        toasts: document.querySelectorAll('.toast').length,
        progVisible: !!cont && !cont.hidden,
        text: text ? text.textContent : null,
        now: bar ? bar.getAttribute('aria-valuenow') : null,
        max: bar ? bar.getAttribute('aria-valuemax') : null,
        btns: BTNS.map((id) => {
          const b = document.getElementById(id);
          return b ? b.disabled : null;
        }),
      });
    };
    window.__psampler = setInterval(sample, 120);
    sample();
  });
}

async function stopSampler(page) {
  return page.evaluate(() => {
    clearInterval(window.__psampler);
    return { samples: window.__psamples, identityOk: window.__pidentityOk };
  }).catch(() => ({ samples: [], identityOk: false }));
}

/** Read stored capture records (count only) from the worker's IndexedDB. */
async function recordCount(page) {
  return page.evaluate(() => new Promise((resolve) => {
    try {
      const req = indexedDB.open('imgfetch', 1);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('captures')) { resolve(0); return; }
          const rq = db.transaction('captures', 'readonly').objectStore('captures').count();
          rq.onsuccess = () => resolve(rq.result || 0);
          rq.onerror = () => resolve(-1);
        } catch { resolve(-1); }
      };
      req.onerror = () => resolve(-1);
    } catch { resolve(-1); }
  })).catch(() => -1);
}

/* ------------------------------------------------------------------ */
/* P1: observe a 20-tile capture in the English popup                  */
/* ------------------------------------------------------------------ */
{
  const popup = await openPopup();
  const pg = await openFixture(`${BASE}/rows?h=16000`);
  await pg.bringToFront();
  await installSampler(popup);
  await startCapture(popup);
  // Screenshot + overlap evidence once the capture is under way.
  let shotTaken = false;
  let overlap = null;
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < CAPTURE_TIMEOUT_MS) {
    st = await popup.evaluate(() => window.__prog).catch(() => null);
    if (!shotTaken) {
      const mid = await popup.evaluate(() => {
        const bar = document.getElementById('captureProgressBarWrap');
        const cont = document.getElementById('captureProgress');
        if (!bar || !cont || cont.hidden) return null;
        const now = Number(bar.getAttribute('aria-valuenow') || 0);
        if (now < 2) return null;
        const cr = cont.getBoundingClientRect();
        const btns = ['btnShotVisible', 'btnShotArea', 'btnShotElement', 'btnShotFull']
          .map((id) => document.getElementById(id).getBoundingClientRect());
        const hit = btns.some((r) => !(r.bottom <= cr.top || cr.bottom <= r.top || r.right <= cr.left || cr.right <= r.left));
        return { now, overlap: hit };
      }).catch(() => null);
      if (mid) {
        overlap = mid.overlap;
        if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-progress-en.png') }).catch(() => {});
        shotTaken = true;
      }
    }
    if (st && st.done) break;
    await sleep(300);
  }
  const { samples, identityOk } = await stopSampler(popup);
  const resp = st && st.resp;
  const during = samples.filter((s) => s.progVisible);
  const maxToasts = samples.reduce((m, s) => Math.max(m, s.toasts), 0);
  const nows = during.map((s) => Number(s.now)).filter((v) => Number.isFinite(v));
  const monotonic = nows.every((v, i) => i === 0 || v >= nows[i - 1]);
  const reachedEnd = nows.length > 0 && during[during.length - 1]
    && Number(during[during.length - 1].now) === Number(during[during.length - 1].max)
    && Number(during[during.length - 1].max) > 1;
  const distinctTexts = new Set(during.map((s) => s.text).filter(Boolean)).size;
  const btnsDisabledDuring = during.length > 0 && during.every((s) => s.btns.every((d) => d === true));
  const finalState = await popup.evaluate(() => ({
    hidden: document.getElementById('captureProgress').hidden,
    btns: ['btnShotVisible', 'btnShotArea', 'btnShotElement', 'btnShotFull']
      .map((id) => document.getElementById(id).disabled),
  })).catch(() => ({ hidden: false, btns: [] }));
  const ok = !!(resp && resp.ok === true)
    && maxToasts <= 1
    && during.length >= 5
    && identityOk
    && distinctTexts >= 3
    && monotonic && reachedEnd
    && overlap === false
    && btnsDisabledDuring
    && finalState.hidden === true
    && finalState.btns.every((d) => d === false);
  phase('P1 progress is one live row, never stacked toasts, buttons lock and unlock', ok, {
    respOk: !!(resp && resp.ok), maxToasts, progressSamples: during.length,
    identityOk, distinctTexts, monotonic, reachedEnd, overlap,
    btnsDisabledDuring, finalHidden: finalState.hidden, finalBtns: finalState.btns,
    note: `maxToasts=${maxToasts} progressSamples=${during.length} distinctTexts=${distinctTexts} monotonic=${monotonic} reachedEnd=${reachedEnd} overlap=${overlap} locked=${btnsDisabledDuring} endHidden=${finalState.hidden}`,
  });
  await pg.close().catch(() => {});
  // Leave the popup tab open for P2; close stray result tabs by simply
  // ignoring them (each phase brings its own fixture to front).
  globalThis.__popupP1 = popup;
}

/* ------------------------------------------------------------------ */
/* P2: Stop mid-capture keeps finished parts and unlocks               */
/* ------------------------------------------------------------------ */
{
  const popup = globalThis.__popupP1;
  const pg = await openFixture(`${BASE}/rows?h=48000`);
  await pg.bringToFront();
  const before = await recordCount(popup);
  await startCapture(popup);
  // Wait until the progress row shows at least tile 3.
  let sawTile = 0;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && sawTile < 3) {
      sawTile = await popup.evaluate(() => {
        const cont = document.getElementById('captureProgress');
        const bar = document.getElementById('captureProgressBarWrap');
        if (!cont || cont.hidden || !bar) return 0;
        return Number(bar.getAttribute('aria-valuenow') || 0);
      }).catch(() => 0);
      if (sawTile >= 3) break;
      await sleep(200);
    }
  }
  const stopClickAt = Date.now();
  await popup.evaluate(() => document.getElementById('btnCaptureStop')?.click());
  // The Stopping state must appear (button disabled or label changed).
  let stoppingSeen = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !stoppingSeen) {
      stoppingSeen = await popup.evaluate(() => {
        const b = document.getElementById('btnCaptureStop');
        return !!b && (b.disabled || /Stopping/.test(b.textContent || ''));
      }).catch(() => false);
      if (stoppingSeen) break;
      await sleep(100);
    }
  }
  const { st, ms } = await waitCapture(popup, 90000);
  const settleMs = Date.now() - stopClickAt;
  const after = await recordCount(popup);
  let partsTab = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !partsTab) {
      partsTab = ctx.pages().some((p) => p.url().includes('/pages/parts.html'));
      if (partsTab) break;
      await sleep(200);
    }
  }
  const finalState = await popup.evaluate(() => ({
    hidden: document.getElementById('captureProgress').hidden,
    btns: ['btnShotVisible', 'btnShotArea', 'btnShotElement', 'btnShotFull']
      .map((id) => document.getElementById(id).disabled),
  })).catch(() => ({ hidden: false, btns: [] }));
  const ok = sawTile >= 3 && stoppingSeen && !!(st && st.done)
    && settleMs < 30000 && ms < 90000
    && after > before && partsTab
    && finalState.hidden === true && finalState.btns.every((d) => d === false);
  phase('P2 Stop ends capture early, keeps parts, unlocks buttons', ok, {
    sawTile, stoppingSeen, settleMs, recordsBefore: before, recordsAfter: after,
    partsTab, finalHidden: finalState.hidden, finalBtns: finalState.btns,
    resp: JSON.stringify((st && st.resp) || (st && st.threw) || null).slice(0, 160),
    note: `sawTile=${sawTile} stopping=${stoppingSeen} settleAfterStop=${settleMs}ms records ${before}->${after} partsTab=${partsTab} unlocked=${finalState.btns.every((d) => d === false)}`,
  });
  await pg.close().catch(() => {});
  await popup.close().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* P3: reopening the popup mid-capture shows progress at once          */
/* ------------------------------------------------------------------ */
{
  const ctrl = await openPopup(); // throwaway sender page (not under test)
  const popup = await openPopup(); // the reopen candidate, stays in background
  const pg = await openFixture(`${BASE}/rows?h=24000`);
  await pg.bringToFront();
  await startCapture(ctrl);
  await sleep(2500); // several tiles in
  // The reopen: a fresh popup document (init runs again), without
  // activating the popup's tab (see the header note).
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  let shown = null;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !shown) {
      shown = await popup.evaluate(() => {
        const cont = document.getElementById('captureProgress');
        const bar = document.getElementById('captureProgressBarWrap');
        if (!cont || cont.hidden || !bar) return null;
        const now = Number(bar.getAttribute('aria-valuenow') || 0);
        const btns = ['btnShotVisible', 'btnShotArea', 'btnShotElement', 'btnShotFull']
          .map((id) => document.getElementById(id).disabled);
        return now >= 1 ? { now, btns } : null;
      }).catch(() => null);
      if (shown) break;
      await sleep(150);
    }
  }
  let p3debug = null;
  if (!shown) {
    p3debug = await popup.evaluate(async () => {
      const cont = document.getElementById('captureProgress');
      const bar = document.getElementById('captureProgressBarWrap');
      let resp = null;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_PROGRESS' });
      } catch (e) {
        resp = { threw: String((e && e.message) || e) };
      }
      return {
        contHidden: cont ? cont.hidden : 'no-element',
        now: bar ? bar.getAttribute('aria-valuenow') : null,
        workerAnswer: resp,
      };
    }).catch((e) => ({ evalThrew: String((e && e.message) || e) }));
  }
  const ok = !!shown && shown.btns.every((d) => d === true);
  phase('P3 reopened popup shows live progress immediately', ok, {
    shown, p3debug,
    note: shown ? `progress at tile=${shown.now} buttonsLocked=${shown.btns.every((d) => d === true)}` : 'no progress shown within 4s of reopening',
  });
  // Cleanup: stop the capture from the reopened popup and let it settle.
  await popup.evaluate(() => {
    const b = document.getElementById('btnCaptureStop');
    if (b) b.click();
  }).catch(() => {});
  await waitCapture(ctrl, 90000);
  await pg.close().catch(() => {});
  await popup.close().catch(() => {});
  await ctrl.close().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* P4: Arabic (RTL) popup during a capture                             */
/* ------------------------------------------------------------------ */
{
  await setTestLanguage('ar');
  const popup = await openPopup();
  const pg = await openFixture(`${BASE}/rows?h=9600`);
  await pg.bringToFront();
  await installSampler(popup);
  await startCapture(popup);
  let shotTaken = false;
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < CAPTURE_TIMEOUT_MS) {
    st = await popup.evaluate(() => window.__prog).catch(() => null);
    if (!shotTaken) {
      const now = await popup.evaluate(() => {
        const cont = document.getElementById('captureProgress');
        const bar = document.getElementById('captureProgressBarWrap');
        if (!cont || cont.hidden || !bar) return 0;
        return Number(bar.getAttribute('aria-valuenow') || 0);
      }).catch(() => 0);
      if (now >= 2) {
        if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-progress-ar.png') }).catch(() => {});
        shotTaken = true;
        // Stop early: the Arabic assertions need only a few tiles.
        await popup.evaluate(() => document.getElementById('btnCaptureStop')?.click()).catch(() => {});
      }
    }
    if (st && st.done) break;
    await sleep(300);
  }
  const { samples } = await stopSampler(popup);
  const during = samples.filter((s) => s.progVisible);
  const maxToasts = samples.reduce((m, s) => Math.max(m, s.toasts), 0);
  const dir = await popup.evaluate(() => document.documentElement.getAttribute('dir')).catch(() => null);
  const arabicText = during.some((s) => s.text && /[\u0600-\u06FF]/.test(s.text));
  const ok = dir === 'rtl' && during.length >= 2 && arabicText && maxToasts <= 1 && !!(st && st.done);
  phase('P4 Arabic RTL popup: progress Arabic, no stacked toasts', ok, {
    dir, progressSamples: during.length, arabicText, maxToasts,
    sampleText: during.length ? during[during.length - 1].text : null,
    note: `dir=${dir} progressSamples=${during.length} arabicText=${arabicText} maxToasts=${maxToasts}`,
  });
  await pg.close().catch(() => {});
  await popup.close().catch(() => {});
  await setTestLanguage('en').catch(() => {});
}

// G: zero console.error / pageerror
{
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('G zero console.error/pageerror', errOnly.length === 0, {
    errors: errOnly.slice(0, 5), totalWatchEntries: errorWatch.length,
    note: `${errOnly.length} errors`,
  });
}

// H: source manifest untouched
{
  const afterHash = sha256(srcManifest);
  phase('H source manifest unchanged', afterHash === manifestHashBefore, {
    note: `sha256 ${afterHash.slice(0, 16)}...`,
  });
}

results.errorWatch = errorWatch;
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
await ctx.close().catch(() => {});
fixture.close();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp copy is disposable */ }
process.exit(results.errors.length ? 1 : 0);
