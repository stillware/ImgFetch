# Security model

How ImgFetch defends against hostile pages, hostile image hosts, and hostile files, and which risks it accepts on purpose.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Overview

ImgFetch holds host permissions for http and https pages and fetches images with extension privileges, outside page CORS rules.
That reach is exactly what a malicious page or image host would like to borrow, so every page value and every network response is treated as untrusted.
The checks live in shared modules under `core/`, so the service worker, the offscreen document, and the info page apply the same rules.

## Assets

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| Downloaded files | A hostile name or type could place a dangerous file or escape the intended folder. | The browser Downloads folder, reached only through `chrome.downloads`. |
| Local network reachability | Extension fetches bypass page CORS, so a page could try to probe a router or an intranet service through ImgFetch. | Guarded by the URL guard in `core/urls.js`. |
| Settings and site preferences | A forged write could change download behavior or disable protection on a site. | Extension storage, writable only by extension pages. See the sender rules below. |
| Download history | It lists what the user saved and from where. At most 200 records are kept. | Extension storage. It never leaves the device. |
| Capture data | Screenshots can show anything on screen. Parts are stored as Blobs, with at most 60 records kept. | IndexedDB in the extension origin, expiring after 1 hour. |
| Clipboard contents | Clipboard writes happen on user action and should carry only what the user asked for. | Written through the offscreen document, with size caps below. |

ImgFetch has no accounts and stores no credentials, passwords, or payment data. There is nothing of that kind to steal.

## Trust boundaries

- Web pages and image hosts are untrusted. Page supplied strings (alt text, file names, URLs) are data, never markup or code.
- Content scripts run in the ISOLATED world. Page JavaScript cannot reach extension internals, and the background accepts only one message type from that world.
- The service worker is the only router for runtime messages. It validates every message and its sender before routing it.
- The offscreen document has no user interface and runs no page content. It receives only messages the worker sends it, marked with the target `offscreen`.
- The Downloads folder is the only file destination. Every path segment in it is sanitized before use.
- The user is trusted. Scans, downloads, captures, and clipboard writes start from explicit user gestures: a menu click, a popup action, or a shortcut.

## Attacker model

In scope:

- A malicious or compromised web page that tries to make ImgFetch fetch internal URLs, write dangerous files, run script, or leak local data.
- A malicious image host that serves hostile bytes, oversized payloads, redirect chains to private addresses, or a crafted SVG file.
- A crafted file that becomes dangerous later, when the user opens a saved SVG outside the browser.
- A page that forges runtime messages to reach settings, history, or capture functions it has no right to.

Out of scope attackers, such as a compromised browser or a second malicious extension, are listed under Out of scope below.

## Mitigations

### URL guard: scheme rules and private network blocking (`core/urls.js`)

`normalizeUrl` is the single entry point for addresses ImgFetch will fetch or download:

| Rule | Detail |
| --- | --- |
| Allowed schemes | `http:`, `https:`, `data:image/*`, and page `blob:` URLs, which are resolved inside the page before download. `javascript:`, `data:text/html`, `ftp:`, and `file:` are rejected. |
| Embedded credentials | URLs with a username or password are rejected. |
| Length caps | URLs are capped at 8,192 characters. Data URLs are capped at 30,000,000 characters on the download path and at 2,000,000 characters in the scanner. |
| Private network blocking | Loopback, RFC 1918 ranges, link-local, CGNAT (100.64.0.0/10), 0.0.0.0/8, `localhost`, the `.local`, `.internal`, `.lan`, and `.home.arpa` suffixes, and single label hostnames count as private. IPv6 loopback, unspecified, unique local, and link-local addresses count as private, including IPv4 addresses embedded in mapped, compatible, NAT64, and 6to4 forms. |

`isPrivateNetworkFetchBlocked` applies the private network rule with one exception: a fetch to the same private host as the page itself is allowed, so a user intranet keeps working.
The worker enforces it before privileged fetches (`checkPublicFetch`), the offscreen document enforces it again in `allowedSource`, and the info page applies the same rule.

### Redirect re-check after redirects

