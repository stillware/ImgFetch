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
 * ImgFetch, tests/test-security-fuzz.mjs
 * Phase 6 second security pass: hostile-input fuzz over the pure
 * functions at every trust boundary, with a FIXED seed (deterministic).
 * At least 5,000 cases per target, six targets:
 *   1. runtime message handlers (isValidMessage, senderKind)
 *   2. normalizeUrl and the safe fetch URL validator
 *      (isPrivateNetworkUrl, isPrivateNetworkFetchBlocked,
 *      isRedirectBlocked, lensUrlBlocked)
 *   3. the filename sanitiser (sanitizeSegment, buildFilename,
 *      joinDownloadPath, safeZipName)
 *   4. settings and history import (parseSettingsImport,
 *      stripUnknownSettings, normalizeSettings, sanitizeHistoryRecord,
 *      addRecord)
 *   5. the ZIP writer (createZipParts, createZip, crc32)
 *   6. the image header parsers (imageDimensions, sniffImageMime,
 *      parseExif, stripSvgDoctype, svgDimensions)
 * Every case asserts a safety invariant (never throws, output always
 * safe); a failure prints the exact hostile input. Seed 20261124.
 *
 * Runs with plain Node, no dependencies:
 *   node tests/test-security-fuzz.mjs
 */
import {
  normalizeUrl,
  isPrivateNetworkUrl,
  isPrivateNetworkFetchBlocked,
  isRedirectBlocked,
  lensUrlBlocked,
  sanitizePageHost,
  pageUrlFromHost,
} from '../core/urls.js';
import {
  sanitizeSegment,
  buildFilename,
  joinDownloadPath,
  safeExtension,
  parseSettingsImport,
  stripBidiControls,
  truncateNoLoneSurrogate,
  SETTINGS_IMPORT_MAX_CHARS,
} from '../core/filenames.js';
import { safeZipName, createZipParts, createZip, crc32, ZIP_WRITER_MAX_TOTAL_BYTES } from '../core/zip.js';
import { normalizeSettings, stripUnknownSettings } from '../core/settings.js';
import {
  fetchImageBytes,
  sniffImageMime,
  sanitizeHistoryRecord,
  addRecord,
  selectBackfillTargets,
  sanitizeHistoryThumb,
  sanitizeHistoryUrl,
  sanitizeHistoryDlId,
  assertImagePixelBudget,
  imageDimensions,
  MAX_IMAGE_SIDE_PX,
  MAX_IMAGE_PIXELS,
} from '../core/history.js';
import {
  isValidMessage,
  senderKind,
  SENDER_RULES,
  MESSAGE_TYPES,
  isValidCaptureId,
} from '../core/validation.js';
import { parseExif } from '../core/exif.js';
import { stripSvgDoctype, svgDimensions } from '../core/svg.js';
import { dataUrlToBytes } from '../core/data-url.js';

/* Deterministic PRNG (mulberry32), fixed seed. */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng32(20261124);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const ri = (n) => Math.floor(rand() * n);
const rb = () => rand() < 0.5;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass += 1; }
  else {
    fail += 1;
    if (failures.length < 20) failures.push(name);
  }
}
function section(name) {
  console.log(`  ${name}`);
}

const HOSTILE_PIECES = [
  '', ' ', '\n', '\t', '\0', '\x01\x02\x1f', '\x7f',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
  '..', '../', '..\\', '/', '\\', 'C:', 'C:\\', '//', '\\\\',
  'CON', 'con', 'Con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'com9.exe',
  'a'.repeat(500), 'x'.repeat(5000),
  '\u202e', '\u202d', '\u202a', '\u2066', '\u200e', '\u200f', '\ufeff',
  '\u200b', '\u2060', '\u061c', '\u180e', '\u00ad',
  'photo\u202egnp.exe', 'a\u200bb', 'x\u00ady',
  '\uD83D\uDE00'.repeat(60), 'e\u0301', '\u0043\u004f\u004e',
  '%2e%2e', '%252e%252e', '%2F', '%5c', 'a%00b',
  'a.b', '...', ' . . ', 'a  b', 'a\tb', 'a\nb',
  '.png', 'a.png.exe', 'a.tar.gz', 'a.',
  '\uFF23\uFF2F\uFF2E', '\u3002', '\uFF0E',
  'a/b/c', 'a\\b\\c', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b',
  'NaN', 'Infinity', '-0', '1e999', '0x10',
];

