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
 * ImgFetch, pages/capture.js
 * Screenshot preview: shows the capture, lets the user save / retake / discard.
 */
(() => {
  'use strict';
  const UI = window.ImgFetchUI;

  /* B: runtime localization. Classic script: no static imports, so the
   * i18n module loads lazily; English defaults stay until it resolves. */
  let __t = null;
  let partLabel = ''; // FIX 4.2: "Part i of N", re-applied after applyI18n()
  function applyPartLabel() {
    if (!partLabel) return;
    try {
      const sub = document.querySelector('.brand-sub');
      if (sub) sub.textContent = partLabel;
      document.title = partLabel;
    } catch { /* never break the preview */ }
  }
  (async () => {
    try {
      const { initI18n, t, applyI18n, onLanguageChange } = await import('../shared/i18n.js');
      await initI18n();
      __t = t;
      applyI18n();
      applyPartLabel();
      onLanguageChange(() => { applyI18n(); applyPartLabel(); });
    } catch { /* English defaults remain */ }
  })();

  /** Translate a key; falls back to the given English when i18n is unavailable. */
  function tr(key, english, vars) {
    if (__t) {
      try { return __t(key, vars); } catch { /* fall through */ }
    }
    return english;
  }
  const $ = (id) => document.getElementById(id);
  const id = location.hash.replace('#', '');

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const { settings } = await UI.send('GET_SETTINGS');
      UI.applyTheme(settings.theme);
      UI.watchSystemTheme(() => settings.theme);
    } catch {
      UI.applyTheme('system');
    }
    if (!id) {
      fail(tr('capture_invalidLink', 'This preview link is invalid.'));
      return;
    }
    try {
      // Fast path: read the capture straight from IndexedDB (same extension
      // origin) instead of a multi-MB worker round trip; retries briefly
      // while the worker finishes storing, then falls back to the worker.
      const { loadCaptureRecord, captureRecordObjectUrl } = await import('../shared/capture-io.js');
      const cap = await loadCaptureRecord(id, (t, pl) => UI.send(t, pl));
      // Blob records (stitched parts) display through an object URL;
      // legacy dataUrl records pass straight through. The object URL
      // is revoked when the page goes away.
      const source = captureRecordObjectUrl(cap);
      window.addEventListener('unload', () => source.revoke());
      $('shot').src = source.url;
      // FIX 4.2: parts of a split full-page capture show their
      // "Part i of N" title in the subtitle and the tab title.
      if (cap.partTotal > 1 && cap.partIndex > 0) {
        partLabel = tr('part_title', `Part ${cap.partIndex} of ${cap.partTotal}`,
          { count: cap.partIndex, total: cap.partTotal });
        applyPartLabel();
      }
      $('meta').textContent = cap.width > 0 && cap.height > 0
        ? tr('capture_metaPixels', `${cap.width} × ${cap.height} pixels`, { width: cap.width, height: cap.height })
        : tr('capture_ready', 'Screenshot ready');
      $('loading').hidden = true;
      $('content').hidden = false;
    } catch (err) {
      fail(err.message);
    }

    $('btnSave').addEventListener('click', async () => {
      $('btnSave').disabled = true;
      try {
        const { filename } = await UI.send('SAVE_CAPTURE', { id });
        UI.toast(tr('capture_savedFile', `Saved ${filename.split('/').pop()}`, { filename: filename.split('/').pop() }));
        setTimeout(() => window.close(), 900);
      } catch (err) {
        UI.toast(err.message);
        $('btnSave').disabled = false;
      }
    });
    // B6: copy the screenshot bitmap to the clipboard (user gesture).
    $('btnCopyShot').addEventListener('click', async () => {
      try {
        const { loadCaptureRecord, captureRecordBlob } = await import('../shared/capture-io.js');
        const cap = await loadCaptureRecord(id, (t, pl) => UI.send(t, pl));
        let blob = captureRecordBlob(cap);
        if (!blob) {
          const { dataUrlToBlob } = await import('../core/data-url.js');
          blob = dataUrlToBlob(cap.dataUrl);
        }
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        UI.toast(tr('capture_copied', 'Screenshot copied to clipboard.'));
      } catch (err) {
        UI.toast(tr('capture_copyFailed', 'Could not copy the screenshot.'));
      }
    });
    $('btnRetakeVisible').addEventListener('click', async () => {
      try {
        await UI.send('CAPTURE_VISIBLE');
        window.close();
      } catch (err) {
        UI.toast(err.message);
      }
    });
    $('btnRetakeArea').addEventListener('click', async () => {
      try {
        await UI.send('CAPTURE_AREA');
        window.close();
      } catch (err) {
        UI.toast(err.message);
      }
    });
    $('btnDiscard').addEventListener('click', () => window.close());
  }

  function fail(message) {
    const loading = $('loading');
    loading.textContent = '';
    loading.append(UI.el('p', message, 'muted'));
  }
})();