The pre-fetch check vets only the address a fetch starts at, and `fetch` follows redirects silently.
After a fetch completes, the offscreen document re-checks the final address (`response.url`) with the same private network rule through `isRedirectBlocked`.
A response whose redirect landed on a blocked address is refused before its body is used. This covers conversion, sniffing, sanitizing, and ZIP fetches.

### SVG sanitizer (`core/svg.js`)

A saved SVG opened as a document can run embedded script, so network SVG files are sanitized in the offscreen document (`SANITIZE_SVG`) before they are saved as single images.
The worker calls it through `maybeSanitizeSvg` in `background/service-worker.js`. Input text over 5,000,000 characters is refused.

- The sanitizer is an allowlist, not a denylist. Elements and attributes that are not listed are removed, including `script`, `foreignObject`, `iframe`, `embed`, and `object`.
- Event handler attributes are removed in any letter case. SMIL elements (`animate`, `set`, and relatives) that retarget `href` are removed.
- URL values are normalized first, because browsers ignore tab and newline characters inside a scheme. Only same-document fragments, http and https URLs, and `data:image` URLs survive in `href`, `xlink:href`, and `src`.
- A `data:image` payload that carries a script is rejected, including payloads hidden with base64. The decoder sniffs the decoded bytes as well as the raw text.
- Style content loses `@import`. In styles and in other attributes, `url()` keeps only fragment or `data:image` targets; any other `url()` value becomes `none`.
- DOCTYPE declarations are stripped before parsing, so internal entity subsets and entity expansion bombs never reach the parser.
  References to entities a removed declaration defined are dropped. The five predefined XML entities and numeric character references are kept.

What the sanitizer deliberately keeps is stated under Known accepted risks, item 1.

### Filename safety (`core/filenames.js`)

- Every name segment passes through `sanitizeSegment`: characters such as `<>:"/\|?*` and control characters are stripped, leading and trailing dots and spaces are trimmed, reserved Windows device names are prefixed, and length is capped.
- `safeExtension` maps the output extension onto an allowlist of image formats. Executable and script extensions can never be produced; the request falls back to `png`.
- `joinDownloadPath` builds the download path from sanitized segments only. Traversal segments and separators are removed, so a download cannot escape the Downloads folder.

### Message validation and sender rules (`core/validation.js`)

Every runtime message to the service worker passes through `isValidMessage` and the sender rules before routing. Validation fails closed.

| Check | Detail |
| --- | --- |
| Type allowlist | Only the 39 types in `MESSAGE_TYPES` are routable. Unknown types and malformed envelopes are rejected. Broadcast types such as `QUEUE_UPDATE` and `NOTICE` are not accepted as inbound messages. |
| Field types | Declared string fields must be strings. A numeric or null value in a checked field rejects the message. |
| Size caps | A message is rejected when its JSON form is longer than 1,000,000 characters. `SAVE_ANNOTATED` is the one exception, capped at 45,000,000 characters. |
| Annotated save cap | The worker also rejects a `SAVE_ANNOTATED` data URL longer than 40,000,000 characters with a too-large error. |
| Sender classification | `senderKind` returns `extension` only for a `chrome-extension://` sender address, `content` for a sender with a tab, and `unknown` for anything else. Unknown is never treated as extension. |
| Sender rules | `SENDER_RULES` allows only `SCAN_PROGRESS` from content scripts. Every other routable type requires an extension page sender. Anything not listed is denied. |
| Progress payload shape | `CAPTURE_PROGRESS` counts must be integers within bounds, totals at least 1, and no counter above its total. |
| Capture id format | `isValidCaptureId` accepts only `cap-` followed by 10 to 16 digits, a hyphen, and 1 to 6 digits. `isValidCaptureGroupId` applies the same shape with the `grp-` prefix. Ids in any other shape never reach the storage layer. |

### Offscreen document isolation

