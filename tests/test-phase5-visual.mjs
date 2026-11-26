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
 * ImgFetch, tests/test-phase5-visual.mjs
 *
 * Phase 5 visual items A1 to A8, static checks plus the shared custom
 * dropdown (A7) exercised against a minimal DOM stub (no jsdom).
 * The real-browser proof (pixel tests, locales, screenshots) lives in
 * the Phase 5 visual report; this suite guards the regressions that a
 * static check can catch: glow removal, caret and focus rules,
 * inline hero art, the fixed-height welcome stage, the shortcuts
 * grid, reserved selected-total space, sentence-case sidebar labels,
 * editor scrollbar gutter, and dropdown open/choose/keyboard/sync.
 *
 * Run: node tests/test-phase5-visual.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const read = (rel) => readFileSync(join(PROJ, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(cond, name, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` (${detail})` : ''}`);
  }
}
function show(v) {
  try { return JSON.stringify(v); } catch { return Object.prototype.toString.call(v); }
}
function eq(actual, want, name) {
  ok(actual === want, `${name} (got ${show(actual)}, want ${show(want)})`);
}
function has(hay, needle, name) { ok(hay.includes(needle), name); }
function lacks(hay, needle, name) { ok(!hay.includes(needle), name); }

/* ---------- static checks ---------- */

const uiCss = read('shared/ui.css');
const uiJs = read('shared/ui.js');
const popupHtml = read('popup/popup.html');
const popupJs = read('popup/popup.js');
const optionsHtml = read('options/options.html');
const optionsJs = read('options/options.js');
const welcomeHtml = read('pages/welcome.html');
const annotateHtml = read('pages/annotate.html');
const captureHtml = read('pages/capture.html');
const infoHtml = read('pages/info.html');
const partsHtml = read('pages/parts.html');
const renameHtml = read('pages/rename.html');
const brandSvg = read('shared/assets/brand-mark.svg');

// A3: no page-background glow anywhere. The body must carry no
// background-image; the privacy hero must be flat, not a gradient.
ok(!/body\s*{[^}]*background-image:/s.test(uiCss), 'A3 ui.css body has no background-image glow');
has(uiCss, 'no background glow', 'A3 ui.css documents the glow removal');
ok(!/\.privacy-hero\s*{[^}]*linear-gradient/s.test(optionsHtml), 'A3 privacy hero has no linear gradient');
has(optionsHtml, 'background: var(--accent-soft);', 'A3 privacy hero is a flat accent tint');

// A6: one shared text-input treatment: accent caret, full line height,
// accent border plus soft ring on focus, 150 ms transitions.
has(uiCss, 'caret-color: var(--accent);', 'A6 caret-color is the accent');
has(uiCss, 'input[type="text"], input[type="number"], textarea {\n  caret-color: var(--accent);', 'A6 caret rule covers every text input');
ok(/input\[type="text"\]:focus-visible[^{]*{[^}]*border-color: var\(--accent\);[^}]*box-shadow: 0 0 0 3px var\(--accent-soft\);/s.test(uiCss), 'A6 text focus is accent border plus soft ring');
has(optionsHtml, '.side-search:focus-within { border-color: var(--accent);', 'A6 search box focus border is the accent');
has(optionsHtml, '.side-search:focus-within .keycap { opacity: 0; }', 'A6 "/" hint fades out while the search box is focused');
has(optionsHtml, 'line-height: 1.5; padding: 0 2px;', 'A6 search input keeps full line height past the font shorthand');

// A1: popup document never scrolls and main shows no scrollbar chrome.
has(popupHtml, 'html, body { width: 400px; height: 560px; overflow: hidden; }', 'A1 popup html/body are fixed 400x560 with overflow hidden');
has(popupHtml, 'scrollbar-width: none;', 'A1 popup main shows no scrollbar chrome');
has(popupHtml, '.grid-wrap { margin: 4px 0; }', 'A1 grid no longer offsets for a scrollbar that is gone');

// A2: hero art is pure inline vector, no raster img, no object-fit cover.
lacks(popupHtml, 'hero-g1.svg', 'A2 popup has no hero raster img reference (g1)');
lacks(popupHtml, 'hero-g2.svg', 'A2 popup has no hero raster img reference (g2)');
lacks(popupHtml, 'hero-g4.svg', 'A2 popup has no hero raster img reference (g4)');
has(popupHtml, '<symbol id="hero-g1"', 'A2 hero g1 is an inline symbol');
has(popupHtml, '<symbol id="hero-g2"', 'A2 hero g2 is an inline symbol');
has(popupHtml, '<symbol id="hero-g4"', 'A2 hero g4 is an inline symbol');
eq((popupHtml.match(/<use href="#hero-g[124]"[^>]*\/>/g) || []).length, 6, 'A2 both hero stacks instantiate the three symbols');
lacks(popupHtml, '<image', 'A2 inline hero art embeds no raster image');
ok(!/\.hero-art \{[^}]*object-fit/s.test(popupHtml), 'A2 hero art has no object-fit resampling');
// The canonical SVG files stay pure vector too.
for (const g of ['hero-g1.svg', 'hero-g2.svg', 'hero-g4.svg']) {
  const svg = read(`shared/assets/${g}`);
  lacks(svg, '<image', `A2 ${g} embeds no raster image`);
  lacks(svg, '<filter', `A2 ${g} uses no filter`);
}

// A4: welcome steps share one grid cell; the stage takes the tallest step.
has(welcomeHtml, '.step-stage { display: grid; }', 'A4 welcome has a grid step stage');
has(welcomeHtml, '.step-stage .step { grid-area: 1 / 1; visibility: hidden; }', 'A4 inactive steps still size the grid cell');
has(welcomeHtml, '<div class="step-stage">', 'A4 steps are wrapped in the stage');

// A5: shortcuts are a two-column grid driven by the longest label.
has(optionsHtml, 'grid-template-columns: var(--kb-label-w, 220px) auto;', 'A5 shortcut rows are a two-column grid');
has(optionsJs, "'kb-row-label'", 'A5 shortcut labels use the grid label class');
lacks(optionsJs, "'kb-label'", 'A5 the old unstyled kb-label class is gone');
has(optionsJs, 'sizeShortcutLabels(list);', 'A5 longest label is measured after rendering');

// A7: one shared dropdown component exists and is wired in both pages.
for (const fn of ['createDropdown', 'initDropdowns', 'destroyDropdowns', 'syncDropdown', 'refreshDropdown', 'refreshDropdowns']) {
  has(uiJs, `function ${fn}`, `A7 shared/ui.js defines ${fn}`);
  has(uiJs, `    ${fn},`, `A7 shared/ui.js exports ${fn}`);
}
has(uiCss, '.if-dropdown-btn', 'A7 dropdown button styles exist');
has(uiCss, '.if-dropdown-list.is-open', 'A7 dropdown open styles exist');
has(uiCss, '.if-dropdown-option[aria-selected="true"]', 'A7 selected row styles exist');
has(popupJs, 'UI.initDropdowns(document);', 'A7 popup initialises the shared dropdowns');
has(optionsJs, 'UI.initDropdowns(document);', 'A7 options initialises the shared dropdowns');
has(optionsJs, 'UI.destroyDropdowns(list);', 'A7 site list tears down dropdowns before re-rendering');
has(popupJs, 'UI.syncDropdown(orient);', 'A7 popup syncs the orientation dropdown after a programmatic reset');
has(optionsJs, 'UI.syncDropdown(select);', 'A7 options syncs the nav dropdown after a programmatic reset');

// A8: selected-total reserves its space; editor reserves the gutter;
// sidebar labels are sentence case in the affected locales.
has(popupHtml, '.res-selected-size { font-size: 12.5px; color: var(--muted); padding: 10px 2px 0; font-variant-numeric: tabular-nums; height: 29px;', 'A8 selected-total line has a fixed height');
lacks(popupHtml, '.res-selected-size[hidden]', 'A8 selected-total line has no hidden rule');
lacks(popupJs, 'el.hidden = true', 'A8 popup.js never hides the selected-total line');
lacks(popupJs, 'el.hidden = false', 'A8 popup.js never unhides the selected-total line');
has(annotateHtml, 'html { scrollbar-gutter: stable; }', 'A8 editor reserves the scrollbar gutter');
const en = JSON.parse(read('_locales/en/messages.json'));
eq(en.options_secFilenames.message, 'File names', 'A8 en sidebar File names is sentence case');
eq(en.options_secSites.message, 'Site preferences', 'A8 en sidebar Site preferences is sentence case');
eq(en.options_secHistory.message, 'Download history', 'A8 en sidebar Download history is sentence case');
eq(en.options_secBackup.message, 'Backup & reset', 'A8 en sidebar Backup & reset is sentence case');
const id = JSON.parse(read('_locales/id/messages.json'));
eq(id.options_secFilenames.message, 'Nama file', 'A8 id sidebar Nama file is sentence case');
eq(id.options_secSites.message, 'Preferensi situs', 'A8 id sidebar Preferensi situs is sentence case');
eq(id.options_secHistory.message, 'Riwayat unduhan', 'A8 id sidebar Riwayat unduhan is sentence case');
eq(id.options_secBackup.message, 'Cadangan dan atur ulang', 'A8 id sidebar Cadangan dan atur ulang is sentence case');
eq(id.options_secScreenshots.message, 'Tangkapan layar', 'A8 id sidebar Tangkapan layar is sentence case');
const tr = JSON.parse(read('_locales/tr/messages.json'));
eq(tr.options_secFilenames.message, 'Dosya adları', 'A8 tr sidebar Dosya adları is sentence case');
eq(tr.options_secSites.message, 'Site tercihleri', 'A8 tr sidebar Site tercihleri is sentence case');
eq(tr.options_secHistory.message, 'İndirme geçmişi', 'A8 tr sidebar İndirme geçmişi is sentence case');
eq(tr.options_secBackup.message, 'Yedekleme ve sıfırlama', 'A8 tr sidebar Yedekleme ve sıfırlama is sentence case');
eq(tr.options_secScreenshots.message, 'Ekran görüntüleri', 'A8 tr sidebar Ekran görüntüleri is sentence case');
const vi = JSON.parse(read('_locales/vi/messages.json'));
eq(vi.options_secFilenames.message, 'Tên tệp', 'A8 vi sidebar Tên tệp is sentence case');
eq(vi.options_secHistory.message, 'Lịch sử tải xuống', 'A8 vi sidebar Lịch sử tải xuống is sentence case');
eq(vi.options_secBackup.message, 'Sao lưu và đặt lại', 'A8 vi sidebar Sao lưu và đặt lại is sentence case');
const de = JSON.parse(read('_locales/de/messages.json'));
eq(de.options_secBackup.message, 'Sichern & Zurücksetzen', 'A8 de keeps capitalised nouns (German rule)');

// Phase 7 item 1: hero stack is no longer clipped. Both stacks carry the
// enlarged viewBox, and every rotated card (and its shadow ellipse) lies
// fully inside that viewBox with at least 1 unit margin on all sides.
const stackTags = [...popupHtml.matchAll(/<svg class="hero-stack-svg"[^>]*>/g)].map((m) => m[0]);
eq(stackTags.length, 2, 'P7 both hero stacks are present');
for (const tag of stackTags) {
  has(tag, 'viewBox="-6 -3 162 90"', 'P7 hero stack viewBox is -6 -3 162 90');
  has(tag, 'width="162"', 'P7 hero stack width is 162');
  has(tag, 'height="90"', 'P7 hero stack height is 90');
  has(tag, 'overflow="visible"', 'P7 hero stack overflow is visible');
}
lacks(popupHtml, 'viewBox="0 0 150 84"', 'P7 old hero viewBox is gone');
has(popupHtml, '.hero-stack-svg { display: block; width: 162px; height: 90px; overflow: visible; }', 'P7 hero stack CSS is 162 by 90 with overflow visible');
const vb = stackTags[0].match(/viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/);
ok(vb, 'P7 hero viewBox parses');
const vbX = Number(vb[1]);
const vbY = Number(vb[2]);
const vbW = Number(vb[3]);
const vbH = Number(vb[4]);
// Rotated bounding box of a rect about its rotation centre.
function rotatedRectBox(x, y, w, h, deg, cx, cy) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => {
    const dx = px - cx;
    const dy = py - cy;
    return [cx + dx * c + dy * s, cy - dx * s + dy * c];
  });
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
// Rotated bounding box of an ellipse about its group rotation centre.
function rotatedEllipseBox(cx, cy, rx, ry, deg, rcx, rcy) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = cx - rcx;
  const dy = cy - rcy;
  const ccx = rcx + dx * c + dy * s;
  const ccy = rcy - dx * s + dy * c;
  const hx = Math.sqrt((rx * c) ** 2 + (ry * s) ** 2);
  const hy = Math.sqrt((rx * s) ** 2 + (ry * c) ** 2);
  return [ccx - hx, ccy - hy, ccx + hx, ccy + hy];
}
function insideViewBox(box, name) {
  const [x0, y0, x1, y1] = box;
  const m = Math.min(x0 - vbX, vbX + vbW - x1, y0 - vbY, vbY + vbH - y1);
  ok(m >= 1, `${name} lies inside the viewBox with at least 1 unit margin (min margin ${m.toFixed(2)})`);
}
const rotations = [...popupHtml.matchAll(/rotate\((-?\d+) (\d+) (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
eq(rotations.length, 4, 'P7 four card rotations are present (two per stack)');
const cardRects = [...popupHtml.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="9" fill="none"/g)].map((m) => m.slice(1).map(Number));
eq(cardRects.length, 6, 'P7 six card rects are present (three per stack)');
const cardNames = ['left card', 'right card', 'centre card'];
for (let s = 0; s < 2; s += 1) {
  for (let i = 0; i < 3; i += 1) {
    const [x, y, w, h] = cardRects[s * 3 + i];
    if (i === 2) {
      insideViewBox(rotatedRectBox(x, y, w, h, 0, x + w / 2, y + h / 2), `P7 stack ${s + 1} ${cardNames[i]}`);
    } else {
      const [deg, cx, cy] = rotations[s * 2 + i];
      insideViewBox(rotatedRectBox(x, y, w, h, deg, cx, cy), `P7 stack ${s + 1} ${cardNames[i]}`);
    }
  }
}
const shadows = [...popupHtml.matchAll(/<ellipse cx="(\d+)" cy="(\d+)" rx="(\d+)" ry="(\d+)" fill="url\(#hero-shadow-[ab]\)"\/>/g)].map((m) => m.slice(1).map(Number));
eq(shadows.length, 6, 'P7 six card shadow ellipses are present (three per stack)');
for (let s = 0; s < 2; s += 1) {
  for (let i = 0; i < 3; i += 1) {
    const [cx, cy, rx, ry] = shadows[s * 3 + i];
    if (i === 2) {
      insideViewBox(rotatedEllipseBox(cx, cy, rx, ry, 0, cx, cy), `P7 stack ${s + 1} ${cardNames[i]} shadow`);
    } else {
      const [deg, rcx, rcy] = rotations[s * 2 + i];
      insideViewBox(rotatedEllipseBox(cx, cy, rx, ry, deg, rcx, rcy), `P7 stack ${s + 1} ${cardNames[i]} shadow`);
    }
  }
}

// Phase 7 item 2: new logo, no glow. The shared rule paints nothing of its
// own, the SVG owns its shape, and every page rule agrees.
const brandRule = uiCss.match(/\.brand-mark \{[^}]*\}/);
ok(brandRule, 'P7 shared .brand-mark rule exists');
has(brandRule[0], 'background: none;', 'P7 shared brand mark has no background');
has(brandRule[0], 'box-shadow: none;', 'P7 shared brand mark has no box-shadow');
has(brandRule[0], 'filter: none;', 'P7 shared brand mark has no filter');
has(brandRule[0], 'border-radius: 0;', 'P7 shared brand mark has no border-radius');
lacks(brandRule[0], 'linear-gradient', 'P7 shared brand mark has no gradient');
lacks(brandRule[0], '0 3px 10px', 'P7 shared brand mark has no glow shadow');
lacks(brandRule[0], 'inline-flex', 'P7 shared brand mark is not the old letter mark');
has(brandSvg, 'id="bm-bg"', 'P7 new brand mark uses the bm- gradient id');
has(brandSvg, 'id="bm-halo"', 'P7 new brand mark keeps the sun halo inside the tile');
lacks(brandSvg, 'brand-grad', 'P7 old brand gradient id is gone');
has(brandSvg, 'rx="30"', 'P7 new brand mark tile uses the SVG squircle corners');
has(brandSvg, 'viewBox="0 0 128 128"', 'P7 new brand mark is a 128 square');
has(popupHtml, '.topbar .brand-mark { width: 28px; height: 28px; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 popup header logo has no glow');
has(optionsHtml, '.side-brand .brand-mark { width: 32px; height: 32px; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 options sidebar logo has no glow');
has(optionsHtml, '.about-logo { width: 64px; height: 64px; flex: none; display: block; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 About logo has no glow');
has(welcomeHtml, '.welcome-mark { width: 72px; height: 72px; flex: none; display: block; background: none; box-shadow: none; filter: none; border-radius: 0; margin: 0 auto 18px; }', 'P7 welcome logo has no glow');
has(annotateHtml, '.annotate-top .brand-mark { width: 28px; height: 28px; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 annotate logo has no glow');
has(captureHtml, '.brand-mark { width: 40px; height: 40px; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 capture logo has no glow');
has(infoHtml, '.brand-mark { width: 40px; height: 40px; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 info logo has no glow');
has(partsHtml, '.parts-header .brand-mark { width: 40px; height: 40px; flex: none; display: block; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 parts logo has no glow');
has(renameHtml, '.brand-mark { width: 40px; height: 40px; background: none; box-shadow: none; filter: none; border-radius: 0; }', 'P7 rename logo has no glow');
const logoPages = [popupHtml, optionsHtml, welcomeHtml, annotateHtml, captureHtml, infoHtml, partsHtml, renameHtml];
eq(logoPages.reduce((n, html) => n + (html.match(/<img class="[^"]*brand-mark[^"]*" src="\.\.\/shared\/assets\/brand-mark\.svg"/g) || []).length, 0)
  + (optionsHtml.match(/<img class="about-logo" src="\.\.\/shared\/assets\/brand-mark\.svg"/g) || []).length,
  9, 'P7 nine logo images load the brand mark by img src');
ok(!/id="bm-/.test(popupHtml + optionsHtml + welcomeHtml), 'P7 the mark is never inlined, so no page risks duplicate bm- ids');

// Phase 7 item 2b, fixed: popup home vertical spacing. One flex column,
// five equal flexible gaps: the four group gaps plus equal outer padding
// top and bottom. A fixed gap cannot fit every locale because the title
// block height varies (52.73 en, 71.58 fr, 103.47 de, measured in the
// real popup), so five flex-grow spacers share the leftover height and
// the gaps shrink in de and fr while staying equal within each combo.
// The spacer bases (12 top, 16 middle, 0 bottom) absorb the uneven main
// padding (4 top, 16 bottom) so every measured gap equals the same G.
const heroRule = popupHtml.match(/\.hero \{[^}]*\}/);
ok(heroRule, 'P7 .hero rule exists');
lacks(heroRule[0], 'gap:', 'P7 home column carries no fixed gap');
lacks(heroRule[0], 'padding-top:', 'P7 home column carries no top padding');
lacks(heroRule[0], 'space-between', 'P7 home column does not use space-between');
lacks(heroRule[0], '31.5px', 'P7 home column no longer pins the old 31.5 px gap');
lacks(popupHtml, 'padding-top: 27.5px;', 'P7 old 27.5 px column top padding is gone');
const heroGapRule = popupHtml.match(/\.hero-gap \{[^}]*\}/);
ok(heroGapRule, 'P7 .hero-gap rule exists');
has(heroGapRule[0], 'flex: 1 1 16px;', 'P7 spacers grow equally from a 16 px basis');
has(heroGapRule[0], 'min-height: 0;', 'P7 spacers may shrink to nothing');
has(popupHtml, '.hero-gap-top { flex-basis: 12px; }', 'P7 top spacer basis is 12 px');
has(popupHtml, '.hero-gap-bottom { flex-basis: 0; }', 'P7 bottom spacer basis is 0 px');
has(popupHtml, '<div class="hero-title-block">', 'P7 title and subtitle share one block');
has(popupHtml, '<div class="hero-capture-block">', 'P7 CAPTURE label and tiles share one block');
ok(/<div class="hero-title-block">[\s\S]*?<h1[^>]*>[\s\S]*?<p[^>]*>[\s\S]*?<\/div>/.test(popupHtml), 'P7 title block holds the h1 and the subtitle');
ok(/<div class="hero-capture-block">[\s\S]*?<div class="popup-sec-label"[\s\S]*?<div class="shot-row"[\s\S]*?<\/div>/.test(popupHtml), 'P7 capture block holds the label and the tiles');
has(popupHtml, '.hero h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.45; margin: 0 2px; }', 'P7 hero title carries no top margin');
has(popupHtml, '.hero p { color: var(--muted); font-size: 13px; line-height: 1.45; margin: 0 2px; }', 'P7 hero subtitle carries no top margin');
has(popupHtml, '#btnScan { margin-top: 0;', 'P7 Scan button carries no top margin');
has(popupHtml, '.popup-sec-label { margin: 0 2px 8px;', 'P7 CAPTURE label carries no top margin and an 8 px bottom gap');
has(popupHtml, '.hero-title-block { display: flex; flex-direction: column; gap: 2px; }', 'P7 title to subtitle gap is 2 px');
ok(popupHtml.indexOf('hero-capture-block') < popupHtml.indexOf('id="captureProgress"') && popupHtml.indexOf('id="captureProgress"') < popupHtml.indexOf('id="homeStatus"'), 'P7 capture progress and home status stay inside the capture block');
has(popupHtml, '#captureProgress { margin-top: 14px;', 'P7 capture progress keeps its 14 px gap below the tiles');
eq((popupHtml.match(/<div class="hero-gap/g) || []).length, 5, 'P7 five flexible spacers in the home column');
// Spacers sit before, between and after the four groups, in order.
const heroStart = popupHtml.indexOf('<div class="hero">');
const heroSlice = popupHtml.slice(heroStart, popupHtml.indexOf('</section>', heroStart));
let heroPos = -1;
let heroOrdered = true;
for (const mark of ['<div class="hero-gap hero-gap-top"', '<div class="hero-viewfinder">', '<div class="hero-gap" aria-hidden="true"></div>', '<div class="hero-title-block">', '<div class="hero-gap" aria-hidden="true"></div>', '<button id="btnScan"', '<div class="hero-gap" aria-hidden="true"></div>', '<div class="hero-capture-block">', '<div class="hero-gap hero-gap-bottom"']) {
  const at = heroSlice.indexOf(mark, heroPos + 1);
  if (at < 0) { heroOrdered = false; break; }
  heroPos = at;
}
ok(heroOrdered, 'P7 spacers sit before, between and after the four groups in order');
// The equal-gap model, from geometry measured in the real popup at DPR 1:
// popup 560, topbar 64, main 496, main padding 4 top and 16 bottom, so
// the .hero column is 476 tall and the five measured gaps share 496 less
// the group heights. Spacer bases add to 60 (12 plus 3 times 16 plus 0).
// These checks pin the model, not rendered pixels; the proof worker
// re-measures the real popup in every locale, DPR and theme.
const homeGroups = { en: 168 + 52.73 + 44 + 99.33, ar: 168 + 52.73 + 44 + 99.33, fr: 168 + 71.58 + 44 + 99.33, de: 168 + 103.47 + 44 + 99.33 };
const homeGap = { en: 26.39, ar: 26.39, fr: 22.62, de: 16.24 };
for (const lang of Object.keys(homeGroups)) {
  const groups = homeGroups[lang];
  const g = (496 - groups) / 5;
  const share = (476 - groups - 60) / 5;
  ok(Math.abs(g - homeGap[lang]) < 0.01 && Math.abs(g - (16 + share)) < 0.01 && 12 + share > 0 && share > 0,
    `P7 home equal gap model fits in ${lang} (G ${g.toFixed(2)} px, spacers ${(12 + share).toFixed(2)} / ${(16 + share).toFixed(2)} / ${share.toFixed(2)} px)`);
}

// No em dash, en dash or spaced double hyphen in any file this item touched.
// options/options.html and options/options.js carry a pre-existing en dash
// placeholder in the About version span (baseline, not a Phase 5 addition),
// so the whole-file dash check covers only the files this item owns outright.
for (const rel of ['shared/ui.css', 'shared/ui.js', 'popup/popup.html', 'popup/popup.js', 'pages/welcome.html', 'pages/annotate.html', 'pages/capture.html', 'pages/info.html', 'pages/parts.html', 'pages/rename.html', 'docs/project-structure.md', 'tests/test-phase5-visual.mjs']) {
  const text = read(rel);
  ok(!text.includes('\u2014') && !text.includes('\u2013'), `no em/en dash in ${rel}`);
  // Build the needle from parts so this check itself does not contain it.
  ok(!text.includes(' ' + '--' + ' '), `no spaced double hyphen in ${rel}`);
}
// CRLF: every touched code file keeps CRLF line endings.
for (const rel of ['shared/ui.css', 'shared/ui.js', 'popup/popup.html', 'popup/popup.js', 'options/options.html', 'options/options.js', 'pages/welcome.html', 'pages/annotate.html', 'pages/capture.html', 'pages/info.html', 'pages/parts.html', 'pages/rename.html', 'docs/project-structure.md', 'tests/test-phase5-visual.mjs']) {
  const buf = readFileSync(join(PROJ, rel));
  const lf = (buf.toString('utf8').match(/\n/g) || []).length;
  const crlf = (buf.toString('utf8').match(/\r\n/g) || []).length;
  eq(crlf, lf, `CRLF preserved in ${rel}`);
}

/* ---------- dropdown behaviour against a minimal DOM stub ---------- */

function matches(el, sel) {
  if (!sel) return false;
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.getAttribute('id') === sel.slice(1);
  const dot = sel.indexOf('.');
  if (dot > 0) return el.tagName === sel.slice(0, dot).toUpperCase() && el.classList.contains(sel.slice(dot + 1));
  return el.tagName === sel.toUpperCase();
}
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._cls = new Set();
    this.classList = {
      add: (...c) => { c.forEach((x) => this._cls.add(x)); },
      remove: (...c) => { c.forEach((x) => this._cls.delete(x)); },
      toggle: (c, f) => { if (f === undefined) f = !this._cls.has(c); if (f) this._cls.add(c); else this._cls.delete(c); return f; },
      contains: (c) => this._cls.has(c),
    };
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this._text = '';
    this.listeners = {};
    this.tabIndex = 0;
    this.disabled = false;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); return c; }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) { if (!('target' in ev)) ev.target = this; for (const fn of (this.listeners[ev.type] || [])) fn.call(this, ev); return true; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { x: 0, y: 100, width: 200, height: 32, top: 100, bottom: 132, left: 0, right: 200 }; }
  scrollIntoView() {}
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  focus() { document.activeElement = this; }
  closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
}
class SelectEl extends El {
  constructor() {
    super('select');
    this.options = [];
    this.selectedIndex = -1;
  }
  get value() { const o = this.options[this.selectedIndex]; return o ? o.value : ''; }
  set value(v) { const i = this.options.findIndex((o) => o.value === v); if (i >= 0) this.selectedIndex = i; }
}
class OptionEl extends El {
  constructor(value, label, disabled) {
    super('option');
    this.value = value;
    this.textContent = label;
    this.disabled = !!disabled;
  }
}

const body = new El('body');
const docEl = new El('html');
docEl.appendChild(body);
globalThis.document = {
  body,
  documentElement: docEl,
  activeElement: null,
  createElement: (tag) => (tag === 'select' ? new SelectEl() : new El(tag)),
  createElementNS: (ns, tag) => new El(tag),
  querySelectorAll: (sel) => body.querySelectorAll(sel),
  querySelector: (sel) => body.querySelector(sel),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 900;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

await import('../shared/ui.js');
const UI = globalThis.ImgFetchUI;
ok(UI && typeof UI.createDropdown === 'function', 'A7 ImgFetchUI loads with createDropdown');

function makeSelect() {
  const row = new El('div');
  body.appendChild(row);
  const select = new SelectEl();
  select.setAttribute('id', 'testSelect');
  select.setAttribute('aria-label', 'Test select');
  for (const [v, label, dis] of [['', 'Any orientation', false], ['landscape', 'Landscape', false], ['portrait', 'Portrait', false], ['square', 'Square', true]]) {
    const o = new OptionEl(v, label, dis);
    select.options.push(o);
    select.appendChild(o);
  }
  select.selectedIndex = 0;
  row.appendChild(select);
  return { row, select };
}
function key(target, keyName) {
  target.dispatchEvent({ type: 'keydown', key: keyName, preventDefault: () => {}, ctrlKey: false, metaKey: false, altKey: false });
}
function click(target) { target.dispatchEvent({ type: 'click' }); }

const { row, select } = makeSelect();
let changes = 0;
select.addEventListener('change', () => { changes += 1; });
const inst = UI.createDropdown(select);
ok(inst, 'A7 createDropdown returns an instance');
ok(select.classList.contains('if-native-hidden'), 'A7 native select is visually hidden');
eq(select.tabIndex, -1, 'A7 native select leaves the tab order');
const btn = row.querySelector('.if-dropdown-btn');
ok(btn, 'A7 dropdown button exists');
eq(btn.getAttribute('role'), null, 'A7 button carries no redundant role');
eq(btn.getAttribute('aria-haspopup'), 'listbox', 'A7 button declares a listbox');
eq(btn.getAttribute('aria-expanded'), 'false', 'A7 button starts collapsed');
eq(row.querySelector('.if-dropdown-label').textContent, 'Any orientation', 'A7 button label follows the selected option');
const list = document.querySelector('.if-dropdown-list');
ok(list, 'A7 listbox exists in the document body');
eq(list.getAttribute('role'), 'listbox', 'A7 listbox has the listbox role');
eq(list.children.length, 4, 'A7 listbox has one option per select option');
eq(list.children[0].getAttribute('aria-selected'), 'true', 'A7 selected row is marked selected');
eq(list.children[3].getAttribute('aria-disabled'), 'true', 'A7 disabled option is marked disabled');

// Open with a click, choose with the keyboard.
click(btn);
eq(btn.getAttribute('aria-expanded'), 'true', 'A7 click opens the dropdown');
ok(list.classList.contains('is-open'), 'A7 open list has the is-open class');
key(btn, 'ArrowDown');
key(btn, 'ArrowDown');
key(btn, 'Enter');
eq(select.value, 'portrait', 'A7 ArrowDown twice plus Enter chooses Portrait');
eq(changes, 1, 'A7 choosing dispatches exactly one change event');
eq(btn.getAttribute('aria-expanded'), 'false', 'A7 choosing closes the dropdown');
eq(row.querySelector('.if-dropdown-label').textContent, 'Portrait', 'A7 button label follows the new value');
eq(document.activeElement, btn, 'A7 focus returns to the button after choosing');

// Escape closes and returns focus; typeahead jumps to a match.
click(btn);
key(btn, 'Escape');
eq(btn.getAttribute('aria-expanded'), 'false', 'A7 Escape closes the dropdown');
eq(document.activeElement, btn, 'A7 Escape returns focus to the button');
click(btn);
key(btn, 'p');
eq(btn.getAttribute('aria-activedescendant'), list.children[2].id, 'A7 typeahead p activates Portrait');
key(btn, 'Enter');
eq(select.value, 'portrait', 'A7 typeahead plus Enter chooses Portrait');

// Home and End move to the ends.
click(btn);
key(btn, 'End');
eq(btn.getAttribute('aria-activedescendant'), list.children[3].id, 'A7 End activates the last option');
key(btn, 'Home');
eq(btn.getAttribute('aria-activedescendant'), list.children[0].id, 'A7 Home activates the first option');
key(btn, 'Escape');

// Disabled options cannot be chosen.
click(btn);
const before = select.value;
list.children[3].dispatchEvent({ type: 'click' });
eq(select.value, before, 'A7 clicking a disabled option changes nothing');
key(btn, 'Escape');

// Programmatic value changes sync; label changes rebuild.
select.value = 'landscape';
UI.syncDropdown(select);
eq(row.querySelector('.if-dropdown-label').textContent, 'Landscape', 'A7 syncDropdown follows a programmatic value');
select.options[1].textContent = 'Wide';
UI.refreshDropdown(select);
eq(list.children[1].textContent.includes('Wide'), true, 'A7 refreshDropdown rebuilds option labels');
eq(row.querySelector('.if-dropdown-label').textContent, 'Wide', 'A7 refreshDropdown follows the renamed selected option');

// Idempotent init and teardown.
const again = UI.createDropdown(select);
ok(again === inst, 'A7 creating a dropdown twice returns the same instance');
eq(row.querySelectorAll('.if-dropdown-btn').length, 1, 'A7 second init adds no second button');
UI.destroyDropdowns(row);
eq(document.querySelectorAll('.if-dropdown-list').length, 0, 'A7 destroy removes the listbox');
ok(!select.classList.contains('if-native-hidden'), 'A7 destroy unhides the native select');
eq(select.parentNode, row, 'A7 destroy unwraps the select back into its row');
const reinst = UI.createDropdown(select);
ok(reinst && reinst !== inst, 'A7 a destroyed dropdown can be created again');

console.log(`test-phase5-visual: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
