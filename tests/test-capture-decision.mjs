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
 * ImgFetch, tests/test-capture-decision.mjs
 * FIX 3: the capture-mode decision logic never consults tab.url. The
 * worker feeds it outcomes discovered with try/catch (injection ok/failed,
 * visible capture ok/failed); the empty-URL case (chrome:// with no tabs
 * permission) is just "injection failed", which must fall back to a
 * visible capture of the SAME active tab, never a different tab, and
 * never a silent failure.
 */
import { decideCaptureStep, modeNeedsInjection, CAPTURE_MODES } from '../core/capture-decision.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `, ${extra}` : ''}`); }
}

// --- modeNeedsInjection ---
check('visible needs no injection', modeNeedsInjection('visible') === false);
check('area needs injection', modeNeedsInjection('area') === true);
check('element needs injection', modeNeedsInjection('element') === true);
check('full needs injection', modeNeedsInjection('full') === true);
check('four modes', CAPTURE_MODES.length === 4);

// --- visible mode ---
{
  const d = decideCaptureStep('visible', { injection: null, visible: null });
  check('visible: first step captures the visible area', d.step === 'capture-visible');
}
{
  const d = decideCaptureStep('visible', { injection: null, visible: 'ok' });
  check('visible: ok ends the capture', d.step === 'done');
}
{
  const d = decideCaptureStep('visible', { injection: null, visible: 'failed' });
  check('visible: refusal surfaces cap_captureRefused', d.step === 'refuse' && d.errorKey === 'cap_captureRefused');
}

// --- injection modes: happy path ---
for (const mode of ['area', 'element', 'full']) {
  const d0 = decideCaptureStep(mode, { injection: null, visible: null });
  check(`${mode}: first step is injection`, d0.step === 'inject', JSON.stringify(d0));
  const d1 = decideCaptureStep(mode, { injection: 'ok', visible: null });
  check(`${mode}: injection ok proceeds`, d1.step === 'proceed' && d1.mode === mode, JSON.stringify(d1));
}

// --- injection modes: restricted page falls back to visible, same tab ---
for (const mode of ['area', 'element', 'full']) {
  const d = decideCaptureStep(mode, { injection: 'failed', visible: null });
  check(`${mode}: injection failure goes to visible capture`, d.step === 'capture-visible', JSON.stringify(d));
  const d2 = decideCaptureStep(mode, { injection: 'failed', visible: 'ok' });
  check(
    `${mode}: fallback done with a notice, naming the requested mode`,
    d2.step === 'fallback-done' && d2.noticeKey === 'cap_restrictedFallback' && d2.noticeVars && d2.noticeVars.mode === mode,
    JSON.stringify(d2),
  );
  const d3 = decideCaptureStep(mode, { injection: 'failed', visible: 'failed' });
  check(
    `${mode}: visible refused too -> localized error, never silent`,
    d3.step === 'refuse' && d3.errorKey === 'cap_captureRefused',
    JSON.stringify(d3),
  );
}

// --- empty-URL case (chrome://, edge:// without the tabs permission):
// tab.url is empty, so the ONLY signal is the injection outcome. The
// decision function takes no URL at all; prove the table is URL-free.
{
  // Simulate chrome://newtab: injection failed, visible capture allowed.
  const d = decideCaptureStep('full', { injection: 'failed', visible: 'ok' });
  check('empty URL + injection failed + visible ok -> visible fallback, not another tab',
    d.step === 'fallback-done');
  // Simulate the Chrome Web Store: injection failed AND visible refused.
  const d2 = decideCaptureStep('full', { injection: 'failed', visible: 'failed' });
  check('empty URL + both failed -> refuse with a clear error, never silent',
    d2.step === 'refuse' && typeof d2.errorKey === 'string' && d2.errorKey.length > 0);
  // No step ever names a tab id or URL: the decision cannot reroute tabs.
  const seen = JSON.stringify([
    decideCaptureStep('full', { injection: null, visible: null }),
    decideCaptureStep('full', { injection: 'failed', visible: null }),
    decideCaptureStep('full', { injection: 'failed', visible: 'ok' }),
    decideCaptureStep('full', { injection: 'failed', visible: 'failed' }),
  ]);
  check('no decision step references a tab or URL', !/tabId|tab\.|url/i.test(seen), seen.slice(0, 120));
}

// --- unknown mode degrades to visible, never throws ---
{
  const d = decideCaptureStep('bogus', { injection: null, visible: null });
  check('unknown mode falls back to visible', d.step === 'capture-visible');
  const d2 = decideCaptureStep(null, { injection: null, visible: null });
  check('null mode falls back to visible', d2.step === 'capture-visible');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
