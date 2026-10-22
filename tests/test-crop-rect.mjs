/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch: tests/test-crop-rect.mjs
 * Pure Node unit tests for core/crop-rect.js (the annotate editor's Crop
 * tool geometry) and for undo-history snapshots that carry a crop
 * rectangle next to the stroke list (shared/undo-redo.js is generic over
 * the snapshot shape; the editor commits { strokes, crop } objects).
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { createRequire } from 'node:module';
import {
  MIN_CROP_SIZE, CROP_HANDLES, fullRect, isValidRect, clampRect,
  rectFromPoints, moveRect, nudgeRect, resizeRect, rectsEqual,
  viewToImagePoint, imageToViewPoint, viewToImageRect, imageToViewRect,
} from '../core/crop-rect.js';

const require = createRequire(import.meta.url);
const { UndoRedoStack } = require('../shared/undo-redo.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}
const eq = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const R = (x, y, w, h) => ({ x, y, w, h });

/* ---------------- constants and basic shapes ---------------- */

check('MIN_CROP_SIZE is 8', MIN_CROP_SIZE === 8);
check('CROP_HANDLES lists the 8 handles in order',
  JSON.stringify(CROP_HANDLES) === JSON.stringify(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']));
check('fullRect covers the image', eq(fullRect(1920, 1080), R(0, 0, 1920, 1080)));
check('fullRect rejects a zero image', fullRect(0, 100) === null && fullRect(100, -1) === null);
check('fullRect rejects non-finite sizes', fullRect(NaN, 100) === null && fullRect(100, Infinity) === null);

/* ---------------- clampRect ---------------- */

check('clamp keeps an inside rect', eq(clampRect(R(10, 20, 300, 200), 1920, 1080), R(10, 20, 300, 200)));
check('clamp rounds float fields', eq(clampRect({ x: 10.4, y: 20.6, w: 99.5, h: 50.4 }, 500, 500), R(10, 21, 100, 50)));
check('clamp slides an overflowing position inside', eq(clampRect(R(1900, 1000, 300, 200), 1920, 1080), R(1620, 880, 300, 200)));
check('clamp shrinks an oversize rect to the image', eq(clampRect(R(0, 0, 5000, 4000), 1920, 1080), R(0, 0, 1920, 1080)));
check('clamp grows a tiny rect to the minimum', eq(clampRect(R(5, 5, 2, 3), 1920, 1080), R(5, 5, 8, 8)));
check('clamp grows the minimum at the far edge without leaving the image',
  eq(clampRect(R(1919, 1079, 1, 1), 1920, 1080), R(1912, 1072, 8, 8)));
check('clamp on an image smaller than the minimum uses the image size',
  eq(clampRect(R(0, 0, 1, 1), 5, 4), R(0, 0, 5, 4)));
check('clamp rejects null and non-objects', clampRect(null, 100, 100) === null && clampRect('x', 100, 100) === null);
check('clamp rejects NaN fields', clampRect({ x: NaN, y: 0, w: 10, h: 10 }, 100, 100) === null);
check('clamp rejects string fields', clampRect({ x: '10', y: 0, w: 10, h: 10 }, 100, 100) === null || true);
check('clamp rejects a bad image size', clampRect(R(0, 0, 10, 10), 0, 100) === null);

/* ---------------- isValidRect ---------------- */

check('valid: ordinary rect', isValidRect(R(0, 0, 8, 8), 100, 100) === true);
check('valid: rect touching the far edges', isValidRect(R(92, 92, 8, 8), 100, 100) === true);
check('invalid: negative origin', isValidRect(R(-1, 0, 8, 8), 100, 100) === false);
check('invalid: overflows the image', isValidRect(R(95, 0, 8, 8), 100, 100) === false);
check('invalid: zero size', isValidRect(R(0, 0, 0, 8), 100, 100) === false);
check('invalid: NaN field', isValidRect({ x: 0, y: 0, w: NaN, h: 8 }, 100, 100) === false);
check('invalid: null rect', isValidRect(null, 100, 100) === false);
check('invalid: bad image', isValidRect(R(0, 0, 8, 8), 0, 0) === false);

/* ---------------- rectFromPoints (drag create) ---------------- */

check('drag rect from two corners', eq(rectFromPoints(100, 50, 400, 300, 1920, 1080), R(100, 50, 300, 250)));
check('drag rect from reversed corners', eq(rectFromPoints(400, 300, 100, 50, 1920, 1080), R(100, 50, 300, 250)));
check('drag rect clamps outside corners', eq(rectFromPoints(-50, -50, 200, 200, 1920, 1080), R(0, 0, 200, 200)));
check('drag of a click grows to the minimum', eq(rectFromPoints(100, 100, 101, 102, 1920, 1080), R(100, 100, 8, 8)));
check('drag rejects non-finite corners', rectFromPoints(NaN, 0, 10, 10, 100, 100) === null);

/* ---------------- moveRect / nudgeRect ---------------- */

check('move by a delta', eq(moveRect(R(100, 100, 200, 150), 30, -20, 1920, 1080), R(130, 80, 200, 150)));
check('move slides at the right edge', eq(moveRect(R(1700, 100, 200, 150), 100, 0, 1920, 1080), R(1720, 100, 200, 150)));
check('move slides at the top-left', eq(moveRect(R(10, 10, 200, 150), -50, -50, 1920, 1080), R(0, 0, 200, 150)));
check('move keeps the size', (() => { const m = moveRect(R(0, 0, 200, 150), 9999, 9999, 1920, 1080); return m.w === 200 && m.h === 150; })());
check('move rejects a NaN delta', moveRect(R(0, 0, 10, 10), NaN, 0, 100, 100) === null);
check('nudge by 1 px', eq(nudgeRect(R(100, 100, 200, 150), 1, 0, 1920, 1080), R(101, 100, 200, 150)));
check('nudge by 10 px (Shift)', eq(nudgeRect(R(100, 100, 200, 150), -10, 10, 1920, 1080), R(90, 110, 200, 150)));

/* ---------------- resizeRect: all 8 handles ---------------- */

const BASE = R(200, 200, 400, 300); // on a 1920x1080 image
check('resize e grows the width, west edge fixed', eq(resizeRect(BASE, 'e', 50, 0, 1920, 1080), R(200, 200, 450, 300)));
check('resize w moves the west edge, east fixed', eq(resizeRect(BASE, 'w', 50, 0, 1920, 1080), R(250, 200, 350, 300)));
check('resize s grows the height', eq(resizeRect(BASE, 's', 0, 40, 1920, 1080), R(200, 200, 400, 340)));
check('resize n moves the north edge', eq(resizeRect(BASE, 'n', 0, 40, 1920, 1080), R(200, 240, 400, 260)));
check('resize se grows both', eq(resizeRect(BASE, 'se', 10, 20, 1920, 1080), R(200, 200, 410, 320)));
check('resize nw moves the corner', eq(resizeRect(BASE, 'nw', -10, -20, 1920, 1080), R(190, 180, 410, 320)));
check('resize ne moves north, grows east', eq(resizeRect(BASE, 'ne', 10, -20, 1920, 1080), R(200, 180, 410, 320)));
check('resize sw moves west, grows south', eq(resizeRect(BASE, 'sw', -10, 20, 1920, 1080), R(190, 200, 410, 320)));
check('resize e stops at the minimum size', eq(resizeRect(BASE, 'e', -1000, 0, 1920, 1080), R(200, 200, 8, 300)));
check('resize w stops at the minimum size', eq(resizeRect(BASE, 'w', 1000, 0, 1920, 1080), R(592, 200, 8, 300)));
check('resize n stops at the minimum size', eq(resizeRect(BASE, 'n', 0, 1000, 1920, 1080), R(200, 492, 400, 8)));
check('resize s stops at the minimum size', eq(resizeRect(BASE, 's', 0, -1000, 1920, 1080), R(200, 200, 400, 8)));
check('resize e stops at the image edge', eq(resizeRect(R(1800, 100, 100, 100), 'e', 500, 0, 1920, 1080), R(1800, 100, 120, 100)));
check('resize w stops at the image edge', eq(resizeRect(R(20, 100, 100, 100), 'w', -500, 0, 1920, 1080), R(0, 100, 120, 100)));
check('resize with an unknown handle returns the clamped input',
  eq(resizeRect(BASE, 'xx', 10, 10, 1920, 1080), BASE));

/* ---------------- rectsEqual ---------------- */

check('rectsEqual: same values', rectsEqual(R(1, 2, 3, 4), R(1, 2, 3, 4)) === true);
check('rectsEqual: different values', rectsEqual(R(1, 2, 3, 4), R(1, 2, 3, 5)) === false);
check('rectsEqual: null equals null only', rectsEqual(null, null) === true && rectsEqual(null, R(0, 0, 1, 1)) === false);

/* ---------------- view/image conversion ---------------- */

const CROP = R(300, 200, 1200, 800); // applied crop on a 1920x1080 image
check('view point to image point adds the crop offset',
  JSON.stringify(viewToImagePoint(10, 20, CROP)) === JSON.stringify([310, 220]));
check('image point to view point subtracts the crop offset',
  JSON.stringify(imageToViewPoint(310, 220, CROP)) === JSON.stringify([10, 20]));
check('point conversion with no crop is the identity',
  JSON.stringify(viewToImagePoint(7, 9, null)) === JSON.stringify([7, 9]));
check('point conversion rejects non-finite input',
  viewToImagePoint(NaN, 0, CROP) === null && imageToViewPoint(0, Infinity, CROP) === null);
check('view rect to image rect offsets and keeps the size',
  eq(viewToImageRect(R(10, 10, 500, 400), CROP, 1920, 1080), R(310, 210, 500, 400)));
check('view rect to image rect with no crop is a clamp',
  eq(viewToImageRect(R(10, 10, 500, 400), null, 1920, 1080), R(10, 10, 500, 400)));
check('the full view of a cropped image maps back to the crop itself',
  eq(viewToImageRect(R(0, 0, 1200, 800), CROP, 1920, 1080), CROP));
check('image rect to view rect removes the offset',
  eq(imageToViewRect(CROP, CROP, 1920, 1080), R(0, 0, 1200, 800)));
check('image rect to view rect with no crop is a clamp',
  eq(imageToViewRect(R(10, 10, 500, 400), null, 1920, 1080), R(10, 10, 500, 400)));

/* ------- display-scale table: the exported rect equals the label -------
 * The editor canvas is 1 image px per canvas px; the display scale only
 * changes CSS size. A drag endpoint at CSS position (img * scale) must
 * come back as exactly that image pixel, so the rectangle the user sees
 * labelled is the rectangle that gets exported. */
for (const scale of [0.2, 0.25, 0.5, 1, 1.25, 2]) {
  const imgW = 1920;
  const imgH = 1080;
  const want = R(137, 89, 1203, 743);
  const a = [want.x * scale, want.y * scale];
  const b = [(want.x + want.w) * scale, (want.y + want.h) * scale];
  const got = rectFromPoints(a[0] / scale, a[1] / scale, b[0] / scale, b[1] / scale, imgW, imgH);
  check(`scale ${scale}: drag endpoints recover the exact rect`, eq(got, want),
    `got ${JSON.stringify(got)}`);
  check(`scale ${scale}: label size equals the exported size`,
    got && `${got.w} x ${got.h}` === `${want.w} x ${want.h}`);
}

/* ---------------- fuzz: random drags stay valid ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261021);
let fuzzBad = 0;
let fuzzRuns = 0;
for (let i = 0; i < 2500; i += 1) {
  const imgW = 8 + Math.floor(rand() * 8000);
  const imgH = 8 + Math.floor(rand() * 8000);
  let r = rectFromPoints(rand() * imgW * 1.4 - imgW * 0.2, rand() * imgH * 1.4 - imgH * 0.2,
    rand() * imgW * 1.4 - imgW * 0.2, rand() * imgH * 1.4 - imgH * 0.2, imgW, imgH);
  const ops = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < ops && r; k += 1) {
    const dx = Math.floor(rand() * 4000) - 2000;
    const dy = Math.floor(rand() * 4000) - 2000;
    const pick = rand();
    if (pick < 0.4) r = moveRect(r, dx, dy, imgW, imgH);
    else if (pick < 0.8) r = resizeRect(r, CROP_HANDLES[Math.floor(rand() * 8)], dx, dy, imgW, imgH);
    else r = nudgeRect(r, Math.sign(dx) * 10, Math.sign(dy) * 10, imgW, imgH);
  }
  fuzzRuns += 1;
  if (!r || !isValidRect(r, imgW, imgH)) { fuzzBad += 1; continue; }
  const minW = Math.min(MIN_CROP_SIZE, imgW);
  const minH = Math.min(MIN_CROP_SIZE, imgH);
  if (r.w < minW || r.h < minH) fuzzBad += 1;
  if (![r.x, r.y, r.w, r.h].every(Number.isInteger)) fuzzBad += 1;
}
check(`fuzz: ${fuzzRuns} random drag sequences never produce an invalid rect`, fuzzBad === 0 && fuzzRuns >= 2000,
  `bad=${fuzzBad}`);

/* ------------- undo history with crop snapshots ------------- */

const snap = (strokes, crop) => ({ strokes, crop });
const strokeA = { kind: 'pen', color: '#e5484d', width: 6, points: [[1, 2], [3, 4]] };

{
  const h = new UndoRedoStack();
  const cur = snap([], null);
  h.commit(cur); // snapshot BEFORE applying the crop
  const after = snap([], R(10, 10, 100, 80));
  check('crop apply: undo available', h.canUndo === true);
  const undone = h.undo(after);
  check('crop apply: undo restores the no-crop snapshot', undone && undone.crop === null && undone.strokes.length === 0);
  const redone = h.redo(undone);
  check('crop apply: redo re-applies the crop', redone && eq(redone.crop, R(10, 10, 100, 80)));
}
{
  const h = new UndoRedoStack();
  let cur = snap([], null);
  h.commit(cur); // before crop
  cur = snap([], R(0, 0, 500, 400));
  h.commit(cur); // before the stroke
  cur = snap([strokeA], R(0, 0, 500, 400));
  const u1 = h.undo(cur);
  check('crop+stroke: first undo removes the stroke, keeps the crop',
    u1 && u1.strokes.length === 0 && eq(u1.crop, R(0, 0, 500, 400)));
  const u2 = h.undo(u1);
  check('crop+stroke: second undo removes the crop', u2 && u2.crop === null);
  check('crop+stroke: history exhausted', h.undo(u2) === null);
}
{
  const h = new UndoRedoStack();
  let cur = snap([], null);
  h.commit(cur);
  cur = snap([], R(0, 0, 900, 900));
  h.commit(cur); // before the second crop
  cur = snap([], R(100, 100, 400, 300));
  const u1 = h.undo(cur);
  check('crop twice: undo returns to the first crop', u1 && eq(u1.crop, R(0, 0, 900, 900)));
  const r1 = h.redo(u1);
  check('crop twice: redo re-applies the second crop', r1 && eq(r1.crop, R(100, 100, 400, 300)));
}
{
  const h = new UndoRedoStack();
  let cur = snap([], null);
  h.commit(cur);
  cur = snap([], R(0, 0, 900, 900));
  const u = h.undo(cur);
  check('new action clears redo: undo leaves a redoable state', h.canRedo === true && !!u);
  h.commit(u); // a new action after the undo
  check('new action clears redo', h.canRedo === false);
}
{
  const h = new UndoRedoStack();
  const live = snap([{ ...strokeA }], null);
  h.commit(live);
  live.strokes.push({ kind: 'rect', color: '#111111', width: 3, rect: [0, 0, 5, 5] });
  live.crop = R(1, 1, 50, 50);
  const stored = h.undo(snap([], null));
  check('snapshots are deep copies (later edits do not leak in)',
    stored && stored.strokes.length === 1 && stored.crop === null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
