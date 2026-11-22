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
 * ImgFetch, shared/theme-init.js
 * Tiny blocking script, loaded in <head> before shared/ui.css, so the
 * saved theme applies before first paint and the page never flashes the
 * wrong theme. No inline script is used anywhere (MV3 CSP).
 *
 * How it works: chrome.storage.local is async, so the saved theme cannot
 * be read synchronously before paint. Instead, UI.applyTheme keeps a
 * plain mirror of the theme choice in localStorage under 'imgfetch-theme',
 * and this script reads that mirror synchronously. When no mirror exists
 * yet (first run, or storage unavailable), the page paints with the
 * system theme, and the async read below corrects it from the real
 * settings as soon as they load. The page scripts still call
 * UI.applyTheme(settings.theme) at startup, which stays authoritative.
 */
(function () {
  'use strict';

  var MIRROR_KEY = 'imgfetch-theme';
  var root = document.documentElement;

  function resolve(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function apply(theme) {
    var resolved = resolve(theme);
    root.setAttribute('data-theme', resolved);
    try { root.style.colorScheme = resolved; } catch (e) { /* old browser; ignore */ }
    return resolved;
  }

  var stored = null;
  try {
    stored = window.localStorage ? window.localStorage.getItem(MIRROR_KEY) : null;
  } catch (e) {
    stored = null;
  }
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    apply(stored);
  } else {
    apply('system');
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('settings', function (res) {
        var theme = res && res.settings && res.settings.theme;
        if (theme === 'light' || theme === 'dark' || theme === 'system') {
          apply(theme);
          try {
            if (window.localStorage) window.localStorage.setItem(MIRROR_KEY, theme);
          } catch (e2) { /* mirror is best effort only */ }
        }
      });
    }
  } catch (e) { /* storage unavailable; the mirror above already applied */ }
})();
