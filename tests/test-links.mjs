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
 * ImgFetch, tests/test-links.mjs
 *
 * External-link contract (fix 2, section 3a): every link to an http(s) URL
 * in options, popup, welcome, info, capture, annotate and rename (static
 * HTML anchors AND anchors created or updated from JS) must open in a new
 * tab with target="_blank" and rel="noopener noreferrer". Internal links
 * (relative URLs, "#", chrome-extension: URLs, blob: URLs, the GPL header
 * comment URLs) are never flagged, so there are no false positives on
 * internal links.
 *
 * Also pins the repository URL to exactly
 * https://github.com/umr-x/ImgFetch (owner lowercase, repo name capital
 * I and F) and allows only the derived suffixes /blob/main/PRIVACY.md,
 * /blob/main/LICENSE, /issues and /releases.
 *
 * Run: node tests/test-links.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(HERE, '..');

const PAGES = [
  'options/options.html',
  'popup/popup.html',
  'pages/welcome.html',
  'pages/info.html',
  'pages/capture.html',
  'pages/annotate.html',
  'pages/rename.html',
];

const JS_DIRS = ['options', 'popup', 'pages', 'shared'];

const REPO_URL = 'https://github.com/umr-x/ImgFetch';
const ALLOWED_SUFFIXES = new Set([
  '',
  '/blob/main/PRIVACY.md',
  '/blob/main/LICENSE',
  '/issues',
  '/releases',
]);

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

