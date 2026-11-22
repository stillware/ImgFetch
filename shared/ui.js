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
 * ImgFetch, shared/ui.js
 * Tiny view helpers shared by popup, options and pages. No dependencies.
 */
(() => {
  'use strict';

  /**
   * Runtime localization for the shared UI helpers. ui.js is a classic
   * script, so the i18n module loads lazily; English defaults are used
   * until it resolves (or if it cannot load, e.g. no chrome runtime).
   * initI18n is intentionally not called here: every page using these
   * helpers already runs it at startup, and this module shares that
   * loaded state.
   */
  let __t = null;
  try {
    import('./i18n.js').then((m) => {
      if (m && typeof m.t === 'function') __t = m.t;
    }).catch(() => { /* English defaults remain */ });
  } catch { /* dynamic import unavailable; English defaults remain */ }

  /** Translate a key; falls back to the given English when i18n is unavailable. */
  function tr(key, english) {
    if (__t) {
      try {
        const s = __t(key);
        if (typeof s === 'string' && s && s !== key) return s;
      } catch { /* fall through */ }
    }
    return english;
  }

  /** Resolve "system" to light/dark and apply [data-theme] on <html>. */
  function applyTheme(theme) {
    const root = document.documentElement;
    let resolved = theme || 'system';
    if (resolved === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (root.getAttribute('data-theme') === resolved) {
      storeThemeMirror(theme || 'system');
      return resolved;
    }
    // Smooth cross-fade so switching themes never flashes or jerks.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      root.classList.add('theme-fade');
      setTimeout(() => root.classList.remove('theme-fade'), 350);
    }
    root.setAttribute('data-theme', resolved);
    try { root.style.colorScheme = resolved; } catch { /* old browser; ignore */ }
    storeThemeMirror(theme || 'system');
    return resolved;
  }

  /**
   * Fast theme mirror for shared/theme-init.js. chrome.storage.local is
   * async, so it cannot be read before first paint; this plain value in
   * localStorage can, and theme-init.js applies it from <head>. It only
   * ever holds the theme choice, never settings or history.
   */
  const THEME_MIRROR_KEY = 'imgfetch-theme';
  function storeThemeMirror(theme) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem(THEME_MIRROR_KEY, theme);
      }
    } catch { /* storage unavailable; the async path still applies */ }
  }

  function watchSystemTheme(getTheme) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'system') applyTheme('system');
    });
  }

  /** Safe text: create an element with textContent (never innerHTML). */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function toast(message, ms) {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = el('div', null, 'toast-stack');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    // Round 5: a repeated identical text replaces the visible toast
    // (and restarts its timer) instead of stacking a copy of it.
    for (const child of [...stack.children]) {
      if (child.textContent === message) {
        clearTimeout(child._toastTimer);
        child._toastTimer = setTimeout(() => child.remove(), ms || 2600);
        stack.appendChild(child);
        return;
      }
    }
    const t = el('div', message, 'toast');
    stack.appendChild(t);
    t._toastTimer = setTimeout(() => t.remove(), ms || 2600);
    while (stack.children.length > 3) stack.firstChild.remove();
  }

  /**
   * L6: inline confirmation dialog matching the ImgFetch design, replaces
   * window.confirm(). Returns a Promise<boolean>. Focus-trapped, Escape
   * cancels, and it restores focus to the invoking element.
   */
  function confirmDialog({ title, message, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const backdrop = el('div', null, 'confirm-backdrop');
      const dialog = el('div', null, 'confirm-dialog');
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', title);
      const h = el('h3', title, 'confirm-title');
      const p = el('p', message, 'confirm-message');
      const row = el('div', null, 'confirm-actions');
      const cancelBtn = el('button', tr('ui_cancel', 'Cancel'), 'btn');
      cancelBtn.type = 'button';
      const okBtn = el('button', confirmLabel || tr('ui_confirm', 'Confirm'), danger ? 'btn btn-danger' : 'btn btn-primary');
      okBtn.type = 'button';
      row.append(cancelBtn, okBtn);
      dialog.append(h, p, row);
      backdrop.append(dialog);
      document.body.append(backdrop);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        backdrop.remove();
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(value);
      };
      cancelBtn.addEventListener('click', () => finish(false));
      okBtn.addEventListener('click', () => finish(true));
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish(false);
      });
      backdrop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(false);
        // Simple focus trap: keep Tab cycling inside the dialog.
        if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === cancelBtn ? okBtn : cancelBtn).focus();
        }
      });
      okBtn.focus();
    });
  }

  /** Promise wrapper around chrome.runtime.sendMessage with friendly errors. */
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(tr('ui_startingUp', 'ImgFetch is starting up, please try again in a moment.')));
          return;
        }
        if (!res || res.ok !== true) {
          reject(new Error((res && res.error) || tr('ui_somethingWrong', 'Something went wrong. Please try again.')));
          return;
        }
        resolve(res);
      });
    });
  }

  function formatBytes(n) {
    if (!n || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
  }

  function formatDims(w, h) {
    return w > 0 && h > 0 ? `${w} × ${h}` : tr('ui_unknownSize', 'Unknown size');
  }

  /**
   * History row size: the exact on-disk file size when known (measured at
   * download completion), otherwise the image dimensions, otherwise the
   * honest "Unknown size".
   */
  function formatHistorySize(r) {
    const b = r && Number(r.bytes);
    if (b > 0) return formatBytes(b);
    return '-';
  }

  /**
   * Lucide icon from the bundled sprite (shared/assets/lucide-sprite.svg).
   * Returns an <svg> with a <use> reference; stroke, size and color come
   * from ui.css (.icon). Pass flip for directional icons (chevrons,
   * arrows, undo, redo) so they mirror in RTL. Pass label only when the
   * icon carries meaning on its own; decorative icons stay aria-hidden.
   */
  const SPRITE_PATH = 'shared/assets/lucide-sprite.svg';
  function spriteUrl() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL(SPRITE_PATH);
      }
    } catch { /* fall through to the relative path */ }
    return '../' + SPRITE_PATH;
  }
  function icon(name, opts) {
    const o = opts || {};
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon' + (o.size === 20 ? ' icon-20' : o.size === 16 ? ' icon-16' : '') + (o.flip ? ' flip-rtl' : ''));
    if (o.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', o.label);
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', spriteUrl() + '#' + name);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Button loading state: swaps in a spinning loader icon, disables the
   * button, and restores it. The button keeps its size while loading.
   */
  function setButtonLoading(button, loading) {
    if (!button) return;
    const loader = button.querySelector('.icon-loader');
    if (loading) {
      button.classList.add('is-loading');
      button.disabled = true;
      if (!loader) {
        const spin = icon('loader-circle', { size: 16 });
        spin.classList.add('icon-loader');
        button.prepend(spin);
      }
    } else {
      button.classList.remove('is-loading');
      button.disabled = false;
      if (loader) loader.remove();
    }
  }

  /**
   * Paint a range slider track fill from its value. Call on input and once
   * after wiring a slider. Sets --fill, which ui.css uses for the track.
   */
  function paintRange(input) {
    if (!input) return;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const v = Number(input.value);
    const pct = max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0;
    input.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  /** Skeleton block for loading states; add .skeleton-text or
   * .skeleton-thumb for the shape. Static under reduced motion (CSS).
   */
  function skeleton(kind) {
    return el('div', null, 'skeleton' + (kind ? ' skeleton-' + kind : ''));
  }

  /**
   * Empty state block: icon, title and description, all set as text.
   * Callers pass already-localized strings; this helper adds no strings.
   */
  function emptyState(opts) {
    const o = opts || {};
    const box = el('div', null, 'empty');
    if (o.icon) {
      const holder = el('div', null, 'empty-icon');
      holder.appendChild(icon(o.icon));
      box.appendChild(holder);
    }
    if (o.title) box.appendChild(el('p', o.title, 'empty-title'));
    if (o.description) box.appendChild(el('p', o.description, 'empty-desc'));
    return box;
  }

  function debounce(fn, ms) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms || 200);
    };
  }

  window.ImgFetchUI = {
    applyTheme,
    watchSystemTheme,
    el,
    toast,
    confirmDialog,
    send,
    formatBytes,
    formatDims,
    formatHistorySize,
    debounce,
    icon,
    setButtonLoading,
    paintRange,
    skeleton,
    emptyState,
  };
})();
