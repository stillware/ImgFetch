# ImgFetch Project Structure

An annotated map of every file in the repository, grouped by responsibility, plus the naming conventions.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Reading this document

The tree below lists one file or folder per line, in repository order.
Counts in comments on unit test lines are the passing check counts verified for version 1.1.0.
Generated end to end result files under `tests/test-e2e/` follow the `results-*.json` pattern and are named in prose only, after the tree.
The `.github/` folder is listed as a single directory line, and its template files are named in prose after the tree.

## File tree

```
ImgFetch/
├── manifest.json # Manifest V3 definition: permissions, commands, service worker, options page
├── LICENSE # GNU General Public License v3 or later
├── README.md # Project overview, install steps, shortcuts, documentation index
├── CHANGELOG.md # Release history in Keep a Changelog format
├── CONTRIBUTING.md # Development setup, checks, and contribution process
├── CODE_OF_CONDUCT.md # Contributor Covenant 2.1, enforcement through GitHub
├── SECURITY.md # Supported versions and private vulnerability reporting
├── PRIVACY.md # Privacy policy: what data is handled and where it stays
├── TERMS.md # Terms of use
├── TRADEMARK.md # Name and logo policy: the GPL covers the code, not the ImgFetch name
├── README-package.md # Short README placed inside the store and release ZIP as README.md
├── .gitignore # Ignores dist output, zip files, and node_modules
├── .github/ # Issue templates and the pull request template, named in prose below
├── _locales/ # 21 locale folders, 19 languages, one messages.json per folder
├── assets/
│   ├── brand/
│   │   ├── imgfetch-mark-exact.svg # Logo master, vector source
│   │   └── imgfetch-mark-master.png # Logo master render at 1600 px
│   └── readme/
│       ├── editor-crop.png # README image at 1600 by 1000 px: editor with the Crop tool active
│       ├── editor-tools-copy-save.png # README image: editor annotations with Copy and Save
│       ├── fullpage-parts-overview.png # README image: Parts overview of a multi part capture
│       ├── hero-scan-and-save.png # README image: popup scan results, the README hero image
│       ├── languages-and-settings.png # README image: Settings with the language picker
│       ├── privacy-no-tracking.png # README image: privacy facts panel
│       ├── quality-and-formats.png # README image: quality and format options
│       ├── rtl-arabic.png # README image: Arabic right to left layout
│       ├── scan-select-download.png # README image: scan results with a selection and the download bar
│       ├── screenshot-modes.png # README image: the four screenshot modes
│       └── social-preview-1280x640.png # GitHub social preview image at 1280 by 640 px
├── background/
│   ├── service-worker.js # Context menus, message router, download queue, screenshots, history
│   └── idb.js # IndexedDB wrapper for the captures store
├── content/
│   ├── scanner.js # Page scanner: image collection, source probing, ranking
│   └── overlay.js # Area selector and Element picker overlay
├── core/
│   ├── bulk-payload.js # Queue payloads for single and bulk downloads
│   ├── capture-decision.js # Capture mode and scroll target decision logic
│   ├── capture-storage.js # Capture record byte accounting and group pruning rules
│   ├── clipboard-image.js # Copy size planner: full image or downscaled copy
│   ├── crop-image.js # Lossless in worker crop for Area and Element captures
│   ├── crop-rect.js # Editor Crop geometry: clamp, resize, nudge, coordinate conversion
│   ├── data-url.js # Chunked data URL decoder
│   ├── dedupe.js # Scan result deduplication
│   ├── exif.js # EXIF parsing for orientation and GPS
│   ├── export.js # Format conversion planning and quality resolution
│   ├── filenames.js # Safe filename building and download path joining
│   ├── filters.js # Search, filter, and sort for scan results
│   ├── folders.js # Download folder resolution for the organize modes
│   ├── fullpage-capture.js # Full page part planner: balanced parts and tile layout
│   ├── gif.js # Pure JavaScript GIF encoder
│   ├── history.js # Download history records, pruning, and grouping
│   ├── image-url.js # Best image URL selection for Copy Image Link
│   ├── png-quantize.js # PNG color reduction for the explicit quality path
│   ├── queue-persist.js # Throttled and immediate queue persistence
│   ├── queue.js # Download queue: concurrency, retry, cancel
│   ├── scan-state.js # Scan lifecycle state
│   ├── settings.js # Settings schema, defaults, normalization
│   ├── svg.js # Allowlist based SVG sanitizer
│   ├── urls.js # URL normalization, host rules, private network guard
│   ├── validation.js # Message types, sender rules, payload validation, friendly errors
│   ├── zip-accum.js # Chunked ZIP accumulator with abort and time limit
│   └── zip.js # Part based ZIP builder
├── docs/
│   ├── README.md # Documentation index with start here paths per reader
│   ├── architecture.md # Components, message protocol, storage, diagrams
│   ├── build.md # Build and packaging steps
│   ├── glossary.md # Terms used in the code and the documentation
│   ├── limitations.md # Known limits, reasons, and workarounds
│   ├── performance.md # Performance design and measured numbers
│   ├── permissions.md # Every manifest permission and its justification
│   ├── project-structure.md # This document
│   ├── security-model.md # Threat model, boundaries, and mitigations
│   ├── translating.md # How to add or fix a translation
│   ├── user-guide.md # Task based user instructions
│   ├── decisions/
│   │   └── README.md # Index of the architecture decision records, files named in prose below
│   ├── history/
│   │   ├── README.md # Index of the historical round records
│   │   ├── 01-initial-build-plan.md # Historical record: initial build plan
│   │   ├── 02-audit-round-1-fixes.md # Historical record: audit round 1 fixes
│   │   ├── 03-audit-round-2-fixes.md # Historical record: audit round 2 fixes
│   │   ├── 04-audit-round-3-fixes.md # Historical record: audit round 3 fixes
│   │   └── 05-audit-round-4-fixes.md # Historical record: audit round 4 fixes
│   └── tests/
│       ├── README.md # Testing notes and suite overview
│       ├── manual-test-checklist.md # Manual test checklist for release checks
│       └── test-report.md # Generated test report
├── icons/
│   ├── icon-16.png # Extension icon at 16 px
│   ├── icon-32.png # Extension icon at 32 px
│   ├── icon-48.png # Extension icon at 48 px
│   ├── icon-128.png # Extension icon at 128 px
│   └── icon-512.png # Extension icon at 512 px
├── offscreen/
│   ├── offscreen.html # Offscreen document host page
│   └── offscreen.js # Conversion, sanitizing, ZIP, stitching, clipboard work
├── options/
│   ├── options.html # Options page markup
│   └── options.js # Options page logic with autosave
├── pages/
│   ├── welcome.html # Welcome page markup
│   ├── welcome.js # Welcome page logic: onboarding flow
│   ├── capture.html # Capture preview page markup
│   ├── capture.js # Capture preview page logic
│   ├── parts.html # Parts overview page markup
│   ├── parts.js # Parts overview logic: per part Edit, Save, Copy, Discard
│   ├── annotate.html # Annotation editor markup
│   ├── annotate.js # Editor logic: tools, Crop, undo, composite export
│   ├── rename.html # Ask for filename sheet markup
│   ├── rename.js # Ask for filename sheet logic
│   ├── info.html # Image info page markup
│   └── info.js # Image info page logic and actions
├── popup/
│   ├── popup.html # Popup markup
│   └── popup.js # Popup logic: scan results, filters, queue, history, capture progress
├── scripts/
│   ├── check-docs-links.mjs # Offline checker for relative links between markdown files
│   ├── check-duplicates.mjs # Single source of truth checker for shared limits and rules
│   ├── check-i18n.mjs # Localization checker: keys, plurals, placeholders
│   ├── make-icons.py # Regenerates the extension icon set
│   ├── package.sh # Builds the store zip files after validation and tests
│   ├── regression-diff.mjs # Behavior diff between a release tree and the current tree
│   ├── release-check.sh # Release gate: tests, validator, packaging
│   └── validate.py # Static checks: JSON, syntax, security rules, tree and count consistency
├── shared/
│   ├── capture-io.js # Reads capture records from IndexedDB for result pages
│   ├── copy-shot.js # Copy action for screenshots with downscale fallback
│   ├── i18n.js # Custom localization loader and locale list
│   ├── platform.js # Platform detection and the large copy clipboard rule
│   ├── ui.css # Design system with light and dark themes
│   ├── ui.js # Theme, toast, and messaging helpers
│   └── undo-redo.js # Undo and redo stack carrying strokes and crop
├── store-assets/
│   ├── promo-marquee-1400x560.png # Store marquee at 1400 by 560 px
│   ├── promo-tile-440x280.png # Store promo tile at 440 by 280 px
│   ├── store/
│   │   ├── editor-crop.png # Store screenshot at 1280 by 800 px: editor with the Crop tool active
│   │   ├── fullpage-parts-overview.png # Store screenshot: Parts overview of a multi part capture
│   │   ├── hero-scan-and-save.png # Store screenshot: popup scan results
│   │   ├── quality-and-formats.png # Store screenshot: quality and format options
│   │   ├── scan-select-download.png # Store screenshot: scan results with a selection and the download bar
│   │   └── screenshot-modes.png # Store screenshot: the four screenshot modes
│   └── store-listing.md # Ready to paste store listing text and submission checklist
└── tests/
    ├── test-candidates.mjs # 21: candidate discovery and bulk payload checks
    ├── test-capture-decision.mjs # 28: capture decision logic checks
    ├── test-capture-storage.mjs # 23: capture storage and Blob record checks
    ├── test-clipboard-image.mjs # 32: copy size planner checks
    ├── test-content-scripts.mjs # 18: content script and worker localization rule checks
    ├── test-contract-filename.mjs # 2730: filename to download path contract checks
    ├── test-contract-fullpage.mjs # 405: part planner and stitcher contract checks
    ├── test-contract-settings.mjs # 8: settings schema contract checks
    ├── test-copy-shot.mjs # 48: Copy button behavior checks
    ├── test-core.mjs # 110: core logic checks for queue, settings, URLs, validation
    ├── test-crop-rect.mjs # 87: Crop geometry and crop undo history checks
    ├── test-data-url.mjs # 13: chunked data URL decoder checks
    ├── test-fullpage-parts.mjs # 93: part split, limit, and no truncation checks
    ├── test-fuzz-url-guard.mjs # 3000: seeded URL guard fuzz cases
    ├── test-html-modules.mjs # 24: page script module loading checks
    ├── test-i18n-core.mjs # 125: localization core checks for fallback and plurals
    ├── test-i18n-dom.mjs # 16: localization DOM checks, including right to left layout
    ├── test-links.mjs # 22: external link target and rel attribute checks
    ├── test-no-lossy-pipeline.mjs # 3: static scan that the capture pipeline stays lossless
    ├── test-overlay.mjs # 9: element picker checks
    ├── test-parts-overview.mjs # 49: Parts overview and platform helper checks
    ├── test-perf-budget.mjs # 12: performance budget checks over recorded results
    ├── test-png-quantize.mjs # 5: PNG quantization checks
    ├── test-progress.mjs # 34: capture progress contract and toast dedup checks
    ├── test-queue-persist.mjs # 5: queue persistence checks
    ├── test-races.mjs # 6: race checks for cancel, token isolation, bursts
    ├── test-scanner.mjs # 18: relevance scoring checks
    ├── test-security.mjs # 450: security checks, hostile input tables, forbidden API scan, fuzz
    ├── test-svg.mjs # 12: SVG sanitizer checks with a stub DOM
    ├── test-svg-real-dom.mjs # 18: SVG sanitizer checks with a real DOM through jsdom
    ├── test-undo-redo.mjs # 13: undo and redo stack checks
    ├── test-urls-ipv6.mjs # 21: IPv6 private network guard checks
    ├── test-zip-accum.mjs # 9: chunked ZIP abort and time limit checks
    └── test-e2e/
        ├── README.md # How to run the real browser suites
        ├── capture-e2e.mjs # Real browser capture checks for all four capture modes
        ├── clipboard-e2e.mjs # Real browser Copy button checks
        ├── crop-e2e.mjs # Real browser editor Crop checks
        ├── e2e.mjs # Real browser main flow checks
        ├── first-tile-e2e.mjs # Real browser stale first tile regression checks
        ├── fixture-server.mjs # Local fixture pages and assets for the browser suites, helper only
        ├── growing-e2e.mjs # Real browser growing page capture checks
        ├── i18n-e2e.mjs # Real browser localization checks
        ├── parts-e2e.mjs # Real browser Parts overview checks
        ├── perf-e2e.mjs # Real browser performance timing runs
        ├── progress-e2e.mjs # Real browser capture progress row checks
        ├── redirect-e2e.mjs # Real browser offscreen redirect recheck checks
        ├── stop-e2e.mjs # Real browser cancel and tab switch stop checks
        ├── tileloop-e2e.mjs # Real browser multi part capture loop regression checks
        └── undo-shortcut-e2e.mjs # Real browser editor Undo and Redo shortcut checks
```

