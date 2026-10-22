# 0003: Custom i18n Loader with 21 Locales

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

The browser's built in `chrome.i18n` ties strings to the browser language
and offers no supported way for a user to pick a different language inside
the extension and switch at runtime.
ImgFetch lets the user pick a language in Settings, with `auto` as the
default, and applies the change without a reload.
Strings live in standard `_locales/<code>/messages.json` files.

## Decision

Write a custom loader in `shared/i18n.js`. It resolves the stored setting
against its `LOCALES` list, fetches the locale file plus English and base
language fallbacks, selects plural variants with `Intl.PluralRules`, and
substitutes `{name}` placeholders.

Ship 21 locales covering 19 languages. Arabic is the right to left locale.
Use `chrome.i18n` only for manifest strings.

Guard the files with `scripts/check-i18n.mjs`, which enforces key parity,
placeholder parity, plural forms, and the banned dash rule.
The full guide is [the translating guide](../translating.md).

## Consequences

Language switching is instant and testable in Node, and the fallback chain
(resolved locale, base language, English, the key itself) means a broken
locale file degrades to English instead of breaking a page.
The cost is discipline: every locale must carry the same key set, so
adding one string means updating 21 files, and the checker is a required
step in every change that touches strings.
