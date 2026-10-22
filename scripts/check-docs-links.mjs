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
 * ImgFetch, scripts/check-docs-links.mjs
 * Offline checker for the markdown documentation: every relative link
 * and image path must resolve to a file in this repository, and every
 * anchor must match a heading in the target file (GitHub slug rules).
 * No network access. Run directly (node scripts/check-docs-links.mjs)
 * or through scripts/validate.py. Exit code 1 on any failure.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function collectMarkdown(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectMarkdown(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Remove fenced code blocks and inline code so examples are not parsed. */
function stripCode(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** GitHub heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    let slug = slugify(m[1]);
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    anchors.add(slug);
  }
  return anchors;
}

const failures = [];
const files = collectMarkdown(ROOT, []).sort();
const anchorCache = new Map();
let linkCount = 0;

function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) {
    anchorCache.set(absPath, anchorsOf(stripCode(readFileSync(absPath, 'utf8'))));
  }
  return anchorCache.get(absPath);
}

for (const file of files) {
  const rel = file.slice(ROOT.length + 1).split('\\').join('/');
  const text = stripCode(readFileSync(file, 'utf8'));
  const linkRe = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const raw = m[1];
    if (/^(https?:|mailto:|tel:)/i.test(raw)) continue;
    linkCount += 1;
    const hashIdx = raw.indexOf('#');
    const pathPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const anchor = hashIdx >= 0 ? decodeURIComponent(raw.slice(hashIdx + 1)) : '';
    const targetAbs = pathPart
      ? resolve(dirname(file), decodeURIComponent(pathPart))
      : file;
    if (pathPart && !existsSync(targetAbs)) {
      failures.push(`${rel}: link target does not exist: ${raw}`);
      continue;
    }
    if (anchor && existsSync(targetAbs) && statSync(targetAbs).isFile()
        && targetAbs.toLowerCase().endsWith('.md')) {
      if (!anchorsFor(targetAbs).has(anchor)) {
        failures.push(`${rel}: anchor not found: ${raw}`);
      }
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  console.error(`check-docs-links: ${failures.length} broken link(s) in ${files.length} markdown files`);
  process.exit(1);
}
console.log(`check-docs-links: ${files.length} markdown files, ${linkCount} relative links, all resolve`);
