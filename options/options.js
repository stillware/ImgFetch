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
 * ImgFetch, options/options.js
 * Settings page controller. Every change saves automatically (debounced).
 */
import { parseSettingsImport, buildFilename, SETTINGS_IMPORT_MAX_CHARS } from '../core/filenames.js';
import { stripUnknownSettings } from '../core/settings.js';
import { initI18n, t, applyI18n, onLanguageChange, setLanguage, LOCALES, LOCALE_INFO } from '../shared/i18n.js';
import { normalizeHost } from '../core/urls.js';
import { hasHostPermission, requestHostPermission, HOST_PERMISSION_ORIGINS } from '../shared/offscreen-bridge.js';
import { groupByDay } from '../core/history.js';
import { buildHistoryRow, historyCountLabel, wireClearHistory, updateHistoryRowThumb } from '../shared/history-ui.js';

const UI = window.ImgFetchUI;

// B: runtime localization. No top-level await; init() awaits i18nReady.
const i18nReady = initI18n();
const $ = (id) => document.getElementById(id);

// Public repository URL. Used by the About section links.
const GITHUB_REPO = 'https://github.com/stillware/ImgFetch';

let settings = null;
let saveTimer = 0;
let savePillTimer = 0;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await i18nReady;
  applyI18n();
  onLanguageChange(() => { applyI18n(); paintAboutPrivacy(); paintPrivacyPermNote(); buildSettingsSearchIndex(); applySettingsSearchFilter(false); if (UI.refreshDropdowns) UI.refreshDropdowns(document); });
  try {
    const res = await UI.send('GET_SETTINGS');
    settings = res.settings;
  } catch (err) {
    UI.toast(err.message);
    return;
  }
  UI.applyTheme(settings.theme);
  UI.watchSystemTheme(() => settings.theme);
  buildLanguageOptions();
  paintAll();
  // Phase 5 A7: one shared custom dropdown per native select.
  if (UI.initDropdowns) UI.initDropdowns(document);
  wireAll();
  $('aboutVersion').textContent = chrome.runtime.getManifest().version;
  $('optionsVersion').textContent = `${t('about_version')} ${chrome.runtime.getManifest().version}`;
  $('aboutLicenceLink').href = GITHUB_REPO + '/blob/main/LICENSE';
  $('aboutRepoLink').href = GITHUB_REPO;
  $('aboutRepoLink').textContent = GITHUB_REPO.replace('https://', '');
  // B: aboutPrivacyLink is created by paintAboutPrivacy() (wireAbout).
}

function scheduleSave() {
  const el = $('saveState');
  const pill = $('savePill');
  // G2: the pill text swaps (150 ms) instead of jumping.
  UI.swapText(el, t('options_saving'));
  pill.hidden = false;
  pill.className = 'save-pill saving';
  clearTimeout(saveTimer);
  clearTimeout(savePillTimer);
  saveTimer = setTimeout(async () => {
    try {
      const res = await UI.send('SAVE_SETTINGS', { settings });
      settings = res.settings;
      UI.applyTheme(settings.theme);
      UI.swapText(el, t('options_saved'));
      pill.className = 'save-pill';
      // The pill appears briefly after a save, then hides again.
      savePillTimer = setTimeout(() => { pill.hidden = true; }, 2600);
    } catch (err) {
      UI.swapText(el, t('options_saveFailed'));
      pill.className = 'save-pill error';
      UI.toast(err.message);
    }
  }, 350);
}

/* ---------------- paint ---------------- */

function seg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === value));
  });
}

/**
 * The slider track fill is a CSS gradient driven by --fill (see
 * shared/ui.css): set it from the value so the filled part matches the
 * thumb position in both themes.
 */
