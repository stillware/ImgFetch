# ImgFetch Security Review (Phase 5, Part H)

Hostile review of the final Phase 5 code, run last, on the tree as it
stands after Parts A to G. Every item in the Phase 5 addendum (H1 to
H11) was checked, every fixable finding was fixed, and everything that
could not be fixed in scope is listed under Accepted residual risk or
Recommendations instead of hidden.

Applies to: ImgFetch 1.1.1
Last verified: 2026-11-23
Reviewer method: code reading of every trust boundary, targeted grep
evidence in `out/compare/H/`, new tests in `tests/test-security.mjs`
(section 12), and the new static checker `scripts/check-security.mjs`
(18 checks, all passing). The full test suite and all repo checks were
run green at the end; the numbers are in the final report, not here.

Severity means: Critical (remote code or data theft with no user
action), High (a hostile page or host can act with the extension's
privileges), Medium (a hostile input can corrupt data, waste resources
or mislead the user), Low (defense in depth, or a cosmetic gap).

## Checklist results

### H1. Manifest and permissions: PASS

Manifest (`manifest.json`) is unchanged except for the one allowed
Phase 5 change, the optional `downloads.open` permission from item B2.
Verified:

* Required permissions, exactly eight: `contextMenus`, `downloads`,
  `storage`, `scripting`, `activeTab`, `offscreen`, `notifications`,
  `clipboardWrite`. Each is used (spot check: `validate.py` section 5
  ties each permission to the API that needs it) and each is justified
  in `docs/permissions.md`. No unused permission was found.
* Optional permissions, exactly one: `downloads.open`. It is requested
  only from the Open click (a user gesture) in `shared/history-ui.js`
  (`requestDownloadsOpenPermission`, via `chrome.permissions.request`),
  never at install and never in the background. Denial falls back to
  `downloads.show` with a quiet toast. If the popup closes while the
  prompt is up, the grant is stored by the browser, so the next click
  finds it already granted. The open itself runs in the popup or
  options page, never in the service worker: the worker call fails
  with "User gesture required" (proven live in Phase 5). There is
  deliberately no `OPEN_DOWNLOAD` message type in the worker.
* Host permissions, exactly two: `https://*/*` and `http://*/*`.
  Scheme wide because image hosts are unpredictable; narrower patterns
  would break scanning and conversion on unvisited sites. Documented
  in `docs/permissions.md`.
* No `externally_connectable` key exists, so no web page can send
  `chrome.runtime` messages to the extension. No
  `web_accessible_resources` key exists, so no extension page, script
  or asset is exposed to web pages at all.
* Extension pages CSP is exactly `script-src 'self'; object-src
  'self'`: no `unsafe-eval`, no `unsafe-inline`, no remote script or
  style. All code ships inside the package.
* `scripts/check-security.mjs` asserts every line above, so a future
  permission or CSP change fails the check instead of slipping in.

### H2. Messaging and trust boundaries: PASS, 3 findings fixed

* The service worker (`background/service-worker.js`, line 3317) runs
  every inbound message through `isValidMessage` and then requires
  `sender.id === chrome.runtime.id`, then applies `SENDER_RULES` by
  sender kind (`core/validation.js`). Only `SCAN_PROGRESS` may come
  from a content script; every other routable type requires an
  extension page sender. Anything unlisted is denied. No
  `onMessageExternal` handler exists anywhere (there is nothing for a
  web page to call, see H1). No `window.postMessage` listener exists
  anywhere in shipped code (grep over all shipped JS returns zero
  hits), so that half of H2 is not applicable.
* The offscreen document (`offscreen/offscreen.js`,
  `handleOffscreenMessage`) checks `sender.id` before dispatch, and
  every dispatch arm coerces or allowlists its fields (`String(...)`,
  `Number(...)`, format allowlist, `allowedSource`). The worker is its
  only caller.
* The popup (`popup/popup.js`, `onRuntimeMessage`) checks
  `sender.id`. The options page HISTORY_THUMB listener did not, so
  that was fixed (see F-H2-1). The broadcast payload is still
  sanitised on use (`updateHistoryRowThumb` only assigns a thumb after
  `sanitizeHistoryThumb` accepts it).
