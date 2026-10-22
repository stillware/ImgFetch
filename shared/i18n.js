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
 * ImgFetch, shared/i18n.js
 * Custom localization loader. chrome.i18n is used ONLY for the manifest
 * strings (via __MSG_..__); everything else goes through this module so the
 * user can pick a language manually and switch at runtime without reload.
 *
 * The module top level is side-effect free: no chrome.*, no document and no
 * fetch at import time, so Node tests and core/settings.js can import it.
 * Do NOT import core/settings.js here (import cycle risk); the raw stored
 * settings are read directly from chrome.storage.local.
 */

export const LOCALES = [
  'en', 'es', 'es_419', 'pt_BR', 'fr', 'de', 'it', 'nl', 'ru', 'uk', 'pl',
  'cs', 'tr', 'ar', 'zh_CN', 'zh_TW', 'ja', 'ko', 'id', 'vi', 'th',
];

export const LOCALE_INFO = {
  en: { englishName: 'English', dir: 'ltr' },
  es: { englishName: 'Spanish', dir: 'ltr' },
  es_419: { englishName: 'Latin American Spanish', dir: 'ltr' },
  pt_BR: { englishName: 'Brazilian Portuguese', dir: 'ltr' },
  fr: { englishName: 'French', dir: 'ltr' },
  de: { englishName: 'German', dir: 'ltr' },
  it: { englishName: 'Italian', dir: 'ltr' },
  nl: { englishName: 'Dutch', dir: 'ltr' },
  ru: { englishName: 'Russian', dir: 'ltr' },
  uk: { englishName: 'Ukrainian', dir: 'ltr' },
  pl: { englishName: 'Polish', dir: 'ltr' },
  cs: { englishName: 'Czech', dir: 'ltr' },
  tr: { englishName: 'Turkish', dir: 'ltr' },
  ar: { englishName: 'Arabic', dir: 'rtl' },
  zh_CN: { englishName: 'Simplified Chinese', dir: 'ltr' },
  zh_TW: { englishName: 'Traditional Chinese', dir: 'ltr' },
  ja: { englishName: 'Japanese', dir: 'ltr' },
  ko: { englishName: 'Korean', dir: 'ltr' },
  id: { englishName: 'Indonesian', dir: 'ltr' },
  vi: { englishName: 'Vietnamese', dir: 'ltr' },
  th: { englishName: 'Thai', dir: 'ltr' },
};

// Base language codes whose plural system has a single category: they carry
// the bare key only, never suffixed plural variants.
const COLLAPSED_BASES = new Set(['ja', 'ko', 'zh', 'th', 'vi', 'id', 'tr']);

function isCollapsedCode(code) {
  return COLLAPSED_BASES.has(String(code || '').split('_')[0].toLowerCase());
}

/**
 * Normalize a BCP 47 tag to the underscore form used for locale folders:
 * lowercase language, uppercase region, '-' becomes '_'.
 * "pt-BR" -> "pt_BR", "es-419" -> "es_419", "en-US" -> "en_US".
 */
export function normalizeTag(tag) {
  const raw = String(tag || '').trim().replace(/-/g, '_');
  if (!raw) return '';
  const parts = raw.split('_');
  const lang = parts[0].toLowerCase();
  if (parts.length === 1) return lang;
  const rest = parts.slice(1).map((p) => (/^\d+$/.test(p) ? p : p.toUpperCase()));
  return [lang, ...rest].join('_');
}

/**
 * Best-match a locale code from an ordered list of language tags
 * (navigator.languages style). Exact match wins, then base-language match
 * (first LOCALES entry sharing the base, e.g. "pt" -> "pt_BR",
 * "zh" -> "zh_CN"), then "en". Pure: uses LOCALES only.
 */
export function matchLocale(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const norm = list.map(normalizeTag).filter(Boolean);
  for (const tag of norm) {
    if (LOCALES.includes(tag)) return tag;
  }
  for (const tag of norm) {
    const base = tag.split('_')[0];
    const hit = LOCALES.find((c) => c.split('_')[0] === base);
    if (hit) return hit;
  }
  return 'en';
}

/** Intl plural category for a locale code and an integer count. */
export function pluralCategory(code, n) {
  const tag = String(code || 'en').replace(/_/g, '-');
  try {
    return new Intl.PluralRules(tag).select(Number(n));
  } catch {
    return 'other';
  }
}

/** Replace {name} tokens from vars; unknown tokens are left as-is. */
function substitute(message, vars) {
  if (typeof message !== 'string') return message;
  if (!vars || typeof vars !== 'object') return message;
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  ));
}

/**
 * Pure message resolution over an ordered chain of message dicts
 * (resolved locale, base language, en). Handles plural selection when
 * vars.count is an integer and placeholder substitution. Never throws and
 * never returns undefined: the key itself is the last resort.
 */
export function resolveMessage(dicts, key, vars, code) {
  try {
    const list = Array.isArray(dicts) ? dicts : [];
    const count = vars && Number.isInteger(vars.count) ? vars.count : null;
    let variants;
    if (count === null || isCollapsedCode(code)) {
      variants = [key];
    } else {
      const cat = pluralCategory(code, count);
      variants = [`${key}_${cat}`, `${key}_other`, key];
    }
    for (const vk of variants) {
      for (const d of list) {
        if (d && typeof d[vk] === 'string') return substitute(d[vk], vars);
      }
    }
    return substitute(key, vars);
  } catch {
    return typeof key === 'string' ? key : '';
  }
}