function syncRangeFill(input) {
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct}%`);
}

/** Example values for the live file name preview (clearly an example). */
const FILENAME_PREVIEW_CTX = {
  site: 'example',
  name: 'sunset',
  date: new Date(2026, 9, 2, 10, 30, 0),
  num: 1,
  width: 1920,
  height: 1080,
  ext: 'jpg',
};

function paintFilenamePreview() {
  const preview = $('fnPreview');
  if (!preview) return;
  const input = $('customTemplate');
  const template = input ? input.value : '';
  preview.textContent = buildFilename('custom', { ...FILENAME_PREVIEW_CTX, custom: template });
}

/**
 * Estimated result line (Quality): the mockup shows a sample photo size,
 * but no source image exists on this page, so no size can be computed
 * honestly. The line instead states the live conversion qualities
 * from settings, and updates on every slider move.
 */
function paintQualityEstimate() {
  const el = $('qualityEstimateText');
  if (!el || !settings) return;
  el.textContent = t('q_estimateLine', {
    jpg: `${Math.round(settings.jpgQuality * 100)}%`,
    webp: `${Math.round(settings.webpQuality * 100)}%`,
    png: `${Math.round(settings.pngQuality * 100)}%`,
  });
}

/** Token chips insert their token at the cursor in the template field. */
function wireFilenameTokens() {
  document.querySelectorAll('#tokenChips .token-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const input = $('customTemplate');
      if (!input) return;
      const token = chip.dataset.token || '';
      const start = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      const pos = start + token.length;
      input.focus();
      input.setSelectionRange(pos, pos);
      settings.customTemplate = input.value;
      paintFilenamePreview();
      scheduleSave();
    });
  });
}

function paintAll() {
  seg('themeSeg', settings.theme);
  seg('afterDlSeg', settings.afterDownload);
  seg('shotFormatSeg', settings.screenshotFormat);
  document.querySelectorAll('input[name="qualityPreference"]').forEach((r) => {
    r.checked = r.value === settings.qualityPreference;
  });

  $('saveAsDialog').checked = settings.saveAsDialog;
  $('autoRetryOnce').checked = settings.autoRetryOnce;
  $('maxConcurrent').value = settings.maxConcurrent;
  $('maxConcVal').textContent = settings.maxConcurrent;
  syncRangeFill($('maxConcurrent'));

  document.querySelectorAll('input[name="filenameMode"]').forEach((r) => {
    r.checked = r.value === settings.filenameMode;
  });
  $('customTemplate').value = settings.customTemplate;
  $('customTemplateWrap').hidden = settings.filenameMode !== 'custom';
  paintFilenamePreview();

  $('folderMode').value = settings.folderMode;
  $('subfolder').value = settings.subfolder;
  $('useSubfolder').checked = settings.useSubfolder === true;
  syncSubfolderField();

  $('jpgQuality').value = settings.jpgQuality;
  $('jpgQVal').textContent = `${Math.round(settings.jpgQuality * 100)}%`;
  syncRangeFill($('jpgQuality'));
  $('pngQuality').value = settings.pngQuality;
  $('pngQVal').textContent = `${Math.round(settings.pngQuality * 100)}%`;
  syncRangeFill($('pngQuality'));
  $('webpQuality').value = settings.webpQuality;
  $('webpQVal').textContent = `${Math.round(settings.webpQuality * 100)}%`;
  syncRangeFill($('webpQuality'));
  paintQualityEstimate();
  $('screenshotQuality').value = settings.screenshotQuality;
  $('shotQVal').textContent = `${Math.round(settings.screenshotQuality * 100)}%`;
  syncRangeFill($('screenshotQuality'));

  $('minSizePreset').value = settings.minSizePreset;
  $('includeBackgrounds').checked = settings.includeBackgrounds;
  seg('scanDepthSeg', settings.scanDepth === 'loaded' ? 'loaded' : 'scroll');
  $('dedupeScan').checked = settings.dedupeScan;
  $('annotateAfterCapture').checked = settings.annotateAfterCapture;
  $('askFilename').checked = settings.askFilename;
  $('autoCollapseQueue').checked = settings.autoCollapseQueue !== false;

  $('language').value = settings.language || 'auto';
  $('historyEnabled').checked = settings.historyEnabled;
  $('historyRetentionDays').value = settings.historyRetentionDays;

  renderSiteList();
}

/* ---------------- wire ---------------- */

function wireSeg(id, key) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.addEventListener('click', () => {
      settings[key] = b.dataset.v;
      seg(id, b.dataset.v);
      scheduleSave();
    });
  });
}

function wireCheck(id, key) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    scheduleSave();
  });
}

/** The subfolder name field is only meaningful while its toggle is on. */
function syncSubfolderField() {
  const on = $('useSubfolder').checked;
  $('subfolder').disabled = !on;
  $('subfolder').closest('.field').style.opacity = on ? '' : '0.55';
}

function wireAll() {
  wireSeg('themeSeg', 'theme');
  wireFilenameTokens();
  wireSeg('afterDlSeg', 'afterDownload');
  wireSeg('shotFormatSeg', 'screenshotFormat');
  document.querySelectorAll('input[name="qualityPreference"]').forEach((r) => {
    r.addEventListener('change', () => {
      settings.qualityPreference = document.querySelector('input[name="qualityPreference"]:checked').value;
      scheduleSave();
    });
  });

  wireCheck('saveAsDialog', 'saveAsDialog');
  wireCheck('autoRetryOnce', 'autoRetryOnce');
  wireCheck('includeBackgrounds', 'includeBackgrounds');
  document.querySelectorAll('#scanDepthSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      settings.scanDepth = b.dataset.v;
      settings.detectLazyScroll = b.dataset.v === 'scroll'; // keep legacy alias in sync
      seg('scanDepthSeg', b.dataset.v);
      scheduleSave();
    });
  });
  wireCheck('dedupeScan', 'dedupeScan');
  wireCheck('annotateAfterCapture', 'annotateAfterCapture');
  wireCheck('askFilename', 'askFilename');
  wireCheck('historyEnabled', 'historyEnabled');
  wireCheck('autoCollapseQueue', 'autoCollapseQueue');
  wireCheck('useSubfolder', 'useSubfolder');
  $('useSubfolder').addEventListener('change', syncSubfolderField);

  $('maxConcurrent').addEventListener('input', (e) => {
    settings.maxConcurrent = Number(e.target.value);
    $('maxConcVal').textContent = e.target.value;
    syncRangeFill(e.target);
    scheduleSave();
  });
  $('jpgQuality').addEventListener('input', (e) => {
    settings.jpgQuality = Number(e.target.value);
    $('jpgQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    syncRangeFill(e.target);
    paintQualityEstimate();
    scheduleSave();
  });
  $('pngQuality').addEventListener('input', (e) => {
    settings.pngQuality = Number(e.target.value);
    $('pngQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    syncRangeFill(e.target);
    paintQualityEstimate();
    scheduleSave();
  });
  $('webpQuality').addEventListener('input', (e) => {
    settings.webpQuality = Number(e.target.value);
    $('webpQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    syncRangeFill(e.target);
    paintQualityEstimate();
    scheduleSave();
  });
  $('screenshotQuality').addEventListener('input', (e) => {
    settings.screenshotQuality = Number(e.target.value);
    $('shotQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    syncRangeFill(e.target);
    scheduleSave();
  });

  document.querySelectorAll('input[name="filenameMode"]').forEach((r) => {
    r.addEventListener('change', () => {
      settings.filenameMode = document.querySelector('input[name="filenameMode"]:checked').value;
      $('customTemplateWrap').hidden = settings.filenameMode !== 'custom';
      paintFilenamePreview();
      scheduleSave();
    });
  });
  $('customTemplate').addEventListener('input', UI.debounce((e) => {
    settings.customTemplate = e.target.value;
    paintFilenamePreview();
    scheduleSave();
  }));
  $('subfolder').addEventListener('input', UI.debounce((e) => {
    settings.subfolder = e.target.value;
    scheduleSave();
  }));
  $('minSizePreset').addEventListener('change', (e) => {
    settings.minSizePreset = e.target.value;
    scheduleSave();
  });
  $('folderMode').addEventListener('change', (e) => {
    settings.folderMode = e.target.value;
    scheduleSave();
  });
  $('historyRetentionDays').addEventListener('change', (e) => {
    const n = Math.min(365, Math.max(1, Math.round(Number(e.target.value) || 30)));
    settings.historyRetentionDays = n;
    e.target.value = n;
    scheduleSave();
  });

  wireSites();
  wireHistorySection();
  wireBackup();
  wireScreenshots();
  wireLanguage();
  wireShortcuts();
  wireAbout();
  wireSidebar();
  wireSidebarSearch();
}

/* ---------------- language ---------------- */

/**
 * B: language picker. Option labels use each locale's native name from
 * shared/i18n.js LOCALE_INFO (nativeName): the same strings messages.json
 * carries as languageName, but available without fetching 21 locale files,
 * so the page opens faster. The first option ("auto") is translated via
 * data-i18n; locale names are never translated, so they carry no
 * data-i18n attributes.
 */
function buildLanguageOptions() {
  const select = $('language');
  if (!select) return;
  for (const code of LOCALES) {
    const opt = document.createElement('option');
    opt.value = code;
    const info = LOCALE_INFO[code] || {};
    const label = info.nativeName || info.englishName || code;
    opt.textContent = `${label} (${info.englishName || code})`;
    select.append(opt);
  }
}

function wireLanguage() {
  const select = $('language');
  if (!select) return;
  select.addEventListener('change', () => {
    const code = select.value;
    settings.language = code;
    scheduleSave(); // debounced SAVE_SETTINGS, the same path as every option
    // Re-render in the new language immediately, without a reload.
    setLanguage(code).catch(() => {});
  });
}

/* ---------------- site preferences ---------------- */

function renderSiteList() {
  const list = $('siteList');
  if (UI.destroyDropdowns) UI.destroyDropdowns(list);
  list.textContent = '';
  const entries = Object.entries(settings.sitePrefs || {});
  if (!entries.length) {
    list.append(UI.el('p', t('sp_empty'), 'muted small'));
    return;
  }
  const frag = document.createDocumentFragment();
  const labels = { smart: t('sp_smart'), best: t('sp_smart'), normal: t('sp_asShown'), disabled: t('sp_paused') };
  for (const [host, mode] of entries.sort()) {
    const row = UI.el('div', null, 'site-row');
    const name = UI.el('strong', host);
    name.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis;';
    const select = document.createElement('select');
    select.className = 'inline';
    select.setAttribute('aria-label', t('sp_behaviorAria', { host }));
    for (const [v, label] of Object.entries(labels)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      if (v === mode) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      settings.sitePrefs[host] = select.value;
      scheduleSave();
    });
    const remove = UI.el('button', t('sp_remove'), 'btn btn-sm btn-ghost');
    remove.addEventListener('click', () => {
      delete settings.sitePrefs[host];
      renderSiteList();
      scheduleSave();
    });
    row.append(name, select, remove);
    frag.append(row);
  }
  list.append(frag);
  if (UI.initDropdowns) UI.initDropdowns(list);
}

function cleanHost(raw) {
  return normalizeHost(raw); // single shared rule, see core/urls.js (H9)
}

function wireSites() {
  $('btnAddSite').addEventListener('click', () => {
    const host = cleanHost($('siteHost').value);
    if (!host) {
      UI.toast(t('sp_typeDomain'));
      return;
    }
    settings.sitePrefs[host] = settings.sitePrefs[host] || 'smart';
    $('siteHost').value = '';
    renderSiteList();
    scheduleSave();
    UI.toast(t('sp_added', { host }));
  });
  $('btnCurrentSite').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = tab && tab.url ? cleanHost(new URL(tab.url).hostname) : '';
      if (!host) {
        UI.toast(t('sp_noCurrentSite'));
        return;
      }
      $('siteHost').value = host;
      UI.toast(t('sp_currentSiteIs', { host }));
    } catch {
      UI.toast(t('sp_noCurrentSite'));
    }
  });
}

/* ---------------- download history ---------------- */

function wireHistorySection() {
  // B1: the "Show thumbnails in history" toggle. options.html is not
  // edited in this phase, so the row is built here in the existing
  // switch-row style (same classes as the historyEnabled row above it).
  // data-i18n attributes keep it translated when the language changes.
  const enabledRow = $('historyEnabled') && $('historyEnabled').closest('label');
  if (enabledRow && enabledRow.parentNode && !$('historyShowThumbnails')) {
    const thumbsRow = document.createElement('label');
    thumbsRow.className = 'switch-row opt-row';
    const rowText = document.createElement('span');
    rowText.className = 'opt-row-text';
    const strong = document.createElement('strong');
    strong.setAttribute('data-i18n', 'hi_showThumbs');
    strong.textContent = t('hi_showThumbs');
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.setAttribute('data-i18n', 'hi_showThumbsHint');
    hint.textContent = t('hi_showThumbsHint');
    rowText.append(strong, hint);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch';
    input.setAttribute('role', 'switch');
    input.id = 'historyShowThumbnails';
    input.checked = settings.historyShowThumbnails !== false;
    input.addEventListener('change', (e) => {
      settings.historyShowThumbnails = e.target.checked;
      scheduleSave();
      loadOptHistory(); // hide or show the stored thumbnails at once
    });
    thumbsRow.append(rowText, input);
    enabledRow.parentNode.insertBefore(thumbsRow, enabledRow.nextSibling);
  }
  // B1 backfill: a thumbnail that arrives while this section is open
  // updates its row in place, without re-rendering the list.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      // H2: the worker is the only sender of HISTORY_THUMB broadcasts.
      if (!sender || sender.id !== chrome.runtime.id) return;
      if (!msg || msg.type !== 'HISTORY_THUMB' || !msg.id || !msg.thumb) return;
      const row = document.querySelector(`[data-record-id="${CSS.escape(String(msg.id))}"]`);
      if (row) updateHistoryRowThumb(row, msg.thumb);
    });
  }
  loadOptHistory();
  wireClearHistory($('btnClearHistory'), {
    t,
    toast: (msg) => UI.toast(msg),
    clear: () => UI.send('CLEAR_HISTORY'),
    onCleared: () => loadOptHistory(),
    list: $('optHistoryList'),
    swapText: (node, text) => UI.swapText(node, text),
  });
}

let optHistoryLoadSeq = 0;
async function loadOptHistory() {
  const seq = ++optHistoryLoadSeq;
  const list = $('optHistoryList');
  list.textContent = '';
  try {
    const { records } = await UI.send('GET_HISTORY');
    // A newer load started while we awaited (e.g. rapid section switches),
    // only the latest may paint, or rows duplicate.
    if (seq !== optHistoryLoadSeq) return;
    if (!records || !records.length) {
      const p = UI.el('p', t('history_empty'), 'muted small');
      list.append(p);
      // G2: the empty state fades in over 250 ms.
      if (UI.fadeIn) UI.fadeIn(p);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const group of groupByDay(records, t)) {
      const head = UI.el('div', null, 'hist-day'); head.append(UI.el('span', `${group.label} · `), UI.el('span', historyCountLabel(group.count, t), 'hist-count')); frag.append(head);
      for (const r of group.items) {
        frag.append(buildHistoryRow(r, {
          t,
          formatSize: (rec) => UI.formatHistorySize(rec),
          showDownload: (dlId) => UI.send('SHOW_DOWNLOAD', { downloadId: String(dlId) }),
          toast: (msg) => UI.toast(msg),
          showThumbnails: !settings || settings.historyShowThumbnails !== false,
        }));
      }
    }
    list.append(frag);
    // G2: history rows enter with a 40 ms stagger, first 8 rows only.
    if (UI.stagger) UI.stagger(list, '.hist-item', 8);
    // B1 backfill: thumbnail the records that still have no thumb, in
    // the background. The worker caps it at 12 per view open and
    // broadcasts each finished thumbnail (HISTORY_THUMB above).
    UI.send('BACKFILL_HISTORY_THUMBS').catch(() => {});
  } catch (err) {
    list.append(UI.el('p', err.message, 'muted small'));
  }
}

/* ---------------- backup & reset ---------------- */

function wireBackup() {
  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ imgfetch: 1, version: 1, settings }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'imgfetch-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    UI.toast(t('bk_exported'));
  });

  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    // H6: refuse an oversized import file before reading it into memory.
    if (file.size > SETTINGS_IMPORT_MAX_CHARS) {
      UI.toast(t('bk_importInvalid'));
      return;
    }
    try {
      const text = await file.text();
      const data = parseSettingsImport(text);
      // H6: an import accepts only known settings keys. Unknown fields
      // (and any __proto__ key) are dropped here, before SAVE_SETTINGS.
      const imported = stripUnknownSettings(
        data.settings && typeof data.settings === 'object' ? data.settings : data,
      );
      const res = await UI.send('SAVE_SETTINGS', { settings: imported });
      settings = res.settings;
      paintAll();
      UI.toast(t('bk_imported'));
    } catch {
      UI.toast(t('bk_importInvalid'));
    }
  });

  $('btnReset').addEventListener('click', async () => {
    const ok = await UI.confirmDialog({
      title: t('options_resetTitle'),
      message: t('options_resetMessage'),
      confirmLabel: t('options_resetConfirm'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await UI.send('RESET_SETTINGS');
      settings = res.settings;
      paintAll();
      UI.toast(t('options_resetDone'));
    } catch (err) {
      UI.toast(err.message);
    }
  });
}

/* ---------------- screenshots: capture now ---------------- */

function wireScreenshots() {
  const run = async (type, label) => {
    try {
      const res = await UI.send(type);
      if (res && res.cancelled) return;
      UI.toast(t('sh_captured', { label }));
    } catch (err) {
      UI.toast(err.message);
    }
  };
  $('shotNowVisible').addEventListener('click', () => run('CAPTURE_VISIBLE', t('sh_capturedVisible')));
  $('shotNowArea').addEventListener('click', () => run('CAPTURE_AREA', t('sh_capturedArea')));
  $('shotNowElement').addEventListener('click', () => run('CAPTURE_ELEMENT', t('sh_capturedElement')));
  $('shotNowFull').addEventListener('click', () => run('CAPTURE_FULL', t('sh_capturedFull')));
}

/* ---------------- shortcuts: real bindings ---------------- */

// B: command name -> message key; labels resolve via t() at render time,
// after initI18n() has loaded the locale.
const COMMAND_LABEL_KEYS = {
  'imgfetch-scan-page': 'kb_scanPage',
  'imgfetch-scan-page-alt': 'kb_scanPageAlt',
  'imgfetch-select-element': 'kb_selectElement',
  'imgfetch-capture-area': 'kb_captureArea',
  'imgfetch-capture-element': 'kb_captureElement',
};

// Mockup order for the shortcuts list (getAll() order is not stable).
const COMMAND_ORDER = [
  'imgfetch-scan-page',
  'imgfetch-capture-area',
  'imgfetch-select-element',
  'imgfetch-capture-element',
  'imgfetch-scan-page-alt',
];

/**
 * Phase 5 A5: the shortcuts label column follows the longest label.
 * Measures each label unwrapped with an offscreen probe in the label
 * font, then sets --kb-label-w on the list, clamped to 160..320px, so
 * the keys column starts at the same X in every row, in every locale.
 */
function sizeShortcutLabels(list) {
  const labels = [...list.querySelectorAll('.kb-row-label')];
  if (!labels.length) return;
  const probe = document.createElement('span');
  const cs = getComputedStyle(labels[0]);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
  probe.style.font = cs.font;
  document.body.appendChild(probe);
  let max = 0;
  for (const l of labels) { probe.textContent = l.textContent; max = Math.max(max, probe.offsetWidth); }
  probe.remove();
  const w = Math.min(320, Math.max(160, Math.ceil(max)));
  list.style.setProperty('--kb-label-w', `${w}px`);
}

async function wireShortcuts() {
  const list = $('shortcutList');
  try {
    const commands = await chrome.commands.getAll();
    const byName = new Map(commands.map((c) => [c.name, c]));
    // Render in the mockup order, not the getAll() order.
    const known = COMMAND_ORDER.map((name) => byName.get(name)).filter((c) => c && COMMAND_LABEL_KEYS[c.name]);
    list.textContent = '';
    if (!known.length) {
      list.append(UI.el('p', t('kb_none'), 'small muted'));
    } else {
      for (const c of known) {
        const row = UI.el('div', null, 'kb-row');
        row.append(UI.el('span', t(COMMAND_LABEL_KEYS[c.name]), 'kb-row-label'));
        const keys = UI.el('span', null, 'kb-keys');
        if (c.shortcut) {
          for (const part of String(c.shortcut).split('+')) {
            keys.append(UI.el('kbd', part.trim(), 'keycap'));
          }
        } else {
          keys.append(UI.el('span', t('kb_notSet'), 'badge badge-warn'));
        }
        row.append(keys);
        list.append(row);
      }
      sizeShortcutLabels(list);
    }
  } catch {
    list.textContent = '';
    list.append(UI.el('p', t('kb_readFailed'), 'small muted'));
  }
  $('btnCopyShortcutLink').addEventListener('click', async () => {
    // L2: Edge uses edge://, Chrome uses chrome://.
    const scheme = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
    const link = `${scheme}://extensions/shortcuts`;
    try {
      await navigator.clipboard.writeText(link);
      UI.toast(t('kb_linkCopied'));
    } catch {
      UI.toast(link);
    }
  });
}

