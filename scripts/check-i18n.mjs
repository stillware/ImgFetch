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
 * ImgFetch, scripts/check-i18n.mjs
 *
 * Validates the _locales/<code>/messages.json files. Fails (exit 1) on any
 * of: a missing locale folder (all 21 required); invalid JSON; a key missing
 * in a locale or extra in a locale (compared against en's key set, with
 * plural variants expanded per the locale's category list); a non-English
 * value identical to the English value that is not on the reviewed
 * allow-list below; a missing or unused plural form for the locale's
 * categories; a placeholder mismatch (the set of {tokens} in a locale's
 * message must equal en's set for the corresponding key/variant); any
 * U+2014, U+2013 or " -- " in any message; appName !== "ImgFetch".
 *
 * Run: node scripts/check-i18n.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '_locales');

const LOCALES = [
  'en', 'es', 'es_419', 'pt_BR', 'fr', 'de', 'it', 'nl', 'ru', 'uk', 'pl',
  'cs', 'tr', 'ar', 'zh_CN', 'zh_TW', 'ja', 'ko', 'id', 'vi', 'th',
];

// Plural categories each locale must carry per plural base. Collapsed
// locales (ja, ko, zh_CN, zh_TW, th, vi, id, tr) carry the bare key only.
const CATEGORIES = {
  es: ['one', 'other'],
  es_419: ['one', 'other'],
  pt_BR: ['one', 'other'],
  fr: ['one', 'other'],
  de: ['one', 'other'],
  it: ['one', 'other'],
  nl: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
  uk: ['one', 'few', 'many', 'other'],
  pl: ['one', 'few', 'many', 'other'],
  cs: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
};
const COLLAPSED = new Set(['ja', 'ko', 'zh_CN', 'zh_TW', 'th', 'vi', 'id', 'tr']);
const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

// The dash detector MUST use escapes, never the literal characters, so that
// a mechanical text-replacement pass over the repository cannot corrupt it.
const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const DOUBLE_DASH = ' -- ';

/**
 * Reviewed allow-list for values that are legitimately identical to the
 * English source. Entries are "code:key". Reviewed 2026-10-18:
 * - Universal: brand "ImgFetch" (appName, required identical); values made
 *   only of placeholders/symbols (history_groupLine, fn_templatePlaceholder,
 *   fn_tokensList, popup_thumbTitle, info_shownAtValue); the domain example
 *   sp_hostPlaceholder ("example.com").
 * - Per-locale: true cognates and established loanwords, e.g. German
 *   "Format"/"System"/"Screenshot", French "Version"/"Documentation",
 *   Dutch "Privacy"/"Camera", and bare number+unit strings like "< 400px".
 * Anything identical to English that is NOT listed here fails the check.
 */
const UNIVERSAL_IDENTICAL_KEYS = new Set([
  'appName',
  'history_groupLine',
  'fn_templatePlaceholder',
  'fn_tokensList',
  'sp_hostPlaceholder',
  'popup_thumbTitle',
  'info_shownAtValue',
]);
const ALLOW_IDENTICAL = new Set([
  'cs:about_licence', 'cs:tool_text',
  'de:about_version', 'de:color_orange', 'de:kv_format', 'de:menu_screenshot',
  'de:options_secDownloads', 'de:options_secScreenshots', 'de:popup_queueTitle',
  'de:popup_screenshotGroup', 'de:popup_shotElementLabel', 'de:sp_smart',
  'de:theme_system', 'de:tool_text',
  'es:options_secGeneral', 'es:popup_shotVisibleLabel',
  'es_419:options_secGeneral', 'es_419:popup_shotVisibleLabel',
  'fr:about_docs', 'fr:about_licence', 'fr:about_version',
  'fr:capture_metaPixels', 'fr:color_orange', 'fr:kv_dimensions',
  'fr:kv_format', 'fr:kv_source', 'fr:popup_orientPortrait',
  'fr:popup_shotVisibleLabel', 'fr:tool_rect', 'fr:ui_fallbackName',
  'id:kv_format', 'id:popup_shotAreaLabel',
  'it:menu_screenshot', 'it:options_secPrivacy', 'it:popup_home',
  'it:popup_screenshotGroup', 'it:popup_shotAreaLabel',
  'ja:popup_sizeSmall',
  'ko:popup_sizeSmall',
  'nl:capture_metaPixels', 'nl:kv_camera', 'nl:menu_screenshot',
  'nl:options_secDownloads', 'nl:options_secPrivacy',
  'nl:options_secScreenshots', 'nl:popup_home', 'nl:popup_queueTitle',
  'nl:popup_screenshotGroup', 'nl:popup_shotElementLabel', 'nl:tool_pen',
  'pl:kv_format', 'pl:popup_shotElementLabel',
  'pt_BR:capture_metaPixels', 'pt_BR:options_secDownloads',
  'pt_BR:popup_queueTitle',
  'zh_CN:popup_sizeSmall', 'zh_CN:popup_sizeMedium', 'zh_CN:popup_sizeLarge',
  'zh_TW:popup_sizeSmall', 'zh_TW:popup_sizeMedium', 'zh_TW:popup_sizeLarge',
]);

let failures = 0;
function fail(message) {
  failures += 1;
  console.error('FAIL: ' + message);
}

function splitPlural(key) {
  const idx = key.lastIndexOf('_');
  if (idx > 0) {
    const suffix = key.slice(idx + 1);
    if (PLURAL_SUFFIXES.has(suffix)) return [key.slice(0, idx), suffix];
  }
  return [null, null];
}

function tokensOf(message) {
  const out = new Set();
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m;
  while ((m = re.exec(message)) !== null) out.add(m[1]);
  return out;
}

function sameTokenSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---- load en -----------------------------------------------------------
const enPath = join(ROOT, 'en', 'messages.json');
if (!existsSync(enPath)) {
  fail('missing locale folder or messages.json for en');
  console.log(`check-i18n: ${failures} failures`);
  process.exit(1);
}
let en;
try {
  en = JSON.parse(readFileSync(enPath, 'utf8'));
} catch (e) {
  fail('invalid JSON in en/messages.json: ' + e.message);
  console.log(`check-i18n: ${failures} failures`);
  process.exit(1);
}
const enKeys = Object.keys(en);

// Plural bases found in en (a base is plural when en carries suffixed
// variants for it).
const pluralBases = new Map(); // base -> Set(variants present in en)
for (const k of enKeys) {
  const [base, suffix] = splitPlural(k);
  if (base) {
    if (!pluralBases.has(base)) pluralBases.set(base, new Set());
    pluralBases.get(base).add(suffix);
  }
}
// Token set per plural base in en (all en variants of a base share it).
const enBaseTokens = new Map();
for (const [base, variants] of pluralBases) {
  const first = [...variants][0];
  enBaseTokens.set(base, tokensOf(en[`${base}_${first}`].message));
}

// Expected key set for a locale: en's non-plural keys plus, per plural
// base, the locale's categories (or the bare key for collapsed locales).
function expectedKeys(code) {
  const out = new Set();
  const seenBase = new Set();
  for (const k of enKeys) {
    const [base] = splitPlural(k);
    if (!base) {
      out.add(k);
    } else if (!seenBase.has(base)) {
      seenBase.add(base);
      if (code === 'en') {
        for (const v of pluralBases.get(base)) out.add(`${base}_${v}`);
      } else if (COLLAPSED.has(code)) {
        out.add(base);
      } else {
        for (const cat of CATEGORIES[code]) out.add(`${base}_${cat}`);
      }
    }
  }
  return out;
}

// Reference token set for a locale key: en's token set for the same
// key/variant, or the base token set when en lacks that variant
// (e.g. ru _few while en only has _one/_other).
function referenceTokens(code, key) {
  if (en[key]) return tokensOf(en[key].message);
  const [base] = splitPlural(key);
  if (base && enBaseTokens.has(base)) return enBaseTokens.get(base);
  return null;
}

// ---- check every locale -------------------------------------------------
for (const code of LOCALES) {
  const path = join(ROOT, code, 'messages.json');
  if (!existsSync(path)) {
    fail(`missing locale folder or messages.json for ${code}`);
    continue;
  }
  let dict;
  try {
    dict = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`invalid JSON in ${code}/messages.json: ${e.message}`);
    continue;
  }

  if (code !== 'en' && (!dict.appName || dict.appName.message !== 'ImgFetch')) {
    fail(`${code}: appName message must be exactly "ImgFetch"`);
  }

  const want = expectedKeys(code);
  const have = new Set(Object.keys(dict));
  for (const k of want) {
    if (!have.has(k)) fail(`${code}: missing key "${k}"`);
  }
  for (const k of have) {
    if (!want.has(k)) fail(`${code}: extra key "${k}" (not in en key set)`);
  }

  for (const k of have) {
    const entry = dict[k];
    if (!entry || typeof entry.message !== 'string') {
      fail(`${code}: key "${k}" has no string message`);
      continue;
    }
    const msg = entry.message;
    // banned dashes
    if (msg.includes(EM_DASH) || msg.includes(EN_DASH) || msg.includes(DOUBLE_DASH)) {
      fail(`${code}: key "${k}" contains a banned dash (U+2014, U+2013 or " -- ")`);
    }
    // identical to English
    if (code !== 'en' && en[k] && msg === en[k].message) {
      const allowed = UNIVERSAL_IDENTICAL_KEYS.has(k) || ALLOW_IDENTICAL.has(`${code}:${k}`);
      if (!allowed) fail(`${code}: key "${k}" is identical to the English value and not on the allow-list`);
    }
    // placeholder parity
    const ref = referenceTokens(code, k);
    if (ref && !sameTokenSet(tokensOf(msg), ref)) {
      fail(`${code}: key "${k}" placeholder mismatch (got {${[...tokensOf(msg)].sort().join('},{')}} want {${[...ref].sort().join('},{')}})`);
    }
  }
}

if (failures > 0) {
  console.log(`check-i18n: ${failures} failures`);
  process.exit(1);
}
console.log('check-i18n: OK');
