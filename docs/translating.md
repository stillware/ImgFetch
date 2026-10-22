# Translating ImgFetch

How localization works, how keys, placeholders, and plurals are handled, and how to add or fix a locale.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

All user visible strings live in `_locales/<code>/messages.json`, one folder
per locale. There are 21 locales covering 19 languages.
These translations were produced with AI assistance and have not been
reviewed by native speakers. Corrections are welcome through GitHub Issues
or a pull request.

## How i18n works

ImgFetch uses a custom loader, `shared/i18n.js`, not `chrome.i18n`, for user
interface strings. The loader lets the user pick a language in Settings and
switch at runtime without a reload. The default setting is `auto`, which
follows the browser language list.
`chrome.i18n` is used only for manifest strings, through the `__MSG_...__`
placeholders in `manifest.json`. The manifest default locale is `en`.

At runtime the loader:

1. Reads the stored `language` setting. An unknown value falls back to
   `auto`.
2. Resolves a locale code with `matchLocale`: an exact match first, then a
   base language match, then `en`.
3. Fetches `_locales/<code>/messages.json` and the English file, plus the
   base language file when the code has a region, for example `es` for
   `es_419`.
4. Resolves each key through `t()`: resolved locale first, then base
   language, then English, then the key itself. A broken locale file falls
   back to English and never throws.

`applyI18n` fills elements marked with `data-i18n` and `data-i18n-attr`,
and sets the `lang` and `dir` attributes on the page root element.
The locale list lives in `LOCALES` and the names and directions live in
`LOCALE_INFO`, both in `shared/i18n.js`.

## Key naming conventions

Keys are lowercase snake case with a surface prefix, an underscore, and a
camelCase descriptor. Real examples from `_locales/en/messages.json`:

| Pattern | Examples | Meaning |
|---|---|---|
| `appName`, `appDescription`, `appTagline` | `appName` | App level strings with no prefix |
| `ui_<name>` | `ui_cancel`, `ui_loading`, `ui_somethingWrong` | Generic interface strings |
| `popup_<name>` | `popup_home`, `popup_scanButton`, `popup_shotVisibleLabel` | Popup strings |
| `options_<name>` | `options_secDownloads` | Settings page strings |
| `results_<name>` | `results_titleFound_one`, `results_titleFound_other` | Scan results strings |
| `crop_<name>`, `parts_<name>`, `part_<name>` | `part_title_one` | Editor Crop and Parts overview strings |

Rules:

- Never rename a key. Code looks keys up by exact name.
- Keep every key in every locale. The checker enforces an identical key
  set, with plural variants expanded per locale (see below).
- Keep the `description` field in English. It is a note for translators and
  is never shown to users.
- Add a new string to `_locales/en/messages.json` first, then add it to
  every other locale in the same change.

## Placeholders

Dynamic values use `{name}` tokens inside the message, for example
`Download {count} images` and `{count} image found`.
A token name uses letters, digits, and underscores.

- Keep every token exactly as written. Never translate, rename, reorder the
  spelling of, or drop a token. `{count}` stays `{count}`.
- Every variant of a key must contain exactly the same set of tokens as the
  English source. The checker enforces this.
- If a token does not fit the grammar of your language, restructure the
  sentence around it and keep the token intact.
- An unknown token is left as it is at runtime, so a typo would be shown to
  users literally. The checker catches token typos as a set mismatch.

## Plural suffixes

A key is plural when its text varies with a count, passed as `vars.count`.
At runtime, `resolveMessage` in `shared/i18n.js` uses `Intl.PluralRules`
for the locale, then tries `key_<category>`, then `key_other`, then the
bare key.
English carries the `one` and `other` variants, for example
`results_titleFound_one` and `results_titleFound_other`.

Each locale must carry exactly the variants for its categories:

| Locales | Variants per plural key |
|---|---|
| `es`, `es_419`, `pt_BR`, `fr`, `de`, `it`, `nl` | `key_one`, `key_other` |
| `ru`, `uk`, `pl`, `cs` | `key_one`, `key_few`, `key_many`, `key_other` |
| `ar` | `key_zero`, `key_one`, `key_two`, `key_few`, `key_many`, `key_other` |
| `ja`, `ko`, `zh_CN`, `zh_TW`, `th`, `vi`, `id`, `tr` | The bare `key` only, never suffixed variants |

