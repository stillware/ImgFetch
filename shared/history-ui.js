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
 * ImgFetch, shared/history-ui.js
 * The one shared download-history row design, used by the popup history
 * screen and by the Download History section of the options page.
 *
 * A row is a 40 px tile (a real 120 px thumbnail when the record has a
 * valid one, else the neutral kind icon), the filename without its final
 * image extension plus its format badge, one muted subtext line, and on
 * the right the file size, which gives way to three icon buttons on row
 * hover and on keyboard focus-within. No innerHTML anywhere: every node
 * is built with createElement and textContent, and a thumbnail is only
 * ever assigned to img.src after sanitizeHistoryThumb accepts it.
 *
 * Callers pass `deps`: { t, formatSize, showDownload, toast }. `t` is
 * the page's i18n function, `formatSize` formats the record size
 * (ImgFetchUI.formatHistorySize), `showDownload` reveals a download by
 * id (a UI.send('SHOW_DOWNLOAD') wrapper) and `toast` shows a message.
 */
import { stripImageExtension, sanitizeHistoryThumb } from '../core/history.js';
import { formatGroup } from '../core/filters.js';

/** Chip and thumbnail labels: WebP keeps its mixed case, the rest are caps. */
export const HISTORY_FORMAT_LABELS = { png: 'PNG', jpg: 'JPG', webp: 'WebP', gif: 'GIF', avif: 'AVIF' };
/**
 * History format badge classes per format group. PNG, JPG, GIF and AVIF
 * reuse the existing badge tints (accent, warn, ok, accent); WebP uses a
 * translucent cyan tint (see .hist-fmt-webp). Unknown and other formats
 * get no badge. These are the only badge styles: do not change them.
 */
export const HISTORY_FORMAT_BADGE_CLASS = {
  png: 'badge badge-accent hist-fmt',
  jpg: 'badge badge-warn hist-fmt',
  webp: 'badge hist-fmt hist-fmt-webp',
  gif: 'badge badge-ok hist-fmt',
  avif: 'badge badge-accent hist-fmt',
};

/** Sprite path, relative to the popup and options pages (both one level deep). */
const SPRITE_URL = '../shared/assets/lucide-sprite.svg';

/** Lucide icon from the bundled sprite, as an inline <svg><use>. */
function rowIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon icon-16');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${SPRITE_URL}#${name}`);
  svg.appendChild(use);
  return svg;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * Relative time for a history record: "Just now", "N min ago", "N h ago",
 * "Yesterday", otherwise a short date. Every value comes from the
 * record's own `at` field.
 */
