## Project structure

```
imgfetch/
├── manifest.json                 # MV3 manifest (Chrome + Edge, 4 suggested shortcuts)
├── LICENSE                       # GNU General Public License v3
├── PRIVACY.md                    # Privacy policy
├── TERMS.md                      # Terms of use
├── SECURITY.md                   # Vulnerability reporting policy
├── CHANGELOG.md                  # Release history
├── CONTRIBUTING.md               # How to contribute
├── .gitignore                    # dist/, zips, node_modules/
├── README.md                     # This file
├── _locales/                   # 21 locale folders (19 languages); messages.json each
├── background/
│   ├── service-worker.js         # Menus, message router, download queue, screenshots
│   └── idb.js                    # IndexedDB store for captures/queue persistence
├── content/
│   ├── scanner.js                # Page scanner + relevance scoring + best-source validation
│   └── overlay.js                # Area-select overlay, element picker for screenshots
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js              # Format conversion, SVG sanitize, ZIP build, clipboard
├── popup/
│   ├── popup.html
│   └── popup.js                  # Scan results, filters, preview, queue, history
├── options/
│   ├── options.html
│   └── options.js                # 13-section settings page
├── pages/
│   ├── welcome.html / welcome.js # 3-step onboarding
│   ├── capture.html / capture.js # Screenshot preview
│   ├── annotate.html / annotate.js # Screenshot annotation editor
│   ├── rename.html / rename.js   # "Ask for filename" sheet
│   └── info.html / info.js       # Image info + actions
├── shared/
│   ├── ui.css                    # ImgFetch design system (light + dark)
│   ├── ui.js                     # Theme, toast, messaging helpers
│   ├── copy-shot.js              # Copy-button UI glue for the annotate editor
│   ├── undo-redo.js              # FIX 1 undo/redo stack (pure, no DOM)
│   └── i18n.js                   # Custom localization loader (manual language switch)
├── core/                         # Pure, testable logic (no chrome.* APIs)
│   ├── urls.js                   # URL normalize / parse / host rules / private-net guard
│   ├── filenames.js              # Safe filename building, traversal-proof paths
│   ├── filters.js                # Search / filter / sort (threshold size chips)
│   ├── settings.js               # Schema, defaults, validation, quality resolver
│   ├── queue.js                  # Concurrency, retry, cancel, restart persistence
│   ├── validation.js             # Message + sender validation, friendly errors
│   ├── history.js                # History records, pruning, grouping
│   ├── dedupe.js                 # Scan-result deduplication
│   ├── exif.js                   # EXIF parsing (orientation, GPS)
│   ├── export.js                 # Format conversion planning
│   ├── gif.js                    # Pure-JS GIF encoder (animated stills)
│   ├── png-quantize.js           # PNG quality: median-cut color reduction
│   ├── zip.js                    # Part-based ZIP builder (no concat buffer, DOS dates)
│   ├── fullpage-capture.js       # Part-based full-page planner (single stitch-limit rule)
│   ├── zip-accum.js              # Chunked-ZIP accumulator: abort + 2-min TTL
│   ├── queue-persist.js           # Throttled + immediate queue persistence
│   ├── image-url.js              # Best image-URL picking for Copy Image Link
│   ├── scan-state.js             # Scan lifecycle state (idle/scanning/results)
│   ├── svg.js                    # Allowlist SVG sanitizer
│   ├── bulk-payload.js           # DOWNLOAD_IMAGE/MANY queue payloads + candidate sanitizer
│   ├── folders.js                # Smart folder resolution (subfolder toggle + organize modes)
│   ├── capture-decision.js       # FIX 3 capture-mode decision logic (pure, no DOM/chrome)
│   └── clipboard-image.js        # Copy-size planner: full image vs downscale (no DOM)
├── assets/brand/                 # ImgFetch brand masters
│   ├── imgfetch-mark-exact.svg  # Logo master (vector)
│   └── imgfetch-mark-master.png # Logo master render 1600px
├── icons/                        # Extension icon set (16/32/48/128/512)
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   ├── icon-128.png
│   └── icon-512.png
├── store-assets/                 # Store listing graphics (not shipped in zips)
│   ├── promo-tile-440x280.png   # Store promo tile
│   ├── screenshot-1-welcome.png # Store screenshots (used in README)
│   ├── screenshot-2-scan.png
│   ├── screenshot-3-home.png
│   ├── screenshot-4-settings.png
│   └── screenshot-5-quality.png
├── tests/
│   ├── test-core.mjs             # 110 unit tests (queue, settings, urls, validation…)
│   ├── test-png-quantize.mjs     # 5 PNG quantization tests
│   ├── test-scanner.mjs          # 18 relevance-scoring tests (stub DOM)
│   ├── test-overlay.mjs          # 9 element-picker tests (stub DOM)
│   ├── test-svg.mjs              # 12 SVG sanitizer tests (stub DOM)
│   ├── test-svg-real-dom.mjs     # 18 SVG sanitizer tests (real DOM via jsdom)
│   ├── test-capture-decision.mjs # 28 FIX 3 decision-logic tests
│   ├── test-undo-redo.mjs        # 13 FIX 1 undo/redo stack tests
│   ├── test-links.mjs            # 22 FIX 2 external-link target/rel tests
│   ├── test-contract-fullpage.mjs # 405 part-planner/stitcher contract tests
│   ├── test-fullpage-parts.mjs     # 75 part-split/limit/no-truncation tests
│   ├── test-contract-filename.mjs # 2730 filename to download-path contract checks
│   ├── test-contract-settings.mjs # 8 settings schema contract tests
│   ├── test-fuzz-url-guard.mjs   # 3000 seeded fuzz cases
│   ├── test-urls-ipv6.mjs        # 21 IPv6 private-network guard tests
│   ├── test-zip-accum.mjs        # 9 chunked-ZIP abort/TTL tests
│   ├── test-queue-persist.mjs    # 5 immediate-persist tests
│   ├── test-races.mjs            # 6 race tests (cancel, token isolation, bursts)
│   ├── test-candidates.mjs       # 21 candidate-discovery + bulk-payload tests
│   ├── test-clipboard-image.mjs  # 32 copy-size planner tests
│   ├── test-copy-shot.mjs        # 28 Copy-button UI tests (stub DOM)
│   ├── test-i18n-core.mjs        # 62 localization core tests (fallback, plurals, matching)
│   ├── test-i18n-dom.mjs          # 16 localization DOM tests (stub DOM, incl. RTL)
│   ├── test-html-modules.mjs     # 24 page script module-loading tests
│   ├── test-content-scripts.mjs  # 18 content-script and worker-i18n rule tests
│   └── test-e2e/
│       ├── e2e.mjs               # Playwright phases P0-P8 (see test-e2e/RUN.md)
│       ├── capture-e2e.mjs         # Playwright FIX 3 + FIX 4 phases C1-C11 (see test-e2e/RUN.md)
│       ├── fixture-server.mjs    # Generated fixture pages/assets (no internet)
│       ├── clipboard-e2e.mjs     # Playwright: Copy-button real-browser tests
│       ├── i18n-e2e.mjs          # Playwright: localization real-browser tests
│       └── RUN.md                # How to run the real-browser suite
├── scripts/
│   ├── make-icons.py             # Regenerate icons
│   ├── validate.py               # Static checks (JSON, syntax, security, README/tree, docs)
│   ├── check-duplicates.mjs     # Single-source-of-truth: shared limits/rules
│   ├── check-i18n.mjs            # Localization checker: keys, plurals, placeholders, dashes
│   ├── regression-diff.mjs       # Pre-release vs current behavior diff
│   ├── release-check.sh          # Release gate: runs all tests, validator, packaging
│   └── package.sh                # Build store zips (runs validator + all tests)
└── docs/
    ├── ARCHITECTURE.md           # How the code is organized
    ├── BUILD.md                  # Packaging for the Chrome Web Store / Edge Add-ons
    ├── LIMITATIONS.md            # Known limitations, deferred and rejected features
    ├── PERFORMANCE.md            # Performance notes
    ├── PERMISSIONS.md            # Why each permission is needed
    ├── USER_GUIDE.md             # How to use ImgFetch
    ├── PROJECT_STRUCTURE.md      # This file (annotated repo tree)
    ├── SECURITY_MODEL.md         # Threat model and mitigations
    ├── TRANSLATING.md            # How to add or fix a translation
    ├── history/
    │   ├── README.md
    │   ├── 01-initial-build-plan.md
    │   ├── 02-audit-round-1-fixes.md
    │   ├── 03-audit-round-2-fixes.md
    │   ├── 04-audit-round-3-fixes.md
    │   └── 05-audit-round-4-fixes.md
    └── tests/
        ├── README.md             # Testing notes
        ├── manual-test-checklist.md
        └── test-report.md        # Generated test report
```