For example, Russian carries `results_titleFound_one`,
`results_titleFound_few`, `results_titleFound_many`, and
`results_titleFound_other`, while Japanese carries only
`results_titleFound`.

The collapsed locales in the last row have a single plural category in the
loader, so a suffixed variant there would never be used and the checker
rejects it as an extra key.

## RTL notes

Arabic (`ar`) is the only right to left locale. `LOCALE_INFO` marks it with
`dir: rtl`, and `applyI18n` sets `dir="rtl"` and `lang="ar"` on the page
root element.

Styles use CSS logical properties, such as `inset-inline-start`,
`inset-inline-end`, and `margin-inline`, instead of physical left and right
properties, so layouts mirror correctly in Arabic.
When you add a string, check that tokens and numbers read correctly in a
right to left sentence, and do not add direction marks unless a real layout
test shows they are needed.

## What not to translate

Leave these exactly as they are: the brand name `ImgFetch`; format names
(`PNG`, `JPG`, `JPEG`, `WebP`, `AVIF`, `GIF`, `SVG`, `BMP`); and keyboard
key names (`Ctrl`, `Shift`, `Alt`, `Enter`, `Esc`, `Delete`, `Backspace`,
`Tab`).

Shortcut hint sentences are translated in full, with the key names kept as
they are inside the sentence.
Never use an em dash or an en dash in a translation. Use a comma, a period,
a colon, or parentheses instead.

## Add a locale, step by step

1. Pick the locale code. Use the underscore form, for example `pt_BR` or
   `zh_CN`, never a hyphen form. The region is uppercase and a numeric
   region stays numeric, for example `es_419`.
2. Copy the English source folder: `_locales/en` to `_locales/<code>`.
   Each locale folder contains one file, `messages.json`.
3. Translate every `message` value in the new `messages.json`. Keep every
   key, every token, and every English `description` field.
4. Expand the plural variants for the new locale's categories (see the
   table above) and drop the variants it does not use.
5. Add the code to `LOCALES` and an entry to `LOCALE_INFO` in
   `shared/i18n.js`, with the English name, the native name, and the text
   direction (`ltr`, or `rtl` for a right to left language). Keep the list
   in the same order as the locale folders.
6. Add the code to the `LOCALES` list in `scripts/check-i18n.mjs`, and add
   its plural categories to that script's `CATEGORIES` map, or to its
   collapsed set if it carries the bare key only.
7. No separate dropdown step is needed. The Settings language picker is
   built from `LOCALES` and `LOCALE_INFO`, so the new language appears
   with its native name once step 5 is done.
8. Run the checker (below). It must print `check-i18n: OK`.
9. Run `node tests/test-i18n-core.mjs` and `node tests/test-i18n-dom.mjs`.

Bash copy command:

```bash
cp -r _locales/en _locales/<code>
```

PowerShell copy command:

```powershell
Copy-Item -Recurse _locales/en _locales/<code>
```

## Fix a translation

Edit the `message` value for the key in `_locales/<code>/messages.json`,
then run the checker. Do not rename keys.
If the English source itself is wrong, fix `_locales/en/messages.json`
first, then update every locale that carries the string.

## How the checker works

Run it from the repository root. It was run in this session.

```bash
node scripts/check-i18n.mjs
```

PowerShell:

```powershell
node scripts/check-i18n.mjs
```

A clean run prints `check-i18n: OK` and exits with code 0.
The checker fails with exit code 1 on any of the following:

- A missing locale folder or a missing `messages.json` (all 21 required).
- Invalid JSON in any locale file.
- A key missing in a locale, or an extra key in a locale, compared with the
  English key set with plural variants expanded per locale.
- A missing or unused plural form for the locale's categories.
- A placeholder mismatch: the set of tokens in a locale message differs
  from the English set for that key or variant.
- A non English value identical to the English value that is not on the
  reviewed allow list inside the script.
- A banned dash character in any message: U+2014, U+2013, or the sequence
  space, hyphen, hyphen, space.
- `appName` not equal to `ImgFetch` in any non English locale.

## Unit tests

- `node tests/test-i18n-core.mjs` covers locale matching, plural categories,
  and the `t()` fallback chain. It needs no browser.
- `node tests/test-i18n-dom.mjs` covers `applyI18n` against a minimal DOM
  stub, including `lang` and `dir` handling.

Both print a passed and failed count and exit with a nonzero code on
failure. See [the tests guide](tests/README.md).
