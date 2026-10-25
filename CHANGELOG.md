# Changelog

All notable changes to ImgFetch are recorded in this file.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-22

### Added

- Copy button in the screenshot editor, which copies the flattened edited screenshot as PNG to the clipboard, retries with a downscaled copy if the full size is rejected, and suggests Save if copying still fails.
- Redo button in the screenshot editor, next to Undo, with Ctrl+Y and Ctrl+Shift+Z shortcuts for strokes, shapes, text, pixelate and moved text.
- Undo keyboard shortcut in the screenshot editor: Ctrl+Z on Windows and Linux, Cmd+Z on macOS. It does exactly what the Undo button does, including the crop step in the same history, and it does not fire while typing in the text annotation box, where the browser native text undo keeps working.
- Full interface localization in 21 locales covering 19 languages, with a Language setting in Options that defaults to Auto and a right-to-left layout for Arabic.
- Multi-part full-page capture, which captures very long pages whole at full device resolution and splits them into numbered parts instead of truncating or downscaling them.
- Inner-scroll capture, which scroll-captures the largest visible scrollable container when the document itself does not scroll, as on settings pages and in web apps.
- Parts overview page, which lists every part of a split capture with thumbnails and Edit, Save, Save all, Copy and Discard actions, and the editor title reads "Part i of N".
- Growing page support, which follows pages that load more content while scrolling until they settle, and keeps finished parts if the capture is cancelled or the tab is switched.
- Capture progress in the popup, shown as one live status row with a progress bar and a Stop button during a full-page capture.
- Crop tool in the screenshot editor, opened with the C shortcut, with 8 resize handles, arrow key nudging, Apply with Enter and Cancel with Esc.
- Windows clipboard note in the editor for large images, explaining that clipboard history (Win+V) does not show images above roughly 4 MB and that pasting with Ctrl+V still works.
- Security test suite in `tests/test-security.mjs`, covering hostile inputs for the SVG sanitizer, filename building, the private network URL guard, settings validation and message validation.

### Changed

- Full-page parts are larger and balanced, up to 32767 pixels per side and about 100 megapixels per part.
- Capture is faster, with tighter tile pacing and quota backoff, parts stored as Blobs directly in IndexedDB, and the editor annotation canvas allocated only when needed.
- The Options page opens faster because the language picker uses the native language names shipped in the extension instead of fetching all 21 locale files on every open.
- Documentation files under `docs/` use lowercase kebab-case names, and the end-to-end test guide is now `tests/test-e2e/README.md`, with all references updated.
- Cropping is lossless and non-destructive in the editor: the original image and annotations are never modified, the crop shares the Undo and Redo history, and Save and Copy export exactly the cropped region.

### Fixed

- Multi-part full-page capture no longer opens a result tab partway through, which previously stopped the remaining parts; exactly one Parts overview page opens at the end.
- The first tile of a full-page capture could show the page as it was before scrolling to the top; the capture now waits for the scrolled view to be painted before the first shot.
- Area and Element capture no longer runs the crop through the PNG quality path, which reduced colors and cost over a second; cropping now happens in the service worker with no quality parameter and is lossless.
- Full-page stitching is seam free and duplicate free at fractional display scaling (125% and 150%) as well as at 100%, 200% and 300%.
- Screenshots work on every tab the browser allows: Visible captures the real active tab, other capture types fall back to a visible area capture with a clear notice where script injection is forbidden, and a clear error is shown where the browser refuses capture entirely.
- Every external link in the extension pages opens in a new tab, and PRIVACY.md is a clickable link in the Settings Privacy section.
- Very long pages are no longer truncated or downscaled during full-page capture.
- The static validator and the duplicate checker read the documentation tree and UTF-8 files correctly, including on Windows, and the store packager ships the `_locales` folder.
- Capture pruning no longer reads every stored image, result pages read captures directly from IndexedDB, and the missing `.gitignore` file is back in the tree.

### Security

