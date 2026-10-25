# ImgFetch for Firefox

Status: in development, not released. Do not describe ImgFetch for Firefox as available, published, or installable from a store. There is no Firefox listing yet, and no AMO review has taken place. This document records what has been built, what has been verified without Firefox, and what still needs a manual test in Firefox.

Applies to: ImgFetch 1.1.1, root manifest unchanged from Chrome and Edge.
Identity: ImgFetch Developer, org `stillware`.
Add-on ID: `imgfetch@stillware` (see Permanent add-on ID below).

## How to build the Firefox zip

The Firefox build is derived from the same root manifest and the same file list as the Chrome and Edge builds. The root `manifest.json` is the single source of truth and is byte-identical to the baseline. No new root manifest permission was added, and Chrome and Edge loading unpacked from the repository root keeps working.

Full run, which also builds the Chrome and Edge zips:

```bash
bash scripts/package.sh
```

This produces `dist/imgfetch-firefox-<version>.zip` alongside `dist/imgfetch-chrome-<version>.zip` and `dist/imgfetch-edge-<version>.zip`. The Firefox zip differs from the Chrome and Edge zips only in `manifest.json`, verified by the packaging check in `scripts/package.sh`. The README inside all three zips is the repository `README.md`, byte-identical across the three zips. Note that `scripts/package.sh` ships the repository `README.md`, not `README-package.md`, in all three zips.

Firefox only staging, for local testing with web-ext and without running the full test suite:

```bash
bash scripts/package.sh --firefox-only
```

This builds only `dist/firefox-staging/`, with the same file list as the zips and the derived Firefox manifest at the staging root. It runs no tests. It is the folder to point web-ext at (see Run it below).

Packaging note, stated plainly: `scripts/package.sh` keeps CRLF line endings and cannot run under Linux bash. The owner uses Git Bash or WSL for packaging. In this round, the Firefox staging was verified with an LF copy of the script in a `/tmp` sandbox plus a Python replication of the INCLUDE logic: 91 files, Chrome compared with Edge identical, Firefox differing only in `manifest.json`.

The generator is `scripts/make-firefox-manifest.mjs`. It reads the root manifest and writes the derived Firefox manifest into build output only, never into the repository root. To inspect the derived manifest without packaging, run:

```bash
node scripts/make-firefox-manifest.mjs manifest.json /tmp/firefox-manifest.json
```

Do not copy that output into the repository root. The derived manifest is a build artifact.

### What the generator changes

The generator applies only these Firefox differences and fails loudly on any unknown root manifest field, so the two builds cannot silently drift apart:

1. Background: `background.service_worker` is replaced with `background.scripts` holding the same file, `background/service-worker.js`, and `type` stays `module`. The `service_worker` key is dropped, because Firefox does not support it.
2. `minimum_chrome_version` is removed. It is Chrome only and is not a Firefox floor.
3. The `offscreen` permission is removed. Firefox has no Offscreen API.
4. A `browser_specific_settings.gecko` block is added, with `id` `imgfetch@stillware`, `strict_min_version` `142.0`, and `data_collection_permissions` `{"required": ["none"]}`. See Minimum Firefox version below.
5. `optional_host_permissions` is added, repeating the root `host_permissions` (`https://*/*` and `http://*/*`). This is required so `chrome.permissions.request` can grant host access at runtime. Firefox does not grant `host_permissions` at install time. See Host permissions in the compatibility matrix.
6. Two command suggested keys are replaced with Firefox-specific defaults (see Shortcuts in the compatibility matrix). All other commands are unchanged.
7. Every other root field is copied unchanged.

## How to run it

Firefox is in development, so there is no store install path to document. Use a temporary add-on install for testing.

Temporary add-on in Firefox:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Choose Load Temporary Add-on.
3. Select the Firefox zip, or select `manifest.json` inside `dist/firefox-staging/`.
4. Test, then remember that a temporary add-on is removed when Firefox restarts. Reload it after a restart.

With web-ext, pointed at the staging folder:

```bash
npx web-ext run --source-dir dist/firefox-staging
```

Web-ext lint (see Lint status below for the run against this tree):

```bash
npx web-ext lint --source-dir dist/firefox-staging
```

## Lint status

