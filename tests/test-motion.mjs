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
 * ImgFetch, tests/test-motion.mjs
 *
 * Phase 5 Part G motion audit, static checks (no browser needed).
 *
 * Scans every stylesheet (shared/ui.css plus the inline <style> blocks
 * of every HTML page) for the G0/G3 rules: no `transition: all`, no
 * layout property (width, height, top, left, margin, box-shadow) in any
 * transition, animation or keyframe, no hand-written duration or easing
 * (every value is a --duration-* / --ease-* token), exactly one shared
 * prefers-reduced-motion block that neutralises every keyframe, one
 * motion layer with no duplicate keyframes, and the G1 pairing rules.
 * Also checks the JS helpers exist and the components use them.
 *
 * Run: node tests/test-motion.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
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
function has(hay, needle, name) { ok(hay.includes(needle), name); }
function lacks(hay, needle, name) { ok(!hay.includes(needle), name); }

/* ---------- collect every stylesheet ---------- */
const uiCss = read('shared/ui.css');
const uiJs = read('shared/ui.js');
const popupJs = read('popup/popup.js');
const popupHtml = read('popup/popup.html');
const optionsJs = read('options/options.js');
const optionsHtml = read('options/options.html');
const welcomeJs = read('pages/welcome.js');
const welcomeHtml = read('pages/welcome.html');
const annotateHtml = read('pages/annotate.html');
const historyUiJs = read('shared/history-ui.js');
const partsJs = read('pages/parts.js');
const annotateJs = read('pages/annotate.js');

function styleBlocks(html) {
  const out = [];
  const re = /<style>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}
