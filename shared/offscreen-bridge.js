/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch, shared/offscreen-bridge.js
 * One route to the offscreen jobs, in both browser shapes.
 *
 * Chrome and Edge run the background code as a service worker with no
 * document, so the jobs live in a separate offscreen document reached
 * through chrome.offscreen plus runtime messages. Firefox has no
 * offscreen API and no service worker background; its background page
 * is a document, so the same jobs can run in process in that page.
 *
 * The bridge picks exactly one route, by feature detection, on first
 * use, and never uses the other route afterwards:
 *
 *   document mode: chrome.offscreen exists, so ensure() creates (and
 *     reaps after idle) the offscreen document exactly as the service
 *     worker always did, and call() sends the same payload shape
 *     ({...message, target: 'offscreen'}) through runtime.sendMessage
 *     with the same retry rule for a listener that is not registered
 *     yet. The offscreen document's own listener is the only handler.
 *
 *   in-process mode: chrome.offscreen is absent, so ensure() loads the
 *     offscreen module into the background page (it has a DOM there)
 *     and call() invokes its exported dispatch function directly.
 *     No runtime message is sent for offscreen jobs in this mode, and
 *     the offscreen module does not register its runtime listener
 *     when loaded this way, so no message can be handled twice.
 *
 * Message types and payload shapes are unchanged in both modes: call()
 * accepts only the types the offscreen handler switches on, and passes
 * the caller's fields through untouched apart from adding target.
 *
 * Sender validation in in-process mode: there is no sender, because
 * there is no runtime message. The call site is the background page
 * code itself, and the dispatch function reference is held only by
 * this bridge instance; it is never registered as a listener, and the
 * temporary global handle used to hand it over at load time is deleted
 * right after the bridge reads it, so no web page, content script, or
 * other extension page can reach it. Messages that do arrive over the
 * runtime channel still go through the service worker's own
 * onMessage listener, which keeps its sender id check and its per
 * sender type allowlist, and which still declines target 'offscreen'
 * messages rather than answering them. Inside the dispatch, every
 * handler re-validates its own inputs (allowed source URLs, the
 * private network guard, the format allowlist, the SVG sanitizer),
 * exactly as in document mode.
 *
 * This module is also home to two small compatibility helpers that
 * share the same rule (feature detection, Chrome and Edge keep the
 * old behavior): openPopupBestEffort() and the host permission
 * helpers hasHostPermission() and requestHostPermission(). They live
 * here, rather than in a second new shared file, because the service
 * worker already imports this module for the bridge.
 */

export const OFFSCREEN_IDLE_REAP_MS = 30_000;
export const OFFSCREEN_MAX_ATTEMPTS = 4;
export const OFFSCREEN_RETRY_BASE_MS = 150;

/** Default offscreen document path, relative to the extension root. */
export const DEFAULT_OFFSCREEN_PATH = 'offscreen/offscreen.html';

/**
 * Every message type the offscreen handler accepts, in the same order
 * as its switch. call() rejects anything else with 'unknown', which
 * mirrors the handler's default case, so an unknown type can never be
 * routed to either mode.
 */
export const OFFSCREEN_MESSAGE_TYPES = [
  'CONVERT_IMAGE',
  'STRIP_METADATA',
  'SNIFF_TYPE',
  'CLIPBOARD_WRITE',
  'CLIPBOARD_IMAGE',
  'BUILD_ZIP',
  'ZIP_ABORT',
  'REVOKE_URL',
  'CONVERT_BMP',
  'CONVERT_SVG',
  'SANITIZE_SVG',
  'CONVERT_GIF',
  'STITCH_BEGIN',
  'STITCH_TILE',
  'STITCH_END',
  'STITCH_END_BLOB',
  'STITCH_PROBE',
  'STITCH_EXTEND',
  'CAPTURE_GROUP_FINALIZE',
  'STITCH_ABORT',
  'SUPPORTS_AVIF',
  'MEMORY_SAMPLE',
];

export function isOffscreenMessageType(type) {
  return typeof type === 'string' && OFFSCREEN_MESSAGE_TYPES.includes(type);
}

/**
 * True only when the full offscreen API is present. A partial API
 * counts as absent: half a document route is worse than the clean
 * in-process route. This is feature detection on the API object, not
 * a check of any browser identity string.
 */