/* ---------------- about ---------------- */

// B: permission -> message key; descriptions resolve via t() at render time,
// after initI18n() has loaded the locale.
const PERMISSION_DESCRIPTION_KEYS = {
  contextMenus: 'perm_contextMenus',
  downloads: 'perm_downloads',
  storage: 'perm_storage',
  scripting: 'perm_scripting',
  activeTab: 'perm_activeTab',
  offscreen: 'perm_offscreen',
  notifications: 'perm_notifications',
  clipboardWrite: 'perm_clipboardWrite',
};

/**
 * B: the About privacy sentence carries a live PRIVACY.md link inside a
 * translated sentence. Rebuild the paragraph from t('about_privacyText'),
 * splitting on the (never translated) file name so the link survives
 * applyI18n(), which would otherwise wipe the anchor. Called at init and
 * on every language change; the English default is byte-identical.
 */
const PRIVACY_LINK_TEXT = 'PRIVACY.md';
function paintAboutPrivacy() {
  const p = $('aboutPrivacyText');
  if (!p) return;
  const full = t('about_privacyText');
  const a = document.createElement('a');
  a.id = 'aboutPrivacyLink';
  a.href = GITHUB_REPO + '/blob/main/PRIVACY.md';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = PRIVACY_LINK_TEXT;
  p.textContent = '';
  const i = full.indexOf(PRIVACY_LINK_TEXT);
  if (i >= 0) {
    p.append(
      document.createTextNode(full.slice(0, i)),
      a,
      document.createTextNode(full.slice(i + PRIVACY_LINK_TEXT.length)),
    );
  } else {
    // A translation that drops the file name: keep the link anyway.
    p.append(document.createTextNode(full + ' '), a);
  }
}

