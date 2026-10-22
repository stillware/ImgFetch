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
 * ImgFetch, core/fullpage-capture.js
 * Pure full-page capture planning (FIX 4, ROUND 2). No DOM, no chrome.*:
 * the service worker calls planFullPageCapture() and then executes the
 * plan. Unit-tested in Node (tests/test-fullpage-parts.mjs).
 *
 * FIX 4 behavior: NO truncation, NO downscaling. The whole page is
 * captured at full device resolution. When one stitched image would
 * exceed the safe canvas limits, the page is split into numbered parts
 * ("Part i of N"), each part within the limits. The limit rule lives in
 * exactly one place (isStitchSizeAccepted), shared by the planner (which
 * must never emit an unacceptable part) and the offscreen stitcher
 * (which enforces it before allocating a canvas).
 *
 * Seam-free stitching at fractional DPR: every tile offset is an exact
 * integer in device pixels, and every scroll position is device-aligned
 * (scrollCss * dpr is an integer), so tiles land on the page's device
 * grid with no Math.round drift. The last (overlapping) tile is placed
 * exactly at total - tile, never rounded from a CSS value. The worker
 * additionally reads back the real scroll position after each scroll and
 * uses round(actual * dpr) as the tile's true offset, so even a browser
 * that snaps fractional scrolls still stitches without gaps.
 */

export const PART_MAX_SIDE = 16384; // device px, longest side of one part
export const PART_MAX_AREA = 64_000_000; // device px^2, area of one part
export const PART_MAX_COUNT = 48; // sanity cap against runaway (e.g. infinite-scroll) pages

/**
 * Single source of truth for the stitcher's acceptance rule. BOTH the
 * planner (which must never emit an unacceptable part) and the offscreen
 * stitcher (which enforces it before allocating the canvas) use this
 * predicate, so the two can never disagree.
 */
export function isStitchSizeAccepted(width, height) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  return (
    w > 0 &&
    h > 0 &&
    w <= PART_MAX_SIDE &&
    h <= PART_MAX_SIDE &&
    w * h <= PART_MAX_AREA
  );
}

/**
 * Exact tile start offsets (device px, integers) covering [0, total).
 * Tiles are spaced `tile` apart; the last tile starts exactly at
 * total - tile so the tail is covered by overlap, never by a gap.
 */
export function tileOffsets(total, tile) {
  const t = Math.max(1, Math.round(total));
  const s = Math.max(1, Math.round(tile));
  if (t <= s) return [0];
  const offs = [];
  for (let o = 0; o + s < t; o += s) offs.push(o);
  const last = t - s;
  if (offs.length === 0 || offs[offs.length - 1] !== last) offs.push(last);
  return offs;
}

/**
 * Plan a full-page capture at full device resolution.
 *
 * Input: CSS px page size, CSS px viewport, devicePixelRatio.
 * Returns {
 *   parts: [{
 *     index, total,            part numbering ("Part i of N")
 *     x0, y0, w, h,            part region in device px (exact integers)
 *     cssX, cssY, cssW, cssH,   part region in CSS px (reporting only)
 *     tiles: [{ sx, sy, dx, dy }]
 *       sx, sy: CSS px scroll position (fractional, device-aligned:
 *               sx * dpr and sy * dpr are integers)
 *       dx, dy: tile offset inside the part canvas, device px integers
 *   }],
 *   totalTiles, sanityCapped, devW, devH, tileW, tileH, dpr,
 * }
 * Parts tile the page exactly: no gaps, no overlaps between parts.
 * sanityCapped is true when PART_MAX_COUNT cut a runaway page; only the
 * first PART_MAX_COUNT parts (top of the page) are emitted.
 */