function hostileString(maxLen = 120) {
  const n = 1 + ri(6);
  let s = '';
  for (let i = 0; i < n; i += 1) s += pick(HOSTILE_PIECES);
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function hostileValue(depth = 0) {
  const r = rand();
  if (depth > 3 || r < 0.25) return pick([null, undefined, 0, 1, -1, 1.5, NaN, Infinity, -Infinity, '', 'x', true, false]);
  if (r < 0.45) return hostileString(60);
  if (r < 0.6) return [hostileValue(depth + 1), hostileValue(depth + 1)];
  if (r < 0.75) {
    const o = {};
    for (let i = 0; i < 1 + ri(3); i += 1) o[pick(['a', '__proto__', 'constructor', 'prototype', 'type', 'url', 'id'])] = hostileValue(depth + 1);
    return o;
  }
  if (r < 0.85) return 10 ** ri(10) * (rb() ? 1 : -1);
  return hostileString(2000);
}

/* ================================================ 1. messages */
section('1. runtime message handlers (6000 cases)');
{
  const TYPES = [...MESSAGE_TYPES, 'NOPE', '', 'download_image', 'DOWNLOAD_IMAGE ', null, 42, '__proto__'];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const stubFetch = async () => ({
    ok: true, url: 'https://example.com/x.png', headers: { get: () => null },
    body: null, arrayBuffer: async () => png.buffer,
  });
  for (let i = 0; i < 6000; i += 1) {
    const type = pick(TYPES);
    const msg = { type };
    const nFields = ri(5);
    for (let f = 0; f < nFields; f += 1) {
      const key = pick(['srcUrl', 'mode', 'format', 'customName', 'pageUrl', 'tabId', 'id', 'items', 'files', 'settings', 'done', 'total', 'phase', 'part', 'partTotal', 'tile', 'tileCount', 'dataUrl', 'url', 'downloadId', '__proto__', 'constructor']);
      if (key === 'done' || key === 'total') msg[key] = pick([0, 1, 10, -1, 1000001, '3', 1.5, null, {}]);
      else if (key === 'items' || key === 'files') msg[key] = pick([null, [null], ['x'], [{ srcUrl: 'https://a.com/x.png' }], 'nope', 42]);
      else if (key === 'settings') msg[key] = hostileValue();
      else msg[key] = hostileValue();
    }
    if (rb()) msg.type = type;
    let ok;
    try {
      ok = isValidMessage(msg);
    } catch (e) {
      check(`1: isValidMessage never throws (type ${String(type)})`, false);
      continue;
    }
    check(`1: isValidMessage returns a boolean (${String(type)})`, typeof ok === 'boolean');
    if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) {
      check(`1: unknown type rejected (${String(type)})`, ok === false);
    }
    if (msg.type === 'SCAN_PROGRESS' && Number.isInteger(msg.done) && Number.isInteger(msg.total)) {
      check('1: SCAN_PROGRESS bounds enforced', ok === (msg.done >= 0 && msg.total >= 0 && msg.done <= msg.total && msg.total <= 1000000));
    }
    if (msg.type === 'DOWNLOAD_IMAGE' && 'id' in msg && typeof msg.id !== 'string') {
      check('1: DOWNLOAD_IMAGE non-string id rejected', ok === false);
    }
    if (msg.type === 'DOWNLOAD_ZIP' && 'id' in msg && typeof msg.id !== 'string') {
      check('1: DOWNLOAD_ZIP non-string id rejected', ok === false);
    }
    // Sender kinds: only extension pages may send most types, only the
    // content script may send SCAN_PROGRESS.
    const ext = { id: 'x', url: 'chrome-extension://abc/popup/popup.html' };
    const content = { id: 'x', url: 'https://example.com/page', tab: { id: 7 } };
    const unknown = { id: 'x', url: 'https://example.com/page' };
    check('1: senderKind extension page', senderKind(ext) === 'extension');
    check('1: senderKind content script', senderKind(content) === 'content');
    check('1: senderKind unknown without tab', senderKind(unknown) === 'unknown');
    if (typeof type === 'string' && MESSAGE_TYPES.has(type) && SENDER_RULES[type]) {
      check(`1: SENDER_RULES allow extension for ${type} or deny it explicitly`,
        SENDER_RULES[type].includes('extension') || type === 'SCAN_PROGRESS');
      check(`1: SENDER_RULES deny content for ${type} unless SCAN_PROGRESS`,
        SENDER_RULES[type].includes('content') === (type === 'SCAN_PROGRESS'));
    }
    check('1: capture id shape', isValidCaptureId(`cap-1700000000000-123`) === true && isValidCaptureId('cap-1') === false);
  }
  // Targeted: oversized and cyclic payloads.
  check('1: oversized message rejected', isValidMessage({ type: 'GET_SETTINGS', x: 'y'.repeat(1000001) }) === false);
  check('1: SAVE_ANNOTATED allows a large data URL under its cap', isValidMessage({ type: 'SAVE_ANNOTATED', id: 'cap-1700000000000-1', dataUrl: `data:image/png;base64,${'A'.repeat(100000)}` }) === true);
  const cyclic = { type: 'GET_SETTINGS' };
  cyclic.self = cyclic;
  check('1: cyclic message rejected, not a throw', isValidMessage(cyclic) === false);
  check('1: null message rejected', isValidMessage(null) === false);
  check('1: array message rejected', isValidMessage([]) === false);
  // fetchImageBytes without a pageUrl must still block private hosts.
  const r1 = await fetchImageBytes(stubFetch, 'http://127.0.0.1/x.png', {}).then(() => 'allowed', (e) => e.message);
  check('1: fetchImageBytes without pageUrl blocks loopback', r1 === 'private-network');
  const r2 = await fetchImageBytes(stubFetch, 'https://example.com/x.png', {}).then((r) => r.mime, (e) => e.message);
  check('1: fetchImageBytes without pageUrl allows a public host', r2 === 'image/png');
}