/**
 * The Privacy section links to the full statement in the public
 * repository. The link is built here (not hard-coded in HTML) so the
 * repository URL stays a single source of truth. Called at init
 * (wireAbout) and on every language change. The old function name is
 * kept so its call sites are unchanged.
 */
function paintPrivacyPermNote() {
  const a = $('privacyFullLink');
  if (!a) return;
  a.href = GITHUB_REPO + '/blob/main/PRIVACY.md';
}

function aboutPermIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '../shared/assets/lucide-sprite.svg#check');
  icon.append(use);
  return icon;
}

function wireAbout() {
  const manifest = chrome.runtime.getManifest();
  $('aboutVersion').textContent = manifest.version || '–';
  if (manifest.description) $('aboutTagline').textContent = manifest.description;
  const ul = $('aboutPermissions');
  ul.textContent = '';
  const perms = [...(manifest.permissions || [])];
  const hosts = manifest.host_permissions || [];
  for (const p of perms) {
    if (p === 'offscreen') continue; // implementation detail, covered by "convert"
    const li = document.createElement('li');
    li.append(aboutPermIcon());
    li.append(document.createTextNode((PERMISSION_DESCRIPTION_KEYS[p] && t(PERMISSION_DESCRIPTION_KEYS[p])) || p));
    ul.append(li);
  }
  if (hosts.length) {
    const li = document.createElement('li');
    li.append(aboutPermIcon());
    li.append(document.createTextNode(t('perm_hosts')));
    ul.append(li);
  }
  paintAboutPrivacy();
  paintPrivacyPermNote();
  paintHostAccess();
}

