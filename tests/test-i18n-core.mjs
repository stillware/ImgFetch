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
 * ImgFetch, tests/test-i18n-core.mjs
 *
 * Pure Node tests for shared/i18n.js: locale matching, plural categories,
 * the t()/resolveMessage() fallback chain, placeholder substitution and
 * plural selection. No browser, no chrome.* required.
 *
 * Run: node tests/test-i18n-core.mjs
 */
import {
  matchLocale,
  pluralCategory,
  resolveMessage,
  LOCALES,
  LOCALE_INFO,
  t,
  getLocale,
  initI18n,
} from '../shared/i18n.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ---- matchLocale ---------------------------------------------------------
eq(matchLocale(['pt-BR']), 'pt_BR', 'matchLocale exact pt-BR -> pt_BR');
eq(matchLocale(['es-419']), 'es_419', 'matchLocale exact es-419 -> es_419');
eq(matchLocale(['pt-PT']), 'pt_BR', 'matchLocale pt-PT falls back to base pt -> pt_BR');
eq(matchLocale(['pt']), 'pt_BR', 'matchLocale base pt -> pt_BR');
eq(matchLocale(['zh']), 'zh_CN', 'matchLocale base zh -> zh_CN');
eq(matchLocale(['zh-HK']), 'zh_CN', 'matchLocale zh-HK -> zh_CN (first zh entry)');
eq(matchLocale(['es']), 'es', 'matchLocale base es -> es');
eq(matchLocale(['xx-YY']), 'en', 'matchLocale unknown -> en');
eq(matchLocale([]), 'en', 'matchLocale empty -> en');
eq(matchLocale(['en-US', 'fr-CA']), 'en', 'matchLocale en-US has no exact entry, base en missing -> en');
eq(matchLocale(['fr-CA', 'de']), 'de', 'matchLocale exact de beats nothing, fr-CA base -> fr');

// ---- pluralCategory ------------------------------------------------------
eq(pluralCategory('ru', 1), 'one', 'ru 1 -> one');
eq(pluralCategory('ru', 2), 'few', 'ru 2 -> few');
eq(pluralCategory('ru', 5), 'many', 'ru 5 -> many');
eq(pluralCategory('ru', 0), 'many', 'ru 0 -> many');
eq(pluralCategory('ar', 0), 'zero', 'ar 0 -> zero');
eq(pluralCategory('ar', 1), 'one', 'ar 1 -> one');
eq(pluralCategory('ar', 2), 'two', 'ar 2 -> two');
eq(pluralCategory('ar', 5), 'few', 'ar 5 -> few');
eq(pluralCategory('ar', 15), 'many', 'ar 15 -> many');
eq(pluralCategory('ja', 1), 'other', 'ja always other (collapsed uses bare key)');
eq(pluralCategory('ja', 100), 'other', 'ja 100 -> other');
eq(pluralCategory('en', 1), 'one', 'en 1 -> one');
eq(pluralCategory('en', 2), 'other', 'en 2 -> other');

// ---- resolveMessage fallback chain ---------------------------------------
const enDict = { hello: 'Hello', bye: 'Bye' };
const baseDict = { hello: 'Hola (base)' };
const esDict = { hello: 'Hola' };
eq(resolveMessage([esDict, baseDict, enDict], 'hello', null, 'es'), 'Hola', 'exact locale wins');
eq(resolveMessage([{}, baseDict, enDict], 'hello', null, 'es'), 'Hola (base)', 'base language fallback');
eq(resolveMessage([{}, {}, enDict], 'hello', null, 'es'), 'Hello', 'en fallback');
eq(resolveMessage([{}, {}, {}], 'hello', null, 'es'), 'hello', 'key itself as last resort');
eq(resolveMessage([{}, {}, {}], 'missing', null, 'es'), 'missing', 'unknown key returns key');

// ---- placeholders ---------------------------------------------------------
const phDict = { greet: 'Hi {name}, you have {count} messages' };
eq(
  resolveMessage([phDict], 'greet', { name: 'Ana', count: 3 }, 'en'),
  'Hi Ana, you have 3 messages',
  'placeholder substitution',
);
eq(
  resolveMessage([phDict], 'greet', { name: 'Ana' }, 'en'),
  'Hi Ana, you have {count} messages',
  'unknown tokens left as-is',
);
eq(resolveMessage([phDict], 'greet', null, 'en'), 'Hi {name}, you have {count} messages', 'null vars');

