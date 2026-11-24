#!/usr/bin/env node
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
 * ImgFetch, scripts/check-security.mjs
 * Phase 5 Part H static security checks. Runs with plain Node:
 *   node scripts/check-security.mjs
 * Exits 1 when any check fails; prints one PASS line per check group
 * and the fetch inventory (informational, for the security review).
 *
 * 1. Manifest: strict extension_pages CSP, no externally_connectable,
 *    no web_accessible_resources, permissions exactly the allowlisted set.
 * 2. No forbidden DOM/code APIs in shipped JS/HTML: innerHTML/outerHTML
 *    assignment, insertAdjacentHTML, document.write, eval(, new Function,
 *    string-argument setTimeout/setInterval.
 * 3. No javascript: URL in an HTML attribute, and no javascript: URL
 *    flowing into a URL sink (.href, .src, window.open, location) in JS.
 *    A javascript: string inside a guard regex (core/svg.js, which
 *    rejects such URLs) is not a sink and does not fail.
 * 4. No remote references in shipped HTML/CSS: no http(s) src/href/url().
 * 5. No console.log in shipped JS (console.debug is the allowed logger).
 * 6. Bundled assets: only known local files under shared/assets, the
 *    Inter and Lucide licence files present, no minified blobs, no maps,
 *    and no script, event handler or javascript: URL in a bundled SVG.
 * 7. Every manifest permission is justified in docs/permissions.md.
 * 8. Fetch inventory: every fetch( call site is listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_DIRS = ['background', 'content', 'core', 'offscreen', 'options', 'pages', 'popup', 'shared'];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`);
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const shipped = SHIPPED_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const jsFiles = shipped.filter((p) => p.endsWith('.js') || p.endsWith('.mjs'));
const htmlFiles = shipped.filter((p) => p.endsWith('.html'));
const cssFiles = shipped.filter((p) => p.endsWith('.css'));
const read = (p) => fs.readFileSync(p, 'utf8');

/* 1. Manifest */
const manifest = JSON.parse(read(path.join(ROOT, 'manifest.json')));
{
  const csp = (manifest.content_security_policy && manifest.content_security_policy.extension_pages) || '';
  check('manifest CSP is script-src self, object-src self', /script-src 'self'/.test(csp) && /object-src 'self'/.test(csp), csp);
  check('manifest CSP has no unsafe-eval, unsafe-inline or remote source',
    !/unsafe-eval|unsafe-inline|https?:/.test(csp), csp);
  check('manifest has no externally_connectable', !('externally_connectable' in manifest));
  check('manifest has no web_accessible_resources',
    !manifest.web_accessible_resources || manifest.web_accessible_resources.length === 0,
    JSON.stringify(manifest.web_accessible_resources || []));
  const required = ['contextMenus', 'downloads', 'storage', 'scripting', 'activeTab', 'offscreen', 'notifications', 'clipboardWrite'];
  const got = [...(manifest.permissions || [])].sort();
  check('manifest required permissions are exactly the allowlisted eight',
    JSON.stringify(got) === JSON.stringify([...required].sort()), JSON.stringify(got));
  check('manifest optional permissions are exactly downloads.open',
    JSON.stringify(manifest.optional_permissions || []) === JSON.stringify(['downloads.open']),
    JSON.stringify(manifest.optional_permissions || []));
  const hosts = [...(manifest.host_permissions || [])].sort();
  check('manifest host permissions are exactly https and http',
    JSON.stringify(hosts) === JSON.stringify(['http://*/*', 'https://*/*']), JSON.stringify(hosts));
  check('manifest version stays 1.1.1', manifest.version === '1.1.1', String(manifest.version));
}

/* 2. Forbidden DOM/code APIs */
{
  const patterns = [
    [/\.innerHTML\s*=/, 'innerHTML assignment'],
    [/\.outerHTML\s*=/, 'outerHTML assignment'],
    [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
    [/document\.write\s*\(/, 'document.write'],
    [/\beval\s*\(/, 'eval('],
    [/\bnew Function\s*\(/, 'new Function'],
    [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout with a string'],
    [/\bsetInterval\s*\(\s*['"`]/, 'setInterval with a string'],
  ];
  const hits = [];
  for (const f of [...jsFiles, ...htmlFiles]) {
    const src = read(f);
    for (const [re, label] of patterns) {
      if (re.test(src)) hits.push(`${rel(f)}: ${label}`);
    }
  }
  check('no forbidden DOM/code API in shipped JS/HTML', hits.length === 0, hits.join('; '));
}