Conversion, sanitization, stitching, ZIP building, and clipboard work run in one offscreen document, created on demand by the worker with the reasons BLOBS and CLIPBOARD.
It is closed again after 30 seconds idle. It exposes 22 message types, each reached only through a worker message carrying the target `offscreen`.
Fetches inside it send no credentials and no referrer (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`), so cookies and tokens never leak to image hosts.
A fetched blob must have an `image/*` MIME type before it is decoded.

### No remote code and content security policy

The manifest sets `script-src 'self'; object-src 'self'` for extension pages. All code ships inside the package.
There is no `eval`, no `new Function`, and no remotely hosted script. Static validation in `scripts/validate.py` rejects `innerHTML` assignments in extension code.
Page supplied strings enter the DOM through `textContent` or through URL attributes that passed the URL guard first.

### No accounts and no telemetry

ImgFetch has no sign-in, no server of its own, no analytics, no telemetry, and no crash reporting. Nothing about the user is collected or sent anywhere.
The only network traffic is fetching images the user asked for, plus the one user clicked exception below.

### Google Lens guard

Search Image with Google Lens acts only after a user click and opens the Lens upload by URL address with the image address as its parameter. Nothing is injected into Google pages and nothing is read back.
Before opening, `lensUrlBlocked` in `core/urls.js` rejects `data:` and `blob:` addresses and any address the private network rule blocks, so local addresses never leave the machine.

### Clipboard guard

Text copies in the offscreen document are truncated to 8,192 characters before the write. If the write fails, the interface falls back to showing the link for manual copy.
Image copies from the editor are size planned in `core/clipboard-image.js`; very large images are downscaled before the write so a copy cannot allocate an unbounded canvas.

## Out of scope

- A compromised browser, operating system, or extension installation, and attacks that need physical access to the device.
- Other extensions the user installed. Extensions cannot police each other.
- What other software does with a file after ImgFetch saves it, beyond the saved SVG risk stated below.
- Availability attacks by very large pages or images, beyond the caps stated in this document and in [Limitations](limitations.md).
- The Google Lens service itself, which is run by Google.
- Vulnerabilities in the browser image codecs that decode the files ImgFetch fetches.

## Known accepted risks

1. **Saved SVG files can still reference external resources.** The sanitizer keeps http and https references in `href` and `src` attributes, because they are legitimate image references.
   Sanitization applies to the save paths the extension controls: network SVG files saved as single images.
   Extension generated SVG files arrive as `data:` URLs and skip sanitization, files packed into a ZIP download are stored exactly as shown on the page, and if sanitization itself fails the worker saves the original file rather than failing the download.
   When a user opens a saved SVG outside the browser, as a document, a kept external reference can load remote content and reveal the user address to that host.
   Opening the same file as an image runs no script. Users who do not trust a source should open its SVG files as images, or not at all.
2. **DNS rebinding cannot be fully excluded.** The URL guard checks the hostname written in the URL and any IP literal it can parse. It does not resolve hostnames itself and it does not pin the address the fetch uses.
   A public hostname whose DNS answer points to a private address, or whose answer changes between the check and the fetch, can pass the guard.
   The redirect re-check covers redirect targets, not DNS answers. The same host exception for intranets is deliberate, so a page on a private host can use images from that host.
3. **Page reported dimensions can lie.** A page can misreport `naturalWidth` and `naturalHeight` before validation. ImgFetch re-measures candidates during probing, so rankings and file decisions use real pixels, but a page can still waste some probing work.
4. **Screenshots record rendered pixels.** `captureVisibleTab` captures whatever is on screen, including protected content exactly as the browser rendered it. ImgFetch does not bypass any protection; it records pixels the way the operating system screenshot does.
5. **Conversion fallback saves the original.** When a requested format conversion fails, the download falls back to the original source with a notice, instead of failing. The saved file can therefore be in a different format than the one picked, and its name and extension say which.

## How it is tested

| Suite | Coverage | Checks |
| --- | --- | --- |
| [tests/test-security.mjs](../tests/test-security.mjs) | Hostile input tables for the SVG sanitizer (stub DOM and real DOM), filename building, the private network URL guard, settings validation, and message validation, plus a static scan for forbidden DOM APIs. | 450 checks, run this session |
| [tests/test-fuzz-url-guard.mjs](../tests/test-fuzz-url-guard.mjs) | Seeded fuzz over the URL guard and related pure functions, asserting the safety invariants hold and nothing throws unhandled. | 3,000 checks, run this session |

Static checks in `scripts/validate.py` also run over the whole tree, including the `innerHTML` ban and manifest reference checks.
The user facing summary of what each permission does is in [Permissions](permissions.md). Report a vulnerability as described in [Security](../SECURITY.md).