/* ================================================ 2. URLs */
section('2. normalizeUrl and the safe fetch URL validator (6000 cases)');
{
  const PRIVATE_V4 = [[10, 1, 2, 3], [172, 20, 5, 6], [192, 168, 1, 1], [127, 0, 0, 1], [169, 254, 9, 9], [100, 70, 1, 2], [0, 0, 0, 0], [0, 1, 2, 3]];
  const PUBLIC_V4 = [[8, 8, 8, 8], [1, 1, 1, 1], [93, 184, 216, 34], [151, 101, 1, 69], [100, 128, 1, 2], [172, 32, 1, 1], [192, 169, 1, 1], [169, 253, 1, 1]];
  const hex = (n) => `0x${n.toString(16)}`;
  const oct = (n) => `0${n.toString(8)}`;
  function v4Spellings([a, b, c, d]) {
    const int32 = ((a * 256 + b) * 256 + c) * 256 + d;
    return [
      `${a}.${b}.${c}.${d}`,
      `${hex(a)}.${hex(b)}.${hex(c)}.${hex(d)}`,
      `${oct(a)}.${oct(b)}.${oct(c)}.${oct(d)}`,
      `${int32}`,
      `0x${int32.toString(16)}`,
      `${hex(a)}.${b}.${c}.${d}`,
      `${a}.${b}.${c}.${d}.`,
      `${a}.${b}.${c}.${d}:8080`,
    ];
  }
  function v6Spellings(ip) {
    const [a, b, c, d] = ip;
    const g6 = ((a << 8) | b).toString(16);
    const g7 = ((c << 8) | d).toString(16);
    return [
      `[::ffff:${a}.${b}.${c}.${d}]`,
      `[::ffff:${g6}:${g7}]`,
      `[0:0:0:0:0:ffff:${g6}:${g7}]`,
      `[::${g6}:${g7}]`,
      `[::ffff:0:${g6}:${g7}]`,
      `[64:ff9b::${g6}:${g7}]`,
      `[64:ff9b:1::${g6}:${g7}]`,
      `[2002:${g6}:${g7}::]`,
      `[2002:${g6}:${g7}::1]`,
    ];
  }
  for (let i = 0; i < 6000; i += 1) {
    const priv = rb();
    const ip = pick(priv ? PRIVATE_V4 : PUBLIC_V4);
    const spelling = pick([...v4Spellings(ip), ...v6Spellings(ip)]);
    const url = `http://${spelling}/img.jpg`;
    let got;
    try { got = isPrivateNetworkUrl(url); } catch { got = 'threw'; }
    // Teredo [2001:0::...] is the only form whose embedded IPv4 is
    // stored XORed, and v6Spellings does not generate it; every spelling
    // here carries its IPv4 plainly, so the assertions apply to all.
    if (priv) check(`2: private spelling blocked ${url}`, got === true);
    if (!priv) check(`2: public spelling allowed ${url}`, got === false);
    check(`2: guard never throws ${url}`, got !== 'threw');
    // normalizeUrl must never return credentials or a bad scheme.
    const n = normalizeUrl(url);
    check(`2: normalizeUrl keeps a usable http URL ${url}`, n === null || (typeof n === 'string' && !n.includes('@') && /^https?:\/\//.test(n)));
  }
  // Targeted hostile URL shapes.
  const badUrls = [
    'javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'file:///etc/passwd', 'chrome://extensions', 'chrome-extension://abc/x.png',
    'ftp://example.com/x.png', 'https://user:pass@example.com/x.png',
    'https://example.com@127.0.0.1/x.png', 'http://127.0.0.1%09@evil.com/',
    'data:text/html,<script>alert(1)</script>',
    'data:image/png;base64,' + 'A'.repeat(100),
    'blob:chrome-extension://abc/123',
    'http://[::1', 'http://[v6]/', 'http://256.256.256.256/x.png',
    'http://localhost/x.png', 'http://LOCALHOST:8080/x.png',
    'http://router/x.png', 'http://intranet/x.png',
    'http://example.local/x.png', 'http://a.internal/x.png',
    'http://a.lan/x.png', 'http://a.home.arpa/x.png',
    'http://example.com./x.png',
  ];
  for (const u of badUrls) {
    let blocked;
    try { blocked = isPrivateNetworkUrl(u); } catch { blocked = 'threw'; }
    check(`2: guard never throws on ${u.slice(0, 40)}`, blocked !== 'threw');
    const n = normalizeUrl(u);
    check(`2: normalizeUrl rejects credentials/bad scheme for ${u.slice(0, 40)}`,
      n === null || (!n.includes('@') && !/^javascript:|^file:|^ftp:|^chrome:/i.test(n)));
  }
  check('2: partial form 127.1 is loopback', isPrivateNetworkUrl('http://127.1/x.png') === true);
  check('2: partial form 192.168 is 192.0.0.168, public', isPrivateNetworkUrl('http://192.168/x.png') === false);
  check('2: single number 100 is 0.0.0.100, private', isPrivateNetworkUrl('http://100/x.png') === true);
  check('2: ULA prefix is private whatever the suffix', isPrivateNetworkUrl('http://[fc00::808:808]/x.png') === true);
  check('2: link-local prefix is private whatever the suffix', isPrivateNetworkUrl('http://[fe80::808:808]/x.png') === true);
  check('2: localhost blocked', isPrivateNetworkUrl('http://localhost/x.png') === true);
  check('2: localhost subdomain blocked', isPrivateNetworkUrl('http://a.localhost/x.png') === true);
  check('2: single-label host blocked', isPrivateNetworkUrl('http://printer/x.png') === true);
  check('2: public host allowed', isPrivateNetworkUrl('https://example.com/x.png') === false);
  check('2: NAT64 /48 loopback blocked', isPrivateNetworkUrl('http://[64:ff9b:1::7f00:1]/x.png') === true);
  check('2: NAT64 /48 public allowed', isPrivateNetworkUrl('http://[64:ff9b:1::808:808]/x.png') === false);
  check('2: IPv4-translated loopback blocked', isPrivateNetworkUrl('http://[::ffff:0:7f00:1]/x.png') === true);
  check('2: IPv4-translated public allowed', isPrivateNetworkUrl('http://[::ffff:0:808:808]/x.png') === false);
  check('2: Teredo XORed loopback blocked', isPrivateNetworkUrl('http://[2001:0::80ff:ffff]/x.png') === true);
  check('2: Teredo XORed public allowed', isPrivateNetworkUrl('http://[2001:0::808:808]/x.png') === false);
  check('2: 6to4 loopback blocked', isPrivateNetworkUrl('http://[2002:7f00:1::]/x.png') === true);
  check('2: 6to4 public allowed', isPrivateNetworkUrl('http://[2002:808:808::]/x.png') === false);
  check('2: ideographic full stop loopback blocked', isPrivateNetworkUrl('http://127\u30020\u30020\u30021/x.png') === true);
  check('2: redirect to private blocked', isRedirectBlocked('http://127.0.0.1/x.png', 'https://example.com/') === true);
  check('2: redirect to public allowed', isRedirectBlocked('https://cdn.example.com/x.png', 'https://example.com/') === false);
  check('2: redirect same private host allowed', isRedirectBlocked('http://192.168.1.1/b.png', 'http://192.168.1.1/a.png') === false);
  check('2: redirect with no pageUrl blocks private', isRedirectBlocked('http://127.0.0.1/x.png', '') === true);
  check('2: Lens blocks data URLs', lensUrlBlocked('data:image/png;base64,AAAA', 'https://example.com/') === 'bad-url');
  check('2: Lens blocks private URLs', lensUrlBlocked('http://192.168.1.1/x.png', 'https://example.com/') === 'private-network');
  check('2: Lens allows public URLs', lensUrlBlocked('https://example.com/x.png', 'https://example.com/') === null);
  check('2: data URL over the decoded cap rejected', normalizeUrl(`data:image/png;base64,${'A'.repeat(70000000)}`) === null);
  check('2: data URL under the cap kept', normalizeUrl('data:image/png;base64,AAAA') !== null);
  check('2: non-image data URL rejected', normalizeUrl('data:text/html,<b>x</b>') === null);
  check('2: pageHost smuggling rejected', sanitizePageHost('example.com@127.0.0.1') === '');
  check('2: pageHost with slash rejected', sanitizePageHost('example.com/evil') === '');
  check('2: pageHost with port rejected', sanitizePageHost('example.com:8080') === '');
  check('2: plain pageHost kept', sanitizePageHost('sub.example.com') === 'sub.example.com');
  check('2: IPv6 pageHost kept', sanitizePageHost('[::1]') === '[::1]');
  check('2: pageUrlFromHost smuggled is empty', pageUrlFromHost('example.com@127.0.0.1') === '');
  check('2: pageUrlFromHost valid builds https', pageUrlFromHost('example.com') === 'https://example.com/');
  check('2: same-host exception needs a validated host',
    isPrivateNetworkFetchBlocked('http://127.0.0.1/x.png', pageUrlFromHost('example.com@127.0.0.1')) === true);
}

/* ================================================ 3. filenames */
section('3. filename sanitiser (6000 cases)');
{
  const SAFE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg']);
  const INVISIBLE = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\ufeff\u200b\u2060\u061c\u180e\u00ad]/;
  const ILLEGAL = /[/\\:<>:"|?*\u0000-\u001f]/;
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let i = 0; i < 6000; i += 1) {
    const raw = hostileString(300);
    const seg = sanitizeSegment(raw);
    check(`3: segment has no illegal chars (${JSON.stringify(raw.slice(0, 30))})`, !ILLEGAL.test(seg));
    check(`3: segment has no bidi or invisible controls (${JSON.stringify(raw.slice(0, 30))})`, !INVISIBLE.test(seg));
    check(`3: segment has no lone surrogate (${JSON.stringify(raw.slice(0, 30))})`, !LONE_SURROGATE.test(seg));
    check(`3: segment length capped at 96 (${JSON.stringify(raw.slice(0, 30))})`, seg.length <= 96);
    check(`3: segment has no trailing dot or space (${JSON.stringify(raw.slice(0, 30))})`, !/[.\s]$/.test(seg));
    check(`3: segment is not a reserved name (${JSON.stringify(raw.slice(0, 30))})`, !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg));
    const built = buildFilename(pick(['original', 'site', 'custom']), {
      site: raw, name: raw, ext: pick(['png', 'exe', 'html', 'js', 'svg', 'xyz', '']),
      custom: raw, date: new Date(), num: 3, width: 800, height: 600,
    });
    check(`3: built name has a safe extension (${JSON.stringify(raw.slice(0, 30))})`,
      /\.([a-z0-9]+)$/.test(built) && SAFE_EXT.has(built.split('.').pop()));
    check(`3: built name length capped at 180 (${JSON.stringify(raw.slice(0, 30))})`, built.length <= 180);
    check(`3: built name has no lone surrogate (${JSON.stringify(raw.slice(0, 30))})`, !LONE_SURROGATE.test(built));
    check(`3: built name has no illegal chars (${JSON.stringify(raw.slice(0, 30))})`, !ILLEGAL.test(built));
    const joined = joinDownloadPath(raw, raw);
    check(`3: joined path never escapes (${JSON.stringify(raw.slice(0, 30))})`,
      !joined.split('/').includes('..') && joined.split('/').length <= 4 && !joined.startsWith('/') && !/^[a-z]:/i.test(joined));
    const zipName = safeZipName(raw);
    check(`3: zip name has no separator or lone surrogate (${JSON.stringify(raw.slice(0, 30))})`,
      !/[/\\]/.test(zipName) && !LONE_SURROGATE.test(zipName) && zipName.length > 0 && zipName.length <= 120);
  }
  check('3: bidi controls stripped', stripBidiControls('a\u202eb') === 'ab');
  check('3: zero width space stripped', stripBidiControls('a\u200bb') === 'ab');
  check('3: soft hyphen stripped', stripBidiControls('a\u00adb') === 'ab');
  check('3: word joiner stripped', stripBidiControls('a\u2060b') === 'ab');
  check('3: ZWNJ kept (real letter in Persian/Urdu words)', stripBidiControls('a\u200cb') === 'a\u200cb');
  check('3: ZWJ kept (emoji joiner)', stripBidiControls('a\u200db') === 'a\u200db');
  check('3: truncate drops a trailing lone surrogate', truncateNoLoneSurrogate(`A`.repeat(95) + '\uD83D' + 'x'.repeat(10), 96) === 'A'.repeat(95));
  check('3: truncate keeps a whole surrogate pair', truncateNoLoneSurrogate('\uD83D\uDE00'.repeat(60), 100) === '\uD83D\uDE00'.repeat(50));
  check('3: reserved name with extension prefixed', sanitizeSegment('con.txt') === '_con.txt');
  check('3: traversal name cleaned', sanitizeSegment('../../etc/passwd') === 'etcpasswd' || !sanitizeSegment('../../etc/passwd').includes('/'));
  check('3: blocked extension maps to png', safeExtension('exe') === 'png');
  check('3: html extension maps to png', safeExtension('html') === 'png');
  check('3: jpeg normalises to jpg', safeExtension('jpeg') === 'jpg');
  check('3: zip keeps the extra ext when allowed', joinDownloadPath('', 'a.zip', ['zip']) === 'a.zip');
  check('3: exe maps to png without an explicit allowlist', joinDownloadPath('', 'a.exe') === 'a.png');
  check('3: an explicitly allowed extra ext is kept', joinDownloadPath('', 'a.foo', ['foo']) === 'a.foo');
}