const cssSources = [
  ['shared/ui.css', uiCss],
  ['popup/popup.html', styleBlocks(popupHtml).join('\n')],
  ['options/options.html', styleBlocks(optionsHtml).join('\n')],
  ['pages/welcome.html', styleBlocks(welcomeHtml).join('\n')],
  ['pages/annotate.html', styleBlocks(annotateHtml).join('\n')],
];
const allCss = cssSources.map(([, css]) => css).join('\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const cssNoComments = stripComments(allCss);

/* ---------- G1: token scale ---------- */
const tokenDefs = {
  '--duration-stagger': '40ms',
  '--duration-micro': '80ms',
  '--duration-quick': '150ms',
  '--duration-fast': '250ms',
  '--duration-medium': '350ms',
  '--duration-slow': '400ms',
  '--duration-very-slow': '500ms',
  '--duration-spin': '800ms',
  '--duration-shimmer': '1500ms',
  '--duration-scan': '1600ms',
  '--duration-pulse': '1000ms',
};
for (const [name, value] of Object.entries(tokenDefs)) {
  has(uiCss, `${name}: ${value};`, `G1 token ${name} is ${value}`);
}
const easeDefs = {
  '--ease-smooth-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
  '--ease-in-out': 'ease-in-out',
  '--ease-out': 'ease-out',
  '--ease-linear': 'linear',
  '--ease-bounce': 'cubic-bezier(0.34, 1.36, 0.64, 1)',
};
for (const [name, value] of Object.entries(easeDefs)) {
  has(uiCss, `${name}: ${value};`, `G1 easing ${name} is ${value}`);
}
for (const name of ['--motion-distance-text', '--motion-distance-shake', '--motion-distance-page', '--motion-distance-reveal', '--motion-distance-celebrate']) {
  has(uiCss, `${name}:`, `G1 distance token ${name} exists`);
}
for (const name of ['--motion-scale-modal', '--motion-scale-dropdown-open', '--motion-scale-tooltip', '--motion-scale-dropdown-close']) {
  has(uiCss, `${name}:`, `G1 scale token ${name} exists`);
}
for (const name of ['--motion-blur-small', '--motion-blur-page']) {
  has(uiCss, `${name}:`, `G1 blur token ${name} exists`);
}
/* Reconciliation: the Phase 4 --dur-* / --ease names survive only as
   aliases that point at the canonical tokens, never as a second scale. */
const aliasDefs = {
  '--dur-stagger': '--duration-stagger',
  '--dur-micro': '--duration-micro',
  '--dur-quick': '--duration-quick',
  '--dur-fast': '--duration-fast',
  '--dur-medium': '--duration-medium',
  '--dur-slow': '--duration-slow',
  '--dur-vslow': '--duration-very-slow',
  '--dur': '--duration-quick',
  '--ease': '--ease-smooth-out',
  '--ease-overshoot': '--ease-bounce',
};
for (const [alias, canon] of Object.entries(aliasDefs)) {
  has(uiCss, `${alias}: var(${canon});`, `G1 legacy alias ${alias} points at ${canon}`);
}
/* In the files Part G owns, no --dur-* use survives outside the alias
   definitions themselves (comments stripped first). annotate.html is
   outside Part G ownership; its --dur- uses still resolve through the
   aliases, which the next check documents. */
for (const [label, text] of [['shared/ui.css', uiCss], ['popup/popup.html', popupHtml], ['options/options.html', optionsHtml], ['pages/welcome.html', welcomeHtml]]) {
  const clean = stripComments(text);
  const uses = clean.split('\n').filter((line) => line.includes('--dur-') && !/--dur-[a-z]+:\s*var\(--duration-/.test(line));
  ok(uses.length === 0, `G1 ${label} has no --dur- use outside alias definitions`, uses.join(' | ').slice(0, 200));
}
has(annotateHtml, '--dur-quick', 'G1 annotate.html still uses the --dur- alias (out of Part G scope, covered)');
lacks(cssNoComments, 'var(--ease-overshoot)', 'G1 no var(--ease-overshoot) use remains (renamed to --ease-bounce)');

/* ---------- G0/G3: forbidden properties ---------- */
const FORBIDDEN = ['width', 'height', 'top', 'left', 'margin', 'box-shadow'];
function declarationsOf(css, prop) {
  const out = [];
  const re = new RegExp(`${prop}\\s*:\\s*([^;{}]+);`, 'g');
  let m;
  while ((m = re.exec(css)) !== null) out.push(m[1]);
  return out;
}
for (const [label, css] of cssSources) {
  const clean = stripComments(css);
  lacks(clean, 'transition: all', `G0 ${label} has no transition: all`);
  lacks(clean, 'transition:all', `G0 ${label} has no transition:all`);
  /* Rule-aware: box-shadow is forbidden on large areas, but a 3 px
     focus ring is not a large area, so :focus rules and the dropdown
     expanded state (which shows the same ring) may transition it. */
  const rules = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of rules) {
    for (const value of [...declarationsOf(body, 'transition'), ...declarationsOf(body, 'animation')]) {
      for (const bad of FORBIDDEN) {
        if (bad === 'box-shadow' && /:focus|aria-expanded/.test(selector)) continue;
        ok(!new RegExp(`\\b${bad}\\b`).test(value), `G0 ${label} no ${bad} in transition/animation (${value.slice(0, 80)})`);
      }
    }
  }
}
/* Keyframe bodies: only opacity, transform, filter (blur, page swaps
   only) and stroke-dashoffset may animate. */
function keyframeBlocks(css) {
  const blocks = [];
  const re = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return blocks;
}
const keyframes = keyframeBlocks(cssNoComments);
for (const { name, body } of keyframes) {
  const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
  for (const prop of props) {
    if (prop === 'filter') {
      ok(name === 'sx-page-in-fwd' || name === 'sx-page-in-back', `G0 filter blur only in page swaps (found in ${name})`);
    } else {
      ok(!FORBIDDEN.includes(prop), `G0 keyframe ${name} does not animate ${prop}`);
    }
  }
}
/* No keyframe is defined twice, none of the removed duplicates remain,
   and every defined keyframe is actually used. */
const keyframeNames = keyframes.map((k) => k.name);
for (const name of ['sx-pane-in', 'sx-grid-in', 'sx-fade', 'section-in']) {
  ok(!keyframeNames.includes(name), `G4 removed duplicate keyframe ${name} is gone`);
}
const dupes = keyframeNames.filter((n, i) => keyframeNames.indexOf(n) !== i);
ok(dupes.length === 0, 'G4 no keyframe is defined twice', dupes.join(', '));
for (const name of new Set(keyframeNames)) {
  ok(new RegExp(`animation[^;]*\\b${name}\\b`).test(cssNoComments), `G4 keyframe ${name} is used`);
}
/* No scrollbar animation anywhere. */
for (const [label, css] of cssSources) {
  const clean = stripComments(css);
  const scrollRules = [...clean.matchAll(/::-webkit-scrollbar[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  for (const rule of scrollRules) {
    ok(!/transition|animation/.test(rule), `G3 ${label} no animation on scrollbars`);
  }
}
/* will-change only during an animation: only motion utility selectors. */
for (const [label, css] of cssSources) {
  const clean = stripComments(css);
  const rules = [...clean.matchAll(/([^{}]+)\{([^{}]*will-change[^{}]*)\}/g)];
  for (const [, selector] of rules) {
    ok(/motion-|segmented/.test(selector), `G4 ${label} will-change only on motion utilities (${selector.trim().slice(0, 60)})`);
  }
}

/* ---------- every duration and easing is a token ---------- */
function rootBlock(css) {
  const start = css.indexOf(':root {');
  if (start < 0) return '';
  let depth = 0;
  let i = start;
  while (i < css.length) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start, i + 1); }
    i += 1;
  }
  return '';
}
const cssSansRoot = cssNoComments.replace(rootBlock(cssNoComments), '');
const cssSansVars = cssSansRoot.replace(/var\(--[a-z0-9-]+\)/g, '');
const literalDurations = [...cssSansVars.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)];
const badDurations = literalDurations.filter((m) => !(Number(m[1]) === 0 || Number(m[1]) === 0.01));
ok(badDurations.length === 0, 'G1 every duration is a token (only 0 and the 0.01ms reduced-motion override are literal)', badDurations.map((m) => m[0]).join(', '));
/* Bare easings are only meaningful inside transition/animation values
   (linear-gradient is a background function, not an easing). */