- The SVG sanitizer strips DOCTYPE declarations, including internal entity subsets, before parsing, so hostile entity expansion cannot hang the parser.
- The SVG URL check also inspects base64 decoded data URL payloads for scripts.
- Image fetches in the offscreen document re-check the final URL after redirects against the private network rule.
- The popup verifies the sender of its messages, and data URLs are decoded with a chunked decoder instead of `fetch`.

### Removed

- Dead code, including an unused crop handler, unused imports, an orphaned queue timer variable and an unused test helper.
- Hard-coded machine paths in development scripts, replaced by the `IMGFETCH_TESTDEPS` environment variable.

Note: translations in this version were produced with AI assistance and have not been reviewed by native speakers. Please open an issue if you find a mistake.

## [1.0.0] - 2026-10-12

ImgFetch 1.0.0 is the first public release: smart image downloading, whole page scanning, screenshots with a built-in editor, and a self-managing download queue.
No accounts, no analytics, no telemetry; everything stays on your device.

### Added

#### Downloading

- Right-click menu with Smart Download, Save as, Open Original, Copy Image Link, Copy Image, Image Info, Scan This Page, a Screenshot submenu, Add Site Preference, Disable on This Site and Settings.
- Smart Download finds every genuinely available source (original, srcset, picture element and lazy-loaded variants), validates each one in the page, and downloads the best valid source directly, with no conversion and no upscaling.
- If the top source fails, Smart Download tries the next source, up to 5 in total, with honest stage feedback from finding the best quality to the final result.
- Save as finds the highest quality valid source first, then decodes once and encodes straight into the requested format: PNG, JPEG, WebP, AVIF, GIF, SVG or BMP.
- Honest encoders and labels: the binary content, MIME type and extension of every saved file always match, with a pure JavaScript GIF89a encoder and a 24-bit BMP encoder shipped in the extension.
- Animated WebP and APNG files convert to genuine multi-frame GIFs via WebCodecs, and AVIF support is probed with a real encode so a capable browser is never silently downgraded.
- Copy Image Link copies the actual URL of the image as plain text, resolved in the page so srcset and picture choices match what you see.
- Copy Image copies the actual pixels to the clipboard with a three step fallback chain, so the clipboard never ends up empty, even for hotlink protected images.
- Image Info shows full details including EXIF data (camera, date taken, full size and GPS) for JPEGs that carry it.
- Download queue with concurrency from 1 to 6, real completion tracking, automatic retry once, cancel that also cancels the browser download, retry failed, clear finished and Show in folder.
- The queue survives service worker restarts: pending items re-queue and in-flight browser downloads are adopted, never duplicated.
- Download selected as ZIP packs scan results into one ZIP file with a pure JavaScript writer, capped at 200 files, 50 MB per file and 300 MB in total.
- Smart file names with the original name, site and date templates or custom templates, an optional rename sheet with preview, and an optional ask for file name per download.
- Smart folders that save to one place, by website, by type (Photos, Screenshots, GIFs, Graphics) or by date, with per-site overrides.
- Download history with the last 200 downloads, retention controls, search and clear.

#### Smart quality

- Two quality modes everywhere: Smart, which uses the best verified source, and As shown, which uses exactly what the page displays.
- The Original quality preference skips probing entirely and takes the exact page source.
- Scan-time candidate evidence comes only from currentSrc, src, srcset width hints, picture sources and lazy-load attributes, ranked by measured area; URLs are never invented, guessed or rewritten.

#### Page scanner

- Relevance scoring across rendered and natural dimensions, visibility, document context, CSS classes, URL patterns, repetition and alt text, so interface assets such as logos, icons, tracking pixels, favicons and sprites are filtered out and counted honestly in the footer.
- Broad source coverage: iframes, og:image, image inputs, inline SVG, canvas snapshots, object and embed elements, pseudo-element backgrounds, page blob URLs, video posters, open shadow DOM and lazy-load attributes.
- Scan This Page with depth control (Loaded page or Scroll page), duplicate removal that keeps the largest variant, size, orientation and format filters, text search, sorting, bulk selection and a preview modal.
- The Ctrl+Shift+S shortcut starts a real scan with live progress in the popup; double presses share one in-flight scan, and restricted pages and paused sites get a clear explanation.

