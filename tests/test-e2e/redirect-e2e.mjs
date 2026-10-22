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
 * ImgFetch e2e: tests/test-e2e/redirect-e2e.mjs
 * Real-browser suite (Playwright + Chromium) for Phase C4 / F1: the
 * offscreen document re-checks the FINAL url of every fetch against
 * the private-network rule, so a public-looking URL that redirects to
 * a private address is refused even though the original URL passed.
 *
 * The fixture server (127.0.0.1) plays the role of the "public" host:
 * with pageUrl on the same host, the initial URL passes through the
 * same-host intranet exception, exactly like a public URL passes the
 * pre-flight check. Its /img/redirect-private.png endpoint answers 302
 * to the same image on "localhost" (a different private host name,
 * resolving to the same server): fetch follows silently, and only the
 * final-URL re-check can refuse it. /img/redirect-same.png is the
 * control: a redirect that stays on the same host must still work.
 *
 * Phases:
 *  R1  control: a direct image converts through the offscreen document
 *  R2  control: a same-host redirect still converts
 *  R3  CONVERT_IMAGE refuses a redirect to a private host
 *  R4  SANITIZE_SVG refuses a redirect to a private host
 *  R5  SNIFF_TYPE refuses a redirect to a private host
 *  R6  BUILD_ZIP refuses a redirect to a private host
 *  R0  zero console.error / pageerror in any context
 *
 * Run under a virtual display, like the other suites:
 *   PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright \
 *     xvfb-run -a node tests/test-e2e/redirect-e2e.mjs
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
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');

const results = { phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? `: ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const { server, port } = await startFixtureServer(0);
const ORIGIN = `http://127.0.0.1:${port}`;
const PAGE_URL = `${ORIGIN}/gallery`;
console.log(`fixture server: ${ORIGIN}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-redirect-e2e-'));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
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

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');
ctx.on('page', (p) => watchErrors(p, `page:${p.url().slice(0, 60)}`));

await sw.evaluate(() => chrome.offscreen.createDocument({
  url: 'offscreen/offscreen.html',
  reasons: ['BLOBS', 'CLIPBOARD'],
  justification: 'ImgFetch redirect re-check e2e',
})).catch(() => { /* already created by the worker */ });

const sendOff = (msg) => sw.evaluate(
  (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
  { target: 'offscreen', ...msg },
);

// Bounded readiness wait for the offscreen document, replacing the
// old fixed sleep: probe with the harmless SUPPORTS_AVIF message
// until the reply no longer carries the connection error, retrying
// every 200 ms for up to about 10 s. If the document never answers,
// offscreenReady stays false and phase R1 fails with a clear note.
let offscreenReady = false;
let lastProbe = null;
{
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    lastProbe = await sendOff({ type: 'SUPPORTS_AVIF' })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    const probeError = lastProbe && lastProbe.error ? String(lastProbe.error) : '';
    if (lastProbe && !probeError.includes('Could not establish connection')) {
      offscreenReady = true;
      break;
    }
    await sleep(200);
  }
}

// R1: control, direct image converts.
try {
  if (!offscreenReady) {
    throw new Error(`offscreen document never answered the SUPPORTS_AVIF readiness probe within 10 s (last reply: ${JSON.stringify(lastProbe).slice(0, 140)})`);
  }
  const res = await sendOff({
    type: 'CONVERT_IMAGE', srcUrl: `${ORIGIN}/img/64/64/ff0000.png`, pageUrl: PAGE_URL, format: 'png', quality: 1,
  });
  phase('R1 control: direct image converts', !!(res && res.ok && res.width === 64 && res.height === 64),
    { note: JSON.stringify(res).slice(0, 140) });
} catch (e) { phase('R1 control: direct image converts', false, { note: e.message.slice(0, 200) }); }

// R2: control, same-host redirect still converts.
try {
  const res = await sendOff({
    type: 'CONVERT_IMAGE', srcUrl: `${ORIGIN}/img/redirect-same.png`, pageUrl: PAGE_URL, format: 'png', quality: 1,
  });
  phase('R2 control: same-host redirect still converts', !!(res && res.ok && res.width === 64 && res.height === 64),
    { note: JSON.stringify(res).slice(0, 140) });
} catch (e) { phase('R2 control: same-host redirect', false, { note: e.message.slice(0, 200) }); }

// R3: CONVERT_IMAGE refuses the private redirect with the guard's error.
try {
  const res = await sendOff({
    type: 'CONVERT_IMAGE', srcUrl: `${ORIGIN}/img/redirect-private.png`, pageUrl: PAGE_URL, format: 'png', quality: 1,
  });
  phase('R3 CONVERT_IMAGE refuses a redirect to a private host',
    !!(res && res.ok === false && res.error === 'blocked-redirect'),
    { note: JSON.stringify(res).slice(0, 140) });
} catch (e) { phase('R3 CONVERT_IMAGE redirect refusal', false, { note: e.message.slice(0, 200) }); }

// R4: SANITIZE_SVG refuses the private redirect the same way.
try {
  const res = await sendOff({
    type: 'SANITIZE_SVG', srcUrl: `${ORIGIN}/svg/redirect-private.svg`, pageUrl: PAGE_URL,
  });
  phase('R4 SANITIZE_SVG refuses a redirect to a private host',
    !!(res && res.ok === false && res.error === 'blocked-redirect'),
    { note: JSON.stringify(res).slice(0, 140) });
} catch (e) { phase('R4 SANITIZE_SVG redirect refusal', false, { note: e.message.slice(0, 200) }); }

// R5: SNIFF_TYPE refuses the private redirect (its own failure error).
try {
  const res = await sendOff({
    type: 'SNIFF_TYPE', srcUrl: `${ORIGIN}/img/redirect-private.png`, pageUrl: PAGE_URL,
  });
  phase('R5 SNIFF_TYPE refuses a redirect to a private host',
    !!(res && res.ok === false && res.error === 'sniff-failed'),
    { note: JSON.stringify(res).slice(0, 140) });
} catch (e) { phase('R5 SNIFF_TYPE redirect refusal', false, { note: e.message.slice(0, 200) }); }

// R6: BUILD_ZIP produces no archive from the private redirect.
try {
  const res = await sendOff({
    type: 'BUILD_ZIP', files: [{ url: `${ORIGIN}/img/redirect-private.png`, name: 'x.png' }], pageUrl: PAGE_URL, zipToken: 'redirect-e2e',
  });
  phase('R6 BUILD_ZIP refuses a redirect to a private host',
    !!(res && res.ok === false && !res.url),
    { note: JSON.stringify(res).slice(0, 140) });
  await sendOff({ type: 'ZIP_ABORT', zipToken: 'redirect-e2e' }).catch(() => {});
} catch (e) { phase('R6 BUILD_ZIP redirect refusal', false, { note: e.message.slice(0, 200) }); }

const hard = errorWatch.filter((e) => e.kind !== 'console.warning');
phase('R0 zero console.error/pageerror', hard.length === 0,
  { note: hard.length ? JSON.stringify(hard.slice(0, 4)) : 'clean' });

console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
await ctx.close().catch(() => {});
server.close();
process.exit(results.errors.length ? 1 : 0);