Web-ext lint was run against the Firefox staging built from this tree on 2026-10-25 with web-ext 10.8.0 (installed via npx): 0 errors, 0 warnings, 0 notices. No Firefox binary exists in this environment, so no Firefox runtime test was possible; a clean lint run is not a substitute for the manual test checklist. Re-run lint after any manifest or staging change, and document every warning in this file if any appear.

## Minimum Firefox version and why

Minimum: Firefox 142.0, as `browser_specific_settings.gecko.strict_min_version` in the derived manifest.

Justification, constraint by constraint:

1. Data collection declaration: the AMO built-in consent declaration (`browser_specific_settings.gecko.data_collection_permissions` with `required` `["none"]`, because the extension collects no data) needs Firefox 140 on desktop and Firefox 142 on Android. A single 142.0 floor covers both, so no separate consent control is needed.
2. Optional host permissions: `optional_host_permissions` needs Firefox 128 or later. The 142.0 floor covers it.
3. Background scripts plus `service_worker` duality and `storage.session`: both are covered by 142.0. The derived manifest uses `background.scripts` only, not both keys, but 142.0 is above every version floor the background and storage paths need.
4. Popup opening is deliberately NOT a reason to raise the floor. `chrome.action.openPopup` may succeed from Firefox 149, but all three call sites are catch-guarded and degrade to no popup on earlier versions instead of crashing. Raising the floor to 149 solely for popup opening was not done. See `action.openPopup` in the compatibility matrix.

The derived manifest sets no `gecko_android` key and no `strict_max_version`. Android is out of scope for this round and needs a separate audit (downloads, context menus, capture, clipboard, and background behavior all differ on Android) before any Android claim is made.

## Permanent add-on ID

The add-on ID is `imgfetch@stillware`, defined once in `scripts/make-firefox-manifest.mjs` and nowhere else as a source value. It is permanent once published: changing it later creates a new AMO listing, not an update to the existing listing. Do not change it without a deliberate decision that a new listing is intended. It is an org-controlled string in the allowed format, not a personal address.

## Compatibility matrix

Reading note: "Chrome behavior" is what the code relies on today. "Firefox behavior" is what the cited Mozilla documentation says, or is marked as needing a manual test where it was not verified. "What was done" is the change already in the tree. Anything marked "needs manual test in Firefox" was not verified in a real Firefox and must not be presented as verified.