/**
 * Translate a key, falling back to English when the key has no
 * translation yet. The host access strings are new and have no locale
 * keys, so t() would echo the key itself; treat that echo as missing.
 */
function trOrEnglish(key, english) {
  try {
    const s = t(key);
    if (typeof s === 'string' && s && s !== key) return s;
  } catch { /* fall through to English */ }
  return english;
}

/**
 * Persistent host permission entry point, next to the About
 * permission list. Same behavior as the welcome page row: hidden
 * when the hosts are already granted (always true on Chrome and
 * Edge, where install grants them), visible with a gesture button
 * when they are not. The button click is the user gesture the
 * browser requires for permissions.request. If the helper is
 * unavailable, the row stays hidden. Needs manual test in Firefox:
 * grant, deny, and the row hidden on Chrome and Edge.
 */
async function paintHostAccess() {
  const row = $('hostAccessRow');
  const text = $('hostAccessText');
  const btn = $('hostAccessBtn');
  if (!row || !text || !btn) return;
  let granted = true;
  try {
    granted = await hasHostPermission(chrome, HOST_PERMISSION_ORIGINS);
    if (!granted) {
      text.textContent = trOrEnglish('options_hostAccessDesc', 'ImgFetch needs permission to access websites before it can scan pages or save images from them. If you skipped that permission when installing, grant it here.') + ' ';
      btn.textContent = trOrEnglish('options_hostAccessButton', 'Allow access to websites');
      btn.onclick = async () => {
        try {
          const ok = await requestHostPermission(chrome, HOST_PERMISSION_ORIGINS);
          if (ok) {
            row.hidden = true;
          } else {
            text.textContent = trOrEnglish('options_hostAccessDenied', 'Access was not granted. ImgFetch can still work from the toolbar button or menu on the current page, but scanning and saving from other pages need this permission. You can grant it anytime here, in Settings, About.') + ' ';
          }
        } catch {
          /* keep the row visible so the user can try again */
        }
      };
    }
  } catch {
    granted = true;
  }
  row.hidden = granted;
}

