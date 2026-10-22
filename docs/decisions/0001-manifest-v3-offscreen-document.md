# 0001: Manifest V3 with an Offscreen Document

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

ImgFetch is a Manifest V3 extension. Its background is a service worker,
which has no DOM and can be suspended by the browser at any time.

Several core jobs need DOM or canvas APIs that a service worker does not
have: image format conversion, ZIP building, SVG sanitizing, tile
stitching, and clipboard writes on the worker's behalf.
The manifest sets `minimum_chrome_version` to 116 and declares the
`offscreen` permission.

## Decision

Use one offscreen document (`offscreen/offscreen.html` and
`offscreen/offscreen.js`) for the work the service worker cannot do.
The worker sends it typed messages with `target: offscreen`.

The offscreen message set covers conversion, metadata stripping, type
sniffing, SVG sanitizing, ZIP building, clipboard writes, tile stitching,
capture group finalizing, format support probing, and memory sampling.

Work that the worker can do itself, such as the lossless Area and Element
crop, stays in the worker. See decision 0006.

## Consequences

The service worker stays small and free of DOM code, and heavy work does
not block it.
The offscreen document can be created and closed on demand, so it costs
nothing while idle.
The cost is one extra message boundary: payloads crossing it must be
validated and kept within the message size caps in `core/validation.js`.