| API or behavior | Chrome behavior | Firefox behavior | What was done, and test status |
| --- | --- | --- | --- |
| Offscreen API (`chrome.offscreen`) | Creates one offscreen document at `offscreen/offscreen.html` for BLOBS and CLIPBOARD work, reaped after 30 seconds idle when no job is inflight, with retries when the listener is not yet registered. | Firefox does not implement `chrome.offscreen` and does not support `background.service_worker`. | Replaced by the offscreen bridge (see Offscreen bridge below). The `offscreen` permission is removed from the derived manifest only. |
| Offscreen jobs: image conversion, metadata stripping, type sniffing, BMP, SVG conversion, SVG sanitizing, GIF conversion | Run in the offscreen document: decode with `createImageBitmap`, draw to a DOM canvas, re-encode with canvas `toBlob` or `toDataURL`, fetch with Range headers for sniffing, sanitize SVG through DOMParser, build GIF through `core/gif.js`. | A Firefox background page is a document, so it can host DOM canvas, DOMParser, fetch, and `createImageBitmap` directly. | Jobs now run in-process in the background event page in the Firefox path, with identical message types and payloads. Needs manual test in Firefox for each job family. |
| Offscreen jobs: ZIP building, ZIP abort, URL revocation | Builds a ZIP in the offscreen document from fetched file blobs through `core/zip.js` and `core/zip-accum.js`, with abort and URL revocation messages. | Same background page document context can run the same pure ZIP modules. Abort timing across event page suspension is not verified. | Same bridge route as above. Needs manual test in Firefox for large ZIP builds and for abort. |
| Offscreen jobs: stitching and capture group finalization | Stitches viewport tiles on one long lived DOM canvas in the offscreen document, probes and extends the canvas, and finalizes a capture group into IndexedDB. Tile pacing is 520 ms because `captureVisibleTab` is rate limited in Chrome. | Stitch state held in a module variable in the offscreen document is lost if the replacement context unloads. Canvas size ceilings in Firefox are not verified. | Same bridge route as above. Needs manual test in Firefox for full page tiling, for the 32767 side ceiling, and for stitch survival across idle. See Known limitations. |
| Offscreen jobs: clipboard writes, AVIF probe | Writes text and PNG from the offscreen document, because the service worker has no user gesture of its own and no clipboard access in that context. Probes AVIF by a real 16 by 16 canvas encode and checks the blob type. | A background page is a document, so clipboard writes can run there, subject to the clipboard rules below. Whether a background page write without a fresh user gesture succeeds with `clipboardWrite` is not verified. | Same bridge route as above. Needs manual test in Firefox for copy from the context menu and from the popup, with and without a fresh click, and for the AVIF probe returning the PNG fallback result without throwing. |
| Background: service worker versus event page | Runs as a module service worker with no DOM, no window, and no document. No top level await. State that must survive restart is in `storage.session`, `storage.local`, or IndexedDB. | Firefox uses `background.scripts` as an event page. The `type` key controls whether scripts load as ES modules, so `type` `module` can stay. An event page can unload when idle. | Generator replaces `service_worker` with `scripts`, same file, `type` kept. The service worker file contains no service worker only API (no `skipWaiting`, no `clients.claim`, no `importScripts`, no install or activate listeners). Needs manual test in Firefox for module loading of the full import graph in the event page. |
| Timers (`setTimeout` pacing and retries) | Tile pacing, queue broadcast timer, and retry timers run through `setTimeout` in the service worker. | DOM based timers do not remain active after an event page has idled. Alarms are the recommended wake mechanism for a timer that must fire after idle. | No alarms-based rewrite was added. It would need a new `alarms` permission and was out of scope. Tile pacing inside an active capture is expected to be fine, but any timer that must span idle is untested. Needs manual test in Firefox. See Known limitations. |
| Host permissions and `chrome.permissions` | `host_permissions` are granted at install. The code never checked `permissions.contains` and never called `permissions.request`. Background fetch, offscreen fetch, and scripting injection all assume the hosts are granted. | Firefox MV3 treats manifest `host_permissions` as opt in, not granted at install. `permissions.request` can only run inside a user action handler, not from `runtime.onInstalled`. The user can deny some hosts. `optional_host_permissions` is supported from Firefox 128. | Added `optional_host_permissions` repeating the root hosts in the derived manifest, plus a user-gesture button on the welcome page (step 0) and in options (About section) calling `requestHostPermission`. Rows hide on grant, stay with denied text on decline, and stay hidden if the helper is unavailable. Only an explicit `false` from `permissions.contains` counts as not granted; a missing or throwing permissions API returns `true`, so Chrome and Edge behavior is unchanged. `activeTab` covers the current tab on toolbar click or menu click, but it does not replace host permissions for background fetch of arbitrary image hosts. Needs manual test in Firefox for the grant path, the deny path, and for fetch and injection with hosts granted and with hosts denied. See Open questions for the `optional_host_permissions` plus `host_permissions` question. |
| `chrome.action.openPopup` | Best effort popup open after a menu or command action, wrapped in catch, with comments noting it needs a user gesture and can be denied. The calls happen after awaits, so the gesture may already be lost even in Chrome. | Before Firefox 149, these calls are likely to reject after awaits, which the code already catches. From Firefox 149, the call may succeed, including the unfocused window rejection rule documented by MDN. | Three call sites in `background/service-worker.js` are replaced with `openPopupBestEffort()`, with the same swallow-errors behavior, returning a boolean. Zero remaining direct `chrome.action.openPopup` calls in the worker. Needs manual test in Firefox for each of the three call sites, before and after 149 if that behavior matters. |
| `chrome.storage.local` | Persists settings, history, and counters. Settings are cached in a module variable and mirrored to `storage.local`. | Supported in Firefox under the `storage` permission, which the manifest already declares. | No change. Needs manual test in Firefox for settings migration and history pruning. |
| `chrome.storage.session` | Holds the download queue, the last scan payload, scan state, and capability probes in memory, so a worker restart can requeue unfinished items. The code already treats `storage.session` as a cache over IndexedDB and local storage, not as the only copy of capture blobs. | Session items are stored in memory for the browser session, are not persisted to disk, and are cleared when the browser stops or the extension is disabled or uninstalled. | No change to the API calls. A missing or cleared session area degrades to requeue from IndexedDB, not to data loss. Needs manual test in Firefox for queue recovery after an event page restart. |
| `chrome.storage.onChanged`, `chrome.runtime` (sendMessage, onMessage, getURL, getManifest, openOptionsPage, onInstalled, onStartup) | Message routing with sender id checks, URL building for extension pages, version display, welcome tab on install, menu rebuild on startup. | All of these runtime members are long supported in Firefox. Firefox also supports `chrome` namespace calls with callbacks as a porting aid, so the existing promise style calls do not need a namespace rewrite. The service worker to offscreen routing through `runtime.sendMessage` with a `target` field disappears with the offscreen document and is replaced by direct calls in the background page. | No change, except for the offscreen routing replacement. Needs manual test in Firefox for the onInstalled welcome tab and the onStartup menu rebuild. |
| `chrome.tabs` (create, get, query, update, reload, remove) | Opens result, rename, info, options, and welcome pages, queries the active tab in the current window, reloads a result tab, and removes temporary tabs. The manifest does not declare the `tabs` permission, and the code does not read privileged tab fields in a way that was found to need it. | Supported in Firefox. If any Firefox path reads privileged tab fields, host permissions or the `tabs` permission would be needed. | No change. Needs manual test in Firefox for every tabs call site, especially query with active and currentWindow, and create with an extension page URL. |
| `chrome.tabs.captureVisibleTab` | Captures the visible viewport as a PNG data URL, always with format `png`, never jpeg quality, and never rect or scale options, with a 520 ms tile gap and a stability wait. | MDN documents `tabs.captureTab` as the Firefox name for the same capture family, and documents rect and scale support from Firefox 82. Whether `chrome.tabs.captureVisibleTab` is accepted in Firefox exactly as written was not established from a cited compat table. No Firefox rate limit, maximum capture size, or tiling difference was verified. | No change to the call as written, pending test. Needs manual test in Firefox for captureVisibleTab compared with captureTab acceptance, capture of a tab in a non active window, capture size ceiling on large viewports, and full page tiling timing. |
| `chrome.scripting.executeScript` | Injects `content/scanner.js` and `content/overlay.js` by file, and runs func bodies in the ISOLATED world with args, including `allFrames` true for scanning. No MAIN world injection is used. | Scripting is supported in Firefox MV3. The ISOLATED world and the files form are the portable forms. Injection into a page requires a matching host permission or `activeTab` for that tab. | No change to the API calls. The host permission flow above is the change. Needs manual test in Firefox for allFrames scanning, overlay injection, and func serialization on a page with frames. |
| `chrome.contextMenus` and `chrome.commands` | Builds nested image and page menus on install and on startup. Dispatches five commands to scan, select element, capture area, and capture element handlers. Options and welcome pages display the real shortcut list from `getAll` instead of hardcoding. | Supported in Firefox under the `contextMenus` permission, which the manifest declares. The image and page contexts used here are standard contexts. The manifest commands format, including `suggested_key.default`, is supported. | No change to the API calls. Shortcut defaults are audited below. Needs manual test in Firefox for menu nesting depth, separator rendering, and onClicked after an event page restart. |
| `chrome.action` (manifest action key, default popup, icons, title) | Toolbar button opens `popup/popup.html` with localized title and icons at 16, 32, 48, and 128 px. | Supported in Firefox MV3. Firefox icon sizing rules pick the smallest larger icon, or the largest if all are smaller. The manifest supplies 16, 32, 48, and 128, so Firefox can pick a suitable size. | No change. Needs manual test in Firefox for icon sharpness on high DPI. |
| `chrome.downloads` (download, search, onChanged, cancel, show) | Single download helper passes url, filename, saveAs from settings (default false), and conflictAction `uniquify`, and catches failures to null. Search ties a download id to queue state, onChanged drives history, cancel drives queue cancel, show drives Show in folder. | The exact options used here (url, filename, saveAs, conflictAction) are all documented for Firefox. When saveAs is true, the Save As dialog is shown populated with filename; when omitted, Firefox follows the user preference for asking where to save files. | No change to the options used. Needs manual test in Firefox for saveAs true and false, uniquify on conflict, subfolder filenames, data URL downloads, and show on all desktop platforms. |
| `chrome.notifications.create` (basic type only) | Creates basic notifications with type `basic`, iconUrl from `icons/icon-48.png`, title ImgFetch, and message text. No id, no buttons, no imageUrl, no progress, no list items, no requireInteraction, no silent flag, no priority, no contextMessage. All calls are catch-guarded. | Firefox currently only supports type, title, message, and iconUrl, and the only supported value for type is `basic`. That is exactly the subset the code uses. One warning: calling create more than once in rapid succession may result in no notification being displayed at all. | No change. Needs manual test in Firefox for rapid successive notifications and for icon rendering from a PNG iconUrl. |
| Clipboard (`navigator.clipboard`, ClipboardItem, `clipboardWrite` permission) | Editor copy uses a promise-backed ClipboardItem with image/png, called synchronously from the click handler, with downscale to a 12 MP budget before encode. Offscreen copy writes PNG the same way. Page injected copy writes text and falls back to a textarea plus execCommand copy. The manifest declares `clipboardWrite`. | ClipboardWrite enables writing outside a short lived user action handler. Extension pages (popup, annotate, options) are extension contexts, so the editor direct write path is the expected Firefox path. The exact Firefox version where image/png ClipboardItem write became unflagged was not verified from an MDN compat table. | No code change to the editor path (`shared/copy-shot.js` already uses promise-backed ClipboardItem image/png synchronously from the click handler, with `clipboardWrite` already declared). Needs manual test in Firefox for editor copy from the annotate page click, popup copy, context menu copy image (which goes through the background page in the Firefox build), large image downscale to 12 MP, and copy without a fresh gesture. |
| OffscreenCanvas, `convertToBlob`, `createImageBitmap`, canvas `toBlob` and `toDataURL` | Crop uses `createImageBitmap` with a crop rect, draws to a new OffscreenCanvas, and exports with `convertToBlob` image/png, described as lossless by construction with no quality parameter. Offscreen conversion uses DOM canvas `toBlob` and `toDataURL`. No WebGL context is used. | OffscreenCanvas is supported in Firefox, and `convertToBlob` is an older API, but the exact constructor plus 2d context plus `convertToBlob` combination version was not verified from an MDN compat table. In Firefox the background page is a document, so both DOM canvas and OffscreenCanvas are available. | No change to the crop module logic. Needs manual test in Firefox for crop at large sizes, for odd rects, and for the 32767 side case, in the background page context. |
| AVIF probe and fallback | Fast probe, then one real encode with MIME verification of the output. If AVIF is not really available, the smart download path reports the avif-unavailable error, and the bulk path falls back to PNG. | Canvas AVIF encoding is not available in Firefox either. `toBlob` with image/avif silently falls back to PNG for an unsupported type, which is exactly why the code MIME checks the blob type. Firefox AVIF decoding support does not imply AVIF encoding support. | Probe and PNG fallback logic untouched. Only the user-facing wording changed to browser-neutral ("AVIF encoding is not available in this browser. A PNG was saved instead.") in `core/validation.js` and `_locales/en/messages.json`. The other 20 locales still carry the old Chrome and Edge 130 plus wording. That needs a locale pass, not hand-edited translations. See Known limitations. Needs manual test in Firefox to confirm the probe returns the fallback result and does not throw. |
| `chrome.i18n` and manifest `__MSG__` placeholders | The extension does not call `chrome.i18n.getMessage` in code. It uses a custom loader that fetches `_locales` messages through `runtime.getURL`, and it relies on the browser to substitute `__MSG__` placeholders in the manifest. | Manifest `__MSG__` substitution is supported in Firefox, and the custom loader only needs `runtime.getURL` and fetch, both available in Firefox extension contexts. | No change. Needs manual test in Firefox for locale fallback, especially `es_419` and zh variants, and for manifest title and description localization. See Known limitations. |
| IndexedDB (`background/idb.js`, `shared/capture-io.js`) | Capture records and blobs live in IndexedDB, not in `storage.session`, so a worker restart does not lose them. | A Firefox background page document context supports IndexedDB. Transactions surviving event page unloading during a long capture were not verified. | No change expected. Needs manual test in Firefox for capture record write, read, prune, and recovery after restart. |
| Fetch, Range requests, credentials, private network guards | Fetches image URLs, sometimes with credentials include from the page, sometimes with credentials omit and no referrer from the offscreen document, and with Range bytes 0 to 31 for sniffing. Private network and lens URL guards live in `core/urls.js`. | Fetch in an extension context in Firefox requires host permission for cross origin hosts, which ties back to the host permissions row. The fetch API itself is not a gap. | No change to fetch calls. The host permission flow is the change. Needs manual test in Firefox for fetch from the background page to image hosts with hosts granted and with hosts denied. |
| Content Security Policy, extension pages | CSP is `script-src 'self'; object-src 'self'` for extension pages. No remote code, no eval in the manifest, and all scripts are local files. | Firefox MV3 supports the extension pages CSP key in the same form. No CSP difference was found from the cited docs, and web-ext lint passes with 0 warnings. | No change expected. Needs manual test in Firefox through loading every extension page. |
| `options_page` compared with `options_ui`, and `runtime.openOptionsPage` | Options page is `options/options.html`, opened through `runtime.openOptionsPage` and, in one place, through `tabs.create` to `options/options.html` with a hash for the sites section. | Whether Firefox MV3 accepts the `options_page` key exactly as written, or requires `options_ui` with page and open_in_tab, was not verified from a cited MDN page. | No change made. The derived manifest keeps `options_page` unchanged. Needs manual test in Firefox: load the extension, call openOptionsPage, and check whether the options page opens and whether the hash navigation to the sites section works. If lint rejects `options_page`, switch the Firefox manifest to `options_ui` and retest. See Known limitations and Open questions. |
| `minimum_chrome_version` and Chrome only manifest keys | Chrome refuses to install below version 116. | Firefox ignores `minimum_chrome_version`, so keeping it would be harmless but confusing in a Firefox only manifest. It is not a Firefox floor and must not be copied into `strict_min_version`. | Removed from the derived manifest only. |
| Permissions list as a whole | Eight permissions, all requested at install in Chrome, with no optional permissions: contextMenus, downloads, storage, scripting, activeTab, offscreen, notifications, clipboardWrite. | All eight names exist in Firefox permission lists, except offscreen, which is the Chrome only permission tied to the offscreen API and must be removed from the Firefox manifest. The other seven are supported in Firefox. `activeTab` in Firefox grants temporary access on toolbar click and on context menu selection, which helps the popup and menu paths but does not replace host permissions for background fetch. | Derived manifest keeps the seven supported permissions in root order and drops offscreen only. |

