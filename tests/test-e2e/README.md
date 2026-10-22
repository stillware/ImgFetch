# ImgFetch Real Browser Tests

How to run the 14 Playwright Chromium suites that exercise the real extension, what each suite proves, and the run rules that keep results trustworthy.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Suites

| Suite file | What it proves |
|---|---|
| `capture-e2e.mjs` | Captures work on every tab the browser allows, stitching is seam free at DPR 1 to 3, inner scroll containers and fixed elements are handled, page state is restored, long pages split into full resolution parts, and the Area crop is byte exact. |
| `clipboard-e2e.mjs` | The editor Copy button writes a real image to the Chromium clipboard from fixture images. |
| `crop-e2e.mjs` | The editor Crop tool: dragging, handles, keyboard control, Apply and Cancel, pixel exact Save and Copy exports on realistic fixtures, strokes on cropped views, undo and redo, and Arabic RTL layout. It has 66 checks. |
| `e2e.mjs` | The core flows end to end: the extension loads, scanning finds images, bulk download writes correct files, full page stitching matches the plan at DPR 1 and DPR 2, the queue recovers from service worker restarts, and ZIP download produces a valid file. |
| `first-tile-e2e.mjs` | The first tile of a full page capture is never a stale pre scroll frame, across repeated short captures that start scrolled down. |
| `growing-e2e.mjs` | A page that grows while scrolling is followed until it settles, and all grown content is covered by the capture. |
| `i18n-e2e.mjs` | Interface localization in English and Arabic: `lang` and `dir` attributes, translated strings, and the language dropdown. It has 11 checks at DPR 1. |
| `parts-e2e.mjs` | The Parts overview page: card rendering, lazy thumbnails, Edit, Copy, Save, Save all, Discard, and Discard all, with downloads verified on disk and Arabic RTL rendering. |
| `perf-e2e.mjs` | Area, Element, Visible, and Full page capture timings with a per step breakdown. Its results files feed `tests/test-perf-budget.mjs`. See [the performance notes](../../docs/performance.md). |
| `progress-e2e.mjs` | The popup capture progress row: one live status row, a progress bar, locked shot buttons during capture, Stop keeping finished parts, and the same behavior in Arabic. |
| `redirect-e2e.mjs` | The offscreen redirect recheck: a redirect to a different private host is refused by conversion, SVG sanitizing, type sniffing, and ZIP building, while direct and same host requests work. |
| `stop-e2e.mjs` | Cancelling a capture, and switching away from the source tab, stops capture cleanly and keeps the parts already finished. |
| `tileloop-e2e.mjs` | The multi part capture loop: every planned part is captured through the real worker path, no result tab opens during capture, one Parts overview opens at the end, and page state is restored. |
| `undo-shortcut-e2e.mjs` | The editor Undo and Redo keyboard shortcuts: Ctrl+Z and Cmd+Z undo strokes and an applied crop, Ctrl+Y, Ctrl+Shift+Z and Cmd+Shift+Z redo, the Undo button tooltip names the shortcut, and Ctrl+Z inside the text annotation box keeps the browser native text undo. It has 21 checks. |

`fixture-server.mjs` is a helper, not a suite. It is a plain Node HTTP
server that serves generated images, gallery and tall pages, and hostile
endpoints (wrong content type, 403, 404, 429, slow, and oversized
responses) on `127.0.0.1`. No suite needs internet access.

## Prerequisites

- Node.js and Playwright with its Chromium build installed.
- The `PLAYWRIGHT_PACKAGE` environment variable pointing at the installed
  Playwright package. ESM ignores `NODE_PATH`, so the suites resolve
  Playwright through this variable and exit with a clear error without it.
- A display. Every suite runs headed, because extension loading and tab
  capture need headed mode. On a machine without a display, run under
  xvfb.
- Optional: the `IMGFETCH_SHOTS` environment variable, a folder outside the
  repository, for suites that save screenshots for inspection.

Install Playwright:

```bash
npm i playwright
npx playwright install chromium
```

## The temporary copy method

Playwright cannot synthesize the user gesture that grants `activeTab`, so
`chrome.tabs.captureVisibleTab` is not permitted for the fixture pages on
the shipped manifest alone.

Several capture suites (tileloop, growing, stop, first tile, and progress)
therefore copy the extension tree to a temporary folder outside the
repository, add `<all_urls>` to `host_permissions` in the copy's manifest
only, and load the copy.

The repository manifest is never modified by these suites. One suite
hashes the source manifest before and after the run and asserts it is byte
identical.

Other suites drive the same production code through CDP
`Page.captureScreenshot`, which uses the same capture mechanism, and say
so in their file headers.

## Run rules

Run one suite at a time. This rule is strict:

1. Start one suite and let it finish.
2. Close its browser contexts and wait until Chromium has fully exited.
3. Only then start the next suite.

Running suites in parallel or back to back without the exit in step 2 can
leak profiles, ports, and timing state between runs and makes failures
meaningless.
If a first launch flakes, retry the suite once. Report any retry in your
run notes. Do not loop retries until a run passes and report only the pass.

## Run a suite

```bash
PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright xvfb-run -a node tests/test-e2e/e2e.mjs --dpr=1
PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright xvfb-run -a node tests/test-e2e/capture-e2e.mjs --dpr=1
PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright xvfb-run -a node tests/test-e2e/perf-e2e.mjs --dpr=1
PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright xvfb-run -a node tests/test-e2e/tileloop-e2e.mjs
```

Replace `<playwright-install>` with the folder that holds the Playwright
install on your machine. Most suites accept `--dpr=1` or `--dpr=2`.
`e2e.mjs` also accepts `--browser=edge` when Microsoft Edge is installed.
A suite exits with code 1 on any phase failure and on any `console.error`,
`pageerror`, or unhandled rejection in the service worker, popup, offscreen
document, or content scripts.

## Results files

Each suite writes its raw evidence as JSON in this folder, named
`results-*.json` per suite family. Examples in the tree today:

| Results file pattern | From |
|---|---|
| `results-chromium-dpr<N>.json` | `e2e.mjs` |
| `results-capture-chromium-dpr<N>.json` | `capture-e2e.mjs`, including DPR 1.25, 1.5, and 3 runs |
| `results-perf-chromium-dpr<N>.json` | `perf-e2e.mjs` |

Results files are evidence, not documentation. The numbers quoted in
[the performance notes](../../docs/performance.md) are read from the perf
results files, and `tests/test-perf-budget.mjs` asserts they stay within
budget.

## What these suites cannot prove

A real Windows clipboard, real Microsoft Edge, and real touch hardware
cannot be automated here. Those checks are manual. See
[the tests guide](../../docs/tests/README.md) and
[the manual test checklist](../../docs/tests/manual-test-checklist.md).