/* ================================================ 4. settings/history import */
section('4. settings and history import (6000 cases)');
{
  for (let i = 0; i < 6000; i += 1) {
    // Deeply nested / hostile JSON shapes.
    let text;
    const kind = ri(5);
    if (kind === 0) text = JSON.stringify(hostileValue());
    else if (kind === 1) text = JSON.stringify({ settings: hostileValue() });
    else if (kind === 2) {
      let nested = 'x';
      for (let d = 0; d < ri(200); d += 1) nested = [nested];
      text = JSON.stringify({ settings: { sitePrefs: nested } });
    } else if (kind === 3) {
      const prefs = {};
      for (let k = 0; k < ri(50); k += 1) prefs[hostileString(40)] = pick(['smart', 'disabled', 'normal', 'best', 42, null, {}, '__proto__']);
      text = JSON.stringify({ settings: { sitePrefs: prefs, theme: hostileString(20) } });
    } else {
      text = JSON.stringify({ theme: hostileString(30), maxConcurrent: hostileValue(), jpgQuality: hostileValue(), __proto__: { polluted: true } });
    }
    let parsed = null;
    let threw = false;
    try { parsed = parseSettingsImport(text); } catch { threw = true; }
    check(`4: parseSettingsImport rejects or returns an object (${kind})`, threw || (parsed !== null && typeof parsed === 'object'));
    if (!threw && parsed) {
      check(`4: parsed import is a plain object (${kind})`, typeof parsed === 'object' && !Array.isArray(parsed));
      const stripped = stripUnknownSettings(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed);
      check(`4: import allowlist keeps only known keys (${kind})`,
        Object.keys(stripped).every((k) => k in { theme: 1, language: 1, sitePrefs: 1, maxConcurrent: 1, jpgQuality: 1, pngQuality: 1, webpQuality: 1, screenshotQuality: 1, screenshotFormat: 1, filenameMode: 1, customTemplate: 1, folderMode: 1, subfolder: 1, historyRetentionDays: 1, historyEnabled: 1, historyShowThumbnails: 1, afterDownload: 1, qualityPreference: 1, minSizePreset: 1, scanDepth: 1, saveAsDialog: 1, autoRetryOnce: 1, organizeBySite: 1, includeBackgrounds: 1, detectLazyScroll: 1, dedupeScan: 1, askFilename: 1, annotateAfterCapture: 1, useSubfolder: 1, autoCollapseQueue: 1, version: 1 }));
      check(`4: import allowlist drops __proto__ (${kind})`, !Object.prototype.hasOwnProperty.call(stripped, '__proto__'));
      let norm;
      try { norm = normalizeSettings(stripped); } catch { norm = null; }
      check(`4: normalizeSettings never throws (${kind})`, norm !== null);
      if (norm) {
        check(`4: sitePrefs capped at 1000 (${kind})`, Object.keys(norm.sitePrefs).length <= 1000);
        check(`4: sitePrefs has no __proto__ key (${kind})`, !Object.prototype.hasOwnProperty.call(norm.sitePrefs, '__proto__'));
        check(`4: qualities clamped (${kind})`, norm.jpgQuality >= 0.1 && norm.jpgQuality <= 1);
        check(`4: maxConcurrent clamped (${kind})`, norm.maxConcurrent >= 1 && norm.maxConcurrent <= 6);
      }
    }
    check('4: prototype never polluted by imports', {}.polluted === undefined && Object.prototype.polluted === undefined);
    // History records from tampered storage.
    const rec = {
      id: hostileString(200), filename: hostileString(300), site: hostileString(200),
      pageHost: hostileString(300), format: hostileString(30),
      width: hostileValue(), height: hostileValue(), bytes: hostileValue(),
      at: hostileValue(), kind: hostileString(20),
      thumb: hostileString(20000), url: hostileString(3000), dlId: hostileValue(),
    };
    let clean;
    try { clean = sanitizeHistoryRecord(rec); } catch { clean = 'threw'; }
    check('4: sanitizeHistoryRecord never throws', clean !== 'threw');
    if (clean) {
      check('4: record filename has no control chars', !/[\u0000-\u001f\u007f]/.test(clean.filename));
      check('4: record filename has no bidi controls', !/[\u202a-\u202e\u2066-\u2069\u200e\u200f\ufeff]/.test(clean.filename));
      check('4: record pageHost is a validated host or empty',
        clean.pageHost === '' || /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(clean.pageHost) || /^\[[0-9a-f:]+\]$/.test(clean.pageHost));
      check('4: record thumb is a capped jpeg/webp data URL or absent',
        clean.thumb === undefined || (/^data:image\/(jpeg|webp)/.test(clean.thumb) && clean.thumb.length <= 20000));
      check('4: record url is http(s) within the cap or absent',
        clean.url === undefined || (/^https?:\/\//i.test(clean.url) && clean.url.length <= 2048));
      check('4: record numbers are finite and bounded',
        Number.isFinite(clean.width) && Number.isFinite(clean.height) && Number.isFinite(clean.bytes));
      check('4: record kind is allowlisted', ['single', 'bulk', 'screenshot'].includes(clean.kind));
    }
    let added;
    try { added = addRecord([], rec); } catch { added = 'threw'; }
    check('4: addRecord never throws on hostile input', added !== 'threw');
    if (Array.isArray(added) && added.length) {
      check('4: addRecord output pageHost validated', added[0].pageHost === '' || /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(added[0].pageHost) || /^\[[0-9a-f:]+\]$/.test(added[0].pageHost));
    }
    // Backfill targets must never include a private-network URL (F-P6-15).
    const backfillHosts = ['https://example.com/a.png', 'http://127.0.0.1/x.png', 'http://192.168.0.5/x.png', 'http://10.0.0.1/x.png', 'http://[::1]/x.png', 'http://[fe80::1]/x.png', 'http://localhost/x.png', 'https://cdn.example.org/i.jpg', 'data:image/png;base64,AAA', 'not a url', 'http://[64:ff9b:1::7f00:1]/x.png', 'http://172.16.4.4/x.png'];
    const backfillRecs = [];
    for (let b = 0; b < 8; b += 1) backfillRecs.push({ id: `bf${b}`, url: pick(backfillHosts), thumb: ri(3) === 0 ? 'data:image/jpeg;base64,AAAA' : undefined });
    const targets = selectBackfillTargets(backfillRecs);
    check('4: backfill never selects a private-network URL', targets.every((t) => !isPrivateNetworkUrl(t.url)));
    check('4: backfill only selects thumbnail-less records', targets.every((t) => !t.thumb));
    check('4: sanitizeHistoryThumb rejects an over-cap thumb', sanitizeHistoryThumb(`data:image/jpeg;base64,${'A'.repeat(20000)}`) === undefined);
    check('4: sanitizeHistoryUrl rejects javascript', sanitizeHistoryUrl('javascript:alert(1)') === undefined);
    check('4: sanitizeHistoryDlId rejects negatives', sanitizeHistoryDlId(-1) === undefined);
    check('4: sanitizeHistoryDlId rejects floats', sanitizeHistoryDlId(1.5) === undefined);
  }
  check('4: oversized import rejected', (() => { try { parseSettingsImport(' '.repeat(SETTINGS_IMPORT_MAX_CHARS + 1)); return false; } catch (e) { return e.message === 'too-large'; } })());
  check('4: array import rejected', (() => { try { parseSettingsImport('[1,2]'); return false; } catch (e) { return e.message === 'not-an-object'; } })());
  check('4: deeply nested JSON does not hang the parser', (() => {
    let nested = 'x';
    for (let d = 0; d < 5000; d += 1) nested = [nested];
    try { parseSettingsImport(JSON.stringify({ a: nested }).slice(0, 100000)); return true; } catch { return true; }
  })());
  check('4: 100k sitePrefs capped at 1000', (() => {
    const big = { sitePrefs: {} };
    for (let k = 0; k < 100000; k += 1) big.sitePrefs[`host${k}.example.com`] = 'disabled';
    return Object.keys(normalizeSettings(big).sitePrefs).length === 1000;
  })());
  check('4: sitePrefs __proto__ never lands', (() => {
    const out = normalizeSettings(JSON.parse('{"sitePrefs":{"__proto__":{"x":1}}}'));
    return !Object.prototype.hasOwnProperty.call(out.sitePrefs, '__proto__') && {}.x === undefined;
  })());
}

/* ================================================ 5. ZIP writer */
section('5. ZIP writer (6000 cases)');
{
  function parseZip(bytes) {
    // Returns entry names and checks the end-of-central-directory record.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const names = [];
    let off = 0;
    let count = 0;
    while (off + 30 <= bytes.length) {
      const sig = view.getUint32(off, true);
      if (sig !== 0x04034b50) break;
      const nl = view.getUint16(off + 26, true);
      const el = view.getUint16(off + 28, true);
      const cl = view.getUint32(off + 18, true);
      names.push(new TextDecoder().decode(bytes.slice(off + 30, off + 30 + nl)));
      off += 30 + nl + el + cl;
      count += 1;
      if (count > 600) return { names, ok: false, reason: 'too many local headers' };
    }
    if (off + 22 > bytes.length) return { names, ok: false, reason: 'no EOCD' };
    const eocd = view.getUint32(bytes.length - 22, true);
    const total = view.getUint16(bytes.length - 12, true);
    return { names, ok: eocd === 0x06054b50 && total === names.length, reason: 'eocd' };
  }
  for (let i = 0; i < 6000; i += 1) {
    const n = 1 + ri(6);
    const files = [];
    for (let f = 0; f < n; f += 1) {
      const len = ri(50);
      const data = new Uint8Array(len);
      for (let b = 0; b < len; b += 1) data[b] = ri(256);
      files.push({ name: hostileString(150), data });
    }
    // Duplicate storm: repeat one name on purpose.
    if (rb() && files.length > 1) files[1].name = files[0].name;
    let out;
    try {
      out = createZip(files, new Date('2026-01-02T03:04:05Z'));
    } catch (e) {
      check(`5: createZip only fails with a plain error (${e.message})`, e instanceof Error);
      continue;
    }
    check('5: zip output is a Uint8Array', out instanceof Uint8Array);
    const parsed = parseZip(out);
    check('5: zip parses with a consistent EOCD', parsed.ok);
    check('5: zip entry count matches input', parsed.names.length === files.length);
    check('5: zip entry names are unique', new Set(parsed.names).size === parsed.names.length);
    for (const name of parsed.names) {
      check(`5: zip entry name has no separator (${JSON.stringify(name)})`, !/[/\\]/.test(name));
      check(`5: zip entry name is not empty (${JSON.stringify(name)})`, name.length > 0);
      check(`5: zip entry name has no traversal (${JSON.stringify(name)})`, name !== '..' && !name.startsWith('../') && !name.includes('/..'));
      check(`5: zip entry name has no control chars (${JSON.stringify(name)})`, !/[\u0000-\u001f]/.test(name));
    }
    // CRC of the first entry matches its bytes.
    if (files.length && out.length > 30) {
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      const nl = view.getUint16(26, true);
      const cl = view.getUint32(18, true);
      const storedCrc = view.getUint32(14, true);
      const entryBytes = out.slice(30 + nl, 30 + nl + cl);
      check('5: first entry CRC matches its bytes', crc32(entryBytes) === storedCrc);
    }
  }
  check('5: empty file list rejected', (() => { try { createZipParts([]); return false; } catch (e) { return e.message === 'bad-input'; } })());
  check('5: null entry rejected with a plain error', (() => { try { createZipParts([null]); return false; } catch (e) { return e.message === 'bad-input'; } })());
  check('5: string data rejected, not silently zeroed', (() => { try { createZipParts([{ name: 'x', data: 'str' }]); return false; } catch (e) { return e.message === 'bad-input'; } })());
  check('5: over 500 files rejected', (() => {
    try {
      createZipParts(Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array([1]) })));
      return false;
    } catch (e) { return e.message === 'too-many-files'; }
  })());
  check('5: writer total cap enforced', (() => {
    try {
      createZipParts([{ name: 'big', data: new Uint8Array(ZIP_WRITER_MAX_TOTAL_BYTES + 1) }]);
      return false;
    } catch (e) { return e.message === 'too-large'; }
  })());
  check('5: writer cap constant is 300 MB', ZIP_WRITER_MAX_TOTAL_BYTES === 300_000_000);
  check('5: duplicate names deduped', (() => {
    const z = createZipParts([{ name: 'a.png', data: new Uint8Array([1]) }, { name: 'a.png', data: new Uint8Array([2]) }]);
    return z.count === 2;
  })());
  check('5: crc32 is stable', crc32(new Uint8Array([1, 2, 3])) === crc32(new Uint8Array([1, 2, 3])));
}