## Offscreen bridge

`shared/offscreen-bridge.js` is the single route to the offscreen jobs in both browser shapes. It feature-detects `chrome.offscreen`: all three of `hasDocument`, `createDocument`, and `closeDocument` must be functions, or the API counts as absent. A partial API counts as absent. There is no browser-name sniffing anywhere.

Chrome and Edge path: unchanged through `chrome.offscreen`, with the same document creation, idle reaping, and retry rule the service worker always used.

Firefox path: the offscreen handlers run in-process in the background event page. `offscreen/offscreen.js` is imported as a module once, guarded so its runtime listener is NOT registered in-process. The dispatch function is called directly with identical message types and payloads. There is no duplicate handling and no message loop.

The 22 allowlisted message types are: CONVERT_IMAGE, STRIP_METADATA, SNIFF_TYPE, CONVERT_BMP, CONVERT_SVG, SANITIZE_SVG, CONVERT_GIF, BUILD_ZIP, ZIP_ABORT, REVOKE_URL, STITCH_BEGIN, STITCH_TILE, STITCH_END, STITCH_END_BLOB, STITCH_PROBE, STITCH_EXTEND, STITCH_ABORT, CAPTURE_GROUP_FINALIZE, MEMORY_SAMPLE, CLIPBOARD_WRITE, CLIPBOARD_IMAGE, and SUPPORTS_AVIF.

