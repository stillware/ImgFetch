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
 * ImgFetch i18n e2e (tests/test-e2e/i18n-e2e.mjs)
 * Real-browser suite (Playwright + Chromium) for Feature B, interface
 * localization. Run under a virtual display:
 *   xvfb-run -a node tests/test-e2e/i18n-e2e.mjs [--headed]
 *
 * What it does, in `en` and in `ar` (RTL):
 *  I1  pages/welcome.html opens: correct <html> lang/dir, translated strings
 *  I2  pages/rename.html opens directly: correct lang/dir, translated strings
 *  I3  pages/annotate.html opens (GET_CAPTURE stubbed like clipboard-e2e):
 *      correct lang/dir, translated editor strings
 *  I4  options/options.html: correct lang/dir, language dropdown lists
 *      Auto + the 21 locales with native names
 *  I5  the content overlay (Select Area) on a fixture page shows the
 *      translated hint
 * Fails the run on ANY console.error / pageerror / unhandled rejection in
 * the service worker or any opened page.
 *
 * NOT RUN HERE: this environment has no Chromium. Written carefully against
 * tests/test-e2e/e2e.mjs and tests/test-e2e/clipboard-e2e.mjs patterns.
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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

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

// Expected strings come from the shipped locale files, never hardcoded here.
function msg(lang, key) {
  const file = path.join(PROJ, '_locales', lang, 'messages.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json[key] || typeof json[key].message !== 'string') throw new Error(`missing key ${key} in ${lang}`);
  return json[key].message;
}

const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}   headed=${HEADED}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-i18n-e2e-'));

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

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');

// Popup page: privileged control channel (kind='extension').
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
const send = (m) => ctrl.evaluate((x) => chrome.runtime.sendMessage(x), m);

// Set the language the way the options page does: through stored settings.
// Both storage keys are written so the read is deterministic (the worker
// mirrors 'imgfetch.settings' to the 'settings' key shared/i18n.js reads).
async function setTestLanguage(lang) {
  await sw.evaluate(async (l) => {
    const cur = (await chrome.storage.local.get('imgfetch.settings'))['imgfetch.settings'] || {};
    const next = { ...cur, language: l };
    await chrome.storage.local.set({ 'imgfetch.settings': next, settings: next });
  }, lang);
  await new Promise((r) => setTimeout(r, 800));
}

async function pageDirLang(page) {
  return page.evaluate(() => ({
    dir: document.documentElement.getAttribute('dir'),
    lang: document.documentElement.getAttribute('lang'),
  }));
}

// 1x1 red PNG, like clipboard-e2e's fixture but tiny.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function openAnnotate(label) {
  const page = await ctx.newPage();
  watchErrors(page, `annotate-${label}`);
  await page.addInitScript(([b64]) => {
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, cb) => {
      if (m && m.type === 'GET_CAPTURE') {
        setTimeout(() => cb({ ok: true, dataUrl: `data:image/png;base64,${b64}` }), 0);
        return;
      }
      return origSend(m, cb);
    };
  }, [TINY_PNG_B64]);
  await page.goto(`chrome-extension://${extId}/pages/annotate.html#i18n-e2e`);
  await page.waitForSelector('#content:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(1200); // lazy i18n + toolbar paint
  return page;
}

