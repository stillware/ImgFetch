# ImgFetch Tests

What the automated suites cover, how to run them, the counts verified in this session, and what still needs a manual pass.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Summary

| Suite group | Count | Result in this session |
|---|---|---|
| Unit suites in `tests/test-*.mjs` | 33 suites | 7467 checks passed, 0 failed, with jsdom available |
| Unit suites without jsdom | 33 suites | 7431 checks passed, 0 failed |
| Static validation | `scripts/validate.py` | All checks passed |
| Real browser suites in `tests/test-e2e/` | 14 suites | See [the e2e guide](../../tests/test-e2e/README.md) |

The difference between the two unit totals is jsdom:
`tests/test-svg-real-dom.mjs` has 18 checks and self skips without jsdom,
and two suites run expanded sets with jsdom available
(`tests/test-security.mjs` 450 checks instead of 439, and
`tests/test-progress.mjs` 34 instead of 27).
Every other suite runs with Node alone.
Counts in this file are from runs in this session. A generated report
from the test runs is kept in `test-report.md` in this folder. Do not edit
that generated file by hand.

PowerShell variants are translations of the bash commands and were not run in the build sandbox (no PowerShell there).

## Prerequisites

- Node.js, to run every unit suite and checker.
- Python 3, to run `scripts/validate.py`.
- Optional: jsdom. It enables `tests/test-svg-real-dom.mjs` and expands
  `tests/test-security.mjs` and `tests/test-progress.mjs`. Point the
  `IMGFETCH_TESTDEPS` environment variable at a folder whose
  `node_modules` holds jsdom, and pass that folder through `NODE_PATH`
  when running the suite. Without jsdom the suite prints a skip notice
  and exits successfully.
- The real browser suites have their own prerequisites (Playwright
  Chromium, a display under xvfb, headed mode). See
  [the e2e guide](../../tests/test-e2e/README.md).

## Run the unit suites

Run one suite by naming its file:

```bash
node tests/test-core.mjs
```

Run all 33 suites:

```bash
for t in tests/test-*.mjs; do node "$t" || exit 1; done
```

Run the jsdom suite with jsdom available (bash):

```bash
NODE_PATH="$IMGFETCH_TESTDEPS/node_modules" node tests/test-svg-real-dom.mjs
```

PowerShell variants:

```powershell
node tests/test-core.mjs
Get-ChildItem tests/test-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "failed: $($_.Name)" } }
$env:NODE_PATH = "$env:IMGFETCH_TESTDEPS/node_modules"; node tests/test-svg-real-dom.mjs
```

Each suite prints a line with its passed and failed counts and exits with a
nonzero code on failure.

## Unit suites and counts

Counts are checks passed in this session, with jsdom available.

| Suite file | Checks |
|---|---|
| `tests/test-candidates.mjs` | 21 |
| `tests/test-capture-decision.mjs` | 28 |
| `tests/test-capture-storage.mjs` | 23 |
| `tests/test-clipboard-image.mjs` | 32 |
| `tests/test-content-scripts.mjs` | 18 |
| `tests/test-contract-filename.mjs` | 2730 |
| `tests/test-contract-fullpage.mjs` | 405 |
| `tests/test-contract-settings.mjs` | 8 |
| `tests/test-copy-shot.mjs` | 48 |
| `tests/test-core.mjs` | 110 |
| `tests/test-crop-rect.mjs` | 87 |
| `tests/test-data-url.mjs` | 13 |
| `tests/test-fullpage-parts.mjs` | 93 |
| `tests/test-fuzz-url-guard.mjs` | 3000 |
| `tests/test-html-modules.mjs` | 24 |
| `tests/test-i18n-core.mjs` | 125 |
| `tests/test-i18n-dom.mjs` | 16 |
| `tests/test-links.mjs` | 22 |
| `tests/test-no-lossy-pipeline.mjs` | 3 |
| `tests/test-overlay.mjs` | 9 |
| `tests/test-parts-overview.mjs` | 49 |
| `tests/test-perf-budget.mjs` | 12 |
| `tests/test-png-quantize.mjs` | 5 |
| `tests/test-progress.mjs` | 34 |
| `tests/test-queue-persist.mjs` | 5 |
| `tests/test-races.mjs` | 6 |
| `tests/test-scanner.mjs` | 18 |
| `tests/test-security.mjs` | 450 |
| `tests/test-svg.mjs` | 12 |
| `tests/test-svg-real-dom.mjs` | 18, jsdom only |
| `tests/test-undo-redo.mjs` | 13 |
| `tests/test-urls-ipv6.mjs` | 21 |
| `tests/test-zip-accum.mjs` | 9 |
| Total | 7449 |

Together the suites cover URL handling and the private network guard,
filename and settings contracts, the download queue, message validation,
the SVG sanitizer, full page part planning and stitching contracts, i18n,
capture storage and decisions, Crop geometry, the Parts overview helpers,
capture progress, and the performance budgets.

`tests/test-perf-budget.mjs` reads the committed perf results files. See
[the performance notes](../performance.md).

## Static checks

```bash
python3 scripts/validate.py
node scripts/check-i18n.mjs
node scripts/check-duplicates.mjs
```

PowerShell variants:

```powershell
python scripts/validate.py
node scripts/check-i18n.mjs
node scripts/check-duplicates.mjs
```

`scripts/validate.py` checks the manifest and its file references, runs a
syntax check on the JavaScript files, checks security rules such as no
remote code and no `innerHTML`, and lints documentation claims.
See [the build guide](../build.md) for the full validation and packaging
flow.

## Real browser suites

The 14 suites in `tests/test-e2e/` run the real extension in Playwright
Chromium. They cover captures, stitching, the Parts overview, the editor
Crop tool (66 checks in `crop-e2e.mjs`), the editor Undo and Redo keyboard
shortcuts (21 checks in `undo-shortcut-e2e.mjs`), clipboard behavior that
Chromium can automate, redirects, capture progress, and localization.

Run them one suite at a time, headed, under a display. The full list,
prerequisites, and run rules are in
[the e2e guide](../../tests/test-e2e/README.md).

## What cannot be automated

The following need a real machine and a human pass. They are in
[the manual test checklist](manual-test-checklist.md) in this folder:

- The real Windows clipboard, including whether a large copy appears in
  Windows clipboard history.
- Real Microsoft Edge. The automated suites run in Playwright Chromium.
  Edge uses the same zip, but install and behavior must be checked in Edge
  itself.
- Real touch hardware. The Crop suite simulates touch with CDP events, but
  a physical touchscreen check stays manual.
- Screenshot pixel comparison on unusual GPU and driver combinations.

## Manual test checklist

Before a store submission, work through
[the manual test checklist](manual-test-checklist.md) on real Chrome and
real Edge builds. It covers install, the popup, settings, context menus,
scanning and downloads, every capture mode, the Parts overview, the editor
and Crop, keyboard shortcuts, and Edge.