/* ---------------- settings search ---------------- */

/**
 * Sidebar search. The index is built from the already loaded i18n
 * strings (sidebar label, group label and the section's own text), so a
 * query matches in every locale without hard-coded English. Rebuilt on
 * every language change.
 */
let settingsSearchIndex = [];
let slashFocusPending = false;

function normSearchText(s) {
  return (s || '').toLowerCase();
}

function buildSettingsSearchIndex() {
  settingsSearchIndex = SECTION_IDS.map((id) => {
    const btn = document.querySelector(`.side-nav button[data-section="${id}"]`);
    const section = $(id);
    let groupLabel = '';
    let prev = btn ? btn.previousElementSibling : null;
    while (prev) {
      if (prev.classList && prev.classList.contains('side-group')) {
        groupLabel = prev.textContent || '';
        break;
      }
      prev = prev.previousElementSibling;
    }
    const hay = [btn ? btn.textContent : '', groupLabel, section ? section.textContent : ''].join(' ');
    return { id, hay: normSearchText(hay) };
  });
}

/**
 * Filter the sidebar to sections whose titles, labels or descriptions
 * contain the query. When jump is true, open the single matching
 * section, or the first match when the open section no longer matches.
 */
function applySettingsSearchFilter(jump) {
  const input = $('sideSearch');
  const empty = $('sideSearchEmpty');
  const q = normSearchText(input ? input.value.trim() : '');
  const matches = [];
  for (const entry of settingsSearchIndex) {
    const btn = document.querySelector(`.side-nav button[data-section="${entry.id}"]`);
    if (!btn) continue;
    const hit = !q || entry.hay.includes(q);
    // G2: search results filter with a fast 150 ms fade. Showing and
    // hiding are animated only when the state actually changes, so
    // typing does not replay a fade on every keystroke, and a pending
    // hide is cancelled by a show (see UI.setVisibleAnimated).
    if (UI.setVisibleAnimated) {
      if (hit && btn.style.display === 'none') void UI.setVisibleAnimated(btn, true);
      else if (!hit && btn.style.display !== 'none') void UI.setVisibleAnimated(btn, false);
    } else {
      btn.style.display = hit ? '' : 'none';
    }
    if (hit) matches.push(entry.id);
  }
  // A group label shows only while at least one of its items matches.
  document.querySelectorAll('.side-nav .side-group').forEach((g) => {
    let next = g.nextElementSibling;
    let any = false;
    while (next && !(next.classList && next.classList.contains('side-group'))) {
      if (next.tagName === 'BUTTON' && next.style.display !== 'none') { any = true; break; }
      next = next.nextElementSibling;
    }
    if (UI.setVisibleAnimated) {
      if (any && g.style.display === 'none') void UI.setVisibleAnimated(g, true);
      else if (!any && g.style.display !== 'none') void UI.setVisibleAnimated(g, false);
    } else {
      g.style.display = any ? '' : 'none';
    }
  });
  // G2: the "no results" state fades in over 250 ms.
  if (empty) {
    const show = q !== '' && matches.length === 0;
    if (show && empty.hidden) { empty.hidden = false; if (UI.fadeIn) UI.fadeIn(empty); }
    else if (!show) empty.hidden = true;
  }
  if (!q || !jump || matches.length === 0) return;
  const current = document.querySelector('.side-nav button[aria-current="true"]');
  const currentId = current ? current.dataset.section : '';
  if (matches.length === 1) {
    if (currentId !== matches[0]) showSection(matches[0]);
  } else if (!matches.includes(currentId)) {
    showSection(matches[0]);
  }
}

