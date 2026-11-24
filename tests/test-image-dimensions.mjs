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
 * ImgFetch: tests/test-image-dimensions.mjs
 * Node unit tests for imageDimensions in core/history.js, Phase 6 item 6
 * (security recommendation REC-2): AVIF and TIFF header parsing, plus
 * regression checks that the older formats still parse and that hostile
 * or truncated headers return null instead of throwing or reading past
 * the buffer. Prints "N passed, M failed", exits nonzero on failure.
 * Run: node tests/test-image-dimensions.mjs
 */
import { imageDimensions, assertImagePixelBudget } from '../core/history.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}
const eq = (d, w, h) => d !== null && d.w === w && d.h === h;

/** One ISOBMFF box: 4-byte big-endian size, 4-byte type, content. */
function box(type, content) {
  const out = new Uint8Array(8 + content.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(content, 8);
  return out;
}
function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** ImageSpatialExtents box for w by h (version/flags are zero). */
function ispe(w, h) {
  const content = new Uint8Array(12);
  const dv = new DataView(content.buffer);
  dv.setUint32(4, w);
  dv.setUint32(8, h);
  return box('ispe', content);
}
/** Minimal ftyp box: brand plus minor version, no compatible brands. */
function ftyp(brand = 'avif') {
  const content = new Uint8Array(8);
  for (let i = 0; i < 4; i += 1) content[i] = brand.charCodeAt(i);
  return box('ftyp', content);
}
/** meta box holding one iprp/ipco chain with the given ispe boxes. */
function avifWithIspe(...specs) {
  const ipco = box('ipco', concat(...specs.map(([w, h]) => ispe(w, h))));
  const iprp = box('iprp', ipco);
  return concat(ftyp(), box('meta', concat(new Uint8Array(4), iprp)));
}

// ---- AVIF ---------------------------------------------------------------
check('AVIF: minimal file reads 640x480', eq(imageDimensions(avifWithIspe([640, 480])), 640, 480));
check('AVIF: avis brand reads 320x240', eq(imageDimensions(concat(
  ftyp('avis'),
  box('meta', concat(new Uint8Array(4), box('iprp', box('ipco', ispe(320, 240))))),
)), 320, 240));
check('AVIF: several ispe boxes, largest by area wins',
  eq(imageDimensions(avifWithIspe([10, 10], [1920, 1080], [400, 300])), 1920, 1080));
check('AVIF: ftyp only (no meta) returns null', imageDimensions(ftyp()) === null);
check('AVIF: meta without iprp returns null',
  imageDimensions(concat(ftyp(), box('meta', new Uint8Array(4)))) === null);
check('AVIF: ispe with zero width returns null',
  imageDimensions(avifWithIspe([0, 480])) === null);
check('AVIF: meta box size lying past the end returns null', (() => {
  const bad = concat(ftyp(), box('meta', concat(new Uint8Array(4), box('iprp', box('ipco', ispe(640, 480))))));
  const dv = new DataView(bad.buffer);
  dv.setUint32(ftyp().length, 100000);
  return imageDimensions(bad) === null;
})());
check('AVIF: largesize (size 1) top-level box returns null', (() => {
  const bad = concat(ftyp(), box('meta', concat(new Uint8Array(4), box('iprp', box('ipco', ispe(640, 480))))));
  const dv = new DataView(bad.buffer);
  dv.setUint32(0, 1);
  return imageDimensions(bad) === null;
})());
check('AVIF: truncated ispe returns null', (() => {
  const full = avifWithIspe([640, 480]);
  return imageDimensions(full.slice(0, full.length - 4)) === null;
})());
check('AVIF: ispe inside the first 64 bytes (offscreen head slice) parses', (() => {
  const full = avifWithIspe([640, 480]);
  return full.length <= 64 && eq(imageDimensions(full.slice(0, 64)), 640, 480);
})(), `full length ${avifWithIspe([640, 480]).length}`);
check('AVIF: ispe pushed past 64 bytes returns null (falls back to probe)', (() => {
  const hdlr = box('hdlr', new Uint8Array(40));
  const meta = box('meta', concat(new Uint8Array(4), hdlr, box('iprp', box('ipco', ispe(640, 480)))));
  const full = concat(ftyp(), meta);
  return full.length > 64 && imageDimensions(full.slice(0, 64)) === null;
})());
check('AVIF: huge claimed size reaches the pixel budget', (() => {
  const dims = imageDimensions(avifWithIspe([100000, 100000]));
  if (!dims || dims.w !== 100000 || dims.h !== 100000) return false;
  try { assertImagePixelBudget(dims.w, dims.h); return false; }
  catch (e) { return e.message === 'too-large'; }
})());

/** One TIFF file: header, IFD offset 8, entries as [tag, type, count, value]. */
function tiff(le, entries) {
  const n = 8 + 2 + entries.length * 12 + 4;
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  if (le) { out.set([0x49, 0x49, 0x2A, 0x00]); dv.setUint32(4, 8, true); }
  else { out.set([0x4D, 0x4D, 0x00, 0x2A]); dv.setUint32(4, 8, false); }
  dv.setUint16(8, entries.length, le);
  entries.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, tag, le);
    dv.setUint16(e + 2, type, le);
    dv.setUint32(e + 4, count, le);
    if (type === 3) dv.setUint16(e + 8, value, le);
    else dv.setUint32(e + 8, value, le);
  });
  return out;
}