Sender validation in-process: there is no runtime sender, because no runtime message is sent. The dispatch reference is held only by the bridge instance and never registered as a listener or attached to window, so no page, content script, or other extension page can reach it. Messages arriving over the runtime channel still pass the service worker's unchanged listener: the sender id must equal `chrome.runtime.id` plus the per-sender-type allowlist, failing closed. Handlers still re-validate inputs (URL guard including redirect re-check, format allowlist, SVG sanitizer).

One behavior note: malformed or unknown messages are now rejected immediately by the bridge instead of going through the old send-then-reject path. For every type the worker actually sends, behavior is identical.

Bridge tests: `tests/test-offscreen-bridge.mjs`, 64 passed, 0 failed.
Generator tests: `tests/test-make-firefox-manifest.mjs`, 27 passed, 0 failed.

## Service worker touch points

In `background/service-worker.js`:

1. One new import line for the bridge.
2. Old offscreen state variables removed, now owned by the bridge.
3. Old `ensureOffscreen` and `offscreenCall` bodies replaced by thin bridge wrappers. Every existing `offscreenCall` call site is untouched.
4. Three `chrome.action.openPopup` sites replaced with `openPopupBestEffort()`, with the same swallow-errors behavior, returning a boolean.
5. Zero remaining direct `chrome.offscreen` or `chrome.action.openPopup` calls in the worker.