* Findings fixed:
  * F-H2-1 (Low): `options/options.js` HISTORY_THUMB listener
    accepted broadcasts without checking the sender. Fixed at
    `options/options.js:514` (sender id check). The payload was
    already sanitised on use, so no injection was possible; this is
    defense in depth.
  * F-H2-2 (Medium): `SCAN_PROGRESS` (the one type a content script
    may send) had no shape validation. Its counts drive the popup
    progress bar, and the popup receives the broadcast directly from
    the content script, so the worker's gate never sees it. Fixed in
    two places: `isValidScanProgress` in `core/validation.js:146`
    (integers, 0 to 1,000,000, done never past total), enforced by
    `isValidMessage`, and a matching guard in the popup at
    `popup/popup.js:271`.
  * F-H2-3 (Low): the popup and options page built a selector from a
    broadcast record id (`[data-record-id="${msg.id}"]`). A hostile
    id containing a quote would throw in `querySelector` and stop the
    handler. Fixed with `CSS.escape(String(msg.id))` at
    `popup/popup.js:318` and `options/options.js:516`.
  * F-H2-4 (Low, cosmetic): the worker's sender id check was written
    twice in a row (`background/service-worker.js`, the duplicated
    block before `senderKind`). The duplicate was removed; behaviour
    is unchanged. A test now asserts exactly one `foreign-sender`
    rejection in the worker.
* No handler lets a web page trigger a download, fetch, history write
  or settings change: every such action is extension-sender only, and
  every one of them also starts from a user gesture in extension UI
  (click, menu item, shortcut) or from a download the user started.

### H3. Network fetching: PASS, 5 findings fixed

The fetch inventory (from `scripts/check-security.mjs`, which lists
every `fetch(` call site) is short and each site is accounted for:

| Call site | What it fetches | Credentials | Caps and guards |
|---|---|---|---|
| `background/service-worker.js:501` | A page `blob:` URL, fetched in-page by `resolveBlobUrl` | Page default (blob URLs carry no cookies) | 25 MB, image type check |
| `background/service-worker.js:1472` | Thumbnail or Copy source, through `fetchImageBytes` | omit, no referrer | 25 MB streaming, 10 s, sniff, private guard, redirect re-check |
| `background/service-worker.js:2804` | Copy Image fallback, fetched in-page by `copyImageInPage` | Same-origin only (see below) | Canvas size cap, first-frame only |
| `offscreen/offscreen.js:84` | The single capped fetch, `fetchBytesCapped` | omit, no referrer | Per-call byte cap while streaming, 30 s, redirect re-check |
| `pages/info.js:45` | EXIF head, `fetchHead` | omit, no referrer | Streaming cap, private guard |
| `shared/history-ui.js:432` | History Copy source, through `fetchImageBytes` | omit, no referrer | 25 MB streaming, 10 s, sniff, private guard, redirect re-check |
| `shared/i18n.js:172` | Own locale file via `chrome.runtime.getURL` | Not a network fetch | Extension-local URL only |

