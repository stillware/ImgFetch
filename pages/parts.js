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
 * ImgFetch, pages/parts.js
 * Parts overview for a split full-page capture (round 4). The URL hash
 * carries the group id; the parts themselves are read straight from
 * IndexedDB (same extension origin). One card per part, in part order,
 * with a lazily decoded thumbnail (createImageBitmap resize options,
 * so a huge part is never drawn into a big canvas) and the four
 * per-part actions: Edit (the annotate editor in a new tab), Save (the
 * worker's SAVE_CAPTURE flow, honouring the user's PNG/JPG settings),
 * Copy (shared/copy-shot.js, bitmap-resize path) and Discard (the
 * worker's DISCARD_CAPTURE, group membership verified there). The
 * header saves every part in order (one download per part, no zip) or
 * discards the whole group. Saving a capture removes its record (the
 * existing SAVE_CAPTURE semantics), so a group whose parts are all
 * saved or discarded ends on a short empty state with no storage left.
 *
 * Capture records store no page title, so the heading is the generic
 * localized one; the summary line carries the real part count and
 * sizes, and says honestly when the parts differ in size.
 */
(() => {
  'use strict';
  const UI = window.ImgFetchUI;

  let __t = null;
  (async () => {
    try {
      const { initI18n, t, applyI18n, onLanguageChange } = await import('../shared/i18n.js');
      await initI18n();
      __t = t;
      applyI18n();
      onLanguageChange(() => { applyI18n(); refreshTexts(); });
    } catch { /* English defaults remain */ }
  })();

  function tr(key, english, vars) {
    if (__t) {
      try { return __t(key, vars); } catch { /* fall through */ }
    }
    return english;
  }
  const $ = (id) => document.getElementById(id);
  const groupId = location.hash.replace('#', '');

  /** Live parts: [{ rec, card, canvas, observed }], in part order. */
  let parts = [];
  let platformMod = null;
  let observer = null;
  let busy = false; // a Save-all run is in flight

  document.addEventListener('DOMContentLoaded', init);

  function fail(message) {
    const loading = $('loading');
    loading.hidden = false;
    loading.textContent = '';
    loading.append(UI.el('p', message, 'muted'));
  }

  function partTotalOf(rec) {
    return Number(rec.partTotal) > 0 ? Number(rec.partTotal) : parts.length;
  }

  function partLabel(rec) {
    const idx = Number(rec.partIndex) || 0;
    const total = partTotalOf(rec);
    return tr('part_title', `Part ${idx} of ${total}`, { count: idx, total });
  }

  function metaText(rec, bytes) {
    const size = UI.formatBytes(bytes);
    if (size) {
      return tr('parts_metaLine', `${rec.width} \u00d7 ${rec.height} pixels \u00b7 ${size}`,
        { width: rec.width, height: rec.height, size });
    }
    return tr('capture_metaPixels', `${rec.width} \u00d7 ${rec.height} pixels`,
      { width: rec.width, height: rec.height });
  }

  function summaryText() {
    const count = parts.length;
    if (!count) return '';
    const first = parts[0].rec;
    const uniform = parts.every((p) => p.rec.width === first.width && p.rec.height === first.height);
    if (uniform && first.width > 0 && first.height > 0) {
      return tr('parts_summarySame',
        `${count} images \u00b7 ${first.width} \u00d7 ${first.height} px each`,
        { count, width: first.width, height: first.height });
    }
    return tr('parts_summaryVaried', `${count} images \u00b7 different sizes`, { count });
  }

  async function refreshNote() {
    const note = $('windowsNote');
    if (!note || !platformMod) return;
    const multi = parts.some((p) => partTotalOf(p.rec) > 1) || parts.length > 1;
    const show = parts.some((p) => platformMod.shouldShowWindowsClipboardNote(
      undefined, p.rec.width, p.rec.height, multi));
    note.hidden = !show;
    if (show) note.textContent = tr('copy_windowsNote', 'Note: Large screenshots, such as full pages, copy correctly but do not appear in the Windows clipboard history (Win+V). This is a Windows limit, not a problem with the copy. Press Ctrl+V to paste the image where you need it.');
  }

  function refreshTexts() {
    if (!parts.length) return;
    const heading = tr('parts_heading', 'Screenshot parts');
    $('partsHeading').textContent = heading;
    document.title = heading;
    $('partsSummary').textContent = summaryText();
    $('partList').setAttribute('aria-label', tr('parts_listAria', 'Parts of the full-page screenshot'));
    for (const p of parts) {
      p.titleEl.textContent = partLabel(p.rec);
      p.metaEl.textContent = metaText(p.rec, p.bytes);
      p.canvas.setAttribute('aria-label', tr('parts_thumbAlt', `Preview of part ${p.rec.partIndex} of ${partTotalOf(p.rec)}`,
        { count: Number(p.rec.partIndex) || 0, total: partTotalOf(p.rec) }));
      p.editBtn.setAttribute('aria-label', tr('parts_editAria', `Edit part ${p.rec.partIndex} of ${partTotalOf(p.rec)}`,
        { count: Number(p.rec.partIndex) || 0, total: partTotalOf(p.rec) }));
      p.saveBtn.setAttribute('aria-label', tr('parts_saveAria', `Save part ${p.rec.partIndex} of ${partTotalOf(p.rec)}`,
        { count: Number(p.rec.partIndex) || 0, total: partTotalOf(p.rec) }));
      p.copyBtn.setAttribute('aria-label', tr('parts_copyAria', `Copy part ${p.rec.partIndex} of ${partTotalOf(p.rec)}`,
        { count: Number(p.rec.partIndex) || 0, total: partTotalOf(p.rec) }));
      p.discardBtn.setAttribute('aria-label', tr('parts_discardAria', `Discard part ${p.rec.partIndex} of ${partTotalOf(p.rec)}`,
        { count: Number(p.rec.partIndex) || 0, total: partTotalOf(p.rec) }));
    }
    refreshNote();
  }

  function releaseThumb(p) {
    if (observer && p.card) observer.unobserve(p.card);
    if (p.canvas) {
      try {
        const ctx = p.canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      } catch { /* canvas already gone */ }
      // Shrinking the canvas releases its backing store.
      p.canvas.width = 1;
      p.canvas.height = 1;
    }
  }

  async function loadThumb(p) {
    if (p.thumbDone) return;
    p.thumbDone = true;
    try {
      const { captureRecordBlob } = await import('../shared/capture-io.js');
      let blob = captureRecordBlob(p.rec);
      if (!blob && typeof p.rec.dataUrl === 'string' && p.rec.dataUrl) {
        const { dataUrlToBlob } = await import('../core/data-url.js');
        blob = dataUrlToBlob(p.rec.dataUrl);
      }
      if (!blob) return;
      const targetW = 440;
      const w = Number(p.rec.width) || 0;
      const h = Number(p.rec.height) || 0;
      const targetH = w > 0 && h > 0
        ? Math.max(1, Math.round(targetW * h / w))
        : targetW;
      // Decode at thumbnail size: the full image is never drawn into a
      // big canvas just to be shrunk.
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high',
      });
      try {
        p.canvas.width = bitmap.width;
        p.canvas.height = bitmap.height;
        p.canvas.getContext('2d').drawImage(bitmap, 0, 0);
        p.canvas.dataset.loaded = '1';
      } finally {
        try { bitmap.close(); } catch { /* already closed */ }
      }
    } catch { /* a missing thumbnail never breaks the card */ }
  }

  function setCardBusy(p, isBusy) {
    for (const b of [p.editBtn, p.saveBtn, p.copyBtn, p.discardBtn]) {
      if (b.tagName === 'BUTTON') b.disabled = isBusy;
      else b.setAttribute('aria-disabled', String(isBusy));
    }
  }

  function removePart(p, savedKind) {
    releaseThumb(p);
    if (p.card) p.card.remove();
    parts = parts.filter((x) => x !== p);
    if (!parts.length) {
      showEmpty(savedKind === 'saved');
      return;
    }
    refreshTexts();
  }

  function showEmpty(allSaved) {
    if (observer) observer.disconnect();
    $('content').hidden = true;
    $('loading').hidden = true;
    $('emptyText').textContent = allSaved
      ? tr('parts_allSaved', 'All parts were saved. You can close this tab.')
      : tr('parts_empty', 'All parts are gone. You can close this tab.');
    $('emptyState').hidden = false;
  }

  async function savePart(p) {
    setCardBusy(p, true);
    try {
      const { filename } = await UI.send('SAVE_CAPTURE', { id: p.rec.id });
      UI.toast(tr('capture_savedFile', `Saved ${String(filename).split('/').pop()}`,
        { filename: String(filename).split('/').pop() }));
      removePart(p, 'saved');
      return true;
    } catch (err) {
      UI.toast(err.message);
      setCardBusy(p, false);
      return false;
    }
  }

  async function discardPart(p) {
    setCardBusy(p, true);
    try {
      await UI.send('DISCARD_CAPTURE', { id: p.rec.id, groupId });
      removePart(p, 'discarded');
      return true;
    } catch (err) {
      UI.toast(err.message);
      setCardBusy(p, false);
      return false;
    }
  }

  async function copyPart(p) {
    try {
      const [{ captureRecordBlob }, { copyImageBlob }, { dataUrlToBlob }] = await Promise.all([
        import('../shared/capture-io.js'),
        import('../shared/copy-shot.js'),
        import('../core/data-url.js'),
      ]);
      let blob = captureRecordBlob(p.rec);
      if (!blob && typeof p.rec.dataUrl === 'string' && p.rec.dataUrl) {
        blob = dataUrlToBlob(p.rec.dataUrl);
      }
      if (!blob) throw new Error('no image');
      await copyImageBlob(blob, {
        t: (key, vars) => tr(key, key, vars),
        toast: (msg, ms) => UI.toast(msg, ms),
      });
    } catch {
      UI.toast(tr('copyFailed', 'Could not copy the screenshot. Try saving it instead.'));
    }
  }

  function buildCard(rec, bytes) {
    const card = document.createElement('article');
    card.className = 'part-card';
    card.setAttribute('role', 'listitem');
    const canvas = document.createElement('canvas');
    canvas.className = 'part-thumb';
    canvas.width = 440;
    canvas.height = 240;
    canvas.setAttribute('role', 'img');
    const main = document.createElement('div');
    main.className = 'part-main';
    const titleEl = document.createElement('h2');
    titleEl.className = 'part-title';
    const metaEl = document.createElement('p');
    metaEl.className = 'part-meta';
    const actions = document.createElement('div');
    actions.className = 'part-actions';

    const editBtn = document.createElement('a');
    editBtn.className = 'btn btn-ghost';
    editBtn.href = `annotate.html#${rec.id}`;
    editBtn.target = '_blank';
    editBtn.rel = 'noopener noreferrer';
    editBtn.textContent = tr('parts_edit', 'Edit');

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.type = 'button';
    saveBtn.textContent = tr('parts_save', 'Save');

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-ghost';
    copyBtn.type = 'button';
    copyBtn.textContent = tr('copyButton', 'Copy');

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn btn-danger';
    discardBtn.type = 'button';
    discardBtn.textContent = tr('capture_discard', 'Discard');

    actions.append(editBtn, saveBtn, copyBtn, discardBtn);
    main.append(titleEl, metaEl, actions);
    card.append(canvas, main);

    const p = { rec, bytes, card, canvas, titleEl, metaEl, editBtn, saveBtn, copyBtn, discardBtn, thumbDone: false };
    saveBtn.addEventListener('click', () => { if (!busy) savePart(p); });
    discardBtn.addEventListener('click', () => { if (!busy) discardPart(p); });
    copyBtn.addEventListener('click', () => copyPart(p));
    return p;
  }

  async function init() {
    try {
      const { settings } = await UI.send('GET_SETTINGS');
      UI.applyTheme(settings.theme);
      UI.watchSystemTheme(() => settings.theme);
    } catch {
      UI.applyTheme('system');
    }
    if (!groupId) {
      fail(tr('capture_invalidLink', 'This preview link is invalid.'));
      return;
    }
    let records = [];
    let bytesOf = null;
    try {
      const [{ idb }, storage] = await Promise.all([
        import('../background/idb.js'),
        import('../core/capture-storage.js'),
      ]);
      bytesOf = storage.captureRecordBytes;
      const all = await idb.all('captures');
      records = all
        .filter((r) => r && r.groupId === groupId)
        .sort((a, b) => (a.partIndex || 0) - (b.partIndex || 0));
    } catch {
      records = [];
    }
    if (!records.length) {
      fail(tr('capture_invalidLink', 'This preview link is invalid.'));
      return;
    }
    try {
      platformMod = await import('../shared/platform.js');
    } catch { platformMod = null; }

    const list = $('partList');
    parts = records.map((rec) => {
      const bytes = bytesOf ? bytesOf(rec) : (Number(rec.bytes) || 0);
      const p = buildCard(rec, bytes);
      list.append(p.card);
      return p;
    });
    // Lazy thumbnails: decode only when a card approaches the viewport.
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const p = parts.find((x) => x.card === e.target);
          if (p) loadThumb(p);
          observer.unobserve(e.target);
        }
      }, { rootMargin: '240px' });
      for (const p of parts) observer.observe(p.card);
    } else {
      for (const p of parts) loadThumb(p);
    }
    refreshTexts();
    $('loading').hidden = true;
    $('content').hidden = false;

    $('btnSaveAll').addEventListener('click', async () => {
      if (busy || !parts.length) return;
      busy = true;
      $('btnSaveAll').disabled = true;
      $('btnDiscardAll').disabled = true;
      const snapshot = [...parts];
      const progress = $('saveProgress');
      progress.hidden = false;
      let allOk = true;
      for (let i = 0; i < snapshot.length; i += 1) {
        progress.textContent = tr('parts_savingProgress',
          `Saving part ${i + 1} of ${snapshot.length}\u2026`,
          { current: i + 1, total: snapshot.length });
        const ok = await savePart(snapshot[i]);
        if (!ok) { allOk = false; break; }
      }
      progress.hidden = true;
      busy = false;
      if (parts.length) {
        $('btnSaveAll').disabled = false;
        $('btnDiscardAll').disabled = false;
      }
      if (allOk && !parts.length) showEmpty(true);
    });
    $('btnDiscardAll').addEventListener('click', async () => {
      if (busy) return;
      $('btnDiscardAll').disabled = true;
      $('btnSaveAll').disabled = true;
      try {
        await UI.send('DISCARD_CAPTURE_GROUP', { groupId });
      } catch { /* the group is gone or unreachable; clear the page anyway */ }
      for (const p of [...parts]) releaseThumb(p);
      parts = [];
      showEmpty(false);
    });
  }
})();