function wireSidebarSearch() {
  const input = $('sideSearch');
  if (!input) return;
  buildSettingsSearchIndex();
  input.addEventListener('input', () => {
    // A "/" keypress that focused the box can still deliver its
    // character to the newly focused input; drop that one leading
    // slash so focusing never becomes a query for "/".
    if (slashFocusPending) {
      slashFocusPending = false;
      if (input.value.startsWith('/')) input.value = input.value.slice(1);
    }
    applySettingsSearchFilter(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      applySettingsSearchFilter(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      applySettingsSearchFilter(true);
    }
  });
  // "/" focuses the box when no text field is focused; typing "/" inside
  // a field keeps its normal meaning.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    e.preventDefault();
    slashFocusPending = true;
    input.focus();
    input.select();
  });
}

/* ---------------- sidebar navigation ---------------- */

const SECTION_IDS = [
  'general',
  'downloads',
  'quality',
  'filenames',
  'scanning',
  'screenshots',
  'shortcuts',
  'sites',
  'folders',
  'history',
  'backup',
  'about',
  'privacy',
];

let sectionShownOnce = false;
let currentSectionId = 'general';

function showSection(id) {
  if (!SECTION_IDS.includes(id)) id = 'general';
  const prevIdx = SECTION_IDS.indexOf(currentSectionId);
  const nextIdx = SECTION_IDS.indexOf(id);
  for (const s of SECTION_IDS) {
    const el = $(s);
    if (el) el.hidden = s !== id;
  }
  // G2: the content swaps with the 250 ms page slide (8 px, blur to 0),
  // direction following the sidebar order; the sidebar indicator slides
  // with it (UI.initSlidingIndicators). The first section is the page's
  // first paint and never animates.
  if (sectionShownOnce && prevIdx !== nextIdx) {
    const sec = $(id);
    if (sec && UI.runViewTransition) UI.runViewTransition(sec, nextIdx > prevIdx ? 'forward' : 'back');
  }
  sectionShownOnce = true;
  currentSectionId = id;
  document.querySelectorAll('.side-nav button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.section === id));
  });
  // The browser tab title follows the open section, so the tab never says
  // "Settings" while showing something else (e.g. Download History).
  const navLabel = document.querySelector(`.side-nav button[data-section="${id}"]`);
  const label = navLabel ? navLabel.textContent.trim() : '';
  document.title = label && id !== 'general' ? t('options_sectionTitle', { section: label }) : t('options_title');
  const select = $('navSelect');
  if (select) { select.value = id; if (UI.syncDropdown) UI.syncDropdown(select); }
  if (location.hash !== `#${id}`) {
    history.replaceState(null, '', `#${id}`);
  }
  document.querySelector('.settings-main').scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  // The history list is a live log, refresh it every time the section opens,
  // so downloads made after the page loaded (popup, menu, shortcuts) appear.
  if (id === 'history') loadOptHistory();
}

function wireSidebar() {
  document.querySelectorAll('.side-nav button').forEach((b) => {
    b.addEventListener('click', () => showSection(b.dataset.section));
  });
  $('navSelect').addEventListener('change', (e) => showSection(e.target.value));
  window.addEventListener('hashchange', () => {
    showSection(location.hash.replace('#', ''));
  });
  // Deep links (e.g. the "Add Site Preference" menu opens #sites).
  const initial = location.hash.replace('#', '');
  showSection(SECTION_IDS.includes(initial) ? initial : 'general');
}
