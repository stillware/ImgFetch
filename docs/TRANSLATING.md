# Translating ImgFetch

This guide explains how to add a new language to ImgFetch or fix an existing
translation. All user-visible strings live in `_locales/<code>/messages.json`
(Chrome i18n format) and are loaded at runtime by `shared/i18n.js`.

These translations were produced with AI assistance and have not been reviewed by native speakers. If you find a mistake, please open an issue or submit a correction.

## Adding a new language

1. Copy the English source: `cp -r _locales/en _locales/<code>`, where
   `<code>` uses underscores (`pt_BR`, `zh_CN`, never hyphens).
2. Translate every `message` value in `_locales/<code>/messages.json`. Keep
   every key, keep every `{placeholder}` exactly as written, and keep the
   `description` fields in English (they are notes for translators, never
   shown to users).
3. Add the code to `LOCALES` in `shared/i18n.js` (keep the list in the same
   order as the locale folders) and add an entry to `LOCALE_INFO` with the
   English language name and the text direction (`"ltr"`, or `"rtl"` for
   right-to-left languages).
4. Run the checker: `node scripts/check-i18n.mjs`. It must print
   `check-i18n: OK`. Fix every failure it reports before submitting.

## Fixing a translation

Edit the `message` value for the key in `_locales/<code>/messages.json`,
then run `node scripts/check-i18n.mjs` to confirm nothing else broke. Do not
rename keys: the key set must stay identical to English (see below). If a
string is wrong in a way that needs a source change, fix the English text in
`_locales/en/messages.json` first, then update every locale.

## What not to translate

Leave these exactly as they are: the brand name `ImgFetch`; format names
(`PNG`, `JPG`, `JPEG`, `WebP`, `AVIF`, `GIF`, `SVG`, `BMP`); keyboard key
names (`Ctrl`, `Shift`, `Alt`, `Enter`, `Esc`, `Delete`, `Backspace`, `Tab`);
and values that are identical by nature (bare numbers, `{placeholders}`).
Keyboard shortcut hint sentences must be fully translated, keeping the key
names as-is inside the sentence.

Never use em dashes or en dashes in translations. Use a comma, period,
colon, or parentheses instead.

## Plural rules

A key is plural when its English form varies with a count. In English the
variants are `key_one` and `key_other`. Each locale must carry exactly the
variants for its categories, no more and no fewer:

| Locales | Variants per plural key |
|---|---|
| es, es_419, pt_BR, fr, de, it, nl | `key_one`, `key_other` |
| ru, uk, pl, cs | `key_one`, `key_few`, `key_many`, `key_other` |
| ar | `key_zero`, `key_one`, `key_two`, `key_few`, `key_many`, `key_other` |
| ja, ko, zh_CN, zh_TW, th, vi, id, tr | the bare `key` only, never suffixed variants |

Example: for the base `results_titleFound`, Russian carries
`results_titleFound_one`, `results_titleFound_few`,
`results_titleFound_many`, `results_titleFound_other`, while Japanese carries
only `results_titleFound`.

## Placeholder syntax

Dynamic values use `{name}` tokens, for example
`"Download {count} images"`. Rules:

- Every variant of a key must contain exactly the same set of placeholders
  as the English source. The checker enforces this.
- Never translate, rename, or drop a placeholder. `{count}` stays `{count}`.
- If a placeholder makes no sense in your language's grammar, restructure
  the sentence around it, but keep the token itself intact.
- Unknown tokens are left as-is at runtime, so a typo like `{coutn}` would
  show literally to users. The checker catches these.

## Running the checker

```
node scripts/check-i18n.mjs
```

It fails (exit 1) on any of: a missing locale folder; invalid JSON; a key
missing or extra compared to English (with plural variants expanded per the
table above); a translated value identical to English that is not on the
reviewed allow-list inside the script; a missing or unused plural form;
placeholder mismatches; banned dash characters; or `appName` not equal to
`ImgFetch`. A clean run prints `check-i18n: OK`.

## Unit tests

- `node tests/test-i18n-core.mjs`: locale matching, plural categories, and
  the `t()` fallback chain (no browser needed).
- `node tests/test-i18n-dom.mjs`: `applyI18n` against a minimal DOM stub,
  including `lang`/`dir` handling.

Both print `N passed, M failed` and exit non-zero on failure.
