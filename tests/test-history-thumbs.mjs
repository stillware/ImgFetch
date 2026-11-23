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
 * ImgFetch unit tests, runs with plain Node, no dependencies:
 *   node tests/test-history-thumbs.mjs
 *
 * Stage 3 (history thumbnails and actions): addRecord whitelist and caps
 * for thumb, url and dlId, the total thumb budget, old records still
 * loading, the extension-stripping helper, the plural file-count labels
 * from the real locale files, and the raised caps. Thumbnail pixels are
 * verified live in the browser harness (scratch/stage3-verify.mjs):
 * Node has no createImageBitmap, so makeHistoryThumb is only checked
 * here for failing cleanly without worker APIs.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as history from '../core/history.js';
import { resolveMessage } from '../shared/i18n.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; })
    .catch((err) => {
      failed += 1;
      failures.push(`${name}: ${err.message}`);
    });
}

/** A base64 data URL whose decoded size is exactly `bytes`. */
function thumbOf(bytes, mime = 'image/jpeg') {
  const chars = Math.ceil(bytes * 4 / 3);
  return `data:${mime};base64,${'A'.repeat(chars)}`;
}

function totalThumbs(records) {
  return records.reduce((sum, r) => sum + history.thumbByteSize(r.thumb), 0);
}

await test('addRecord keeps a valid thumb, url and dlId', () => {
  const recs = history.addRecord([], {
    filename: 'photo.jpg',
    thumb: thumbOf(8000),
    url: 'https://example.com/photo.jpg',
    dlId: 42,
  });
  assert.equal(recs[0].thumb, thumbOf(8000));
  assert.equal(recs[0].url, 'https://example.com/photo.jpg');
  assert.equal(recs[0].dlId, 42);
  assert.equal(recs[0].filename, 'photo.jpg');
});

await test('addRecord drops non-http urls', () => {
  for (const url of [
    'ftp://example.com/a.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '/relative/path.jpg',
    'example.com/a.jpg',
  ]) {
    const recs = history.addRecord([], { filename: 'a.jpg', url });
    assert.equal(recs[0].url, undefined, url);
  }
  const trimmed = history.addRecord([], { filename: 'a.jpg', url: '  https://example.com/a.jpg  ' });
  assert.equal(trimmed[0].url, 'https://example.com/a.jpg');
  const long = history.addRecord([], { filename: 'a.jpg', url: `https://example.com/${'a'.repeat(2040)}` });
  assert.equal(long[0].url, undefined);
});

await test('addRecord drops oversized or wrong-type thumbs', () => {
  const big = history.addRecord([], { filename: 'a.jpg', thumb: thumbOf(12_289) });
  assert.equal(big[0].thumb, undefined);
  const exact = history.addRecord([], { filename: 'a.jpg', thumb: thumbOf(12_288) });
  assert.equal(exact[0].thumb, thumbOf(12_288));
  for (const thumb of [
    thumbOf(100, 'image/png'),
    thumbOf(100, 'image/gif'),
    'data:text/plain;base64,AAAA',
    'https://example.com/thumb.jpg',
    1234,
  ]) {
    const recs = history.addRecord([], { filename: 'a.jpg', thumb });
    assert.equal(recs[0].thumb, undefined, String(thumb).slice(0, 30));
  }
  const webp = history.addRecord([], { filename: 'a.jpg', thumb: thumbOf(5000, 'image/webp') });
  assert.equal(webp[0].thumb, thumbOf(5000, 'image/webp'));
});

await test('addRecord drops bad download ids, keeps zero', () => {
  for (const dlId of [1.5, -1, '7', null, NaN]) {
    const recs = history.addRecord([], { filename: 'a.jpg', dlId });
    assert.equal(recs[0].dlId, undefined, String(dlId));
  }
  assert.equal(history.addRecord([], { filename: 'a.jpg', dlId: 0 })[0].dlId, 0);
});

await test('addRecord never stores a transient thumbSource', () => {
  const recs = history.addRecord([], {
    filename: 'a.jpg',
    thumbSource: 'data:image/png;base64,AAAA',
  });
  assert.equal(recs[0].thumbSource, undefined);
  assert.equal('thumbSource' in recs[0], false);
});

