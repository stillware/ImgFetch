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
 * ImgFetch: tests/test-a1-fringe.mjs
 * Node unit tests for the Phase 6 item 6 A1 rule: the outermost 12 px of
 * the popup must equal the app background, except the known shadow fringe
 * (the Scan button and hero drop shadows bleeding into the band) of up to
 * 16 levels per channel. Phase 5 measured the fringe at 11 to 15 levels
 * and the owner accepted it; the literal tolerance-0 assertion is gone.
 * The rule itself is checkOuterBand, exported so the real-browser suite
 * (tests/test-e2e/a1-fringe-e2e.mjs) applies the same code to live popup
 * screenshots. The checks below run only when this file is executed
 * directly; importing it for the rule does not run them.
 * Prints "N passed, M failed", exits nonzero on failure.
 * Run: node tests/test-a1-fringe.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Check the outer band of a screenshot against the background colour.
 * `data` is raw RGB or RGBA bytes (channels per pixel), `w` and `h` are
 * the image size in device pixels, `bg` is [r, g, b], `bandPx` is the
 * band width in device pixels. Returns the worst per-channel deviation
 * in the band, how many band pixels deviate at all, and the worst pixel.
 * `ok` is true when every band pixel is within `maxLevels` of the
 * background on every channel. Corners are counted once.
 */
export function checkOuterBand(data, w, h, channels, bg, bandPx, maxLevels = 16) {
  let maxDev = 0;
  let deviating = 0;
  let worst = null;
  let total = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inBand = x < bandPx || x >= w - bandPx || y < bandPx || y >= h - bandPx;
      if (!inBand) continue;
      total += 1;
      const o = (y * w + x) * channels;
      const d = Math.max(
        Math.abs(data[o] - bg[0]),
        Math.abs(data[o + 1] - bg[1]),
        Math.abs(data[o + 2] - bg[2]),
      );
      if (d > 0) deviating += 1;
      if (d > maxDev) { maxDev = d; worst = { x, y, rgb: [data[o], data[o + 1], data[o + 2]], d }; }
    }
  }
  return { ok: maxDev <= maxLevels, maxDev, deviating, total, worst };
}

/** Solid-colour image with one band pixel overridden. */
function image(w, h, bg, overrides = []) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i += 1) { data[i * 3] = bg[0]; data[i * 3 + 1] = bg[1]; data[i * 3 + 2] = bg[2]; }
  for (const [x, y, rgb] of overrides) {
    const o = (y * w + x) * 3;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
  }
  return data;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let pass = 0;
  let fail = 0;
  function check(name, cond, extra = '') {
    if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
  }
  const BG = [11, 13, 24];
  {
    const r = checkOuterBand(image(40, 60, BG), 40, 60, 3, BG, 12);
    check('clean band: maxDev 0 and ok', r.ok && r.maxDev === 0 && r.deviating === 0, JSON.stringify(r));
    check('clean band: total counts the ring once', r.total === 40 * 60 - 16 * 36, `total ${r.total}`);
  }
  {
    // A fringe pixel 16 levels up on blue, at the Scan-button spot.
    const r = checkOuterBand(image(40, 60, BG, [[11, 31, [17, 17, 40]]]), 40, 60, 3, BG, 12);
    check('fringe at exactly 16 levels passes', r.ok && r.maxDev === 16 && r.deviating === 1, JSON.stringify(r));
  }
  {
    // One level past the accepted fringe.
    const r = checkOuterBand(image(40, 60, BG, [[11, 31, [17, 17, 41]]]), 40, 60, 3, BG, 12);
    check('fringe at 17 levels fails', !r.ok && r.maxDev === 17, JSON.stringify(r));
    check('17-level worst pixel is reported', r.worst && r.worst.x === 11 && r.worst.y === 31 && r.worst.d === 17);
  }
  {
    // A solid bar (an old scrollbar thumb) is far past the fringe.
    const bar = [];
    for (let y = 0; y < 60; y += 1) bar.push([39, y, [120, 120, 120]]);
    const r = checkOuterBand(image(40, 60, BG, bar), 40, 60, 3, BG, 12);
    check('scrollbar-style bar fails with a large maxDev', !r.ok && r.maxDev > 100 && r.deviating === 60, JSON.stringify(r));
  }
  {
    // Pixels inside the band edge do not count: the centre stays unchecked.
    const r = checkOuterBand(image(40, 60, BG, [[20, 30, [255, 255, 255]]]), 40, 60, 3, BG, 12);
    check('centre pixel is outside the band', r.ok && r.maxDev === 0 && r.deviating === 0, JSON.stringify(r));
  }
  {
    // RGBA input reads the same RGB bytes.
    const data = new Uint8Array(40 * 60 * 4);
    for (let i = 0; i < 40 * 60; i += 1) { data[i * 4] = BG[0]; data[i * 4 + 1] = BG[1]; data[i * 4 + 2] = BG[2]; data[i * 4 + 3] = 255; }
    const o = (5 * 40 + 2) * 4;
    data[o] = 17; data[o + 1] = 17; data[o + 2] = 40;
    const r = checkOuterBand(data, 40, 60, 4, BG, 12);
    check('RGBA input: same rule, same result', r.ok && r.maxDev === 16 && r.deviating === 1, JSON.stringify(r));
  }
  {
    // A custom bound is honoured.
    const r = checkOuterBand(image(40, 60, BG, [[11, 31, [17, 17, 40]]]), 40, 60, 3, BG, 12, 8);
    check('tighter bound rejects the same fringe', !r.ok && r.maxDev === 16, JSON.stringify(r));
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