const motionValues = [];
for (const [, css] of cssSources) {
  const clean = stripComments(css);
  const rules = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, , body] of rules) {
    motionValues.push(...declarationsOf(body, 'transition'), ...declarationsOf(body, 'animation'));
  }
}
const motionValuesSansVars = motionValues.join('; ').replace(/var\(--[a-z0-9-]+\)/g, '');
ok(!/cubic-bezier\(/.test(motionValuesSansVars), 'G1 no hand-written cubic-bezier outside the token definitions');
ok(!/\bease-in-out\b/.test(motionValuesSansVars), 'G1 no bare ease-in-out outside tokens');
ok(!/\bease-out\b/.test(motionValuesSansVars), 'G1 no bare ease-out outside tokens');
ok(!/\blinear\b/.test(motionValuesSansVars), 'G1 no bare linear outside tokens');

/* ---------- reduced motion: ONE shared rule ---------- */
const reducedBlocks = [...uiCss.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)];
ok(reducedBlocks.length === 1, 'G0 exactly one reduced-motion block in shared/ui.css', `found ${reducedBlocks.length}`);
for (const [label, css] of cssSources.slice(1)) {
  ok(!/@media \(prefers-reduced-motion: reduce\)/.test(stripComments(css)), `G0 ${label} has no per-component reduced-motion block`);
}
function mediaBlock(css, query) {
  const start = css.indexOf(query);
  if (start < 0) return '';
  const brace = css.indexOf('{', start);
  let depth = 0;
  let i = brace;
  while (i < css.length) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(brace + 1, i); }
    i += 1;
  }
  return '';
}
const reduced = mediaBlock(uiCss, '@media (prefers-reduced-motion: reduce)');
has(reduced, 'animation-duration: 0.01ms', 'G0 reduced motion collapses animation durations');
has(reduced, 'animation-iteration-count: 1', 'G0 reduced motion stops infinite loops');
has(reduced, 'transition-duration: 0.01ms', 'G0 reduced motion collapses transition durations');
has(reduced, '*, *::before, *::after', 'G0 reduced motion covers every element');
for (const sel of ['.scan-line', '.spinner', '.skeleton', '.progress.indeterminate', '.q-active', '.check-draw', '.motion-page-in-fwd', '.motion-stagger', '.toast', '.motion-indicator']) {
  has(reduced, sel, `G0 reduced motion neutralises ${sel}`);
}
has(reduced, '.progress.indeterminate > i { transform: none; width: 100%; }', 'G0 reduced motion restores the indeterminate bar to its resting state');