* Findings fixed:
  * F-H3-1 (High): `fetchImageBytes` (`core/history.js`) buffered the
    whole body with `arrayBuffer()` before the 25 MB cap was checked,
    trusted the `Content-Type` header for the MIME type, and had no
    private-network or redirect guard of its own. The history Copy
    path used it with no guard at all. Fixed at
    `core/history.js:192`: the cap is now enforced while streaming
    (reader cancelled past the cap), the MIME comes from
    `sniffImageMime` (`core/history.js:156`, magic bytes for PNG,
    JPEG, GIF, WebP, BMP, AVIF, ICO, TIFF and SVG text; anything else
    throws `not-image`), and an optional `pageUrl` applies the
    private-network guard before fetching and the redirect re-check
    before the body is read. Both callers pass it (worker thumbnail
    fetch, history Copy). The timeout now covers the body read too,
    and a non-abort fetch rejection clears the timer.
  * F-H3-2 (High): the offscreen document fetched with no timeout, no
    size cap and no sniffing in `loadBitmap`, `sanitizeSvg`,
    `convertSvg`, `tryAnimatedGif`, `fetchZipFile` and the SVG
    fallback, and `sniffType` buffered a whole file when a server
    ignored the Range request and answered 200. Fixed by collapsing
    all of them into one choke point, `fetchBytesCapped`
    (`offscreen/offscreen.js:79`): 30 s timeout, Content-Length
    pre-check, size cap enforced while streaming, redirect re-check,
    `credentials: omit`, `referrerPolicy: no-referrer`. It is now the
    only direct `fetch(` in the offscreen document, and seven call
    sites route through it (asserted in the security tests).
  * F-H3-3 (Medium): `loadBitmap` trusted `blob.type` (the
    Content-Type header) and decoded with no pixel cap, so a
    decompression bomb (a tiny file claiming enormous dimensions)
    reached the decoder. Fixed: magic sniff before decoding, header
    dimensions checked before decoding (`imageDimensions`,
    `core/history.js:504`, now exported and extended with BMP and
    ICO), and the decoded bitmap checked again
    (`assertImagePixelBudget`, `core/history.js:61`; 16,384 px per
    side, 268,435,456 total pixels, one definition imported by the
    offscreen document). `convertSvg` got the same post-decode cap.
  * F-H3-4 (Medium): `copyImageInPage`
    (`background/service-worker.js:2804`) fetched with
    `credentials: 'include'` for any origin. A cross-origin image
    host that opts into credentialed CORS would have received the
    user's cookies for that site. Fixed: cookies are sent only when
    the image is on the same origin as the page
    (`sameOrigin ? 'include' : 'omit'`), decided by
    `isSameOriginUrl` (`core/urls.js:383`). Same-origin images behind
    a login still copy; cross-origin images fall back to the canvas
    route. See Accepted residual risk R5.
  * F-H3-5 (Low): `sniffType` is now capped at 64 bytes while
    streaming (was: `arrayBuffer()` after a 200 response).
* SSRF policy, as implemented in `core/urls.js`: extension-privileged
  fetches refuse loopback, RFC 1918, link-local, CGNAT
  (100.64.0.0/10), 0.0.0.0/8, `localhost`, `.local`, `.internal`,
  `.lan`, `.home.arpa`, single-label hostnames, and the IPv6
  equivalents including IPv4-mapped, compatible, NAT64 and 6to4
  forms. The one exception is same-host: a fetch to the same private
  host as the page itself is allowed, so a user intranet keeps
  working. Every redirect hop is re-validated (`isRedirectBlocked`)
  before the body is used, in the worker, the offscreen document, the
  info page and `fetchImageBytes`. Non-image responses fail closed
  and their content is never exposed (sniff rejects them before any
  decoder or canvas sees them). Scheme rules in `normalizeUrl`: only
  `http:`, `https:`, validated `data:image` (50 MB decoded cap) and
  page `blob:` URLs; `file:`, `chrome:`, `chrome-extension:`,
  `javascript:`, `ftp:` and credentials in URLs are refused.
