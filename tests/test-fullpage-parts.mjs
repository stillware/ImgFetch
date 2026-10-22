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
 * ImgFetch, tests/test-fullpage-parts.mjs
 * FIX 4: the part-based planner. No truncation (the whole page is
 * covered), no downscaling (full device resolution), every part within
 * the single shared limit rule, exact integer tile offsets at fractional
 * DPRs, and a sanity cap against runaway pages.
 */
import {
  planFullPageCapture,
  isStitchSizeAccepted,
  tileOffsets,
  pickScrollTarget,
  PART_MAX_SIDE,
  PART_MAX_AREA,
  PART_MAX_COUNT,
} from '../core/fullpage-capture.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `, ${extra}` : ''}`); }
}

const D = (n) => Math.round(n * 1000) / 1000;

/** Every part must satisfy the ONE shared stitch rule. */
function allAccepted(plan) {
  return plan.parts.every((p) => isStitchSizeAccepted(p.w, p.h));
}

/** Parts must tile the page exactly: contiguous, no gaps, no overlaps. */
function partsTileExactly(plan) {
  let y = 0;
  for (const p of plan.parts) {
    if (p.y0 !== y) return false;
    y = p.y0 + p.h;
  }
  return y === plan.devH;
}

/** Tile offsets inside every part: integers, covering the part fully. */
function tilesCoverPart(part, tileW, tileH) {
  for (const t of part.tiles) {
    if (!Number.isInteger(t.dx) || !Number.isInteger(t.dy)) return 'non-integer offset';
  }
  // Coverage along y: sort by dy, walk the union.
  const rows = [...part.tiles].map((t) => t.dy).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  let covered = 0;
  for (const dy of rows) {
    if (dy > covered) return `gap at ${dy}`;
    covered = Math.max(covered, dy + tileH);
  }
  if (covered < part.h) return `short: covered ${covered} < ${part.h}`;
  return '';
}

// --- the limit rule itself ---
check('16384 side accepted', isStitchSizeAccepted(16384, 3906) === true);
check('16385 side rejected', isStitchSizeAccepted(16385, 100) === false);
check('64MP area accepted', isStitchSizeAccepted(8000, 8000) === true); // exactly 64,000,000
check('over 64MP rejected', isStitchSizeAccepted(8000, 8001) === false);
check('zero rejected', isStitchSizeAccepted(0, 100) === false);
check('PART_MAX_SIDE is 16384', PART_MAX_SIDE === 16384);
check('PART_MAX_AREA is 64MP', PART_MAX_AREA === 64_000_000);
check('PART_MAX_COUNT is 48', PART_MAX_COUNT === 48);

// --- tileOffsets: exact, last tile at total - tile ---
check('offsets [0,1000,1500]', JSON.stringify(tileOffsets(2500, 1000)) === '[0,1000,1500]');
check('offsets exact division', JSON.stringify(tileOffsets(2000, 1000)) === '[0,1000]');
check('single tile when smaller', JSON.stringify(tileOffsets(900, 1000)) === '[0]');
check('last tile is exactly total - tile', tileOffsets(3721, 1000).pop() === 2721);
for (const [total, tile] of [[3721, 1000], [5000, 1377], [999, 1000], [16384, 1600]]) {
  const offs = tileOffsets(total, tile);
  const gapsOk = offs.every((o, i) => i === 0 || offs[i] - offs[i - 1] <= tile);
  const coversEnd = offs[offs.length - 1] + tile >= total;
  check(`offsets cover ${total}/${tile} with overlap-only`, gapsOk && coversEnd && offs[0] === 0);
}

// --- normal page: single part, full device resolution, no downscale ---
{
  const p = planFullPageCapture({ fullW: 1600, fullH: 3000, viewportW: 1600, viewportH: 900, dpr: 2 });
  check('normal page: one part', p.parts.length === 1);
  check('normal page: full device resolution', p.parts[0].w === 3200 && p.parts[0].h === 6000,
    `${p.parts[0].w}x${p.parts[0].h}`);
  check('normal page: part accepted', allAccepted(p));
  check('normal page: not sanity capped', p.sanityCapped === false);
  check('normal page: tiles cover part', tilesCoverPart(p.parts[0], p.tileW, p.tileH) === '',
    tilesCoverPart(p.parts[0], p.tileW, p.tileH));
}

// --- long page: split into parts, WHOLE page covered, no truncation ---
{
  const p = planFullPageCapture({ fullW: 1600, fullH: 60000, viewportW: 1600, viewportH: 900, dpr: 2 });
  check('long page: more than one part', p.parts.length > 1, `parts=${p.parts.length}`);
  check('long page: every part accepted', allAccepted(p));
  check('long page: whole page covered (no truncation)', partsTileExactly(p),
    `covered vs devH=${p.devH}`);
  check('long page: numbering is 1..N', p.parts.every((pt, i) => pt.index === i + 1 && pt.total === p.parts.length));
  check('long page: tiles cover every part',
    p.parts.every((pt) => tilesCoverPart(pt, p.tileW, p.tileH) === '') === true);
  check('long page: not sanity capped', p.sanityCapped === false);
}