/* ---------- G4: one shared motion layer ---------- */
for (const cls of ['.motion-page-in-fwd', '.motion-page-in-back', '.motion-pop', '.motion-stagger', '.motion-text-swap', '.motion-fade-in', '.motion-fade-out', '.motion-hero-in', '.motion-indicator']) {
  has(uiCss, cls, `G4 utility class ${cls} exists`);
}
lacks(uiCss, '.pane-anim {', 'G4 .pane-anim no longer carries its own animation');
has(uiCss, 'animation-name: sx-page-in-back', 'G4 RTL mirrors the forward slide');
has(uiCss, 'animation-name: sx-page-in-fwd', 'G4 RTL mirrors the back slide');
const helpers = ['prefersReducedMotion', 'motionDurationMs', 'runViewTransition', 'stagger', 'swapText', 'fadeIn', 'setVisibleAnimated', 'showSuccessCheck', 'toastError', 'initSlidingIndicators', 'dismissToast'];
for (const name of helpers) {
  has(uiJs, `function ${name}(`, `G4 helper ${name} exists in shared/ui.js`);
  has(uiJs, `${name},`, `G4 helper ${name} is exported on ImgFetchUI`);
}
/* Pairing rules (G1): open 250 / close 150, toast in 250 / out 350. */
const dropdownOpen = /\.if-dropdown-list\.is-open \{[^}]*\}/s.exec(uiCss);
ok(dropdownOpen && dropdownOpen[0].includes('var(--duration-fast)'), 'G1 dropdown opens in 250 ms');
const dropdownBase = /\.if-dropdown-list \{[^}]*\}/s.exec(uiCss);
ok(dropdownBase && dropdownBase[0].includes('var(--duration-quick)'), 'G1 dropdown closes in 150 ms');
ok(dropdownBase && dropdownBase[0].includes('var(--motion-scale-dropdown-open)'), 'G1 dropdown opens at the 0.97 scale');
const dialogOpen = /\.modal, \.confirm-dialog \{[^}]*\}/s.exec(uiCss);
ok(dialogOpen && dialogOpen[0].includes('var(--duration-fast)') && dialogOpen[0].includes('var(--ease-bounce)'), 'G1 dialog opens in 250 ms with bounce');
has(uiCss, '.toast.is-leaving { animation: sx-toast-out var(--duration-medium)', 'G1 toast exits in 350 ms');
has(uiCss, '.check-draw { stroke-dasharray: 24; animation: sx-check-draw var(--duration-very-slow)', 'G1 check draw is 500 ms');
has(uiCss, 'animation-delay: calc(var(--i, 0) * var(--duration-stagger))', 'G1 stagger is 40 ms per item');
has(uiCss, 'input.switch::after', 'G1 switch knob rule exists');
const knob = /input\.switch::after \{[^}]*\}/s.exec(uiCss);
ok(knob && knob[0].includes('var(--duration-fast)'), 'G1 switch knob slides in 250 ms');
const track = /input\.switch \{[^}]*\}/s.exec(uiCss);
ok(track && track[0].includes('var(--duration-quick)'), 'G1 switch track crossfades in 150 ms');
has(uiCss, '.hist-thumb.is-loaded { opacity: 1; }', 'G2 history thumbnails fade in on load');

/* ---------- components use the shared layer ---------- */
has(popupJs, 'UI.runViewTransition', 'G2 popup view changes use runViewTransition');
has(popupJs, "UI.stagger(list, '.hist-item', 8)", 'G2 popup history staggers the first 8 rows');
has(popupJs, 'i < 8', 'G2 popup grid staggers the first 8 tiles only');
has(popupJs, 'motion-stagger', 'G2 popup grid uses the shared stagger class');
has(popupJs, 'UI.showSuccessCheck', 'G2 download button shows the success check draw');
has(popupJs, 'UI.toastError', 'G2 popup errors use the shaking error toast');
has(optionsJs, 'UI.runViewTransition', 'G2 options sections use runViewTransition');
has(optionsJs, "UI.stagger(list, '.hist-item', 8)", 'G2 options history staggers the first 8 rows');
has(optionsJs, 'UI.setVisibleAnimated', 'G2 options search fades filter results');
has(optionsJs, 'UI.swapText', 'G2 options save pill swaps text');
has(welcomeJs, 'UI.runViewTransition', 'G2 welcome steps use runViewTransition');
has(partsJs, "UI.stagger(list, '.part-card', 8)", 'G2 parts cards stagger the first 8');
has(annotateJs, 'UI.showSuccessCheck', 'G2 editor Save shows the success check draw');
has(historyUiJs, 'revealThumb', 'G2 history thumbnails fade in via revealThumb');
has(historyUiJs, 'is-loaded', 'G2 history thumbnails get .is-loaded on load');
has(historyUiJs, 'motion-fade-out', 'G2 history rows fade out together on Clear');
has(historyUiJs, 'swapText', 'G2 Clear to Confirm Clear swaps text through deps.swapText');
has(popupHtml, 'has-pill', 'G2 popup nav pill has its has-pill fallback rules');
has(optionsHtml, 'has-pill', 'G2 options sidebar pill has its has-pill fallback rule');

console.log(`test-motion: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
