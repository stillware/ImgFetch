# Architecture Decision Records

Short records of the decisions that shape ImgFetch, what was decided, and what the decision costs and buys.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

Each record has Status, Context, Decision, and Consequences sections and
stays under one page. Every record describes a decision that is verifiable
in the current code and tests.
A decision that is replaced later keeps its file. A new record states that
it replaces the old one, and this index is updated in the same change.

| Record | Decision in one line |
|---|---|
| [0001: Manifest V3 with an offscreen document](0001-manifest-v3-offscreen-document.md) | DOM, canvas, ZIP, and clipboard work the service worker cannot do runs in one offscreen document. |
| [0002: No remote code, no accounts, no tracking](0002-no-remote-code-no-accounts.md) | All code ships in the package, no sign in exists, and no telemetry is collected. |
| [0003: Custom i18n loader with 21 locales](0003-custom-i18n-21-locales.md) | A custom loader in `shared/i18n.js` serves 21 locales from `_locales`, guarded by a checker. |
| [0004: Full page capture in balanced parts stored as Blobs in IndexedDB](0004-full-page-capture-parts-indexeddb.md) | Tall pages split into capped, balanced parts stored as Blobs, not data URLs. |
| [0005: Parts overview page instead of a ZIP download](0005-parts-overview-page.md) | Multi part captures open a page with one card per part for Edit, Copy, and Save. |
| [0006: Lossless crop in the worker for Area and Element captures](0006-lossless-crop-in-worker.md) | Area and Element crops run losslessly in the worker after a lossy offscreen path was removed. |
| [0007: Non-destructive Crop in the editor](0007-non-destructive-crop-editor.md) | Editor Crop stores a rectangle in state and never modifies the original image or strokes. |
| [0008: Editor Copy with the async clipboard and a downscale fallback](0008-copy-async-clipboard-downscale-fallback.md) | Copy writes directly from the editor page and retries once at a smaller size on failure. |
| [0009: File naming standard](0009-file-naming-standard.md) | Root documents are uppercase, `docs/` files are lowercase kebab case, and basenames stay unique. |
