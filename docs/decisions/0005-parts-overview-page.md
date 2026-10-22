# 0005: Parts Overview Page Instead of a ZIP Download

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

A multi part full page capture (decision 0004) needs a user facing result.
The obvious options were to download a ZIP of all parts at once, or to
open a page that shows the parts.
A ZIP hides the parts until the user extracts it, gives no preview, and
forces an all or nothing decision before the user has seen anything.

## Decision

Open a dedicated Parts overview page (`pages/parts.html`) when a capture
finishes with more than one part.

The page shows one card per part, in order, with lazy thumbnails and the
part's size. Each card offers Edit, Copy, and Save, and the page offers
Save all, Discard, and Discard all.
A single part capture keeps the simpler flow and opens the editor
directly. No result or editor tab opens during capture itself.

## Consequences

The user can inspect, edit, copy, or save each part on its own, and can
discard a capture without downloading files first.

Save all covers the bulk case that a ZIP would have served, as individual
image files the user can use immediately.
The cost is one more extension page to localize, test, and keep accessible.
It is covered by `tests/test-e2e/parts-e2e.mjs` and by unit checks in
`tests/test-parts-overview.mjs`.
