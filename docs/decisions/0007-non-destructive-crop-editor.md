# 0007: Non-Destructive Crop in the Editor

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

The annotation editor gained a Crop tool in 1.1.0.
A destructive crop would cut the stored image as soon as the user applied
a rectangle. A wrong drag would then lose image area, and combining crop
with annotation strokes would force strokes to be moved, scaled, or
deleted to match the new image bounds.

## Decision

Make Crop non destructive. The editor stores a crop rectangle in its state
(`{ strokes, crop }`), in the same undo history as strokes.
The original image and all strokes are never modified, moved, or deleted
by a crop. Geometry lives in the pure module `core/crop-rect.js`.

The crop is applied only at render and export time, so Save, Copy, and the
shown dimensions use the cropped size.

Undo restores the previous crop, including no crop. Strokes drawn after a
crop are stored in original image coordinates.
The Crop shortcut is C, the minimum crop is 8 by 8 image pixels, Apply is
Enter, and Cancel is Esc.

## Consequences

A user can crop, annotate, change the crop, and undo in any order without
losing image data or work.

Export stays exact: the exported rectangle is the rectangle the size label
showed, verified pixel for pixel by `tests/test-e2e/crop-e2e.mjs` and by
87 unit checks in `tests/test-crop-rect.mjs`.
The cost is coordinate discipline: view and original image coordinates
must be converted carefully everywhere the cropped view is used.
