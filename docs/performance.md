# ImgFetch Performance

Measured capture timings, the budgets that guard them, and the design choices that keep capture and scanning responsive.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## How the numbers were measured

The numbers below come from `tests/test-e2e/perf-e2e.mjs` and are stored in
`tests/test-e2e/results-perf-chromium-dpr1.json` and
`tests/test-e2e/results-perf-chromium-dpr2.json`.
They were measured with Playwright Chromium under xvfb in the build sandbox,
in headed mode, at device pixel ratio (DPR) 1 and DPR 2.

Area, Element, and large page configurations used 10 runs each.
Visible used 5 runs and the Full page tail used 3 runs.
Values are medians unless a column says otherwise.

Timings on a user machine will differ. These numbers exist to catch
regressions, not to promise a speed on other hardware.

The pipeline steps are: shot (the screenshot), crop (the lossless crop for
Area and Element), store (writing the capture record), open (opening the
result page), and draw (drawing the image in the editor).
Visible and Full page have no crop step, so their crop median is 0 ms.

## Measured medians at DPR 1

| Configuration | Runs | Total median (ms) | Worst (ms) | Shot | Crop | Store | Open | Draw |
|---|---|---|---|---|---|---|---|---|
| Area, realistic | 10 | 867 | 935 | 377 | 238 | 68 | 96 | 79 |
| Element, realistic | 10 | 717 | 837 | 376 | 189 | 13 | 90 | 51 |
| Area, large | 10 | 1623 | 1665 | 685 | 430 | 187 | 145 | 137 |
| Element, large | 10 | 1109 | 1175 | 689 | 275 | 14 | 83 | 33 |
| Visible, realistic | 5 | 764 | 878 | 369 | 0 | 54 | 100 | 249 |
| Full page tail, realistic | 3 | 3092 | 3165 | 2202 | 0 | 238 | 130 | 499 |

Step columns are step medians in milliseconds. Step medians do not have to
add up to the total median, because each median comes from its own column.

## Measured medians at DPR 2

| Configuration | Runs | Total median (ms) | Worst (ms) | Shot | Crop | Store | Open | Draw |
|---|---|---|---|---|---|---|---|---|
| Area, realistic | 10 | 2234 | 2384 | 1218 | 563 | 182 | 114 | 186 |
| Element, realistic | 10 | 1856 | 1896 | 1223 | 392 | 28 | 161 | 40 |
| Area, large | 10 | 4448 | 4783 | 2281 | 1058 | 429 | 170 | 467 |
| Element, large | 10 | 3085 | 3614 | 2312 | 559 | 25 | 123 | 45 |
| Visible, realistic | 5 | 1804 | 1905 | 1194 | 0 | 155 | 115 | 350 |
| Full page tail, realistic | 3 | 9795 | 9867 | 7345 | 0 | 890 | 112 | 1390 |

Step columns are step medians in milliseconds.

## The perf budget suite

`tests/test-perf-budget.mjs` reads the two results files above and checks
every configuration at both DPR values. It has 12 checks in total.
It fails if a median or a worst time exceeds its budget, if the results do
not come from the worker crop path, or if a configuration has too few runs.
See [the tests guide](tests/README.md) for how to run it.

| Configuration | Median budget (ms) | Worst budget (ms) | Crop budget (ms) |
|---|---|---|---|
| Area, realistic | 5000 | 6000 | 1500 |
| Element, realistic | 4000 | 5000 | 1000 |
| Area, large | 11000 | 12000 | 3000 |
| Element, large | 7000 | 8000 | 1500 |
| Visible, realistic | 4000 | 5000 | none |
| Full page tail, realistic | 20000 | 25000 | none |

The crop budget is the key guard. An earlier lossy crop path cost far more
than the lossless worker crop costs now.
If that lossy path returned, the crop step would exceed its budget and the
suite would fail. The Visible and Full page budgets guard paths that were
not reworked, so a regression there also fails the suite.

## Design notes

### Tile gap

Full page capture takes one visible tab shot per tile.
The browser rate limits that call to about 2 shots per second.
The worker waits 520 ms between tile shots (`TILE_GAP_MS`), which keeps a
small margin under the limit and avoids quota errors mid capture.
Stitch work for a finished tile overlaps the wait for the next tile.

### Lazy editor canvas

The annotation editor does not allocate its full resolution annotation
canvas when an image opens. It allocates the canvas lazily, on first
drawing use. Opening a very large screenshot to view it or to use Crop
therefore costs less memory than annotating it.

### Blob parts

A full page that is too tall for one canvas is split into balanced parts.
The limits are a maximum side of 32767 device pixels, a maximum area of
100000000 device pixels (100 MP) per part, and at most 48 parts.
Each finished part is stored as a Blob in IndexedDB, not as a data URL.
A Blob avoids the size and memory cost of a giant base64 string moving
between contexts. See [decision 0004](decisions/0004-full-page-capture-parts-indexeddb.md).

### Other choices

Scanning processes page elements in chunks and yields between chunks, so a
large page does not freeze while it is scanned.
Format conversion and tile stitching run in the offscreen document, which
keeps the popup and the service worker responsive.

The Area and Element crop runs in the service worker instead, in
`core/crop-image.js`. It is lossless and avoids an offscreen round trip.
See [decision 0006](decisions/0006-lossless-crop-in-worker.md).
Download concurrency defaults to 3, so bulk downloads apply back pressure
instead of opening every download at once.

## What is not measured here

Real world scan timing per page type is not in the results files above and
is not claimed here. The manual release pass in
[the manual test checklist](tests/manual-test-checklist.md) covers behavior
on real pages and real hardware.