await test('old records without the new fields keep working', () => {
  const recs = history.addRecord([], { filename: 'old.png', bytes: 1024, kind: 'screenshot' });
  assert.equal(recs[0].thumb, undefined);
  assert.equal(recs[0].url, undefined);
  assert.equal(recs[0].dlId, undefined);
  assert.equal(recs[0].filename, 'old.png');
  assert.equal(recs[0].bytes, 1024);
  assert.equal(recs[0].kind, 'screenshot');
  const groups = history.groupByDay(recs);
  assert.equal(groups[0].items[0].filename, 'old.png');
});

await test('total thumb budget drops the oldest thumbs first', () => {
  const big = thumbOf(20_001);
  const list = [];
  for (let i = 0; i < 200; i += 1) list.push({ filename: `${i}.jpg`, thumb: big, at: Date.now() - i * 1000 });
  const kept = history.enforceThumbBudget(list);
  assert.ok(totalThumbs(kept) <= history.HIST_THUMB_MAX_TOTAL_BYTES, `total ${totalThumbs(kept)}`);
  assert.equal(kept.length, 200);
  assert.ok(kept[0].thumb, 'newest keeps its thumb');
  assert.ok(kept[156].thumb, '157 newest keep their thumbs');
  assert.equal(kept[157].thumb, undefined, 'oldest thumbs are dropped first');
  assert.equal(kept[199].thumb, undefined);
});

await test('addRecord enforces the budget on a list that is already over it', () => {
  const big = thumbOf(20_001);
  const list = [];
  for (let i = 0; i < 200; i += 1) list.push({ filename: `${i}.jpg`, thumb: big, at: Date.now() - i * 1000 });
  const recs = history.addRecord(list, { filename: 'new.jpg' });
  assert.equal(recs.length, 200);
  assert.equal(recs[0].filename, 'new.jpg');
  assert.ok(totalThumbs(recs) <= history.HIST_THUMB_MAX_TOTAL_BYTES, `total ${totalThumbs(recs)}`);
  assert.equal(recs[199].thumb, undefined);
});

await test('200 max-size thumbs stay inside the 3 MB budget', () => {
  let recs = [];
  for (let i = 0; i < 200; i += 1) {
    recs = history.addRecord(recs, { filename: `${i}.jpg`, thumb: thumbOf(12_288) });
  }
  assert.equal(recs.length, 200);
  assert.ok(recs.every((r) => r.thumb), 'every record keeps its thumb');
  assert.ok(totalThumbs(recs) <= history.HIST_THUMB_MAX_TOTAL_BYTES);
  assert.equal(totalThumbs(recs), 200 * 12_288);
});

await test('pruneRecords enforces the thumb budget too', () => {
  const big = thumbOf(20_001);
  const list = [];
  for (let i = 0; i < 200; i += 1) list.push({ filename: `${i}.jpg`, thumb: big, at: Date.now() });
  const pruned = history.pruneRecords(list, 30);
  assert.equal(pruned.length, 200);
  assert.ok(totalThumbs(pruned) <= history.HIST_THUMB_MAX_TOTAL_BYTES);
});

await test('raised caps: 120 px thumbs, 12 KB each, 3 MB total', () => {
  assert.equal(history.HIST_THUMB_SIZE, 120);
  assert.equal(history.HIST_THUMB_MAX_BYTES, 12_288);
  assert.equal(history.HIST_THUMB_MIN_QUALITY, 0.6);
  assert.equal(history.HIST_THUMB_MAX_TOTAL_BYTES, 3_145_728);
  assert.equal(history.MAX_RECORDS, 200);
  assert.equal(history.thumbByteSize('data:image/jpeg;base64,AAAA'), 3);
  assert.equal(history.thumbByteSize('data:image/jpeg;base64,AAA='), 2);
  assert.equal(history.thumbByteSize('not a data url'), 0);
});