export function formatHistoryTime(at, t) {
  const stamp = Number(at) || 0;
  const age = Date.now() - stamp;
  if (!stamp || age < 60000) return t('history_timeNow');
  const mins = Math.floor(age / 60000);
  if (mins < 60) return t('history_timeMinutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('history_timeHours', { count: hours });
  const day = new Date(stamp);
  const yesterday = new Date(Date.now() - 86400000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(day, yesterday)) return t('history_timeYesterday');
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Group count with its word, correctly pluralized: "79 files", "1 file". */
export function historyCountLabel(count, t) {
  return t('history_files', { count });
}

/** One-line subtext: "domain.com · 2 min ago", or "Screenshot · 2 h ago". */
export function historySubtext(record, t) {
  const time = formatHistoryTime(record.at, t);
  if (record.kind === 'screenshot') return `${t('menu_screenshot')} · ${time}`;
  const site = record.pageHost || record.site || '';
  return site ? `${site} · ${time}` : time;
}

/**
 * One history row. The thumbnail image sits on top of the kind icon in
 * the tile; if it fails to load it is removed and the icon shows.
 * Buttons are only rendered when they can act: Open and Copy need a
 * source URL, Show in folder needs a download id.
 */
export function buildHistoryRow(record, deps) {
  const r = record || {};
  const { t } = deps;
  const row = el('div', null, 'hist-item');
  const kindIcon = r.kind === 'bulk' ? 'images' : r.kind === 'screenshot' ? 'camera' : 'image';
  const tile = el('div', null, 'hist-tile');
  tile.append(rowIcon(kindIcon));
  const thumb = sanitizeHistoryThumb(r.thumb);
  if (thumb) {
    const img = document.createElement('img');
    img.className = 'hist-thumb';
    img.alt = '';
    img.draggable = false;
    img.width = 40;
    img.height = 40;
    img.addEventListener('error', () => img.remove());
    img.src = thumb;
    tile.append(img);
  }
  const main = el('div', null, 'hist-main');
  const name = el('div', null, 'hist-name');
  name.title = r.filename || '';
  name.append(el('span', stripImageExtension(r.filename || t('ui_fallbackName')), 'hist-name-text'));
  const fmt = formatGroup(r.format);
  const fmtClass = HISTORY_FORMAT_BADGE_CLASS[fmt];
  if (fmtClass) name.append(el('span', HISTORY_FORMAT_LABELS[fmt], fmtClass));
  main.append(name, el('div', historySubtext(r, t), 'hist-sub'));
  row.append(tile, main);
  const side = el('div', null, 'hist-side');
  const sizeText = Number(r.bytes) > 0 ? deps.formatSize(r) : '';
  if (sizeText) side.append(el('span', sizeText, 'hist-size'));
  const actions = el('div', null, 'hist-actions');
  if (typeof r.url === 'string' && r.url) {
    const open = el('button', null, 'icon-btn hist-action');
    open.type = 'button';
    open.setAttribute('aria-label', t('history_openSource'));
    open.title = t('history_openSource');
    open.append(rowIcon('external-link'));
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(r.url, '_blank', 'noopener,noreferrer');
    });
    actions.append(open);
  }
  if (Number.isInteger(r.dlId)) {
    const show = el('button', null, 'icon-btn hist-action');
    show.type = 'button';
    show.setAttribute('aria-label', t('queue_showInFolder'));
    show.title = t('queue_showInFolder');
    show.append(rowIcon('folder-open'));
    show.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await deps.showDownload(r.dlId);
      } catch {
        deps.toast(t('history_fileNotFound'));
      }
    });
    actions.append(show);
  }
  if (typeof r.url === 'string' && r.url) {
    const copy = el('button', null, 'icon-btn hist-action');
    copy.type = 'button';
    copy.setAttribute('aria-label', t('info_copyLink'));
    copy.title = t('info_copyLink');
    copy.append(rowIcon('copy'));
    const tip = el('span', t('history_copied'), 'hist-copied');
    tip.setAttribute('aria-hidden', 'true');
    copy.append(tip);
    copy.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(r.url);
        tip.classList.add('is-visible');
        setTimeout(() => tip.classList.remove('is-visible'), 1200);
        deps.toast(t('notice_copiedLink'));
      } catch {
        deps.toast(t('notice_copyFailed'));
      }
    });
    actions.append(copy);
  }
  if (actions.childNodes.length) side.append(actions);
  row.append(side);
  return row;
}

/**
 * Two-step Clear history: the first click arms the button in place
 * ("Confirm Clear?" in the danger colour), the second click within
 * 4 seconds clears, otherwise the button reverts. No separate dialog.
 * The button carries aria-live so the change is announced. deps:
 * { t, toast, clear, onCleared }.
 */
export function wireClearHistory(button, deps) {
  const label = button.querySelector('span') || button;
  const original = label.textContent;
  let armed = false;
  let timer = null;
  button.setAttribute('aria-live', 'polite');
  const disarm = () => {
    armed = false;
    if (timer) { clearTimeout(timer); timer = null; }
    label.textContent = original;
    button.classList.remove('is-confirm');
  };
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      label.textContent = deps.t('history_clearConfirmInline');
      button.classList.add('is-confirm');
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    try {
      await deps.clear();
      deps.onCleared();
      deps.toast(deps.t('history_cleared'));
    } catch (err) {
      deps.toast(err.message);
    }
  });
}
