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
 * ImgFetch, pages/rename.js
 * Extracted from pages/rename.html: MV3 blocks inline scripts (CSP),
 * so page logic must live in an external file.
 */
  (() => {
'use strict';
const UI = window.ImgFetchUI;

/* B: runtime localization. Classic script: no static imports, so the
 * i18n module loads lazily; English defaults stay until it resolves. */
let __t = null;
(async () => {
  try {
    const { initI18n, t, applyI18n, onLanguageChange } = await import('../shared/i18n.js');
    await initI18n();
    __t = t;
    applyI18n();
    onLanguageChange(() => { applyI18n(); paintFormatHint(); });
  } catch { /* English defaults remain */ }
})();

/** Translate a key; falls back to the given English when i18n is unavailable. */
function tr(key, english, vars) {
  if (__t) {
    try { return __t(key, vars); } catch { /* fall through */ }
  }
  return english;
}

const q = new URLSearchParams(location.search);
const srcUrl = q.get('src') || '';
const format = q.get('format') || 'as-is';
const mode = q.get('mode') || 'smart';
const pageUrl = q.get('pageUrl') || '';
const tabId = q.get('tabId') || '';

const $ = (id) => document.getElementById(id);
UI.applyTheme('system');

async function init() {
  if (srcUrl) $('preview').src = srcUrl;
  try {
    const { settings } = await UI.send('GET_SETTINGS');
    UI.applyTheme(settings.theme);
    const res = await UI.send('SUGGEST_FILENAME', { srcUrl, format, pageUrl });
    if (res && res.name) $('filename').value = res.name;
  } catch {
    /* fall back to URL hint */
    try {
      $('filename').value = (srcUrl.split('/').pop() || 'image').split('?')[0] || 'image';
    } catch { /* malformed URL; keep default filename */ }
  }
  paintFormatHint();
  $('filename').focus();
  $('filename').select();
}

function paintFormatHint() {
  const fmt = format && format !== 'as-is' ? format.toUpperCase() : tr('rename_originalFormat', 'original format');
  $('formatHint').textContent = tr('rename_formatHint', `Will be saved as ${fmt}. The correct extension is added automatically.`, { format: fmt });
}

$('btnSave').addEventListener('click', async () => {
  const customName = $('filename').value.trim();
  $('btnSave').disabled = true;
  try {
    await UI.send('DOWNLOAD_IMAGE', { srcUrl, mode, format, customName, pageUrl, tabId });
  } finally {
    window.close();
  }
});
$('btnCancel').addEventListener('click', () => window.close());
$('filename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnSave').click();
  if (e.key === 'Escape') window.close();
});

init();
  })();