## Files named in prose

The `.github/` folder holds four files: `ISSUE_TEMPLATE/bug_report.yml`, `ISSUE_TEMPLATE/feature_request.yml`, `ISSUE_TEMPLATE/config.yml`, and `PULL_REQUEST_TEMPLATE.md`.
Together they provide the bug report form, the feature request form, the issue template chooser configuration, and the pull request checklist.

The `docs/decisions/` folder holds nine architecture decision records plus its index.
The records are `0001-manifest-v3-offscreen-document.md`, `0002-no-remote-code-no-accounts.md`, `0003-custom-i18n-21-locales.md`, `0004-full-page-capture-parts-indexeddb.md`, `0005-parts-overview-page.md`, `0006-lossless-crop-in-worker.md`, `0007-non-destructive-crop-editor.md`, `0008-copy-async-clipboard-downscale-fallback.md`, and `0009-file-naming-standard.md`.

The `tests/test-e2e/` folder also holds generated result files that follow the `results-*.json` pattern, one per suite, browser, and device pixel ratio.
They are recorded performance and outcome evidence, regenerated by the suites, and are not listed as tree lines.

The README images under `assets/readme/` are 1600 by 1000 pixel masters, and the store screenshots under `store-assets/store/` are the same compositions at 1280 by 800 pixels, so six file names appear in both folders by design: `hero-scan-and-save.png`, `scan-select-download.png`, `quality-and-formats.png`, `screenshot-modes.png`, `fullpage-parts-overview.png`, and `editor-crop.png`.
The five raw screenshots that shipped before 1.1.0 (`screenshot-1-welcome.png` to `screenshot-5-quality.png` in `store-assets/`) were removed when the designed set replaced them.