// Strip // and /* */ comments while leaving string literals (which may
// legitimately contain "https://" or "//") intact.
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += d || '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function unquote(s) {
  s = s.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseAttrs(tag) {
  const attrs = Object.create(null);
  const re = /([\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = unquote(m[2]);
  }
  return attrs;
}

function isExternalUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

function hasNewTabAttrs(attrs, where) {
  ok(
    attrs.target === '_blank',
    `${where} has target="_blank"`,
    `target=${JSON.stringify(attrs.target)}`,
  );
  const rel = String(attrs.rel || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  ok(
    rel.includes('noopener') && rel.includes('noreferrer'),
    `${where} has rel="noopener noreferrer"`,
    `rel=${JSON.stringify(attrs.rel)}`,
  );
}

// ---- 1. static HTML anchors -------------------------------------------------
const pageHtml = Object.create(null);
for (const page of PAGES) {
  const html = readFileSync(join(PROJ, page), 'utf8');
  pageHtml[page] = html;
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const tags = noComments.match(/<a\b[^>]*>/gi) || [];
  ok(tags.length >= 0, `${page} scanned for anchors`, `${tags.length} found`);
  for (const tag of tags) {
    const attrs = parseAttrs(tag);
    if (attrs.href && isExternalUrl(attrs.href)) {
      hasNewTabAttrs(attrs, `${page}: static <a href="${attrs.href}">`);
    }
  }
}

// ---- 2. anchors built or updated from JS ------------------------------------
function jsFiles() {
  const files = [];
  for (const dir of JS_DIRS) {
    for (const name of readdirSync(join(PROJ, dir))) {
      if (name.endsWith('.js')) files.push(join(dir, name));
    }
  }
  return files;
}

function htmlForJs(relJs) {
  const dir = relJs.split('/')[0];
  const base = basename(relJs, '.js');
  if (dir === 'options') return 'options/options.html';
  if (dir === 'popup') return 'popup/popup.html';
  if (dir === 'pages') return `pages/${base}.html`;
  return null; // shared/: search every page for the id
}

function findAnchorInHtml(html, id) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const re = new RegExp(`<a\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, 'i');
  const m = noComments.match(re);
  return m ? parseAttrs(m[0]) : null;
}

for (const relJs of jsFiles()) {
  const src = stripJsComments(readFileSync(join(PROJ, relJs), 'utf8'));

  // const NAME = 'https://...': remember https-valued constants so that
  // `x.href = NAME` counts as an external link assignment.
  const httpsConsts = new Map();
  const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])https?:\/\/[^'"]*\2/g;
  let m;
  while ((m = constRe.exec(src))) {
    httpsConsts.set(m[1], unquote(m[0].slice(m[0].indexOf('=') + 1)));
  }
  if (httpsConsts.has('GITHUB_REPO')) {
    ok(
      httpsConsts.get('GITHUB_REPO') === REPO_URL,
      `${relJs}: GITHUB_REPO is exactly ${REPO_URL}`,
      httpsConsts.get('GITHUB_REPO'),
    );
  }

  // Derived repository links: only the approved suffixes, no invented ones.
  const suffixRe = /GITHUB_REPO\s*\+\s*(['"`])((?:(?!\1).)+)\1/g;
  while ((m = suffixRe.exec(src))) {
    ok(
      ALLOWED_SUFFIXES.has(m[2]),
      `${relJs}: GITHUB_REPO derived link suffix is approved`,
      m[2],
    );
    ok(
      !/store|chromewebstore|microsoft|edge|addon/i.test(m[2]),
      `${relJs}: no invented store link`,
      m[2],
    );
  }

  const isExternalRhs = (rhs) => {
    if (/https?:\/\//i.test(rhs)) return true;
    const ids = rhs.match(/[A-Za-z_$][\w$]*/g) || [];
    return ids.some((id) => httpsConsts.has(id));
  };

  // $('id').href = ... / document.getElementById('id').href = ...
  const idHrefRe =
    /(?:\$\s*\(\s*|document\s*\.\s*getElementById\s*\(\s*)['"]([\w-]+)['"]\s*\)\s*\.\s*href\s*=\s*([^;]+);/g;
  while ((m = idHrefRe.exec(src))) {
    const [, id, rhs] = m;
    if (!isExternalRhs(rhs)) continue; // internal link: not checked
    const pages =
      htmlForJs(relJs) === null ? PAGES : [htmlForJs(relJs)];
    let found = false;
    for (const page of pages) {
      const attrs = findAnchorInHtml(pageHtml[page], id);
      if (attrs) {
        found = true;
        hasNewTabAttrs(attrs, `${relJs}: #${id} (in ${page})`);
      }
    }
    ok(found, `${relJs}: #${id} anchor exists in HTML`, id);
  }

  // v.href = ... / v.setAttribute('href', ...)
  const varHrefRe = /([A-Za-z_$][\w$]*)\s*\.\s*href\s*=\s*([^;]+);/g;
  const varSetAttrRe =
    /([A-Za-z_$][\w$]*)\s*\.\s*setAttribute\(\s*['"]href['"]\s*,\s*([^)]+)\)/g;
  const externalVars = new Map();
  while ((m = varHrefRe.exec(src))) {
    const [, v, rhs] = m;
    if (isExternalRhs(rhs)) externalVars.set(v, rhs.trim());
  }
  while ((m = varSetAttrRe.exec(src))) {
    const [, v, rhs] = m;
    if (isExternalRhs(rhs)) externalVars.set(v, rhs.trim());
  }
  for (const [v, rhs] of externalVars) {
    const vEsc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetOk =
      new RegExp(`\\b${vEsc}\\s*\\.\\s*target\\s*=\\s*(['"])_blank\\1`).test(
        src,
      ) ||
      new RegExp(
        `\\b${vEsc}\\s*\\.\\s*setAttribute\\(\\s*['"]target['"]\\s*,\\s*['"]_blank['"]\\s*\\)`,
      ).test(src);
    ok(
      targetOk,
      `${relJs}: anchor var ${v} (href ${rhs}) sets target="_blank"`,
    );
    const relMatch =
      src.match(
        new RegExp(`\\b${vEsc}\\s*\\.\\s*rel\\s*=\\s*(['"])([^'"]*)\\1`),
      ) ||
      src.match(
        new RegExp(
          `\\b${vEsc}\\s*\\.\\s*setAttribute\\(\\s*['"]rel['"]\\s*,\\s*(['"])([^'"]*)\\1\\s*\\)`,
        ),
      );
    const rel = relMatch
      ? String(relMatch[2] || relMatch[relMatch.length - 1] || '')
          .toLowerCase()
          .split(/\s+/)
      : [];
    ok(
      rel.includes('noopener') && rel.includes('noreferrer'),
      `${relJs}: anchor var ${v} (href ${rhs}) sets rel="noopener noreferrer"`,
    );
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
