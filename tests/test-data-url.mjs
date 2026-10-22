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
 * ImgFetch: tests/test-data-url.mjs
 * Node unit tests for core/data-url.js (Phase C4 / F6): the chunked
 * atob data-URL decoder that replaced fetch(dataUrl) in the screenshot
 * decode paths. The large cases build 13 MB and 24 MB data URLs in the
 * test and assert byte-exact decoding, including across the decoder's
 * internal chunk boundary.
 * Prints "N passed, M failed", exits nonzero on failure.
 * Run: node tests/test-data-url.mjs
 */
import { dataUrlToBytes, dataUrlToBlob } from '../core/data-url.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

/** Deterministic byte pattern (no RNG state to manage). */
function patternedBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + (i >> 8) * 7 + 13) & 0xff;
  return out;
}

function toDataUrl(bytes, mime = 'image/png') {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return `length ${a.length} != ${b.length}`;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return `byte ${i}: ${a[i]} != ${b[i]}`;
  }
  return '';
}

// Small payload: every byte value, byte-exact.
{
  const src = patternedBytes(4096);
  const out = dataUrlToBytes(toDataUrl(src));
  const diff = bytesEqual(out, src);
  check('small data URL decodes byte-exact', diff === '', diff);
}

// 13 MB payload (a realistic full-page screenshot size), byte-exact.
{
  const src = patternedBytes(13_000_000);
  const out = dataUrlToBytes(toDataUrl(src));
  const diff = bytesEqual(out, src);
  check('13 MB data URL decodes byte-exact', diff === '', diff);
}

// 24 MB payload (near the screenshot data-URL cap), byte-exact.
{
  const src = patternedBytes(24_000_000);
  const out = dataUrlToBytes(toDataUrl(src));
  const diff = bytesEqual(out, src);
  check('24 MB data URL decodes byte-exact', diff === '', diff);
}

// Chunk boundary: base64 lengths around one 131072-char chunk.
{
  const a = patternedBytes(98304); // base64 is exactly 131072 chars
  const diffA = bytesEqual(dataUrlToBytes(toDataUrl(a)), a);
  check('chunk-exact payload decodes byte-exact', diffA === '', diffA);
  const b = patternedBytes(98307); // base64 is 131076 chars: one full chunk + 4
  const diffB = bytesEqual(dataUrlToBytes(toDataUrl(b)), b);
  check('chunk-plus-one-quantum payload decodes byte-exact', diffB === '', diffB);
}

// Blob form: media type and bytes survive.
{
  const src = patternedBytes(2048);
  const blob = dataUrlToBlob(toDataUrl(src, 'image/jpeg'));
  check('blob carries the data URL media type', blob.type === 'image/jpeg', blob.type);
  check('blob size matches the payload', blob.size === src.length, `${blob.size}`);
  const back = new Uint8Array(await blob.arrayBuffer());
  const diff = bytesEqual(back, src);
  check('blob bytes are byte-exact', diff === '', diff);
}

// Base64 with embedded whitespace (line-wrapped payloads) still decodes.
{
  const src = patternedBytes(3000);
  const b64 = Buffer.from(src).toString('base64').replace(/(.{76})/g, '$1\n');
  const diff = bytesEqual(dataUrlToBytes(`data:image/png;base64,${b64}`), src);
  check('whitespace-wrapped base64 decodes byte-exact', diff === '', diff);
}

// Non-base64 payloads: percent-decoded UTF-8 text.
{
  const out = dataUrlToBytes('data:text/plain,hello%20world');
  check('plain data URL decodes as UTF-8 text',
    new TextDecoder().decode(out) === 'hello world', new TextDecoder().decode(out));
  const bare = dataUrlToBlob('data:,abc');
  check('mime-less data URL defaults to text/plain', bare.type === 'text/plain', bare.type);
}

// Malformed input throws instead of decoding garbage.
{
  let threw = 0;
  for (const bad of ['https://example.com/x.png', 'data:no-comma', 42, null, undefined]) {
    try { dataUrlToBytes(bad); } catch { threw += 1; }
  }
  check('malformed inputs throw', threw === 5, `threw ${threw}/5`);
  let badB64Threw = false;
  try { dataUrlToBytes('data:image/png;base64,!!!not-base64!!!'); } catch { badB64Threw = true; }
  check('invalid base64 throws', badB64Threw);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