// ---- TIFF ---------------------------------------------------------------
check('TIFF LE: SHORT width, LONG height reads 800x600',
  eq(imageDimensions(tiff(true, [[256, 3, 1, 800], [257, 4, 1, 600]])), 800, 600));
check('TIFF LE: LONG width, SHORT height reads 320x240',
  eq(imageDimensions(tiff(true, [[256, 4, 1, 320], [257, 3, 1, 240]])), 320, 240));
check('TIFF BE: LONG width, SHORT height reads 320x240',
  eq(imageDimensions(tiff(false, [[256, 4, 1, 320], [257, 3, 1, 240]])), 320, 240));
check('TIFF BE: SHORT width, LONG height reads 800x600',
  eq(imageDimensions(tiff(false, [[256, 3, 1, 800], [257, 4, 1, 600]])), 800, 600));
check('TIFF: entries in any order still parse',
  eq(imageDimensions(tiff(true, [[257, 3, 1, 240], [256, 3, 1, 320]])), 320, 240));
check('TIFF: extra unknown tags are ignored',
  eq(imageDimensions(tiff(true, [[258, 3, 1, 8], [256, 3, 1, 64], [257, 3, 1, 48], [259, 3, 1, 1]])), 64, 48));
check('TIFF: 4-byte header returns null',
  imageDimensions(new Uint8Array([0x49, 0x49, 0x2A, 0x00])) === null);
check('TIFF: IFD offset past the end returns null', (() => {
  const b = tiff(true, [[256, 3, 1, 800], [257, 3, 1, 600]]);
  new DataView(b.buffer).setUint32(4, 100000, true);
  return imageDimensions(b) === null;
})());
check('TIFF: missing height returns null',
  imageDimensions(tiff(true, [[256, 3, 1, 800]])) === null);
check('TIFF: count 2 on the width entry returns null',
  imageDimensions(tiff(true, [[256, 3, 2, 800], [257, 3, 1, 600]])) === null);
check('TIFF: zero width returns null',
  imageDimensions(tiff(true, [[256, 3, 1, 0], [257, 3, 1, 600]])) === null);
check('TIFF: truncated IFD entry returns null', (() => {
  const b = tiff(true, [[256, 3, 1, 800], [257, 3, 1, 600]]);
  return imageDimensions(b.slice(0, 20)) === null;
})());

// ---- Regression: older formats still parse, hostile input is safe -------
check('PNG still reads 64x48', eq(imageDimensions(new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x30,
])), 64, 48));
check('GIF still reads 200x120', eq(imageDimensions(concat(
  new TextEncoder().encode('GIF89a'), new Uint8Array([200, 0, 120, 0]),
)), 200, 120));
check('JPEG still reads 320x240 from SOF0', eq(imageDimensions(new Uint8Array([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0xF0, 0x01, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
])), 320, 240));
// Phase 6 (F-P6-13): a fake SOF hidden in the entropy data after SOS must
// never be read. Before the fix this returned the fake 7680x10000.
check('JPEG fake SOF after SOS returns null', imageDimensions(new Uint8Array([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
  0x11, 0x22, 0x33, 0x44,
  0xFF, 0xC0, 0x00, 0x11, 0x08, 0x27, 0x10, 0x1E, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
])) === null);
check('JPEG real SOF0 before SOS still reads 320x240', eq(imageDimensions(new Uint8Array([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0xF0, 0x01, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x11, 0x22,
])), 320, 240));
check('WebP VP8X still reads 100x50', eq(imageDimensions(concat(
  new TextEncoder().encode('RIFF'), new Uint8Array([0x1E, 0, 0, 0]),
  new TextEncoder().encode('WEBPVP8X'), new Uint8Array([10, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 49, 0, 0]),
)), 100, 50));
check('BMP still reads 10x20', eq(imageDimensions(new Uint8Array([
  0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0,
])), 10, 20));
check('ICO still reads 32x32', eq(imageDimensions(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x20, 0x20, 0, 0])), 32, 32));
check('Unknown bytes return null',
  imageDimensions(new TextEncoder().encode('hello world, not an image')) === null);
check('Empty and short input returns null',
  imageDimensions(new Uint8Array([])) === null && imageDimensions(new Uint8Array([0x89, 0x50])) === null
  && imageDimensions(null) === null);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