Each of the 21 folders under `_locales/` holds one `messages.json` file with the localized strings for that locale.
The folder names are locale codes such as `en`, `es_419`, `pt_BR`, `zh_CN`, and `ar`.

## Grouping by responsibility

Runtime code ships in `background/`, `content/`, `offscreen/`, `popup/`, `options/`, and `pages/`.
Pure logic with no browser API dependency lives in `core/`, which is what the unit suites exercise directly.
Code shared by two or more runtime surfaces lives in `shared/`, so no surface keeps a private copy.
Support material stays out of the runtime folders: `tests/` for checks, `scripts/` for tooling, `docs/` for documentation, `assets/` for brand masters and README images, `icons/` for the shipped icon set, and `store-assets/` for store listing material.

## Naming conventions

Root documents use uppercase names: `README.md`, `README-package.md`, `TRADEMARK.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, `TERMS.md`, `CODE_OF_CONDUCT.md`, and the extensionless `LICENSE`.
Documents under `docs/` use lowercase kebab-case, for example `project-structure.md`, `security-model.md`, and `user-guide.md`.
Decision records add a zero padded number prefix, for example `0001-manifest-v3-with-offscreen-document.md`, so they sort in reading order.
Code files use lowercase kebab-case, and test files add the `test-` prefix, with browser suites adding the `-e2e` suffix.
Every file basename in the repository is unique, with two deliberate exceptions: `README.md` in several folders and `messages.json` in each locale folder.

The standard exists for three practical reasons.
First, the store zip layout in `scripts/package.sh` lists files and folders by name, and unique basenames keep that list and any later audit unambiguous.
Second, `scripts/validate.py` checks this document against the real tree by basename, so a duplicate or missing name fails the release gate instead of drifting silently.
Third, case only renames are a hazard on Windows, where the file system treats two names that differ only in case as the same file: a rename done in two steps on a case sensitive system can collapse or lose the file on checkout.
Fixing one casing and case scheme per location removes that class of rename entirely.