In `offscreen/offscreen.js`: the listener switch moved verbatim into `dispatchOffscreenMessage`, with a thin wrapper keeping the exact target and type gate and the foreign-sender check, plus the in-process guard described above.

## Shortcuts

MDN rule that governs all rows: if a key combination is already used by the browser or by another add-on, you can define it, but your event handler will not be called. A conflict is silent, not an install error. The options and welcome pages show the real shortcut list from `commands.getAll`, so a user can rebind in Manage Extension Shortcuts even where a default is suppressed.

| Command | Chrome default | Firefox default | Reason and test status |
| --- | --- | --- | --- |
| imgfetch-scan-page | Ctrl+Shift+S | Alt+Shift+S | Ctrl+Shift+S is Firefox Take a Screenshot. The Chrome default must not ship as the Firefox default, because the handler will not be called. Alt+Shift+S is a candidate, subject to a press test in Firefox before shipping. If it is found taken in testing, ship the Firefox command with no suggested key and let the user bind it in Manage Extension Shortcuts, with guidance on the welcome page. Do not claim Alt+Shift+S is free until it is pressed in Firefox. |
| imgfetch-capture-area | Ctrl+Shift+X | Ctrl+Shift+X, unchanged | No built-in Firefox match was found in the shortcut lists checked. Confirm by pressing it in Firefox during manual testing, because the lists checked were not an official complete reserved list. |
| imgfetch-select-element | Alt+Shift+E | Alt+Shift+E, unchanged | No built-in Firefox match was found in the shortcut lists checked for Alt+Shift+E as a built-in browser action. Note that Alt+Shift combinations are also used as web page access keys, which is page level behavior, not a browser command conflict found here. Confirm by pressing it in Firefox during manual testing. |
| imgfetch-capture-element | Ctrl+Shift+E | Alt+Shift+C | Ctrl+Shift+E is the Firefox Network monitor (developer tools). Do not ship Ctrl+Shift+E as the Firefox default on the assumption that developer tools being closed makes it free. Alt+Shift+C is a candidate, subject to a press test in Firefox before shipping. If it is found taken in testing, ship the Firefox command with no suggested key and let the user bind it in Manage Extension Shortcuts. |
| imgfetch-scan-page-alt | No suggested key | No suggested key, unchanged | No default to conflict. The user binds this command in Settings, and options and welcome pages already surface `commands.getAll`. |

