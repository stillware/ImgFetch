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
 * ImgFetch, core/capture-decision.js
 * FIX 3: pure capture-mode decision logic. No DOM, no chrome.*: the
 * service worker discovers the outcomes with try/catch around the real
 * browser calls and feeds them here; this module only decides the next
 * step. Unit-tested in Node (tests/test-capture-decision.mjs).
 *
 * The one hard rule: tab.url is NEVER consulted. On restricted pages
 * (chrome://, edge://, the web stores) tab.url is often empty/undefined
 * without the tabs permission, and the old code treated an empty URL as
 * "not a web page" and silently captured a DIFFERENT tab. Here an empty
 * URL changes nothing: injection is attempted, its failure is the
 * fallback signal, and the visible capture always targets the real
 * active tab of the current window.
 */

export const CAPTURE_MODES = ['visible', 'area', 'element', 'full'];

/** Capture modes that need script injection into the page. */
export function modeNeedsInjection(mode) {
  return mode === 'area' || mode === 'element' || mode === 'full';
}

/**
 * Decide the next step of a capture request from the outcomes observed so
 * far.
 *
 * @param {string} requested 'visible' | 'area' | 'element' | 'full'
 * @param {{injection: ('ok'|'failed'|null), visible: ('ok'|'failed'|null)}} outcomes
 *   null = not attempted yet.
 * @returns one of:
 *   { step: 'inject' }            try script injection into the active tab
 *   { step: 'capture-visible' }   capture the visible area of the active tab
 *   { step: 'proceed', mode }     injection worked, run the requested mode
 *   { step: 'done' }              visible capture finished, nothing more to do
 *   { step: 'fallback-done', noticeKey, noticeVars }
 *                                 visible area captured after injection
 *                                 failed; the worker shows the notice
 *   { step: 'refuse', errorKey }  nothing capturable; the worker shows the error
 */
export function decideCaptureStep(requested, outcomes) {
  const mode = CAPTURE_MODES.includes(requested) ? requested : 'visible';
  const inj = outcomes ? outcomes.injection : null;
  const vis = outcomes ? outcomes.visible : null;

  if (!modeNeedsInjection(mode)) {
    if (vis === 'ok') return { step: 'done' };
    if (vis === 'failed') return { step: 'refuse', errorKey: 'cap_captureRefused' };
    return { step: 'capture-visible' };
  }

  if (inj !== 'ok' && inj !== 'failed') return { step: 'inject' };
  if (inj === 'ok') return { step: 'proceed', mode };

  // Injection failed: restricted page (or an empty URL on one). Fall back
  // to a visible-area capture of the SAME active tab, never another tab.
  if (vis === 'ok') {
    return {
      step: 'fallback-done',
      noticeKey: 'cap_restrictedFallback',
      noticeVars: { mode },
    };
  }
  if (vis === 'failed') return { step: 'refuse', errorKey: 'cap_captureRefused' };
  return { step: 'capture-visible' };
}
