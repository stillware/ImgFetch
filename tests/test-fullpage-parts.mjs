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
  tilesCoveringRegion,
  shiftPlanParts,
  pickScrollTarget,
  PART_MAX_SIDE,
  PART_MAX_AREA,
  PART_MAX_COUNT,
  CAPTURE_MAX_DURATION_MS,
  CAPTURE_AREA_FLOOR,
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
check('32767 side accepted', isStitchSizeAccepted(32767, 100) === true);
check('32768 side rejected', isStitchSizeAccepted(32768, 100) === false);
check('100MP area accepted', isStitchSizeAccepted(10000, 10000) === true); // exactly 100,000,000
check('over 100MP rejected', isStitchSizeAccepted(10000, 10001) === false);
check('zero rejected', isStitchSizeAccepted(0, 100) === false);
check('PART_MAX_SIDE is 32767', PART_MAX_SIDE === 32767);
check('PART_MAX_AREA is 100MP', PART_MAX_AREA === 100_000_000);
check('PART_MAX_COUNT is 48', PART_MAX_COUNT === 48);
check('capture duration cap is 10 minutes', CAPTURE_MAX_DURATION_MS === 600_000);
check('allocation floor is positive and below the area cap', CAPTURE_AREA_FLOOR > 0 && CAPTURE_AREA_FLOOR < PART_MAX_AREA);
check('custom tighter limits are honored', isStitchSizeAccepted(5000, 5000, { maxArea: 25_000_000 }) === true
  && isStitchSizeAccepted(5000, 5001, { maxArea: 25_000_000 }) === false);

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
  const p = planFullPageCapture({ fullW: 1280, fullH: 2000000, viewportW: 1280, viewportH: 800, dpr: 1 });
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

// --- Round 4: balanced parts (no giant part + tiny remainder) ---
{
  const p = planFullPageCapture({ fullW: 1280, fullH: 48000, viewportW: 1280, viewportH: 800, dpr: 1 });
  check('balanced: 48000px page splits into 2 parts', p.parts.length === 2, `parts=${p.parts.length}`);
  check('balanced: parts are exactly equal here', p.parts[0].h === 24000 && p.parts[1].h === 24000,
    p.parts.map((pt) => pt.h).join(','));
  check('balanced: cuts land on tile boundaries', p.parts.every((pt) => pt.y0 % p.tileH === 0 || pt.y0 === 0));
  const q = planFullPageCapture({ fullW: 1600, fullH: 60000, viewportW: 1600, viewportH: 900, dpr: 2 });
  const hs = q.parts.map((pt) => pt.h);
  check('balanced: heights differ by at most one tile row',
    Math.max(...hs) - Math.min(...hs) <= q.tileH, hs.join(','));
  check('balanced: whole page still covered at dpr 2', partsTileExactly(q));
}

// --- Round 4: allocation-fallback budgets (maxArea option) ---
{
  const p = planFullPageCapture({
    fullW: 1280, fullH: 48000, viewportW: 1280, viewportH: 800, dpr: 1, maxArea: 25_000_000,
  });
  check('fallback budget: more parts at half-ish area', p.parts.length >= 3, `parts=${p.parts.length}`);
  check('fallback budget: every part within the tighter budget',
    p.parts.every((pt) => isStitchSizeAccepted(pt.w, pt.h, { maxArea: 25_000_000 })));
  check('fallback budget: whole page covered', partsTileExactly(p));
}

// --- Round 4: tilesCoveringRegion + shiftPlanParts (growth/replan helpers) ---
{
  const sub = planFullPageCapture({ fullW: 1280, fullH: 5000, viewportW: 1280, viewportH: 800, dpr: 1 });
  const shifted = shiftPlanParts(sub.parts, 1600, 1);
  check('shift: y0 moved', shifted[0].y0 === sub.parts[0].y0 + 1600);
  check('shift: tile sy moved, dy unchanged',
    shifted[0].tiles[0].sy === sub.parts[0].tiles[0].sy + 1600
    && shifted[0].tiles[0].dy === sub.parts[0].tiles[0].dy);
  check('shift: input not mutated', sub.parts[0].y0 !== shifted[0].y0 || sub.parts[0].y0 === 0);
  const tiles = tilesCoveringRegion({ x0: 0, y0: 1600, w: 1280, h: 2400 }, 1280, 20000, 1280, 800, 1);
  check('region tiles: starts at the region top', tiles.length > 0 && tiles[0].dy === 0 && tiles[0].sy === 1600);
  check('region tiles: all inside the region', tiles.every((t) => t.dy >= 0 && t.dy < 2400));
}

// --- Round 4: property sweep, thousands of size/DPR combinations ---
{
  let combos = 0;
  let badCombo = '';
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    for (let fullH = 700; fullH <= 26000; fullH += 317) {
      for (const [vw, vh] of [[1280, 800], [1920, 900], [390, 844], [800, 600]]) {
        combos += 1;
        const plan = planFullPageCapture({ fullW: vw, fullH, viewportW: vw, viewportH: vh, dpr });
        const areaSum = plan.parts.reduce((n, pt) => n + pt.w * pt.h, 0);
        const okParts = plan.parts.every((pt) => isStitchSizeAccepted(pt.w, pt.h));
        const okTiles = plan.parts.every((pt) => tilesCoverPart(pt, plan.tileW, plan.tileH) === '');
        if (!okParts || !okTiles || areaSum !== plan.devW * plan.devH || !partsTileExactly(plan)) {
          badCombo = `${vw}x${fullH}@${dpr} accepted=${okParts} tiles=${okTiles} area=${areaSum}/${plan.devW * plan.devH}`;
        }
      }
    }
  }
  check(`property sweep: ${combos} combos tile exactly and stay within limits`, badCombo === '', badCombo);
  check('property sweep: really thousands of combos', combos >= 1000, `combos=${combos}`);
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