* Credentials policy: no extension-privileged fetch sends cookies or
  credentials except the two cases above (in-page blob resolution,
  which is page-scoped, and the same-origin Copy Image fetch). All
  conversion, thumbnail, ZIP, sniff and EXIF fetches use
  `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. A fetch
  reveals only the requester's IP address to that image host, exactly
  as a normal browser request to the same site would. This is now
  stated in `PRIVACY.md` and `docs/security-model.md`.

### H4. DOM and injection: PASS, no findings

* Grep over all shipped JS and HTML finds zero `innerHTML` or
  `outerHTML` assignments, zero `insertAdjacentHTML`,
  `document.write`, `eval(` and `new Function`, and zero
  string-argument `setTimeout`/`setInterval`. The only
  `setTimeout` calls pass functions. `scripts/validate.py` section 4
  and `scripts/check-security.mjs` both assert this.
* Every `javascript:` occurrence in shipped JS is a guard (a regex
  that rejects such URLs in `core/svg.js` and `core/bulk-payload.js`),
  never a sink. No `javascript:` URL appears in any HTML attribute,
  and no JS URL sink (`.href`, `.src`, `window.open`, `location`)
  receives one (asserted by `check-security.mjs`).
* There is no `window.open` call in shipped code. The three
  `target="_blank"` links (licence, repository, full privacy
  statement in `options/options.html`) all carry
  `rel="noopener noreferrer"` and their `href` values are set by
  extension code to fixed extension or repository URLs, never from
  page data.
* All page-derived text (titles, alt text, URLs, file names, site
  names) is inserted with `textContent` or `setAttribute` on safe
  attributes. Translation strings are inserted as text
  (`shared/i18n.js` builds text nodes; `data-i18n` targets use
  `textContent`). History thumbnails are assigned to `img.src` only
  after `sanitizeHistoryThumb` accepts them (JPEG or WebP data URL,
  12 KB cap).
* SVG handling: network SVGs are sanitised with the allowlist
  sanitizer (`core/svg.js`) before saving; DOCTYPE and internal
  entities are stripped before parsing; SVG is never injected into
  the DOM as markup (it is rendered through an `<img>` element or
  `createImageBitmap`, or serialised from a sanitised document). See
  `docs/security-model.md` for the allowlist detail.

### H5. Files, names and downloads: PASS, 1 finding fixed

* Finding fixed:
  * F-H5-1 (Medium): `sanitizeSegment` did not strip directional
    formatting characters. A name such as `photo` + U+202E +
    `gnp.exe` displays as `photo-exe.png` in a right-to-left
    override, spoofing the visible extension. Fixed:
    `stripBidiControls` (`core/filenames.js:43`) strips U+202A to
    U+202E, U+2066 to U+2069, U+200E, U+200F and U+FEFF, and is
    applied in `sanitizeSegment`, in `safeZipName`
    (`core/zip.js:48`), and in history record text fields on write
    and on read.
* Verified unchanged and correct: path separators, `..`, control
  characters and trailing dots/spaces are stripped; Windows reserved
  names (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9, with or
  without extension) are prefixed with an underscore; segments cap
  at 96 characters and file names at 180; `joinDownloadPath`
  sanitises every folder segment, allows at most 3 folder levels,
  and cannot escape the Downloads folder (no absolute paths, no
  drive letters, no `..`).
* ZIP entries: `safeZipName` takes the basename only, strips
  traversal and illegal characters, and `createZipParts` dedupes
  names (`name-2`, `name-3`, ...), caps at 500 entries, and builds
  from parts without a giant intermediate copy. The ZIP fetch path
  caps at 200 files, 50 MB per file, 300 MB total, concurrency 4.
* Only image types are ever saved: `safeExtension` maps the output
  extension onto an allowlist (`jpg`, `jpeg`, `png`, `webp`, `gif`,
  `avif`, `bmp`, `svg`) and falls back to `png`; executable and
  script extensions (`exe`, `js`, `html`, `svgz`, and others) can
  never be produced. ZIP entry extensions come from sniffed magic
  bytes first, then Content-Type, then the URL last.
### H6. Storage, import and export: PASS, 3 findings fixed

* Findings fixed:
  * F-H6-1 (Medium): history records were sanitised on write only.
    `GET_HISTORY` returned stored records verbatim, so a record
    written by an older version or tampered with in storage reached
    the popup and options page unsanitised. Fixed:
    `sanitizeHistoryRecord` (`core/history.js:412`) re-validates
    every field on read (text fields stripped of control and bidi
    characters and length capped, numbers clamped, kind allowlisted,
    thumb, URL and download id through the existing sanitisers), and
    the worker applies it in `GET_HISTORY`
    (`background/service-worker.js:3547`, capped at 200 records).
    The UI already rendered all record text with `textContent` and
    only assigned sanitised thumbnails, so no injection was possible
    through this path; the fix closes the hole instead of relying on
    the renderer.
  * F-H6-2 (Medium): a backup import had no size cap and no
    allowlist. `file.text()` read an unbounded file and
    `parseSettingsImport` parsed unbounded JSON. Fixed:
    `SETTINGS_IMPORT_MAX_CHARS` is 1,000,000
    (`core/filenames.js:164`); the options page refuses a larger
    file before reading it (`options/options.js:595`) and the parser
    refuses larger text. `stripUnknownSettings`
    (`core/settings.js:98`) drops every key outside
    `DEFAULT_SETTINGS` at import time
    (`options/options.js:604`). Deliberate scope: normal settings
    loads still preserve unknown keys for forward compatibility (a
    newer version's keys survive a downgrade, asserted by
    `tests/test-contract-settings.mjs`); only the import path
    rejects them, which is what H6 requires. Unknown keys are inert
    in storage: they are never read, never executed, and now bounded
    by the import cap.
  * F-H6-3 (Low): a `__proto__` key inside imported `sitePrefs`
    could reach the prefs object. Fixed: the key is skipped
    explicitly in `normalizeSettings`
    (`core/settings.js:156`). `constructor` and `prototype` as site
    preference keys stay allowed: assigned as own string properties
    with a validated mode they are inert (prototype untouched),
    which the existing security tests assert. Top-level `__proto__`
    in settings is already inert under object spread, and the
    import allowlist drops it.
* Verified unchanged and correct: `normalizeSettings` type and range
  checks every setting (enums allowlisted, qualities clamped 0.1 to
  1, `maxConcurrent` 1 to 6, retention 1 to 365 days, `subfolder`
  and `customTemplate` length capped, language allowlisted, site
  preferences host and mode validated). Imported content is never
  evaluated. An import can only write settings, never history
  records, thumbnails or URLs. `CLEAR_HISTORY` sets the history key
  to an empty list, which removes records, thumbnails, links and
  download ids together; `RESET_SETTINGS` restores defaults.
  Storage budget: at most 200 history records, thumbnails capped at
  12 KB each and 3 MB total (oldest dropped first), captures capped
  at 60 records, 500 MB and 1 hour in IndexedDB.
* No sensitive data in logs: grep finds zero `console.log` in shipped
  code. The only logging calls are `console.debug`, and the scanner
  ones that print a source URL are debug-gated and local only. No
  telemetry, no analytics, no remote endpoints: the fetch inventory
  in H3 is the complete list of network call sites, and none of them
  contacts an ImgFetch server (there is none).

### H7. Resource exhaustion and robustness: PASS, 2 findings fixed

* Findings fixed:
  * F-H7-1 (Medium): `makeHistoryThumb` had no pixel-count cap
    before decoding. Fixed: header dimensions are checked with
    `assertImagePixelBudget` before `createImageBitmap`
    (`core/history.js:621`); the probe fallback for formats without
    a header parser checks after decode. `imageDimensions` now also
    parses BMP and ICO headers. See residual risk R3 for the formats
    still decoded before the cap.
  * F-H7-2 (Medium): conversion paths decoded with no pixel cap at
    all (`convertImage` had none; `convertSvg` checked only for
    zero). Fixed by the `loadBitmap` rewrite (header cap before
    decode, decoded cap after) and a post-decode cap in
    `convertSvg`. The stricter per-format caps stay: GIF 4,000 px
    and 16 MP, BMP 16,000 px and 90 MP, clipboard 8,000 px and
    32 MP, history thumbnails 120 px.
* Verified unchanged and correct: scanner caps (URLs 8,192
  characters, data URLs 2 MB in discovery, 20,000 elements per
  pass, chunked background scan); queue concurrency from settings
  (1 to 6) with retry once; ZIP caps (200 files, 50 MB each, 300 MB
  total, concurrency 4, 30 s per file); stitch size rule shared by
  planner and stitcher (`isStitchSizeAccepted`, allocation probe
  before capture, parts instead of one giant canvas past the limit);
  serial promise queues for history writes (D4) and thumbnail
  fetches (one at a time); ZIP accumulator abort and 2-minute TTL;
  capture storage pruning (60 records, 500 MB, 1 hour). Long URLs
  and names are capped at every layer (8,192, 180, 96, 2,048 for
  history URLs). The 1 MB runtime-message cap and the 40,000,000
  character `SAVE_ANNOTATED` cap are abuse protection; both fail
  with a clear error, never a hang (see residual risk R4).
* Service worker lifecycle: all listeners are registered at top
  level; state that must survive a restart lives in
  `chrome.storage` or IndexedDB, not in memory; there are no
  `chrome.alarms` and no `setInterval` in the worker; the offscreen
  document closes after 30 seconds idle. Rapid clicks are safe:
  history Clear is a two-step arm-and-confirm, the queue is
  serialised, and every action handler is idempotent or guarded by
  the single-writer queue.

### H8. Content script and page isolation: PASS

* Content scripts run in the ISOLATED world. Page JavaScript cannot
  reach extension internals, and the background accepts only
  `SCAN_PROGRESS` from that world (H2). The scanner reads image
  elements, `srcset` and background images only; it does not read
  form values or page text.
* No extension data is leaked into pages: no `web_accessible_resources`
  (H1), no extension URL or id is written into page DOM, and the
  only page-visible surface is the selection overlay. The overlay
  uses unique namespaced classes (`sx-*`) and a static style block,
  which is the isolation the addendum accepts as an alternative to
  shadow DOM. A page can see or remove the overlay nodes, but it
  cannot spoof a capture: the captured rectangle comes from trusted
  mouse events in the isolated world, and the screenshot is a real
  `captureVisibleTab` of the page pixels. Moving the overlay to a
  closed shadow root is listed as Recommendation REC-1.
* Overlay cleanup: every overlay path removes its nodes, restores
  page attributes and removes its listeners (`content/overlay.js`
  cleanup functions). Capture freezes page motion and restores it.
* Screenshots happen only after a user action: toolbar click, menu
  item, keyboard shortcut, or a button in the popup or options page.
  No page script can trigger a capture, and no capture runs on page
  load.

### H9. Dependencies and supply chain: PASS

* No third-party runtime code ships in the extension. The only
  bundled assets are the Inter fonts (SIL Open Font License 1.1,
  `shared/assets/INTER-OFL-1.1.txt`), the Lucide icon sprite (ISC,
  `shared/assets/LUCIDE-ISC.txt`) and the project's own SVG hero
  art. All fonts and icons are local files; there is no CDN
  reference in any shipped HTML or CSS (asserted by
  `check-security.mjs`), no minified blob and no sourcemap. The
  bundled SVGs contain no script, event handler or `javascript:`
  URL (asserted). The full asset list is in
  `docs/project-structure.md` under `shared/assets/`.
* Static analysis: `python3 scripts/validate.py`,
  `node scripts/check-i18n.mjs`, `node scripts/check-duplicates.mjs`
  and `node scripts/check-docs-links.mjs` all pass, plus the new
  `node scripts/check-security.mjs` (18 checks: manifest, forbidden
  APIs, `javascript:` sinks, remote references, `console.log`,
  bundled assets, permission justification, fetch inventory). The
  new script is listed in `docs/project-structure.md`.

### H10. Privacy re-check: PASS, 3 statements fixed

Re-read `PRIVACY.md`, `docs/permissions.md`, the in-app Privacy page
(`options/options.html`, strings `pr_*`) and the store listing draft
(`store-assets/store-listing.md`). Three statements were not exactly
true after Phase 5 and were fixed:

* F-H10-1 (Medium): `PRIVACY.md` said "ImgFetch adds no cookies or
  credentials to these requests" for image downloads and conversions,
  but the Copy Image fallback fetched with `credentials: 'include'`
  for any origin. The code is fixed (same-origin only, F-H3-4) and
  the policy now states the exact rule: conversion, thumbnail, ZIP,
  sniff and EXIF fetches send no cookies or credentials; the in-page
  Copy Image fetch sends the page's own cookies only when the image
  is on the same origin as the page.
* F-H10-2 (Low): the store listing described history without
  mentioning the thumbnail re-request. Added one sentence to the
  "Queue and history" paragraph: history rows can show a small
  local thumbnail, made by requesting each downloaded image once
  more after the download, and thumbnails can be turned off in
  Settings. The in-app Privacy page already disclosed this
  (`pr_stores1`); `PRIVACY.md` already disclosed it in full.
* F-H10-3 (Low): `docs/decisions/0008-copy-async-clipboard-downscale-fallback.md`
  still documented a downscale fallback for editor Copy. Phase 5
  item C removed it: a failed copy is never retried at a smaller
  size, and a too-large image copies the part currently shown at
  full resolution with a toast that says so. A superseding note was
  added to the decision file; the history of the decision is kept.
* Checked and still true: no accounts, no server, no analytics, no
  telemetry, no crash reporting; history thumbnails (120 px,
  12 KB each, 3 MB total, off by a setting, existing previews hidden
  but kept); optional `downloads.open` (requested only from the
  click, fallback to showing the file); clipboard image copy (image
  bytes, never link text, only on click); Google Lens only on click;
  capture records expire after 1 hour, at most 60 kept. The
  "Applies to" line in `PRIVACY.md`, `docs/permissions.md` and the
  store listing was updated to 1.1.1 with last verified 2026-11-23.
* One wording call, kept as is: the About line "Only the images you
  choose to download are fetched" (`about_privacyText`) is a summary
  that points at `PRIVACY.md` for the full statement. Read
  literally it omits scan previews (part of a scan the user
  started) and the thumbnail re-request (an image already chosen).
  Changing it would churn a user-visible string across 21 locales
  for a summary line whose full statement is one click away and
  already exact. Recorded here as residual risk R6.

### H11. Output: done

* This file, `docs/security-review.md`, listed in
  `docs/project-structure.md`.
* `tests/test-security.mjs` extended in place (no duplicate file):
  section 12 adds 77 checks covering message validation, URL scheme
  rules, redirect re-validation, size caps while streaming, SVG
  handling, file name sanitisation with hostile inputs, ZIP name
  sanitisation, import schema and prototype pollution, and history
  sanitisers on tampered storage. Final count: 531 passed, 0 failed
  (was 451; the F1 placement check was also updated to the
  choke-point architecture, same intent, stronger guarantee).
* `scripts/check-security.mjs` added (see H9), listed in
  `docs/project-structure.md`.

## Security table

| ID | Finding | Severity | Status | Evidence |
|---|---|---|---|---|
| F-H2-1 | Options HISTORY_THUMB listener had no sender check | Low | Fixed | `options/options.js:514`; section 12 placement check |
| F-H2-2 | SCAN_PROGRESS had no shape validation | Medium | Fixed | `core/validation.js:146`, `popup/popup.js:271`; section 12g |
| F-H2-3 | Record id interpolated into querySelector unescaped | Low | Fixed | `popup/popup.js:318`, `options/options.js:516`; section 12i |
| F-H2-4 | Worker sender check written twice | Low | Fixed | Duplicate block removed; section 12i asserts one rejection |
| F-H3-1 | fetchImageBytes buffered before the cap, trusted Content-Type, no private/redirect guard | High | Fixed | `core/history.js:192`, `sniffImageMime` at :156; section 12b |
| F-H3-2 | Offscreen fetches had no timeout, cap or sniffing; Range probe buffered whole files | High | Fixed | `fetchBytesCapped`, `offscreen/offscreen.js:79`; F1 checks, section 11 |
| F-H3-3 | Conversion decoded with no pixel cap (decompression bomb) | Medium | Fixed | `offscreen/offscreen.js:160-176`, `core/history.js:61`; section 12c |
| F-H3-4 | Copy Image fetch sent cookies to any origin | Medium | Fixed | `background/service-worker.js:2804`, `core/urls.js:383`; section 12h |
| F-H3-5 | sniffType buffered a whole file on a 200 Range answer | Low | Fixed | `offscreen/offscreen.js:329`; capped at 64 bytes |
| F-H5-1 | Bidi override characters not stripped from file names | Medium | Fixed | `core/filenames.js:43`, `core/zip.js:48`; section 12d |
| F-H6-1 | History records sanitised on write only, not on read | Medium | Fixed | `core/history.js:412`, `background/service-worker.js:3547`; section 12e |
| F-H6-2 | Settings import had no size cap and no unknown-field allowlist | Medium | Fixed | `core/filenames.js:164`, `core/settings.js:98`, `options/options.js:595-604`; section 12f |
| F-H6-3 | __proto__ key inside imported sitePrefs could reach the prefs object | Low | Fixed | `core/settings.js:156`; section 7 tests |
| F-H7-1 | History thumbnails decoded with no pixel cap | Medium | Fixed | `core/history.js:621`; section 12c |
| F-H7-2 | convertImage/convertSvg decoded with no pixel cap | Medium | Fixed | `offscreen/offscreen.js:176`, `:682`; section 12c |
| F-H10-1 | PRIVACY.md credential claim contradicted the Copy fetch | Medium | Fixed | Code F-H3-4 plus `PRIVACY.md` wording |
| F-H10-2 | Store listing omitted the thumbnail re-request | Low | Fixed | `store-assets/store-listing.md` history paragraph |
| F-H10-3 | Decision 0008 documented a removed downscale fallback | Low | Fixed | Superseding note in `docs/decisions/0008-copy-async-clipboard-downscale-fallback.md` |
| H1 | Manifest, permissions, CSP, no externally_connectable, no web_accessible_resources | - | No finding | `scripts/check-security.mjs` (8 manifest checks) |
| H4 | DOM/injection: no innerHTML, eval, javascript: sinks, window.open | - | No finding | `validate.py` section 4, `check-security.mjs`, grep evidence in `out/compare/H/` |
| H8 | Content script isolation, overlay cleanup, capture only on user action | - | No finding | Code reading; REC-1 is hardening, not a gap |
| H9 | No third-party runtime code, local fonts/icons with licences, no CDN | - | No finding | `check-security.mjs` asset checks |

## Accepted residual risk

* R1. Same-private-host exception. A page on the user's intranet can
  ask ImgFetch to fetch other URLs on that same host. Accepted: the
  user is already on that host and the page could fetch those URLs
  itself with its own cookies; the exception is host-scoped, never
  scheme-wide, and every redirect is still re-validated.
* R2. Sanitised SVGs keep external https image references (`image`
  and `feImage` hrefs). When a saved SVG is opened as a document,
  the browser may fetch the referenced image. Accepted: in an
  `<img>` context the browser blocks external loads; only a direct
  open loads them; stripping the references would break legitimate
  illustrations. Already recorded in `docs/security-model.md` under
  known accepted risks.
* R3. AVIF, TIFF and SVG thumbnails decode before the pixel cap.
  `imageDimensions` parses PNG, GIF, JPEG, WebP, BMP and ICO headers
  before decoding; AVIF, TIFF and SVG have no header parser, so the
  cap applies after `createImageBitmap` in the probe path. Accepted:
  the 25 MB source cap bounds the input, a failed allocation fails
  closed, and the post-decode cap still throws before any canvas
  work. Extending the parser is Recommendation REC-2.
* R4. Message size caps. The 1 MB runtime-message cap means the
  popup cannot send a data URL larger than 1 MB to the worker, and
  `SAVE_ANNOTATED` rejects data URLs over 40,000,000 characters
  (the message itself allows 45,000,000). Accepted: the caps are
  abuse protection with clear errors, and large data URLs travel by
  the offscreen blob-URL path (D2) and IndexedDB, never through
  messages. Documented in `docs/limitations.md`.
* R5. Same-origin Copy Image cookies. A same-origin image behind a
  login still sends the page's cookies when copied, because the copy
  needs them to load. Accepted: that is exactly what the page itself
  does when it loads the image, and cross-origin hosts get nothing.
* R6. About summary wording (`about_privacyText`). See H10. Accepted
  as a summary with the exact disclosure one click away in
  `PRIVACY.md` and in the Privacy page itself.
* R7. Scanner discovery caps (URLs 8,192 characters, data URLs 2 MB).
  A very large inline image cannot be scanned; it must be opened and
  saved from the context menu. Pre-existing, documented in
  `docs/limitations.md`.
* R8. History Copy uses a stricter 8,000 px / 32 MP cap in
  `imageBytesToPng` than the shared 16,384 px / 268 MP canvas
  budget. A very large image fails Copy with a quiet message instead
  of copying. Accepted: a clipboard write is not the place for a
  268 MP raster; the download itself is unaffected.

## Recommendations (not fixed in this phase)

* REC-1. Move the area/element selection overlay into a closed
  shadow root. Steps: in `content/overlay.js`, create a host element,
  call `attachShadow({ mode: 'closed' })`, and move the style block,
  the selection box and the hint inside it, keeping the same class
  names; then re-run the overlay and capture end-to-end suites.
  Namespaced classes are compliant today (the addendum accepts them),
  so this is hardening, not a gap.
* REC-2. Extend `imageDimensions` (`core/history.js`) with an AVIF
  box parser (and TIFF IFD parsing) so the pixel cap applies before
  decoding for every thumbnail format. Steps: parse the `ftyp` and
  `avif`/`meta` boxes for `ispe` dimensions, add cases to the
  existing header tests, and re-run `tests/test-history-thumbs.mjs`.
* REC-3. Wire `scripts/check-security.mjs` into
  `scripts/release-check.sh` so the static checks run in the release
  gate. Steps: add `node scripts/check-security.mjs` after the
  `validate.py` step; its exit code is already nonzero on failure.
  Not done here because `release-check.sh` belongs to the E1/E2
  release tooling and this step owns one new script only.