/* ================================================ 6. image header parsers */
section('6. image header parsers (6000 cases)');
{
  function pngHeader(w, h) {
    const b = new Uint8Array(24);
    b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
    b[16] = (w >>> 24) & 255; b[17] = (w >>> 16) & 255; b[18] = (w >>> 8) & 255; b[19] = w & 255;
    b[20] = (h >>> 24) & 255; b[21] = (h >>> 16) & 255; b[22] = (h >>> 8) & 255; b[23] = h & 255;
    return b;
  }
  function gifHeader(w, h) {
    const b = new Uint8Array(10);
    b[0] = 0x47; b[1] = 0x49; b[2] = 0x46; b[3] = 0x38; b[4] = 0x39; b[5] = 0x61;
    b[6] = w & 255; b[7] = (w >>> 8) & 255; b[8] = h & 255; b[9] = (h >>> 8) & 255;
    return b;
  }
  function jpegSof(w, h) {
    const b = new Uint8Array(22);
    b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; b[4] = 0x00; b[5] = 0x11; b[6] = 0x08;
    b[7] = (h >>> 8) & 255; b[8] = h & 255; b[9] = (w >>> 8) & 255; b[10] = w & 255;
    return b;
  }
  function webpVp8x(w, h) {
    const b = new Uint8Array(30);
    b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46;
    b[8] = 0x57; b[9] = 0x45; b[10] = 0x42; b[11] = 0x50;
    b[12] = 0x56; b[13] = 0x50; b[14] = 0x38; b[15] = 0x58;
    const ww = w - 1; const hh = h - 1;
    b[24] = ww & 255; b[25] = (ww >>> 8) & 255; b[26] = (ww >>> 16) & 255;
    b[27] = hh & 255; b[28] = (hh >>> 8) & 255; b[29] = (hh >>> 16) & 255;
    return b;
  }
  const MAKERS = [pngHeader, gifHeader, jpegSof, webpVp8x];
  for (let i = 0; i < 6000; i += 1) {
    const maker = pick(MAKERS);
    const w = pick([0, 1, 2, 100, 16384, 16385, 100000, 4294967295]);
    const h = pick([0, 1, 2, 100, 16384, 16385, 100000, 4294967295]);
    let bytes = maker(w, h);
    // Mutate: truncate at a random length, or flip random bytes.
    if (rb()) bytes = bytes.slice(0, ri(bytes.length + 1));
    else if (rb()) {
      bytes = bytes.slice();
      for (let m = 0; m < ri(4); m += 1) bytes[ri(bytes.length)] = ri(256);
    }
    let dims;
    try { dims = imageDimensions(bytes); } catch { dims = 'threw'; }
    check('6: imageDimensions never throws', dims !== 'threw');
    if (dims) {
      check('6: imageDimensions returns positive finite dims', Number.isFinite(dims.w) && Number.isFinite(dims.h) && dims.w > 0 && dims.h > 0);
      if (dims.w > MAX_IMAGE_SIDE_PX || dims.h > MAX_IMAGE_SIDE_PX || dims.w * dims.h > MAX_IMAGE_PIXELS) {
        let threw = false;
        try { assertImagePixelBudget(dims.w, dims.h); } catch { threw = true; }
        check('6: oversize dims fail the pixel budget', threw === true);
      }
    }
    let mime;
    try { mime = sniffImageMime(bytes); } catch { mime = 'threw'; }
    check('6: sniffImageMime never throws', mime !== 'threw');
    check('6: sniffImageMime returns a known mime or empty',
      mime === '' || mime.startsWith('image/'));
    // EXIF on mutated JPEG-ish bytes.
    let exif;
    try { exif = parseExif(bytes); } catch { exif = 'threw'; }
    check('6: parseExif never throws', exif !== 'threw');
    if (exif) {
      check('6: parseExif returns only known keys',
        Object.keys(exif).every((k) => ['make', 'model', 'dateTime', 'orientation', 'pixelWidth', 'pixelHeight', 'dateTaken', 'gps'].includes(k)));
    }
    // SVG text with DOCTYPE / entity tricks.
    const svgText = pick([
      '<svg width="100" height="50"></svg>',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://example.com/x.dtd"><svg width="10" height="10"/>',
      '<svg width="100000" height="100000"></svg>',
      '<svg viewBox="0 0 640 480"></svg>',
      '<svg width="50%" height="50%" viewBox="0 0 200 100"></svg>',
      '<svg><script>alert(1)</script></svg>',
      '<svg><foreignObject><body><img src=x onerror=alert(1)></body></foreignObject></svg>',
      '<?xml version="1.0"?><!-- comment --><svg width="800" height="600">',
      '<svg width="0" height="10"></svg>',
      '<svg width="10.5px" height="20.9"></svg>',
      '<!DOCTYPE',
      '<!DOCTYPE svg [<!ENTITY a "xxxxxxxxxx"><!ENTITY b "&a;&a;&a;">]>',
    ]);
    const stripped = stripSvgDoctype(svgText);
    check('6: stripSvgDoctype removes every DOCTYPE', !/<!doctype/i.test(stripped));
    check('6: stripSvgDoctype terminates', typeof stripped === 'string');
    const sd = svgDimensions(svgText);
    check('6: svgDimensions never returns absurd dims silently',
      sd === null || (Number.isFinite(sd.w) && Number.isFinite(sd.h) && sd.w > 0 && sd.h > 0));
    if (sd && (sd.w > MAX_IMAGE_SIDE_PX || sd.h > MAX_IMAGE_SIDE_PX || sd.w * sd.h > MAX_IMAGE_PIXELS)) {
      let threw = false;
      try { assertImagePixelBudget(sd.w, sd.h); } catch { threw = true; }
      check('6: oversize SVG dims fail the pixel budget', threw === true);
    }
    // data: URL decoding on hostile payloads.
    const du = pick([
      'data:image/png;base64,AAAA',
      'data:image/png;base64,!!!',
      'data:text/html,<script>',
      'data:image/png;base64,' + 'A'.repeat(1000),
      'data:;base64,AAAA',
      'data:image/png,hello%20world',
      'data:image/png;base64,AB',
    ]);
    let decoded;
    try { decoded = dataUrlToBytes(du); } catch { decoded = 'threw'; }
    check('6: dataUrlToBytes either decodes or throws plainly', decoded === 'threw' || decoded instanceof Uint8Array);
  }
  check('6: PNG dims parsed', JSON.stringify(imageDimensions(pngHeader(800, 600))) === JSON.stringify({ w: 800, h: 600 }));
  check('6: GIF dims parsed', JSON.stringify(imageDimensions(gifHeader(320, 240))) === JSON.stringify({ w: 320, h: 240 }));
  check('6: JPEG dims parsed', JSON.stringify(imageDimensions(jpegSof(1024, 768))) === JSON.stringify({ w: 1024, h: 768 }));
  check('6: WebP dims parsed', JSON.stringify(imageDimensions(webpVp8x(400, 300))) === JSON.stringify({ w: 400, h: 300 }));
  check('6: AVIF has no header parser (REC-2, reported)', imageDimensions(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) === null);
  check('6: TIFF has no header parser (REC-2, reported)', imageDimensions(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])) === null);
  check('6: truncated PNG returns null', imageDimensions(pngHeader(800, 600).slice(0, 10)) === null);
  check('6: svgDimensions reads width and height', JSON.stringify(svgDimensions('<svg width="100" height="50"></svg>')) === JSON.stringify({ w: 100, h: 50 }));
  check('6: svgDimensions falls back to viewBox', JSON.stringify(svgDimensions('<svg viewBox="0 0 640 480"></svg>')) === JSON.stringify({ w: 640, h: 480 }));
  check('6: svgDimensions does not read percentages as pixels', JSON.stringify(svgDimensions('<svg width="50%" height="50%" viewBox="0 0 200 100"></svg>')) === JSON.stringify({ w: 200, h: 100 }));
  check('6: svgDimensions defaults to 300x150', JSON.stringify(svgDimensions('<svg></svg>')) === JSON.stringify({ w: 300, h: 150 }));
  check('6: svgDimensions returns null without a root tag', svgDimensions('hello') === null);
  check('6: svgDimensions flags a bomb', (() => {
    const d = svgDimensions('<svg width="100000" height="100000"></svg>');
    try { assertImagePixelBudget(d.w, d.h); return false; } catch { return true; }
  })());
  check('6: stripSvgDoctype drops entity references', !/&xxe;/.test(stripSvgDoctype('<!DOCTYPE svg [<!ENTITY xxe "x">]><svg>&xxe;</svg>')));
  check('6: stripSvgDoctype keeps predefined entities', /&amp;/.test(stripSvgDoctype('<!DOCTYPE svg [<!ENTITY xxe "x">]><svg>&amp;</svg>')));
  check('6: sniffImageMime identifies PNG', sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === 'image/png');
  check('6: sniffImageMime identifies SVG text', sniffImageMime(new TextEncoder().encode('<svg width="1" height="1"></svg>')) === 'image/svg+xml');
  check('6: sniffImageMime rejects HTML as not-image', sniffImageMime(new TextEncoder().encode('<html><body>hi</body></html>')) === '');
}

/* ================================================ summary */
console.log(`\n${pass} passed, ${fail} failed over 36000 fuzz cases`);
if (failures.length) {
  console.log('First failures:');
  for (const f of failures) console.log(`  FAIL ${f}`);
}
process.exit(fail ? 1 : 0);