/* 3. javascript: URLs: HTML attributes, and JS URL sinks */
{
  const hits = [];
  for (const f of htmlFiles) {
    const src = read(f);
    if (/(?:src|href)\s*=\s*["']\s*javascript:/i.test(src)) hits.push(`${rel(f)}: javascript: in src/href`);
  }
  const sink = /(?:\.href\s*=|\.src\s*=|window\.open\s*\(|location\s*=)[^;\n]*javascript:/i;
  for (const f of jsFiles) {
    const src = read(f);
    if (sink.test(src)) hits.push(`${rel(f)}: javascript: into a URL sink`);
  }
  check('no javascript: URL in HTML attributes or JS URL sinks', hits.length === 0, hits.join('; '));
}

/* 4. No remote references in shipped HTML/CSS */
{
  const hits = [];
  for (const f of htmlFiles) {
    const src = read(f);
    if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(src)) hits.push(`${rel(f)}: remote src/href`);
  }
  for (const f of cssFiles) {
    const src = read(f);
    if (/url\(\s*["']?https?:\/\//i.test(src)) hits.push(`${rel(f)}: remote url()`);
  }
  check('no remote src/href/url() in shipped HTML/CSS', hits.length === 0, hits.join('; '));
}

/* 5. No console.log in shipped JS */
{
  const hits = jsFiles.filter((f) => /console\.log\s*\(/.test(read(f))).map(rel);
  check('no console.log in shipped JS', hits.length === 0, hits.join('; '));
}

/* 6. Bundled assets */
{
  const assets = walk(path.join(ROOT, 'shared', 'assets'));
  const badExt = assets.filter((p) => !/\.(woff2|svg|txt)$/.test(p)).map(rel);
  check('shared/assets holds only fonts, SVG art and licence text', badExt.length === 0, badExt.join('; '));
  check('Inter licence present (INTER-OFL-1.1.txt)',
    fs.existsSync(path.join(ROOT, 'shared', 'assets', 'INTER-OFL-1.1.txt')));
  check('Lucide licence present (LUCIDE-ISC.txt)',
    fs.existsSync(path.join(ROOT, 'shared', 'assets', 'LUCIDE-ISC.txt')));
  const minified = shipped.filter((p) => /\.min\.js$/.test(p) || /\.map$/.test(p)).map(rel);
  check('no minified blobs or sourcemaps in shipped code', minified.length === 0, minified.join('; '));
  const svgHits = [];
  for (const f of assets.filter((p) => p.endsWith('.svg'))) {
    const src = read(f);
    if (/<script/i.test(src) || /\son\w+\s*=/.test(src) || /javascript:/i.test(src)) {
      svgHits.push(rel(f));
    }
  }
  check('no script, event handler or javascript: URL in bundled SVG art', svgHits.length === 0, svgHits.join('; '));
}

/* 7. Every manifest permission is justified in docs/permissions.md */
{
  const perms = read(path.join(ROOT, 'docs', 'permissions.md'));
  const missing = [];
  for (const p of [...(manifest.permissions || []), ...(manifest.optional_permissions || []), ...(manifest.host_permissions || [])]) {
    if (!perms.includes(p)) missing.push(p);
  }
  check('docs/permissions.md justifies every manifest permission', missing.length === 0, missing.join('; '));
}

/* 8. Fetch inventory (informational) */
console.log('  fetch inventory (every fetch( call site in shipped JS):');
for (const f of jsFiles) {
  const lines = read(f).split('\n');
  lines.forEach((line, i) => {
    if (/fetch\s*\(/.test(line)) {
      console.log(`    ${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

console.log(`\nsecurity-check: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