export function hasOffscreenApi(chromeApi) {
  if (!chromeApi || typeof chromeApi !== 'object') return false;
  const offscreen = chromeApi.offscreen;
  if (!offscreen || typeof offscreen !== 'object') return false;
  return typeof offscreen.hasDocument === 'function' &&
    typeof offscreen.createDocument === 'function' &&
    typeof offscreen.closeDocument === 'function';
}

function resolveChromeApi(passed) {
  if (passed && typeof passed === 'object') return passed;
  try {
    if (typeof chrome !== 'undefined' && chrome) return chrome;
  } catch {
    /* no global chrome object in this context */
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default in-process loader. The flag must be set before the import
 * evaluates, because the offscreen module reads it at load time to
 * decide between registering its runtime listener (offscreen
 * document) and exposing its dispatch function (background page).
 * The dispatch function is read back off the same global and then
 * deleted from it right away, so after the load only this bridge holds
 * a reference and no other code in the background page can reach it.
 */
async function defaultLoadInProcessHandler() {
  globalThis.__imgfetchOffscreenInProcess = true;
  await import('../offscreen/offscreen.js');
  const handler = globalThis.__imgfetchOffscreenHandle;
  try {
    delete globalThis.__imgfetchOffscreenHandle;
    delete globalThis.__imgfetchOffscreenInProcess;
  } catch {
    /* a frozen global is not expected, and the handle stays private to this module's reader anyway */
  }
  if (typeof handler !== 'function') {
    throw new Error('offscreen in-process handler unavailable');
  }
  return handler;
}

/**
 * Build a bridge. Options, all optional except where noted:
 *   chromeApi: chrome namespace object (defaults to the global one).
 *   runtimeSendMessage: (payload) => Promise, defaults to
 *     chromeApi.runtime.sendMessage. Injected by tests.
 *   offscreenPath: document path for document mode.
 *   getJustification: () => string, or async () => string, for the
 *     createDocument justification. The service worker passes one
 *     that awaits i18n first, so the string is localized.
 *   inProcessHandler: preloaded dispatch function (tests use this).
 *   loadInProcessHandler: () => Promise<dispatch function>.
 *   sleep: (ms) => Promise, for the document mode retry delays.
 *   now: () => number, for idle reap timing.
 */
export function createOffscreenBridge(options) {
  const opts = options || {};
  const chromeApi = resolveChromeApi(opts.chromeApi);
  const runtimeSendMessage = opts.runtimeSendMessage ||
    ((payload) => chromeApi.runtime.sendMessage(payload));
  const offscreenPath = opts.offscreenPath || DEFAULT_OFFSCREEN_PATH;
  const getJustification = opts.getJustification || null;
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || (() => Date.now());
  let loadInProcessHandler = opts.loadInProcessHandler || defaultLoadInProcessHandler;
  if (opts.inProcessHandler) {
    const fixed = opts.inProcessHandler;
    loadInProcessHandler = async () => fixed;
  }

  let mode = null;
  let ensuring = null;
  let handlerPromise = null;
  let inflight = 0;
  let lastUsed = 0;

  function decideMode() {
    if (!mode) {
      mode = hasOffscreenApi(chromeApi) ? 'document' : 'in-process';
    }
    return mode;
  }

  function loadHandlerOnce() {
    if (!handlerPromise) {
      handlerPromise = loadInProcessHandler();
    }
    return handlerPromise;
  }

  async function ensure() {
    const decided = decideMode();
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (decided === 'in-process') {
        await loadHandlerOnce();
        return;
      }
      const exists = await chromeApi.offscreen.hasDocument().catch(() => false);
      if (exists) {
        // Do not let an idle offscreen document sit in memory: reap
        // it after 30 s of disuse, but never while a job is running.
        if (inflight === 0 && now() - lastUsed > OFFSCREEN_IDLE_REAP_MS) {
          try {
            await chromeApi.offscreen.closeDocument();
          } catch {
            /* already gone */
          }
        } else {
          return;
        }
      }
      // The justification string is user visible in chrome://extensions.
      const justification = getJustification ? await getJustification() : '';
      await chromeApi.offscreen.createDocument({
        url: offscreenPath,
        reasons: ['BLOBS', 'CLIPBOARD'],
        justification,
      });
    })().finally(() => {
      ensuring = null;
    });
    return ensuring;
  }

  async function call(message) {
    if (!message || typeof message !== 'object' || !isOffscreenMessageType(message.type)) {
      throw new Error('unknown');
    }
    await ensure();
    lastUsed = now();
    inflight += 1;
    try {
      const payload = { ...message, target: 'offscreen' };
      if (decideMode() === 'in-process') {
        // Direct call, no retry: there is no listener registration
        // race in process, and retrying a handler error could run a
        // side effecting job (ZIP accumulate, stitch tile) twice.
        const handler = await loadHandlerOnce();
        return await handler(payload);
      }
      let lastErr = null;
      for (let attempt = 0; attempt < OFFSCREEN_MAX_ATTEMPTS; attempt++) {
        try {
          return await runtimeSendMessage(payload);
        } catch (err) {
          lastErr = err;
          // createDocument resolves before the offscreen page's
          // scripts have registered their listener, so retry instead
          // of failing the job.
          if (/receiving end does not exist/i.test(String((err && err.message) || '')) && attempt < OFFSCREEN_MAX_ATTEMPTS - 1) {
            await sleep(OFFSCREEN_RETRY_BASE_MS * (attempt + 1));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    } finally {
      inflight -= 1;
      lastUsed = now();
    }
  }

  return {
    ensure,
    call,
    getMode: () => mode,
    getInflight: () => inflight,
    getLastUsed: () => lastUsed,
  };
}

/**
 * Best effort popup open, for the three service worker call sites.
 * Returns true when the popup opened, false otherwise, and never
 * throws: a sync throw (old browsers without the API) and a rejected
 * promise are both swallowed, exactly as the old call sites did with
 * their try/catch and .catch handlers. Firefox behavior: before
 * Firefox 149 the call rejects when the gesture was consumed by
 * awaits, which lands here as false and the action itself has
 * already run or surfaced its own notice; from Firefox 149 the call
 * no longer needs a gesture. Needs manual test in Firefox at each
 * call site, below and above 149.
 */
export async function openPopupBestEffort(actionApi) {
  let action = actionApi || null;
  if (!action) {
    const api = resolveChromeApi(null);
    action = api ? api.action : null;
  }
  try {
    if (!action || typeof action.openPopup !== 'function') return false;
    await action.openPopup();
    return true;
  } catch {
    return false;
  }
}

/**
 * The host patterns from the root manifest, in manifest order. The
 * runtime helpers default to these when no origins list is given.
 */
export const HOST_PERMISSION_ORIGINS = ['https://*/*', 'http://*/*'];

function originsList(origins) {
  return Array.isArray(origins) && origins.length ? [...origins] : [...HOST_PERMISSION_ORIGINS];
}

/**
 * True when the given hosts are granted. On a browser that has the
 * offscreen API (Chrome and Edge) this always returns true: those
 * browsers grant the manifest hosts at install and the old code never
 * asked, and contains() can report false there when the user narrowed
 * "site access" in the browser, which must not start showing a new
 * prompt. When the permissions API
 * itself is missing, or the contains check throws, this returns true:
 * the old code never checked at all, so a missing API must not newly
 * block Chrome or Edge. Only an explicit false from contains() counts
 * as not granted, and callers must surface that state to the user
 * rather than letting a fetch or injection fail silently.
 */
export async function hasHostPermission(chromeApi, origins) {
  const api = resolveChromeApi(chromeApi);
  if (hasOffscreenApi(api)) return true;
  const perms = api ? api.permissions : null;
  if (!perms || typeof perms.contains !== 'function') return true;
  try {
    return (await perms.contains({ origins: originsList(origins) })) === true;
  } catch {
    return true;
  }
}

/**
 * Request the host patterns from a user gesture. Returns true only
 * when the browser reports the grant. Must be called directly from a
 * click handler: the browser rejects requests made outside a user
 * action handler. Returns false when the permissions API is missing
 * or the request throws, and false when the user declines.
 * Note for the Firefox manifest: a runtime request is only valid for
 * origins listed as optional host permissions in the manifest, so
 * the Firefox build needs optional_host_permissions with these same
 * patterns (a manifest decision owned by the manifest generator,
 * flagged in the Round 9 report, not added here).
 */
export async function requestHostPermission(chromeApi, origins) {
  const api = resolveChromeApi(chromeApi);
  const perms = api ? api.permissions : null;
  if (!perms || typeof perms.request !== 'function') return false;
  try {
    return (await perms.request({ origins: originsList(origins) })) === true;
  } catch {
    return false;
  }
}
