# 0008: Editor Copy with the Async Clipboard and a Downscale Fallback

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

The editor Copy button copies the flattened, edited image to the system
clipboard as PNG.
The editor page (`pages/annotate.html`) is a visible, focused extension
page, so the click is a real user gesture and the manifest grants
`clipboardWrite`. Routing the copy through the service worker or the
offscreen document would lose that gesture.

Very large images are a second problem: browsers can refuse an oversized
clipboard image, and a failed copy must never lose the screenshot or fail
silently.

## Decision

Copy directly from the editor page with the async clipboard API
(`navigator.clipboard.write`), implemented in `shared/copy-shot.js` with
the size decision planned by `core/clipboard-image.js`.

If the direct copy fails, retry once at a smaller, downscaled size.
Every outcome ends in a toast: success, downscaled success, or an honest
error that suggests Save instead.

Copy follows the current view, so after a Crop it copies the cropped size.
On Windows, a large copy may not appear in Windows clipboard history. The
editor says so in a note instead of promising it will appear.

## Consequences

Copy works in one click in the common case and degrades to a smaller image
instead of failing outright on very large screenshots.

The fallback copy is not pixel identical to the original, and the toast
says a smaller copy was made, so the trade off is visible to the user.
The screenshot itself is never modified by a copy, successful or not.
Unit coverage is in `tests/test-copy-shot.mjs` and
`tests/test-clipboard-image.mjs`. Real Windows clipboard behavior stays a
manual check; see [the tests guide](../tests/README.md).