/* ------------------------------------------------------------------ */
/* Runtime state (populated by initI18n, read by t/getLocale)          */
/* ------------------------------------------------------------------ */

const state = {
  locale: 'en',
  language: 'auto',
  messages: null, // resolved locale dict (key -> message)
  baseMessages: null, // base language dict, when the code has a region
  enMessages: null, // English fallback dict
};

const messageCache = new Map(); // code -> dict | null

async function loadMessages(code) {
  if (messageCache.has(code)) return messageCache.get(code);
  let dict = null;
  try {
    if (
      typeof chrome !== 'undefined' && chrome && chrome.runtime &&
      typeof chrome.runtime.getURL === 'function' && typeof fetch === 'function'
    ) {
      const url = chrome.runtime.getURL(`_locales/${code}/messages.json`);
      const res = await fetch(url);
      if (res && res.ok) {
        const json = await res.json();
        dict = {};
        for (const [k, v] of Object.entries(json || {})) {
          if (v && typeof v.message === 'string') dict[k] = v.message;
        }
      }
    }
  } catch {
    dict = null; // a broken locale file falls back to English, never throws
  }
  messageCache.set(code, dict);
  return dict;
}

async function resolveAndLoad() {
  let language = 'auto';
  try {
    if (
      typeof chrome !== 'undefined' && chrome && chrome.storage &&
      chrome.storage.local && typeof chrome.storage.local.get === 'function'
    ) {
      const stored = await chrome.storage.local.get('settings');
      const s = stored && stored.settings;
      if (s && typeof s.language === 'string') language = s.language;
    }
  } catch {
    language = 'auto';
  }
  if (language !== 'auto' && !LOCALES.includes(language)) language = 'auto';
  state.language = language;

  let code = 'en';
  if (language === 'auto') {
    const langs = (typeof navigator !== 'undefined' && Array.isArray(navigator.languages) && navigator.languages.length)
      ? navigator.languages
      : ['en'];
    code = matchLocale(langs);
  } else {
    code = language;
  }
  state.locale = code;

  const [dict, enDict] = await Promise.all([loadMessages(code), loadMessages('en')]);
  state.messages = dict;
  state.enMessages = enDict;
  const base = code.split('_')[0];
  state.baseMessages = base !== code ? await loadMessages(base) : null;
  return code;
}

/**
 * Initialize the locale: read the language setting, resolve the locale,
 * fetch the message files. Resolves with the locale code. Never rejects:
 * on any failure the locale falls back to "en" (t() then returns keys).
 */
export function initI18n() {
  return resolveAndLoad().catch(() => {
    state.locale = 'en';
    state.language = 'auto';
    return 'en';
  });
}

/**
 * Translate a key. Lookup order: resolved locale, base language, English,
 * then the key itself. vars fills {placeholders}; an integer vars.count
 * selects the plural variant. Never throws, never returns undefined.
 */
export function t(key, vars) {
  try {
    const dicts = [state.messages, state.baseMessages, state.enMessages];
    return resolveMessage(dicts, key, vars, state.locale);
  } catch {
    return typeof key === 'string' ? key : '';
  }
}

/** The currently resolved locale code, e.g. "pt_BR". */
export function getLocale() {
  return state.locale;
}

const languageListeners = new Set();

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLanguageChange(cb) {
  if (typeof cb !== 'function') return () => {};
  languageListeners.add(cb);
  return () => { languageListeners.delete(cb); };
}

function notifyLanguageChange() {
  for (const cb of [...languageListeners]) {
    try {
      cb(state.locale);
    } catch {
      // A listener must never break language switching.
    }
  }
}

/**
 * Persist a new language choice ("auto" or a locale code), reload messages
 * and notify listeners. Throws on an invalid code or missing chrome.storage.
 */
export async function setLanguage(code) {
  if (code !== 'auto' && !LOCALES.includes(code)) {
    throw new Error(`ImgFetch: unsupported language "${String(code)}"`);
  }
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    throw new Error('ImgFetch: chrome.storage is unavailable');
  }
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...((stored && stored.settings) || {}), language: code };
  await chrome.storage.local.set({ settings });
  await resolveAndLoad();
  notifyLanguageChange();
  return state.locale;
}

/**
 * Localize a scope (defaults to document): set <html> lang/dir, fill
 * [data-i18n] text and [data-i18n-attr] attributes ("attr:key;attr:key").
 * Safe to call when document is undefined (Node): it does nothing.
 */
export function applyI18n(root) {
  const hasDocument = typeof document !== 'undefined';
  const scope = root && typeof root.querySelectorAll === 'function' ? root : (hasDocument ? document : null);
  if (!scope) return;
  try {
    const code = state.locale || 'en';
    if (hasDocument && document.documentElement) {
      document.documentElement.setAttribute('lang', code.replace(/_/g, '-'));
      const dir = LOCALE_INFO[code] && LOCALE_INFO[code].dir === 'rtl' ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('dir', dir);
    }
    const textEls = scope.querySelectorAll('[data-i18n]');
    for (const el of textEls) {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    }
    const attrEls = scope.querySelectorAll('[data-i18n-attr]');
    for (const el of attrEls) {
      const spec = el.getAttribute('data-i18n-attr');
      if (!spec) continue;
      for (const pair of spec.split(';')) {
        const idx = pair.indexOf(':');
        if (idx <= 0) continue;
        const attr = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
  } catch {
    // Localizing must never break page rendering.
  }
}