export function planFullPageCapture({ fullW, fullH, viewportW, viewportH, dpr }) {
  const W = Math.max(1, Math.round(fullW || 0));
  const H = Math.max(1, Math.round(fullH || 0));
  const vw = Math.max(1, Math.round(viewportW || 0));
  const vh = Math.max(1, Math.round(viewportH || 0));
  const ratio = Number(dpr) > 0 ? Number(dpr) : 1;

  const devW = Math.max(1, Math.round(W * ratio));
  const devH = Math.max(1, Math.round(H * ratio));
  const tileW = Math.max(1, Math.round(vw * ratio));
  const tileH = Math.max(1, Math.round(vh * ratio));

  const xs = tileOffsets(devW, tileW);
  const ys = tileOffsets(devH, tileH);

  // Device-px height of tile row r (the last row may be shorter in the
  // page, but every tile bitmap is tileH tall; the part canvas clips it).
  const rowH = (r) => (r + 1 < ys.length ? ys[r + 1] : devH) - ys[r];

  // 1) Group tile rows into bands: each band fits the side limit and the
  //    area limit at full page width.
  const bands = [];
  let r0 = 0;
  while (r0 < ys.length) {
    let bandH = rowH(r0);
    let r1 = r0 + 1;
    while (
      r1 < ys.length &&
      bandH + rowH(r1) <= PART_MAX_SIDE &&
      devW * (bandH + rowH(r1)) <= PART_MAX_AREA
    ) {
      bandH += rowH(r1);
      r1 += 1;
    }
    bands.push({ r0, r1 });
    r0 = r1;
  }

  // 2) Split wide bands into column blocks at tile boundaries so every
  //    part fits the side and area limits.
  const parts = [];
  for (const band of bands) {
    const y0 = ys[band.r0];
    const y1 = band.r1 < ys.length ? ys[band.r1] : devH;
    const bandH = y1 - y0;
    let c0 = 0;
    while (c0 < xs.length) {
      const x0 = xs[c0];
      let c1 = c0 + 1;
      let blockW = (c1 < xs.length ? xs[c1] : devW) - x0;
      while (
        c1 < xs.length &&
        blockW <= PART_MAX_SIDE &&
        blockW * bandH <= PART_MAX_AREA
      ) {
        const nextW = (c1 + 1 < xs.length ? xs[c1 + 1] : devW) - x0;
        if (nextW > PART_MAX_SIDE || nextW * bandH > PART_MAX_AREA) break;
        c1 += 1;
        blockW = nextW;
      }
      // A single tile column wider than the side limit cannot happen
      // (tileW <= PART_MAX_SIDE is enforced below), but never emit a
      // zero-width part if it somehow does.
      const x1 = c1 < xs.length ? xs[c1] : devW;
      if (x1 > x0 && bandH > 0) {
        parts.push({ x0, y0, w: x1 - x0, h: bandH, r0: band.r0, r1: band.r1, c0, c1 });
      }
      c0 = c1;
    }
  }

  // 3) Sanity cap against runaway pages: first PART_MAX_COUNT parts only.
  let sanityCapped = false;
  let kept = parts;
  if (parts.length > PART_MAX_COUNT) {
    kept = parts.slice(0, PART_MAX_COUNT);
    sanityCapped = true;
  }

  const total = kept.length;
  const out = kept.map((p, i) => {
    const tiles = [];
    for (let r = p.r0; r < p.r1; r += 1) {
      for (let c = p.c0; c < p.c1; c += 1) {
        // Device-aligned scroll: sx * dpr === xs[c] exactly (integers).
        // The worker reads back the real scroll position and re-derives
        // integer offsets from it, so snapping browsers stay exact too.
        tiles.push({
          sx: xs[c] / ratio,
          sy: ys[r] / ratio,
          dx: xs[c] - p.x0,
          dy: ys[r] - p.y0,
        });
      }
    }
    return {
      index: i + 1,
      total,
      x0: p.x0,
      y0: p.y0,
      w: p.w,
      h: p.h,
      cssX: p.x0 / ratio,
      cssY: p.y0 / ratio,
      cssW: p.w / ratio,
      cssH: p.h / ratio,
      tiles,
    };
  });

  return {
    parts: out,
    totalTiles: out.reduce((n, p) => n + p.tiles.length, 0),
    sanityCapped,
    devW,
    devH,
    tileW,
    tileH,
    dpr: ratio,
  };
}

/**
 * FIX 4.1: pick the full-page capture target from a
 * describeScrollContext() report (plain JSON, no DOM). The winner is the
 * scroll root with the largest scrollable content area: the document, a
 * large inner element, or a same-origin iframe. When nothing scrolls, the
 * document is the target (a single tile). Pure and unit-tested.
 *
 * Returns { target: { kind, token? }, notices: {
 *   innerCaptured,     // the target is an inner container/iframe, not the document
 *   nestedClipped,     // the winner contains another scroller with significant hidden content
 *   crossOriginClipped // a large scrollable cross-origin iframe may clip content we cannot see
 * } }.
 */
export function pickScrollTarget(desc) {
  const d = (desc && desc.doc) || {};
  const notices = {
    innerCaptured: false,
    nestedClipped: false,
    crossOriginClipped: !!(desc && desc.crossOriginClipped),
  };
  const scrollable = (c) => c.scrollH > c.clientH + 4 || c.scrollW > c.clientW + 4;
  const cands = [];
  cands.push({
    kind: 'document',
    token: null,
    area: (d.scrollW || 0) * (d.scrollH || 0),
    scrolls: scrollable({ scrollW: d.scrollW || 0, scrollH: d.scrollH || 0, clientW: d.clientW || 0, clientH: d.clientH || 0 }),
    nestedHidden: !!d.nestedHidden,
  });
  for (const c of (desc && desc.containers) || []) {
    cands.push({
      kind: 'container',
      token: c.token,
      area: (c.scrollW || 0) * (c.scrollH || 0),
      scrolls: scrollable(c),
      nestedHidden: !!c.nestedHidden,
    });
  }
  for (const f of (desc && desc.frames) || []) {
    if (!f.sameOrigin) continue; // handled honestly via crossOriginClipped
    cands.push({
      kind: 'frame',
      token: f.token,
      area: (f.scrollW || 0) * (f.scrollH || 0),
      scrolls: scrollable(f),
      nestedHidden: false,
    });
  }
  const scrolling = cands.filter((c) => c.scrolls);
  const pool = scrolling.length ? scrolling : cands.filter((c) => c.kind === 'document');
  let win = pool[0];
  for (const c of pool) {
    if (c.area > win.area) win = c;
  }
  if (win.kind !== 'document') notices.innerCaptured = true;
  if (win.nestedHidden) notices.nestedClipped = true;
  const target = win.token ? { kind: win.kind, token: win.token } : { kind: win.kind };
  return { target, notices };
}