// ---- plural selection ------------------------------------------------------
const cntDict = { n_one: 'one thing', n_other: '{count} things' };
eq(resolveMessage([cntDict], 'n', { count: 1 }, 'en'), 'one thing', 'count 1 -> _one');
eq(resolveMessage([cntDict], 'n', { count: 7 }, 'en'), '7 things', 'count 7 -> _other with substitution');
const otherOnly = { n_other: 'other only' };
eq(resolveMessage([otherOnly], 'n', { count: 1 }, 'ru'), 'other only', 'missing _one falls back to _other');
const jaDict = { n: 'bare key', n_other: 'other key' };
eq(resolveMessage([jaDict], 'n', { count: 5 }, 'ja'), 'bare key', 'collapsed locale uses bare key');
eq(resolveMessage([jaDict], 'n', { count: 1 }, 'zh_CN'), 'bare key', 'zh_CN collapsed uses bare key');
// non-integer count does not trigger plural selection
// 1.5 is not an integer, so the bare key is used; it is absent so the key returns
eq(resolveMessage([cntDict], 'n', { count: 1.5 }, 'en'), 'n', 'non-integer count -> bare key -> key fallback');

// ---- never throws, never undefined ------------------------------------------
assert(resolveMessage(null, 'k', null, 'en') === 'k', 'null dict chain returns key');
assert(resolveMessage([{}], 'k', null, 'en') !== undefined, 'never returns undefined');
assert(typeof resolveMessage([{}], 'k', { count: 2 }, 'ru') === 'string', 'always a string');

// ---- LOCALES / LOCALE_INFO ----------------------------------------------------
eq(LOCALES.length, 21, 'LOCALES has 21 entries');
eq(LOCALES[0], 'en', 'LOCALES starts with en');
assert(LOCALES.includes('es_419') && LOCALES.includes('pt_BR') && LOCALES.includes('zh_CN'), 'LOCALES has underscore codes');
eq(LOCALE_INFO.ar.dir, 'rtl', 'ar dir is rtl');
eq(LOCALE_INFO.en.dir, 'ltr', 'en dir is ltr');
eq(LOCALE_INFO.ja.dir, 'ltr', 'ja dir is ltr');
eq(LOCALE_INFO.es_419.englishName, 'Latin American Spanish', 'es_419 englishName');
eq(LOCALE_INFO.pt_BR.englishName, 'Brazilian Portuguese', 'pt_BR englishName');
eq(LOCALE_INFO.zh_CN.englishName, 'Simplified Chinese', 'zh_CN englishName');

// ---- en/messages.json from disk ----------------------------------------------
const enPath = join(dirname(fileURLToPath(import.meta.url)), '..', '_locales', 'en', 'messages.json');
const enJson = JSON.parse(readFileSync(enPath, 'utf8'));
eq(enJson.appName.message, 'ImgFetch', 'en appName is ImgFetch');
eq(
  enJson.appDescription.message,
  'ImgFetch: Smart Image Downloader. Save images in the best quality, scan whole pages, capture screenshots.',
  'en appDescription exact',
);
eq(enJson.actionTitle.message, 'ImgFetch Smart Image Downloader', 'en actionTitle exact');
eq(enJson.copyButton.message, 'Copy', 'en copyButton exact');
eq(enJson.copyTooltip.message, 'Copy the edited screenshot to the clipboard', 'en copyTooltip exact');
eq(enJson.copySuccess.message, 'Screenshot copied to the clipboard.', 'en copySuccess exact');
eq(
  enJson.copyDownscaled.message,
  'Screenshot copied to the clipboard, downscaled to {width} x {height} to fit.',
  'en copyDownscaled exact',
);
eq(enJson.copyFailed.message, 'Could not copy the screenshot. Try saving it instead.', 'en copyFailed exact');
eq(enJson.copyUnavailable.message, 'Copy is unavailable right now.', 'en copyUnavailable exact');

// ---- initI18n / t / getLocale with no chrome (Node) ------------------------------
await initI18n();
eq(getLocale(), 'en', 'initI18n without chrome resolves en');
eq(t('popup_home'), 'popup_home', 't() without messages returns the key');
eq(t('nope', { count: 2 }), 'nope', 't() with vars but no messages returns the key');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