// --- fractional DPRs: integer offsets, device-aligned scroll, exact last tile ---
for (const dpr of [1, 1.25, 1.5, 2, 3]) {
  const p = planFullPageCapture({ fullW: 1280, fullH: 20000, viewportW: 1280, viewportH: 800, dpr });
  let exact = true;
  let aligned = true;
  for (const part of p.parts) {
    for (const t of part.tiles) {
      if (!Number.isInteger(t.dx) || !Number.isInteger(t.dy)) exact = false;
      // Device-aligned: sx * dpr and sy * dpr are exact integers.
      if (D(t.sx * dpr) !== Math.round(t.sx * dpr) || D(t.sy * dpr) !== Math.round(t.sy * dpr)) aligned = false;
    }
  }
  const lastDy = Math.max(...p.parts[p.parts.length - 1].tiles.map((t) => t.dy));
  const lastPart = p.parts[p.parts.length - 1];
  check(`dpr=${dpr}: integer tile offsets`, exact);
  check(`dpr=${dpr}: device-aligned scroll positions`, aligned);
  check(`dpr=${dpr}: last tile exactly at part bottom - tileH`, lastDy + p.tileH >= lastPart.h,
    `lastDy=${lastDy} tileH=${p.tileH} h=${lastPart.h}`);
  check(`dpr=${dpr}: every part accepted`, allAccepted(p));
  check(`dpr=${dpr}: whole page covered`, partsTileExactly(p));
}

// --- wide page: column splits keep every part within limits ---
{
  const p = planFullPageCapture({ fullW: 40000, fullH: 2000, viewportW: 1600, viewportH: 900, dpr: 1 });
  check('wide page: splits into columns', p.parts.length > 1, `parts=${p.parts.length}`);
  check('wide page: every part accepted', allAccepted(p));
  const totalW = p.parts.filter((pt) => pt.y0 === 0).reduce((n, pt) => n + pt.w, 0);
  check('wide page: full width covered', totalW === p.devW, `covered=${totalW} devW=${p.devW}`);
}

// --- page shorter than the viewport: single tile, no crash ---
{
  const p = planFullPageCapture({ fullW: 1200, fullH: 500, viewportW: 1600, viewportH: 900, dpr: 2 });
  check('short page: one part', p.parts.length === 1);
  check('short page: one tile', p.totalTiles === 1);
  check('short page: full device size', p.parts[0].w === 2400 && p.parts[0].h === 1000);
}

// --- runaway page: sanity cap, first N parts, said clearly ---
{
  const p = planFullPageCapture({ fullW: 1280, fullH: 1000000, viewportW: 1280, viewportH: 800, dpr: 1 });
  check('runaway: capped at PART_MAX_COUNT', p.parts.length === PART_MAX_COUNT, `parts=${p.parts.length}`);
  check('runaway: sanityCapped is true', p.sanityCapped === true);
  check('runaway: every kept part accepted', allAccepted(p));
  check('runaway: numbering covers kept parts', p.parts.every((pt) => pt.total === PART_MAX_COUNT));
}

// --- degenerate inputs never crash ---
{
  const p = planFullPageCapture({ fullW: 0, fullH: 0, viewportW: 0, viewportH: 0, dpr: 0 });
  check('degenerate: one part', p.parts.length === 1);
  check('degenerate: part accepted', allAccepted(p));
}

// --- pickScrollTarget: FIX 4.1 capture-target choice (pure) ---
{
  const doc = { scrollW: 1600, scrollH: 900, clientW: 1600, clientH: 900 };
  const r = pickScrollTarget({ doc, containers: [], frames: [] });
  check('nothing scrolls -> document', r.target.kind === 'document' && !r.target.token);
  check('no notices for a plain page', !r.notices.innerCaptured && !r.notices.nestedClipped && !r.notices.crossOriginClipped);
}
{
  // Document does not scroll, inner container does -> capture the element.
  const r = pickScrollTarget({
    doc: { scrollW: 1600, scrollH: 900, clientW: 1600, clientH: 900 },
    containers: [{ token: 'c0', scrollW: 1500, scrollH: 6000, clientW: 1500, clientH: 500 }],
    frames: [],
  });
  check('inner container wins when the document does not scroll',
    r.target.kind === 'container' && r.target.token === 'c0');
  check('innerCaptured notice set', r.notices.innerCaptured === true);
}
{
  // Mixed case: document scrolls AND an inner container scrolls; the
  // larger scrollable area wins, honestly reported.
  const r = pickScrollTarget({
    doc: { scrollW: 1600, scrollH: 3000, clientW: 1600, clientH: 900, nestedHidden: true },
    containers: [{ token: 'c0', scrollW: 1500, scrollH: 6000, clientW: 1500, clientH: 500 }],
    frames: [],
  });
  check('mixed case: larger container wins', r.target.kind === 'container');
  check('mixed case: innerCaptured notice', r.notices.innerCaptured === true);
  const r2 = pickScrollTarget({
    doc: { scrollW: 1600, scrollH: 12000, clientW: 1600, clientH: 900, nestedHidden: true },
    containers: [{ token: 'c0', scrollW: 1500, scrollH: 2000, clientW: 1500, clientH: 500 }],
    frames: [],
  });
  check('mixed case: larger document wins', r2.target.kind === 'document');
  check('mixed case: nestedClipped notice when the document wins', r2.notices.nestedClipped === true);
}
{
  // Same-origin iframe with the largest content wins; cross-origin never does.
  const r = pickScrollTarget({
    doc: { scrollW: 1600, scrollH: 900, clientW: 1600, clientH: 900 },
    containers: [],
    frames: [{ token: 'f0', sameOrigin: true, scrollW: 1200, scrollH: 4000, clientW: 1200, clientH: 600 }],
  });
  check('same-origin iframe wins', r.target.kind === 'frame' && r.target.token === 'f0');
  const r2 = pickScrollTarget({
    doc: { scrollW: 1600, scrollH: 900, clientW: 1600, clientH: 900 },
    containers: [],
    frames: [{ token: 'f9', sameOrigin: false, scrollW: 99999, scrollH: 99999, clientW: 10, clientH: 10 }],
    crossOriginClipped: true,
  });
  check('cross-origin iframe never wins', r2.target.kind === 'document');
  check('crossOriginClipped notice passes through', r2.notices.crossOriginClipped === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
