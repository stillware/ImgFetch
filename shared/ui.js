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
    // G3: one 150 ms crossfade of background and text colour only.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      root.classList.add('theme-fade');
      setTimeout(() => root.classList.remove('theme-fade'), motionDurationMs('--duration-quick', 150));
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

  /**
   * Toast with an optional leading icon (a Lucide sprite id, e.g. 'check'
   * for a success toast). Callers that pass no icon get the plain text
   * toast exactly as before. The icon is decorative: the dedupe below
   * still compares textContent, which an svg child does not change.
   * G2: enters in 250 ms (8 px up, fade); leaving is a 350 ms fade with
   * no travel, applied as .is-leaving before removal, so a toast never
   * vanishes mid-read. Under reduced motion both are instant.
   */
  function toast(message, ms, icon, opts) {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = el('div', null, 'toast-stack');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    const error = !!(opts && opts.error);
    // Round 5: a repeated identical text replaces the visible toast
    // (and restarts its timer) instead of stacking a copy of it.
    for (const child of [...stack.children]) {
      if (child.textContent === message) {
        clearTimeout(child._toastTimer);
        clearTimeout(child._toastLeaveTimer);
        child.classList.remove('is-leaving');
        child._toastTimer = setTimeout(() => dismissToast(child), ms || 2600);
        stack.appendChild(child);
        return;
      }
    }
    const t = el('div', null, 'toast' + (error ? ' toast-error' : ''));
    if (icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '../shared/assets/lucide-sprite.svg#' + icon);
      svg.appendChild(use);
      t.appendChild(svg);
    }
    t.appendChild(document.createTextNode(message));
    stack.appendChild(t);
    t._toastTimer = setTimeout(() => dismissToast(t), ms || 2600);
    while (stack.children.length > 3) stack.firstChild.remove();
  }

  /** Remove a toast, playing its 350 ms exit fade first (G2). */
  function dismissToast(t) {
    if (!t || !t.isConnected) return;
    clearTimeout(t._toastTimer);
    if (prefersReducedMotion()) { t.remove(); return; }
    t.classList.add('is-leaving');
    const done = () => t.remove();
    t.addEventListener('animationend', function h(e) {
      if (e.target === t) { t.removeEventListener('animationend', h); done(); }
    });
    t._toastLeaveTimer = setTimeout(done, motionDurationMs('--duration-medium', 350) + 100);
  }

  /** Error toast: same timing, plus the small shake from G2. */
  function toastError(message, ms) {
    toast(message, ms, 'alert-triangle', { error: true });
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
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const settle = () => {
          backdrop.remove();
          if (prevFocus && prevFocus.focus) prevFocus.focus();
          resolve(value);
        };
        if (reduce) { settle(); return; }
        backdrop.classList.add('is-closing');
        setTimeout(settle, motionDurationMs('--duration-quick', 150));
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


  /**
   * Custom dropdown (Phase 5 A7). One shared replacement for every native
   * select in the extension, so the option list never shows the system
   * blue highlight. The real select stays in the DOM as the source of
   * truth (same id, same value, same change events); the button and the
   * listbox below are only its face. Listbox is appended to document.body
   * and positioned fixed, so it never clips inside the popup scroll area
   * and flips up when there is no room below. Keyboard: Arrow Up/Down,
   * Home/End, typeahead, Enter/Space to choose, Escape to close and
   * return focus, click outside to close. RTL correct (logical layout
   * comes from the button rect). Motion: open 250 ms, close 150 ms,
   * opacity and transform only (see shared/ui.css).
   */
  let __dropdownSeq = 0;
  const __dropdowns = new WeakMap();

  function __dropdownOptionData(select) {
    return [...select.options].map((o) => ({
      value: o.value, label: o.textContent, disabled: !!o.disabled,
    }));
  }

  function __dropdownLabel(select) {
    const opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : '';
  }

  function createDropdown(select) {
    if (!select || select.tagName !== 'SELECT') return null;
    const existing = __dropdowns.get(select);
    if (existing) return existing;
    const wrap = document.createElement('span');
    wrap.className = 'if-dropdown';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('if-native-hidden');
    try { select.tabIndex = -1; } catch { /* ignore */ }
    select.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'if-dropdown-btn';
    const label = document.createElement('span');
    label.className = 'if-dropdown-label';
    btn.appendChild(label);
    btn.appendChild(icon('chevron-down', { size: 16 }));
    const listId = `if-dropdown-list-${++__dropdownSeq}`;
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', listId);
    // Label the button like the select was labelled.
    for (const attr of ['aria-label', 'aria-labelledby']) {
      const v = select.getAttribute(attr);
      if (v) btn.setAttribute(attr, v);
    }
    if (!btn.getAttribute('aria-label') && !btn.getAttribute('aria-labelledby')) {
      const labelled = select.id && document.querySelector(`label[for="${select.id}"]`);
      if (labelled) btn.setAttribute('aria-label', labelled.textContent.trim());
    }
    wrap.appendChild(btn);

    const list = document.createElement('div');
    list.className = 'if-dropdown-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    document.body.appendChild(list);

    const inst = { select, wrap, btn, label, list, open: false, activeIndex: -1, typeahead: '', typeaheadTimer: 0 };
    __dropdowns.set(select, inst);

    function buildOptions() {
      list.textContent = '';
      __dropdownOptionData(select).forEach((data, i) => {
        const opt = document.createElement('div');
        opt.className = 'if-dropdown-option';
        opt.id = `${listId}-opt-${i}`;
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', String(select.value === data.value));
        if (data.disabled) opt.setAttribute('aria-disabled', 'true');
        const text = document.createElement('span');
        text.className = 'if-option-text';
        text.textContent = data.label;
        opt.appendChild(text);
        opt.appendChild(icon('check', { size: 16 }));
        opt.addEventListener('mousedown', (e) => { e.preventDefault(); });
        opt.addEventListener('click', () => { choose(i); });
        opt.addEventListener('mousemove', () => { setActive(i, false); });
        list.appendChild(opt);
      });
    }
    function sync() {
      label.textContent = __dropdownLabel(select);
      btn.disabled = !!select.disabled;
      [...list.children].forEach((opt, i) => {
        opt.setAttribute('aria-selected', String(select.options[i] && select.value === select.options[i].value));
      });
      const idx = [...select.options].findIndex((o) => o.value === select.value);
      inst.activeIndex = idx;
      btn.removeAttribute('aria-activedescendant');
    }
    function setActive(i, scroll) {
      const opts = [...list.children];
      if (!opts.length) return;
      const n = opts.length;
      const next = ((i % n) + n) % n;
      opts.forEach((o) => o.classList.remove('is-active'));
      opts[next].classList.add('is-active');
      inst.activeIndex = next;
      btn.setAttribute('aria-activedescendant', opts[next].id);
      if (scroll !== false && opts[next].scrollIntoView) {
        try { opts[next].scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      }
    }
    function position() {
      const r = btn.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      list.style.minWidth = `${Math.max(160, r.width)}px`;
      list.style.width = `${r.width}px`;
      let left = r.left;
      left = Math.max(8, Math.min(left, vw - Math.min(320, Math.max(160, r.width)) - 8));
      list.style.left = `${left}px`;
      const below = vh - r.bottom;
      const above = r.top;
      const need = Math.min(240, list.scrollHeight + 8);
      const openUp = below < need && above > below;
      list.classList.toggle('is-open-up', openUp);
      list.style.top = openUp ? `${Math.max(8, r.top - need - 4)}px` : `${r.bottom + 4}px`;
      list.style.maxHeight = `${Math.max(120, Math.min(240, openUp ? above - 12 : below - 12))}px`;
    }
    function open() {
      if (inst.open || select.disabled) return;
      buildOptions();
      sync();
      inst.open = true;
      btn.setAttribute('aria-expanded', 'true');
      position();
      list.classList.add('is-open');
      setActive(inst.activeIndex >= 0 ? inst.activeIndex : 0, false);
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('resize', onReposition);
      document.addEventListener('scroll', onReposition, true);
    }
    function close(refocus) {
      if (!inst.open) return;
      inst.open = false;
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      list.classList.remove('is-open');
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('scroll', onReposition, true);
      if (refocus) btn.focus();
    }
    function onReposition() { if (inst.open) position(); }
    function onDocDown(e) {
      if (!wrap.contains(e.target) && !list.contains(e.target)) close(false);
    }
    function choose(i) {
      const opt = select.options[i];
      if (!opt || opt.disabled) return;
      const changed = select.value !== opt.value;
      select.value = opt.value;
      sync();
      close(true);
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function onTypeahead(ch) {
      inst.typeahead += ch.toLowerCase();
      clearTimeout(inst.typeaheadTimer);
      inst.typeaheadTimer = setTimeout(() => { inst.typeahead = ''; }, 600);
      const opts = __dropdownOptionData(select);
      const start = (inst.activeIndex + 1) % Math.max(1, opts.length);
      for (let k = 0; k < opts.length; k += 1) {
        const i = (start + k) % opts.length;
        if (!opts[i].disabled && opts[i].label.toLowerCase().startsWith(inst.typeahead)) {
          setActive(i);
          return;
        }
      }
    }
    btn.addEventListener('click', () => { if (inst.open) close(false); else open(); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!inst.open) { open(); setActive(e.key === 'ArrowDown' ? 0 : __dropdownOptionData(select).length - 1); return; }
        setActive(inst.activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home') { if (inst.open) { e.preventDefault(); setActive(0); } }
      else if (e.key === 'End') { if (inst.open) { e.preventDefault(); setActive(__dropdownOptionData(select).length - 1); } }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (inst.open) choose(inst.activeIndex); else open();
      } else if (e.key === 'Escape') { if (inst.open) { e.preventDefault(); close(true); } }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!inst.open) open();
        onTypeahead(e.key);
      } else if (e.key === 'Tab') { close(false); }
    });
    inst.buildOptions = buildOptions;
    inst.sync = sync;
    inst.close = close;
    buildOptions();
    sync();
    return inst;
  }

  /** Enhance every native select under root (or root itself). Idempotent. */
  function initDropdowns(root) {
    const scope = root || document;
    const selects = scope === document ? [...document.querySelectorAll('select')]
      : (scope.tagName === 'SELECT' ? [scope] : [...scope.querySelectorAll('select')]);
    return selects.map((s) => createDropdown(s)).filter(Boolean);
  }

  /** Re-read a select's current value into its dropdown button. */
  function syncDropdown(select) {
    const inst = select && __dropdowns.get(select);
    if (inst) inst.sync();
  }

  /** Rebuild a dropdown's option list (labels changed, e.g. new locale). */
  function refreshDropdown(select) {
    const inst = select && __dropdowns.get(select);
    if (!inst) return;
    inst.buildOptions();
    inst.sync();
  }

  /**
   * Tear down every enhanced dropdown under root (listbox removed,
   * select unwrapped and unhidden). Call before re-rendering a list
   * that owns selects, e.g. the site-preference rows, so no orphaned
   * listbox is left in the document body.
   */
  function destroyDropdowns(root) {
    const scope = root || document;
    const selects = scope === document ? [...document.querySelectorAll('select')]
      : (scope.tagName === 'SELECT' ? [scope] : [...scope.querySelectorAll('select')]);
    for (const select of selects) {
      const inst = __dropdowns.get(select);
      if (!inst) continue;
      inst.close(false);
      if (inst.list && inst.list.remove) inst.list.remove();
      if (inst.wrap && inst.wrap.parentNode) inst.wrap.parentNode.insertBefore(select, inst.wrap);
      if (inst.wrap && inst.wrap.remove) inst.wrap.remove();
      select.classList.remove('if-native-hidden');
      select.removeAttribute('aria-hidden');
      try { select.tabIndex = 0; } catch { /* ignore */ }
      __dropdowns.delete(select);
    }
  }

  /** Refresh every enhanced dropdown under root. */
  function refreshDropdowns(root) {
    const scope = root || document;
    const selects = scope === document ? [...document.querySelectorAll('select')]
      : (scope.tagName === 'SELECT' ? [scope] : [...scope.querySelectorAll('select')]);
    selects.forEach((s) => refreshDropdown(s));
  }
  /* ---------------- shared motion layer (Phase 5 Part G, G4) ---------------- */
  /* One small set of helpers; components use these, never copy-pasted
     keyframes or hand-written timeouts. Every helper is a no-op under
     prefers-reduced-motion (the CSS block collapses the rest), and
     every animation is interruptible: re-entering removes the class and
     the safety timeout cleans up if animationend never fires (for
     example when the element was hidden mid-animation). */

  /** True when the user asked for reduced motion. */
  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  /** Read a --duration-* token in ms, for JS timeouts that must match
     the CSS timing (dialog close, toast exit, theme fade). Falls back
     to the given ms when the token cannot be read. */
  function motionDurationMs(name, fallbackMs) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const m = v.match(/^([\d.]+)ms$/);
      if (m) return Number(m[1]);
      const s = v.match(/^([\d.]+)s$/);
      if (s) return Number(s[1]) * 1000;
    } catch { /* fall through to the fallback */ }
    return fallbackMs;
  }

  /** Run a callback when el's animation ends, or after ms, whichever
     comes first. The safety timeout covers hidden elements and removed
     listeners; the listener covers the normal path. */
  function onMotionEnd(el, ms, cb) {
    let done = false;
    const finish = () => { if (done) return; done = true; cb(); };
    const timer = setTimeout(finish, ms);
    el.addEventListener('animationend', function h(e) {
      if (e.target !== el) return;
      el.removeEventListener('animationend', h);
      clearTimeout(timer);
      finish();
    });
  }

  let __viewTransitionToken = 0;
  /**
   * Page/view slide for a newly shown view (G2): 8 px, 250 ms,
   * smooth-out, 3 px blur settling to 0. direction is 'forward',
   * 'back' or 'none' (no animation, e.g. first paint). Mirrored in RTL
   * by the CSS. A second call while one is running restarts the slide
   * from the current state instead of stacking two animations.
   */
  function runViewTransition(el, direction) {
    if (!el || direction === 'none' || direction == null || prefersReducedMotion()) return;
    const cls = direction === 'back' ? 'motion-page-in-back' : 'motion-page-in-fwd';
    const token = ++__viewTransitionToken;
    el._motionToken = token;
    el.classList.remove('motion-page-in-fwd', 'motion-page-in-back');
    void el.offsetWidth;
    el.classList.add(cls);
    onMotionEnd(el, motionDurationMs('--duration-fast', 250) + 100, () => {
      if (el._motionToken === token) el.classList.remove(cls);
    });
  }

  /**
   * Stagger the first `limit` items (default 8) of a list: each gets
   * .motion-stagger with --i as its index, so the entrance is 40 ms per
   * item and the whole stagger stays under 300 ms. Items past the cap
   * appear at once, with no leftover delay. Call after rendering.
   */
  function stagger(container, selector, limit) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const cap = typeof limit === 'number' ? limit : 8;
    const items = container.querySelectorAll(selector || '.motion-stagger-item');
    items.forEach((item, i) => {
      if (i < cap) {
        item.style.setProperty('--i', String(i));
        item.classList.add('motion-stagger');
      } else {
        item.classList.remove('motion-stagger');
        item.style.removeProperty('--i');
      }
    });
  }

  /**
   * Text swap (G2): replace el's text with a 150 ms, 4 px swap. A
   * no-op when the text is unchanged, so per-second updates (scan
   * progress) never animate. Buttons swap opacity only, so the control
   * itself never moves; other elements slide the text. The class is
   * removed when the animation ends, so a later swap replays cleanly.
   */
  function swapText(el, text) {
    if (!el) return;
    const next = text == null ? '' : String(text);
    if (el.textContent === next) return;
    el.textContent = next;
    if (prefersReducedMotion()) return;
    const cls = el.tagName === 'BUTTON' ? 'motion-text-swap-opacity' : 'motion-text-swap';
    el.classList.remove('motion-text-swap', 'motion-text-swap-opacity');
    void el.offsetWidth;
    el.classList.add(cls);
    onMotionEnd(el, motionDurationMs('--duration-quick', 150) + 100, () => el.classList.remove(cls));
  }

  /** Fade el in over 250 ms (empty states, search no-results). */
  function fadeIn(el) {
    if (!el || prefersReducedMotion()) return;
    el.classList.remove('motion-fade-in');
    void el.offsetWidth;
    el.classList.add('motion-fade-in');
    onMotionEnd(el, motionDurationMs('--duration-fast', 250) + 100, () => el.classList.remove('motion-fade-in'));
  }

  /**
   * Show or hide el with a fade. Hiding fades out over 150 ms and only
   * then sets display none; showing restores display at once and fades
   * in. A pending hide is cancelled by a show (rapid typing in the
   * settings search), and vice versa. Under reduced motion both are
   * instant. Returns a promise that resolves when the hide completes.
   */
  function setVisibleAnimated(el, visible) {
    if (!el) return Promise.resolve();
    clearTimeout(el._motionVisTimer);
    if (visible) {
      el.classList.remove('motion-fade-out');
      el.style.display = '';
      fadeIn(el);
      return Promise.resolve();
    }
    if (prefersReducedMotion() || el.style.display === 'none') {
      el.style.display = 'none';
      return Promise.resolve();
    }
    el.classList.add('motion-fade-out');
    return new Promise((resolve) => {
      el._motionVisTimer = setTimeout(() => {
        el.style.display = 'none';
        el.classList.remove('motion-fade-out');
        resolve();
      }, motionDurationMs('--duration-quick', 150));
    });
  }

  /**
   * Success check draw (G2): swap the button's leading icon for a
   * check that draws itself over 500 ms, then restore the icon.
   * Resolves after the draw. A button with no icon, or reduced motion,
   * resolves at once with no swap.
   */
  function showSuccessCheck(button, ms) {
    if (!button) return Promise.resolve();
    const old = button.querySelector('svg');
    const hold = typeof ms === 'number' ? ms : motionDurationMs('--duration-very-slow', 500);
    if (!old || prefersReducedMotion()) return Promise.resolve();
    const check = icon('check', { size: 16 });
    check.classList.add('check-draw');
    old.replaceWith(check);
    return new Promise((resolve) => {
      setTimeout(() => { check.replaceWith(old); resolve(); }, hold);
    });
  }

  /**
   * Sliding indicators (G2): one shared pill per container that moves
   * on transform only (250 ms) to the active item. Containers: the
   * popup nav (.popup-nav, horizontal), the options sidebar (.side-nav,
   * vertical accent bar) and every segmented control (.segmented,
   * horizontal pill). The pill's size is set instantly to the active
   * item; only its position transitions. Positions come from
   * getBoundingClientRect, so they are correct in RTL too; the sidebar
   * bar mirrors to the inline-start side. A MutationObserver watches
   * the active attribute, so the pill follows programmatic changes
   * (section switches, segmented paint) with no per-page wiring.
   */
  function __initPill(container, pillClass, activeSelector, axis) {
    const activeAttr = axis === 'vertical' ? 'aria-current' : 'aria-pressed';
    const pill = document.createElement('div');
    pill.className = pillClass;
    pill.setAttribute('aria-hidden', 'true');
    container.appendChild(pill);
    container.classList.add('has-pill');
    const position = () => {
      const active = container.querySelector(activeSelector);
      if (!active || prefersReducedMotion()) {
        if (!active) pill.style.opacity = '0';
        else { pill.style.opacity = ''; }
        if (!active) return;
      }
      const c = container.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      if (axis === 'vertical') {
        const rtl = document.documentElement.dir === 'rtl';
        const bx = rtl ? (r.right - c.left) + 14 - 3 : (r.left - c.left) - 14;
        pill.style.width = '3px';
        pill.style.height = Math.max(0, r.height - 18) + 'px';
        pill.style.transform = `translate(${bx}px, ${r.top - c.top + 9}px)`;
      } else {
        /* Phase 6 item 5.2: getBoundingClientRect is border-box based,
           but an absolutely positioned pill with top/left 0 sits at the
           container's padding-box origin, one border inside. The old
           code translated by the full border-box offset, so the pill
           sat 1 px low and 1 px right of the pressed button and its
           bottom touched (or crossed) the control's border in the
           light theme. Subtract the container's border widths so the
           pill covers the pressed button exactly, on every control
           that uses this helper (segmented controls and the popup
           nav). The vertical branch keeps its own offsets. */
        const cs = getComputedStyle(container);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        pill.style.width = r.width + 'px';
        pill.style.height = r.height + 'px';
        pill.style.transform = `translate(${r.left - c.left - bl}px, ${r.top - c.top - bt}px)`;
      }
      pill.style.opacity = '';
    };
    const schedule = () => requestAnimationFrame(position);
    /* Phase 6 item 5.2: the pill is sized and placed from the active
       button's live rect, so it must move again whenever that button
       changes. The active button's label changes after load when
       i18n swaps in another locale (a shorter or wider label, and a
       direction flip to rtl), and neither event flips aria-pressed,
       so watching that attribute alone leaves the pill sitting on
       the old label's rect, in Arabic even hanging past the control's
       edge. Re-position on label text changes inside the container
       and on a direction change of the document. */
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === activeAttr) { schedule(); return; }
        if (m.type === 'characterData' || m.type === 'childList') { schedule(); return; }
      }
    });
    observer.observe(container, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: [activeAttr] });
    const dirObserver = new MutationObserver(() => schedule());
    dirObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => {});
    schedule();
    requestAnimationFrame(schedule);
  }

  function initSlidingIndicators() {
    try {
      document.querySelectorAll('.popup-nav').forEach((nav) => {
        if (!nav.querySelector('.motion-indicator')) __initPill(nav, 'motion-indicator', '[aria-pressed="true"]', 'horizontal');
      });
      document.querySelectorAll('.side-nav').forEach((nav) => {
        if (!nav.querySelector('.motion-indicator')) __initPill(nav, 'motion-indicator', '[aria-current="true"]', 'vertical');
      });
      document.querySelectorAll('.segmented').forEach((seg) => {
        if (!seg.querySelector('.motion-pill')) __initPill(seg, 'motion-pill', '[aria-pressed="true"]', 'horizontal');
      });
    } catch { /* indicators are decorative; a failure never breaks the page */ }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSlidingIndicators);
    } else {
      initSlidingIndicators();
    }
  }

  window.ImgFetchUI = {
    prefersReducedMotion,
    motionDurationMs,
    runViewTransition,
    stagger,
    swapText,
    fadeIn,
    setVisibleAnimated,
    showSuccessCheck,
    toastError,
    initSlidingIndicators,
    dismissToast,
    createDropdown,
    initDropdowns,
    destroyDropdowns,
    syncDropdown,
    refreshDropdown,
    refreshDropdowns,
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