## Known limitations

1. Long-job idle survival: no alarms-based rewrite was added, because it would need a new `alarms` permission and was out of scope. Large ZIP builds and full-page stitching across an event-page idle cycle are untested. Needs manual test in Firefox. If a long job is interrupted by unload, that is a real limitation to record here with the failing case, not a case to work around by guessing.
2. Options page acceptance: web-ext lint accepts the derived manifest with `options_page` unchanged (0 warnings), but whether the options page opens correctly at runtime, including hash navigation to the sites section, still needs a load test. See Open questions.
3. Capture ceiling: PART_MAX_SIDE 32767 and PART_MAX_AREA 100000000 from `core/fullpage-capture.js` must be rechecked against the Firefox canvas actually used. Needs manual test in Firefox.
4. Locale fallback: `es_419`, `pt_BR`, `zh_CN`, and `zh_TW` resolution in Firefox was not verified. Needs manual test in Firefox.
5. Shortcut candidates: Alt+Shift+S and Alt+Shift+C are candidates only until pressed in Firefox on Windows, macOS, and Linux. Needs manual test in Firefox on each platform before shipping either as a default.
6. AVIF locale wording follow-up: only English wording was changed to browser-neutral. The other 20 locales still carry the old Chrome and Edge 130 plus wording. That needs a locale pass, not hand-edited translations. Do not hand-edit translations to fix it.
7. Alarms not added: see item 1. No timer that must wake an idle event page was proven to need waking, so no `alarms` permission was added speculatively.
8. Popup before Firefox 149: on Firefox before 149, the three popup opens after async work are likely to reject and degrade to no popup, with no crash. That degradation is accepted at the 142.0 floor. It is not a reason to raise the floor unless the team explicitly decides popup opening after async work must succeed.
9. Host permission install UI: what exactly the Firefox install prompt shows for two broad host patterns in the current release, and whether they are checked by default, was not observed in a live Firefox. Needs manual test in Firefox.
10. Temporary add-on scope: temporary installs are removed on Firefox restart, and host permission grants for a temporary add-on may need repeating after reload. Record the observed behavior during manual testing rather than assuming it.

