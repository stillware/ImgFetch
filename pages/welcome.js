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
 * ImgFetch, pages/welcome.js
 * 4-step onboarding (the last step is a curated mini-settings panel).
 * External script (extension pages block inline JS).
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
      paint(); // re-render the dynamic Next/Start label in the new language
      onLanguageChange(() => { applyI18n(); paint(); paintHostAccess(); });
    } catch { /* English defaults remain */ }
  })();

  /** Translate a key; falls back to the given English when i18n is unavailable. */
  function tr(key, english, vars) {
    if (__t) {
      try { return __t(key, vars); } catch { /* fall through */ }
    }
    return english;
  }

  /**
   * Translate a key, falling back to English when the key has no
   * translation yet. The host access strings below are new and have
   * no locale keys, so t() would echo the key itself; treat that echo
   * as missing, exactly like the unavailable case.
   */
  function trOrEnglish(key, english) {
    if (__t) {
      try {
        const s = __t(key);
        if (typeof s === 'string' && s && s !== key) return s;
      } catch { /* fall through to English */ }
    }
    return english;
  }

  /**
   * Firefox host permission entry point. In Firefox, manifest host
   * permissions are opt-in, so a user who skipped them at install
   * sees this row on the welcome page (which opens on install) with
   * a button that requests the permission. The request must run in
   * the button's click handler, a user gesture, or the browser
   * refuses it. On Chrome and Edge the hosts are granted at install,
   * so the check passes and the row stays hidden. If the helper
   * itself is unavailable, the row stays hidden and onboarding is
   * unaffected. Needs manual test in Firefox: grant, deny, and the
   * row hidden on Chrome and Edge.
   */
  async function paintHostAccess() {
    const row = $('hostAccessRow');
    const text = $('hostAccessText');
    const btn = $('hostAccessBtn');
    if (!row || !text || !btn) return;
    let granted = true;
    try {
      const bridge = await import('../shared/offscreen-bridge.js');
      const api = typeof chrome !== 'undefined' ? chrome : null;
      granted = await bridge.hasHostPermission(api, bridge.HOST_PERMISSION_ORIGINS);
      if (!granted) {
        text.textContent = trOrEnglish('welcome_hostAccessDesc', 'ImgFetch needs permission to access websites before it can scan pages or save images from them. If you skipped that permission when installing, grant it here.');
        btn.textContent = trOrEnglish('welcome_hostAccessButton', 'Allow access to websites');
        btn.onclick = async () => {
          try {
            const ok = await bridge.requestHostPermission(api, bridge.HOST_PERMISSION_ORIGINS);
            if (ok) {
              row.hidden = true;
            } else {
              text.textContent = trOrEnglish('welcome_hostAccessDenied', 'Access was not granted. ImgFetch can still work from the toolbar button or menu on the current page, but scanning and saving from other pages need this permission. You can grant it anytime here, in Settings, About.');
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
  let step = 0;
  let settings = null;
  let saveTimer = 0;
  const $ = (id) => document.getElementById(id);
  const steps = () => [...document.querySelectorAll('.step')];
  const dots = () => [...document.querySelectorAll('.dots i')];

  function paint() {
    steps().forEach((s, i) => s.classList.toggle('active', i === step));
    dots().forEach((d, i) => d.classList.toggle('on', i === step));
    document.getElementById('btnBack').hidden = step === 0;
    document.getElementById('btnNext').textContent = step === steps().length - 1 ? tr('welcome_start', 'Start using ImgFetch') : tr('welcome_next', 'Next');
  }

  document.getElementById('btnBack').addEventListener('click', () => {
    if (step > 0) {
      step -= 1;
      paint();
    }
  });

  document.getElementById('btnNext').addEventListener('click', async () => {
    if (step < steps().length - 1) {
      step += 1;
      paint();
      return;
    }
    // L7: the onboarded flag was written but never read, the welcome page
    // only opens on fresh install (see onInstalled), so the flag is dead state.
    UI.toast(tr('welcome_enjoy', 'Enjoy ImgFetch!'));
    setTimeout(() => window.close(), 600);
  });

  UI.send('GET_SETTINGS').then(({ settings: s }) => {
    settings = s;
    UI.applyTheme(s.theme);
    paintMini();
    wireMini();
  }).catch(() => UI.applyTheme('system'));

  /* ----- mini settings on step 4 ----- */

  function paintMini() {
    if (!settings) return;
    $('wAnnotate').checked = !!settings.annotateAfterCapture;
    $('wAskName').checked = !!settings.askFilename;
    $('wSubfolder').value = settings.subfolder || '';
    document.querySelectorAll('#wAfterDl button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === settings.afterDownload));
    });
  }

  function saveMini() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      UI.send('SAVE_SETTINGS', { settings }).catch((err) => UI.toast(err.message));
    }, 300);
  }

  function wireMini() {
    $('wAnnotate').addEventListener('change', (e) => {
      settings.annotateAfterCapture = e.target.checked;
      saveMini();
    });
    $('wAskName').addEventListener('change', (e) => {
      settings.askFilename = e.target.checked;
      saveMini();
    });
    $('wSubfolder').addEventListener('input', UI.debounce((e) => {
      settings.subfolder = e.target.value;
      // Typing a name means "use it", the toggle follows the field here.
      settings.useSubfolder = e.target.value.trim().length > 0;
      saveMini();
    }));
    document.querySelectorAll('#wAfterDl button').forEach((b) => {
      b.addEventListener('click', () => {
        settings.afterDownload = b.dataset.v;
        paintMini();
        saveMini();
      });
    });
    $('wFullSettings').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    });
  }

  // F4: show the real shortcuts from chrome.commands.getAll(), not hardcoded
  // values. Handles user rebinding, empty (unbound) commands, and Mac.
  function renderShortcut(el, shortcut) {
    el.textContent = '';
    if (!shortcut) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = tr('welcome_shortcutNotSet', 'Not set, assign in browser shortcut settings');
      el.append(s);
      return;
    }
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const pretty = isMac
      ? shortcut.replace(/Ctrl|Control/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧')
      : shortcut;
    const parts = pretty.split('+');
    parts.forEach((part, i) => {
      if (i > 0) el.append(document.createTextNode(isMac ? ' ' : ' + '));
      const k = document.createElement('kbd');
      k.textContent = part.trim();
      el.append(k);
    });
  }

  async function paintShortcuts() {
    let cmds = [];
    try {
      cmds = await chrome.commands.getAll();
    } catch {
      cmds = [];
    }
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c.shortcut || '']));
    renderShortcut($('scScan'), byName['imgfetch-scan-page']);
    renderShortcut($('scCapture'), byName['imgfetch-capture-area']);
  }

  paint();
  paintShortcuts();
  paintHostAccess();
})();