await test('stripImageExtension', () => {
  const strip = history.stripImageExtension;
  assert.equal(strip('photo.jpg'), 'photo');
  assert.equal(strip('31fPUs-jAmL._AC_SR240,240_.jpg'), '31fPUs-jAmL._AC_SR240,240_');
  assert.equal(strip('41rL3nFU5DL._AC_SR240,240_.JPG'), '41rL3nFU5DL._AC_SR240,240_');
  assert.equal(strip('archive.tar.png'), 'archive.tar');
  assert.equal(strip('photo.JPEG'), 'photo');
  assert.equal(strip('pic.avif'), 'pic');
  assert.equal(strip('pic.svg'), 'pic');
  assert.equal(strip('pic.bmp'), 'pic');
  assert.equal(strip('pic.webp'), 'pic');
  assert.equal(strip('pic.gif'), 'pic');
  assert.equal(strip('noextension'), 'noextension');
  assert.equal(strip('.png'), '.png');
  assert.equal(strip('photo.xyz'), 'photo.xyz');
  assert.equal(strip('photo.'), 'photo.');
  assert.equal(strip(''), '');
});

function plainDict(code) {
  const raw = JSON.parse(readFileSync(join(PROJ, '_locales', code, 'messages.json'), 'utf8'));
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.message]));
}

await test('plural file-count labels from the real locale files', () => {
  const en = plainDict('en');
  assert.equal(resolveMessage([en], 'history_files', { count: 1 }, 'en'), '1 file');
  assert.equal(resolveMessage([en], 'history_files', { count: 79 }, 'en'), '79 files');
  const ru = plainDict('ru');
  assert.equal(resolveMessage([ru], 'history_files', { count: 1 }, 'ru'), '1 файл');
  assert.equal(resolveMessage([ru], 'history_files', { count: 2 }, 'ru'), '2 файла');
  assert.equal(resolveMessage([ru], 'history_files', { count: 5 }, 'ru'), '5 файлов');
  assert.equal(resolveMessage([ru], 'history_files', { count: 21 }, 'ru'), '21 файл');
  assert.equal(resolveMessage([ru], 'history_files', { count: 79 }, 'ru'), '79 файлов');
  const ar = plainDict('ar');
  assert.equal(resolveMessage([ar], 'history_files', { count: 0 }, 'ar'), '0 ملفات');
  assert.equal(resolveMessage([ar], 'history_files', { count: 1 }, 'ar'), '1 ملف');
  assert.equal(resolveMessage([ar], 'history_files', { count: 2 }, 'ar'), '2 ملفان');
  assert.equal(resolveMessage([ar], 'history_files', { count: 3 }, 'ar'), '3 ملفات');
  assert.equal(resolveMessage([ar], 'history_files', { count: 11 }, 'ar'), '11 ملفا');
  const ja = plainDict('ja');
  assert.equal(resolveMessage([ja], 'history_files', { count: 79 }, 'ja'), '79件のファイル');
  const pl = plainDict('pl');
  assert.equal(resolveMessage([pl], 'history_files', { count: 1 }, 'pl'), '1 plik');
  assert.equal(resolveMessage([pl], 'history_files', { count: 3 }, 'pl'), '3 pliki');
  assert.equal(resolveMessage([pl], 'history_files', { count: 5 }, 'pl'), '5 plików');
});

await test('makeHistoryThumb fails cleanly without worker APIs', async () => {
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await assert.rejects(history.makeHistoryThumb(tiny), /unsupported/);
  await assert.rejects(history.makeHistoryThumb('https://example.com/a.png'), /unsupported/);
});

await test('clear: an emptied list starts fresh with no leftover fields', () => {
  const before = history.addRecord([], {
    filename: 'a.jpg', thumb: thumbOf(1000), url: 'https://example.com/a.jpg', dlId: 9,
  });
  assert.equal(before.length, 1);
  const cleared = [];
  const after = history.addRecord(cleared, { filename: 'b.jpg' });
  assert.equal(after.length, 1);
  assert.equal(after[0].filename, 'b.jpg');
  assert.equal(after[0].thumb, undefined);
  assert.equal(after[0].url, undefined);
  assert.equal(after[0].dlId, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