#### Screenshots and annotation

- Four capture types (Visible area, Select area, Full page and Capture element) from the popup, the right-click menu, Settings buttons or keyboard shortcuts (Ctrl+Shift+X for Area, Ctrl+Shift+E for Element and Alt+Shift+E to pick an element).
- Full-page capture scrolls and stitches with one shared size rule, per-tile progress, fixed header hiding, abort on tab switch and scroll position restore.
- Built-in annotation editor, on by default, with Pen, Arrow, Rectangle, Circle, Text and Pixelate tools, undo, colors and line widths; each screenshot reuses a single result tab.
- Screenshot JPEG quality defaults to 100%, and screenshots can be copied to the clipboard.

#### Popup and interface

- A single predictable popup router with Home and History views, and Home panes for idle, scanning, results and queue states, with Back navigation.
- A dashboard with live status cards and lists that update in place, with gentle pane transitions.
- Four step onboarding: welcome, core concepts, keyboard shortcuts and a Make it yours step with five curated settings saved live.
- Themes for system, light and dark with a smooth cross-fade, toggle switches, checkboxes and segmented controls, with reduced motion preferences honored throughout.
- Keyboard access throughout, with visible focus states and Esc to cancel pickers.

#### Settings

- Settings in 13 sections (General, Downloads, Quality, File Names, Scanning, Screenshots, Site Preferences, Shortcuts, Folders, Download History, Backup and Reset, About and Privacy) with live save.
- Per-site preferences (Smart, As shown or Paused) honored by the menu, the popup and the shortcuts.
- A Shortcuts page that shows your actual live key bindings with a link to the browser shortcut settings.
- Backup and Reset: export settings to `imgfetch-settings.json`, import with validation, and reset to defaults with confirmation.
- An About section with the logo, the live version and a human readable permission list generated from the manifest.

#### Reliability and performance

- The queue, in-flight captures and scan state survive service worker restarts, and the offscreen document is reaped after 30 seconds idle and never closed mid-job.
- Source probing runs 6 wide with short timeouts and a 3 minute ranked cache; bulk probing is opt-in.
- Thumbnails render at most 6 at a time, and the results grid virtualizes past 360 items.
- Hardened paths: oversized data URLs are skipped gracefully, screenshot files are never mislabeled, ZIP entries are named by real content sniffing, and failures report counts instead of failing silently.

#### Security and privacy

- Local only operation: settings, history and captures never leave your device, with no accounts, no analytics, no telemetry and no remote code.
- Least privilege message routing: senders must be this extension, every message type has an explicit sender allowlist, and the offscreen document verifies its sender.
- Extension fetches block private network URLs (localhost, LAN ranges and IPv6 equivalents) unless the page itself is on that host.
- Network SVGs are sanitized through an allowlist before saving, with scripts, event handlers and javascript: URLs stripped.

#### Brand and testing

- The abstract mark logo, a gradient tile with a minimal landscape mark, regenerated at exact icon sizes (16, 32, 48 and 128, with a 512 master), crisp in both themes.
- More than 6000 unit, contract, fuzz and race checks green at release time, a real browser end-to-end suite, and static checks for the manifest, permissions, remote code, inline scripts and documentation claims.

#### Independent review fixes folded into 1.0.0

- Chrome and Edge zips are built from one tree, and packaging fails if a comparison of the extracted zips finds any difference.
- The validator runs against extracted zips, with project-only files exempt from the zip check.
- The welcome page shows live shortcuts from the browser, handling rebound and unbound keys and Mac symbols.
- Context menu building is serialized with a promise chain, covered by a race test for overlapping builds.
- The activeTab permission was kept because `chrome.tabs.captureVisibleTab` requires it in a real browser.
- The release check script runs every test and writes the test report from real output, with no hand-typed counts.
- All 5 icon sizes are regenerated from the single SVG master, and every silent catch carries a one-line reason.

[1.1.0]: https://github.com/stillware/ImgFetch/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/stillware/ImgFetch/releases/tag/v1.0.0