for (const lang of ['en', 'ar']) {
  const wantDir = lang === 'ar' ? 'rtl' : 'ltr';
  await setTestLanguage(lang);
  console.log(`--- language: ${lang} (expect dir=${wantDir}) ---`);

  // I1: welcome page
  try {
    const page = await ctx.newPage();
    watchErrors(page, `welcome-${lang}`);
    await page.goto(`chrome-extension://${extId}/pages/welcome.html`);
    await page.waitForFunction((d) => document.documentElement.getAttribute('dir') === d, wantDir, { timeout: 10000 });
    const { dir, lang: htmlLang } = await pageDirLang(page);
    const h1 = await page.textContent('.step[data-step="0"] h1');
    const next = await page.textContent('#btnNext');
    phase(`I1 welcome ${lang}: lang/dir/strings`, dir === wantDir && htmlLang === lang &&
      h1.trim() === msg(lang, 'welcome_title') && next.trim() === msg(lang, 'welcome_next'),
      { note: `dir=${dir} lang=${htmlLang} h1=${JSON.stringify(h1.trim().slice(0, 40))}` });
    await page.close();
  } catch (e) {
    phase(`I1 welcome ${lang}`, false, { note: e.message.slice(0, 200) });
  }

  // I2: rename sheet opened directly
  try {
    const page = await ctx.newPage();
    watchErrors(page, `rename-${lang}`);
    const src = encodeURIComponent('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='); // data: URL avoids network in the sandbox
    await page.goto(`chrome-extension://${extId}/pages/rename.html?src=${src}&format=png&mode=smart`);
    await page.waitForFunction((d) => document.documentElement.getAttribute('dir') === d, wantDir, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('formatHint').textContent.length > 0, null, { timeout: 10000 });
    const { dir, lang: htmlLang } = await pageDirLang(page);
    const label = await page.textContent('label[for="filename"]');
    const save = await page.textContent('#btnSave');
    phase(`I2 rename ${lang}: lang/dir/strings`, dir === wantDir && htmlLang === lang &&
      label.trim() === msg(lang, 'rename_filename') && save.trim() === msg(lang, 'rename_download'),
      { note: `dir=${dir} lang=${htmlLang}` });
    await page.close();
  } catch (e) {
    phase(`I2 rename ${lang}`, false, { note: e.message.slice(0, 200) });
  }

  // I3: annotate editor
  try {
    const page = await openAnnotate(lang);
    await page.waitForFunction((d) => document.documentElement.getAttribute('dir') === d, wantDir, { timeout: 10000 });
    const { dir, lang: htmlLang } = await pageDirLang(page);
    const sub = await page.textContent('.brand-sub');
    const toolbarAria = await page.getAttribute('#content .toolbar', 'aria-label');
    const penLabel = await page.textContent('.tool[data-tool="pen"] span');
    phase(`I3 annotate ${lang}: lang/dir/strings`, dir === wantDir && htmlLang === lang &&
      sub.trim() === msg(lang, 'annotate_subtitle') &&
      toolbarAria === msg(lang, 'annotate_toolbarAria') &&
      penLabel.trim() === msg(lang, 'tool_pen'),
      { note: `dir=${dir} lang=${htmlLang}` });
    await page.close();
  } catch (e) {
    phase(`I3 annotate ${lang}`, false, { note: e.message.slice(0, 200) });
  }

  // I4: options page + language dropdown
  try {
    const page = await ctx.newPage();
    watchErrors(page, `options-${lang}`);
    await page.goto(`chrome-extension://${extId}/options/options.html`);
    await page.waitForFunction((d) => document.documentElement.getAttribute('dir') === d, wantDir, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#language option').length > 1, null, { timeout: 10000 });
    const { dir, lang: htmlLang } = await pageDirLang(page);
    const navGeneral = await page.textContent('.side-nav button[data-section="general"]');
    const optCount = await page.evaluate(() => document.querySelectorAll('#language option').length);
    const autoText = await page.evaluate(() => document.querySelector('#language option[value="auto"]').textContent);
    const selected = await page.evaluate(() => document.getElementById('language').value);
    phase(`I4 options ${lang}: lang/dir/dropdown`, dir === wantDir && htmlLang === lang &&
      navGeneral.trim() === msg(lang, 'options_secGeneral') &&
      optCount === 22 && autoText.trim() === msg(lang, 'languageAuto') && selected === lang,
      { note: `dir=${dir} lang=${htmlLang} options=${optCount} selected=${selected}` });
    await page.close();
  } catch (e) {
    phase(`I4 options ${lang}`, false, { note: e.message.slice(0, 200) });
  }

  // I5: content overlay hint on a fixture page
  try {
    const page = await ctx.newPage();
    watchErrors(page, `overlay-${lang}`);
    await page.goto(`${BASE}/gallery`);
    await page.bringToFront();
    await page.waitForTimeout(800);
    const pending = send({ type: 'CAPTURE_AREA' }).catch(() => ({}));
    await page.waitForSelector('[data-imgfetch-overlay] .sx-hint', { timeout: 15000 });
    const hintText = await page.evaluate(() => document.querySelector('.sx-hint').textContent);
    const overlayDir = await page.evaluate(() => {
      const el = document.querySelector('[data-imgfetch-overlay]');
      return el ? window.getComputedStyle(el).direction : '';
    });
    phase(`I5 overlay ${lang}: translated hint`, hintText === msg(lang, 'overlay_selectHint'),
      { note: `hint=${JSON.stringify(hintText.slice(0, 60))} direction=${overlayDir}` });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-imgfetch-overlay]', { state: 'detached', timeout: 5000 });
    await pending;
    await page.close();
  } catch (e) {
    phase(`I5 overlay ${lang}`, false, { note: e.message.slice(0, 200) });
  }
}

// Zero console errors / page errors anywhere.
const hardErrors = errorWatch.filter((e) => e.kind !== 'console.warning');
const warnings = errorWatch.filter((e) => e.kind === 'console.warning');
for (const w of warnings.slice(0, 10)) console.log(`WARN [${w.label}] ${w.text}`);
phase('I0 zero console.error/pageerror/unhandled rejections', hardErrors.length === 0,
  { note: hardErrors.length ? JSON.stringify(hardErrors.slice(0, 5)) : `${warnings.length} warnings, 0 errors` });

const failed = results.errors.length;
console.log(`${results.phases.length - failed} passed, ${failed} failed`);
await ctx.close().catch(() => {});
await fixture.close();
process.exit(failed ? 1 : 0);