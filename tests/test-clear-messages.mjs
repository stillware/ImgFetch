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
 * ImgFetch: tests/test-clear-messages.mjs
 * Node unit tests for the Phase 6 item 6 clear-message strings: the
 * oversize data-URL toast (results_tooLargeSkipped, plural per locale)
 * and the oversize annotated-save toast (annotate_tooLarge). The strings
 * are the contract the wiring plugs into: the scanner counts oversize
 * data-URL drops and the popup toasts results_tooLargeSkipped, and the
 * SAVE_ANNOTATED failure path toasts annotate_tooLarge instead of the
 * raw "too-large" code. The translations are AI-assisted and documented
 * as such; check-i18n.mjs is the authority on plural forms per locale.
 * Prints "N passed, M failed", exits nonzero on failure.
 * Run: node tests/test-clear-messages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = [
  'en', 'es', 'es_419', 'pt_BR', 'fr', 'de', 'it', 'nl', 'ru', 'uk', 'pl',
  'cs', 'tr', 'zh_CN', 'zh_TW', 'ja', 'ko', 'id', 'vi', 'th', 'ar',
];
// Plural categories per locale, mirroring scripts/check-i18n.mjs.
const CATEGORIES = {
  es: ['one', 'other'], es_419: ['one', 'other'], pt_BR: ['one', 'other'],
  fr: ['one', 'other'], de: ['one', 'other'], it: ['one', 'other'],
  nl: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  pl: ['one', 'few', 'many', 'other'], cs: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
};
const COLLAPSED = new Set(['ja', 'ko', 'zh_CN', 'zh_TW', 'th', 'vi', 'id', 'tr']);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

function tokensOf(message) {
  const out = new Set();
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m;
  while ((m = re.exec(message)) !== null) out.add(m[1]);
  return out;
}
const hasDash = (s) => s.includes('\u2014') || s.includes('\u2013') || s.includes(' -- ');

const dicts = {};
for (const loc of LOCALES) {
  dicts[loc] = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8'));
}
const allNewStrings = [];
for (const loc of LOCALES) {
  const d = dicts[loc];
  // 1. The annotated-save message exists and is non-empty.
  const ann = d.annotate_tooLarge;
  check(`annotate_tooLarge present in ${loc}`, !!ann && typeof ann.message === 'string' && ann.message.length > 0);
  if (ann && typeof ann.message === 'string') allNewStrings.push(ann.message);
  // 2. It takes no placeholders, so no locale may add one.
  check(`annotate_tooLarge has no placeholders in ${loc}`, !!ann && tokensOf(ann.message).size === 0, ann ? [...tokensOf(ann.message)].join(',') : 'missing');
  // 3. The oversize-scan plural forms exist per the locale's categories.
  const forms = COLLAPSED.has(loc) ? ['results_tooLargeSkipped']
    : (loc === 'en' ? ['results_tooLargeSkipped_one', 'results_tooLargeSkipped_other'] : CATEGORIES[loc].map((c) => `results_tooLargeSkipped_${c}`));
  const present = forms.every((k) => d[k] && typeof d[k].message === 'string' && d[k].message.length > 0);
  check(`results_tooLargeSkipped forms present in ${loc}`, present, forms.filter((k) => !d[k]).join(','));
  // 4. Every variant carries exactly the {dropped} token, nothing else.
  const tokensOk = forms.every((k) => {
    const t = tokensOf(d[k] ? d[k].message : '');
    return t.size === 1 && t.has('dropped');
  });
  check(`results_tooLargeSkipped tokens are {dropped} only in ${loc}`, tokensOk);
  for (const k of forms) if (d[k]) allNewStrings.push(d[k].message);
}
// 5. The English wording states the caps and the alternatives plainly.
const en = dicts.en;
check('en plural wording states the 500 KB cap',
  en.results_tooLargeSkipped_one.message.includes('500 KB')
  && en.results_tooLargeSkipped_other.message.includes('500 KB'));
check('en annotate wording states the 40 MB cap and the alternatives',
  en.annotate_tooLarge.message.includes('40 MB')
  && en.annotate_tooLarge.message.includes('parts')
  && en.annotate_tooLarge.message.includes('visible area'));
// 6. Every locale states the 40 figure in the annotated-save message.
check('every locale states the 40 figure in annotate_tooLarge',
  LOCALES.every((loc) => dicts[loc].annotate_tooLarge.message.includes('40')),
  LOCALES.filter((loc) => !dicts[loc].annotate_tooLarge.message.includes('40')).join(','));
// 7. No em dash, en dash or double dash in any new string.
check('no em dash, en dash or double dash in any new string',
  allNewStrings.every((s) => !hasDash(s)),
  allNewStrings.filter(hasDash).slice(0, 2).join(' | '));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
