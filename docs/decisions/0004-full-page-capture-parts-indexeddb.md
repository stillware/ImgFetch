# 0004: Full Page Capture in Balanced Parts Stored as Blobs in IndexedDB

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

A full page screenshot is built from viewport tiles. One giant canvas for
a very tall page is impossible: canvas side and area limits cut it off,
and a single capture record carried as a data URL is too heavy, because a
base64 string inflates the data and must be copied between contexts.
Long and growing pages also need protection against a runaway capture
that never ends.

## Decision

Split a full page capture into balanced parts in `core/fullpage-capture.js`.
Each part is capped at a maximum side of 32767 device pixels, a maximum
area of 100000000 device pixels (100 MP), and a capture is capped at 48
parts in total.

Store each finished part as a Blob in IndexedDB (`background/idb.js`),
through a capture group record, rather than as a data URL.
Keep capture records short lived: they expire after 1 hour and at most 60
records are kept, with open groups never pruned.

## Consequences

Very tall pages capture at full resolution without hitting the canvas
ceiling, and no giant base64 string travels through runtime messages.

Balanced parts keep each part's memory cost predictable.
The trade off is a multi file result for tall pages, which the Parts
overview page exists to handle. See decision 0005.
Storage use is bounded by the part caps and the record expiry above.
Performance figures are in [the performance notes](../performance.md).