## Validation

`scripts/validate.py`, section 5b, derives the Firefox manifest to a temp directory (never into the repository root) and checks: valid JSON, all referenced files exist, permissions equal root minus offscreen, no offscreen permission, no `service_worker` key, background scripts and type match root, no `minimum_chrome_version`, permission usage, gecko id, `strict_min_version`, and data collection declaration exact, `optional_host_permissions` matching `host_permissions`, commands matching root with the two Firefox key overrides, and all other fields preserved.

The full validator must end with ALL CHECKS PASSED before any Firefox claim is repeated outside this document. That gate includes the project-structure tree lines and test counts for the new Firefox files.

## Open questions

Everything marked "needs manual test in Firefox" in the matrix above is an open question until it is tested. In addition:

1. Does `permissions.request` work with `optional_host_permissions` added, as implemented? And does it also work with hosts only in `host_permissions`, without `optional_host_permissions`? The implemented build uses both lists, with `optional_host_permissions` repeating `host_permissions`. The second form is untested and must not be assumed to work.
2. Web-ext lint: run on 2026-10-25 with web-ext 10.8.0 against the Firefox staging built from this tree: 0 errors, 0 warnings, 0 notices. Re-run after any manifest change.
3. AMO review outcome unknown. No submission has been made and no review feedback exists.
4. Background page unload during long jobs: does a Firefox event page stay alive for a multi minute ZIP build or a long full page stitch, or does it unload and lose stitch and ZIP state? Needs manual test in Firefox with a large page and a large ZIP.
5. Firefox canvas ceiling: is PART_MAX_SIDE 32767 valid for the canvas actually used in the Firefox background page, or does Firefox cap canvas dimensions lower for the stitch canvas? Needs manual test in Firefox.
6. Capture acceptance: is `chrome.tabs.captureVisibleTab` accepted as written in Firefox, or must the code call `tabs.captureTab`? Needs manual test in Firefox, with a tab in a non active window.
7. Clipboard image write from the background page: does a context menu copy image succeed from the background page with `clipboardWrite`, or must it be routed through an extension page click? Needs manual test in Firefox.
8. Options page acceptance: web-ext lint accepts `options_page` unchanged. Does the options page open correctly at runtime, including hash navigation? Needs manual test in Firefox.
9. Shortcut candidates: are Alt+Shift+S and Alt+Shift+C actually free in current Firefox on Windows, macOS, and Linux? Needs manual test in Firefox on each platform before shipping either as a default.
10. OpenPopup before 149: is the pre 149 degradation (popup simply does not open after a command) acceptable, or should the floor be raised to 149? This is a decision for review, with the tradeoff stated in Minimum Firefox version above.
11. Host permission install UI: see Known limitations item 9.
12. Locale resolution: do `es_419`, `pt_BR`, `zh_CN`, and `zh_TW` resolve correctly in Firefox, or does Firefox fall back to a parent locale for any of them? Needs manual test in Firefox.
13. Android scope: is Android in scope at all? This round assumes desktop only. If Android is added, a separate audit is needed first.
14. Module loading: does the full background import graph load in a Firefox event page as written, or is a bundled single file background script needed? Needs manual test in Firefox.
15. Queue recovery: does queue recovery after an event page restart work from IndexedDB as designed? Needs manual test in Firefox.

## Sources

Mozilla documentation consulted for the inventory behind this document (plain URLs, no claim that a live Firefox check replaced them):

https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_permissions
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action/openPopup
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications/NotificationOptions
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard
https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/

## Manual testing

Work through the Firefox section of [the manual test checklist](tests/manual-test-checklist.md) in a real Firefox. Record the Firefox version, the platform, and the exact result for every item, including every "needs manual test in Firefox" item above, before changing any status line in this document.
