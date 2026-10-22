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
 * ImgFetch, tests/test-i18n-dom.mjs
 *
 * Tests applyI18n() against a hand-rolled minimal DOM stub (no jsdom).
 * globalThis.document and globalThis.chrome are stubbed before importing
 * shared/i18n.js; fetch serves the real _locales/<code>/messages.json
 * files from disk so translations are genuine.
 *
 * Run: node tests/test-i18n-dom.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL: ' + name);
  }
}
function eq(actual, want, name) {
  assert(
    actual === want,
    name + ' (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(want) + ')',
  );
}

// ---- minimal DOM stub -------------------------------------------------------
function makeElement() {
  const attrs = Object.create(null);
  return {
    textContent: '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    _attrs: attrs,
  };
}

const textEl = makeElement();
textEl.setAttribute('data-i18n', 'popup_home');
const attrEl = makeElement();
attrEl.setAttribute('data-i18n-attr', 'title:popup_scanButton;aria-label:popup_home');
const plainEl = makeElement(); // no data-i18n attributes

const documentElement = makeElement();
globalThis.document = {
  documentElement,
  querySelectorAll(selector) {
    if (selector === '[data-i18n]') return [textEl];
    if (selector === '[data-i18n-attr]') return [attrEl];
    return [];
  },
};

// ---- chrome + fetch stubs serving real locale files --------------------------
let storedLanguage = 'ar';
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({ settings: { language: storedLanguage } }),
      set: async (obj) => {
        if (obj && obj.settings && typeof obj.settings.language === 'string') {
          storedLanguage = obj.settings.language;
        }
      },
    },
  },
  runtime: {
    getURL: (p) => 'https://imgfetch.test/' + p,
  },
};
globalThis.fetch = async (url) => {
  const m = String(url).match(/_locales\/([^/]+)\/messages\.json/);
  if (!m) return { ok: false };
  const data = readFileSync(join(HERE, '..', '_locales', m[1], 'messages.json'), 'utf8');
  return { ok: true, json: async () => JSON.parse(data) };
};

// ---- import after stubs -------------------------------------------------------
const i18n = await import('../shared/i18n.js');

// ---- ar: rtl ------------------------------------------------------------------
await i18n.initI18n();
eq(i18n.getLocale(), 'ar', 'initI18n resolves ar from stored language');

i18n.applyI18n();
eq(documentElement.getAttribute('lang'), 'ar', 'html lang is "ar"');
eq(documentElement.getAttribute('dir'), 'rtl', 'html dir is rtl for ar');
eq(textEl.textContent, 'الرئيسية', 'data-i18n textContent translated to Arabic');
eq(attrEl.getAttribute('title'), 'امسح هذه الصفحة', 'data-i18n-attr title translated');
eq(attrEl.getAttribute('aria-label'), 'الرئيسية', 'data-i18n-attr aria-label translated');
eq(plainEl.textContent, '', 'element without data-i18n untouched');

// ---- switch to en: ltr ----------------------------------------------------------
await i18n.setLanguage('en');
eq(i18n.getLocale(), 'en', 'setLanguage(en) resolves en');
i18n.applyI18n();
eq(documentElement.getAttribute('lang'), 'en', 'html lang is "en"');
eq(documentElement.getAttribute('dir'), 'ltr', 'html dir is ltr for en');
eq(textEl.textContent, 'Home', 'data-i18n textContent translated to English');
eq(attrEl.getAttribute('title'), 'Scan this page', 'data-i18n-attr title in English');

// ---- onLanguageChange ------------------------------------------------------------
let notified = null;
const unsub = i18n.onLanguageChange((code) => {
  notified = code;
});
await i18n.setLanguage('ar');
eq(notified, 'ar', 'onLanguageChange listener notified');
unsub();
notified = null;
await i18n.setLanguage('en');
eq(notified, null, 'unsubscribed listener not notified');

// ---- applyI18n with an explicit root ----------------------------------------------
const rootText = makeElement();
rootText.setAttribute('data-i18n', 'popup_settings');
const fakeRoot = {
  querySelectorAll(selector) {
    return selector === '[data-i18n]' ? [rootText] : [];
  },
};
i18n.applyI18n(fakeRoot);
eq(rootText.textContent, 'ImgFetch settings', 'applyI18n(root) uses the given scope');

// ---- applyI18n without document does not throw --------------------------------------
const savedDocument = globalThis.document;
delete globalThis.document;
let threw = false;
try {
  i18n.applyI18n();
} catch {
  threw = true;
}
globalThis.document = savedDocument;
assert(!threw, 'applyI18n without document does not throw');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
