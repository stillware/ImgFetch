# 0006: Lossless Crop in the Worker for Area and Element Captures

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

Area and Element captures take a viewport screenshot and crop it to the
selected rectangle.
An early path sent the whole screenshot to the offscreen document with a
hard coded quality of 0.92. The offscreen encoder treated that value as a
PNG quality setting and ran a lossy median cut color reduction.

The crop therefore destroyed colors nobody asked to lose, and it was the
slowest step in the pipeline. A static unit suite now guards against a
lossy step returning (`tests/test-no-lossy-pipeline.mjs`).

## Decision

Crop in the service worker pipeline instead, in `core/crop-image.js`,
using `createImageBitmap` and `OffscreenCanvas`.
That crop takes no quality parameter, so it is lossless by construction.

It also skips the offscreen cold start and both base64 message round
trips that the old path needed.
Measured crop medians with this path are in
[the performance notes](../performance.md), and
`tests/test-perf-budget.mjs` budgets the crop step so a slower path fails.

## Consequences

Area and Element screenshots keep every color of the source region, and
the crop step is faster as well as correct.
Verification is pixel level: the capture e2e suite compares cropped output
against the source region and requires zero differing pixels.
The worker gains one responsibility, image decoding for screenshots,
which it can do without a DOM. That keeps decision 0001 intact.
