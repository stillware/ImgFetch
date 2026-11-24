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
 * ImgFetch, tests/test-history-b1.mjs
 * Node tests for Phase 5 item B1 (thumbnails for direct web downloads
 * and backfill): the serial queue (ordering, one at a time, rejection
 * isolation), the safe fetch helper (size cap, timeout, silent failure),
 * the backfill selection (cap 12, newest first, no-url skipped) and the
 * toggle-off rule (zero requests). Runs with plain Node, no dependencies:
 *   node tests/test-history-b1.mjs
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { strict as assert } from 'node:assert';
import {
  createSerialQueue,
  selectBackfillTargets,
  thumbFetchAllowed,
  fetchImageBytes,
  bytesToDataUrl,
  HIST_THUMB_FETCH_TIMEOUT_MS,
  HIST_THUMB_SOURCE_MAX_BYTES,
  HIST_THUMB_BACKFILL_MAX,
} from '../core/history.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Response-like stub for fetchImageBytes. */
function fakeResponse({ ok = true, bytes = new Uint8Array([1, 2, 3]), mime = 'image/png', length = null, url = 'https://example.com/a.png' } = {}) {
  let read = false;
  return {
    ok,
    url,
    headers: { get: (name) => (name === 'content-length' ? length : name === 'content-type' ? mime : null) },
    async arrayBuffer() {
      read = true;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    get bodyRead() { return read; },
  };
}

await test('serial queue runs one at a time, in enqueue order', async () => {
  const q = createSerialQueue();
  const starts = [];
  const ends = [];
  const job = (n, ms) => q.enqueue(async () => {
    starts.push(n);
    await sleep(ms);
    ends.push(n);
    return n;
  });
  const results = await Promise.all([job(1, 30), job(2, 10), job(3, 10)]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(starts, [1, 2, 3]);
  assert.deepEqual(ends, [1, 2, 3]);
  assert.equal(ends.indexOf(1) < starts.indexOf(2), true, 'job 2 must start after job 1 ends');
  assert.equal(ends.indexOf(2) < starts.indexOf(3), true, 'job 3 must start after job 2 ends');
});

await test('serial queue: a rejection is reported to its caller only, the chain continues', async () => {
  const q = createSerialQueue();
  const bad = q.enqueue(async () => { throw new Error('boom'); });
  await assert.rejects(bad, /boom/);
  const good = await q.enqueue(async () => 42);
  assert.equal(good, 42);
});

await test('fetchImageBytes fetches once with the safe policy and returns bytes', async () => {
  const seen = [];
  const res = fakeResponse({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), length: '4' });
  const out = await fetchImageBytes(async (url, init) => {
    seen.push([url, init]);
    return res;
  }, 'https://example.com/a.png');
  assert.equal(seen.length, 1, 'exactly one request');
  assert.equal(seen[0][0], 'https://example.com/a.png');
  assert.equal(seen[0][1].credentials, 'omit');
  assert.equal(seen[0][1].referrerPolicy, 'no-referrer');
  assert.deepEqual([...out.bytes], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.finalUrl, 'https://example.com/a.png');
  assert.equal(res.bodyRead, true);
});

await test('fetchImageBytes enforces the 25 MB cap from Content-Length without reading the body', async () => {
  const res = fakeResponse({ length: String(HIST_THUMB_SOURCE_MAX_BYTES + 1) });
  await assert.rejects(
    fetchImageBytes(async () => res, 'https://example.com/big.png'),
    /too-large/,
  );
  assert.equal(res.bodyRead, false, 'oversized body must not be read');
});

await test('fetchImageBytes enforces the 25 MB cap on the decoded body', async () => {
  const big = new Uint8Array(HIST_THUMB_SOURCE_MAX_BYTES + 1);
  const res = fakeResponse({ bytes: big, length: null });
  await assert.rejects(
    fetchImageBytes(async () => res, 'https://example.com/big.png'),
    /too-large/,
  );
});

await test('fetchImageBytes rejects non-OK responses and bad URLs without fetching', async () => {
  let calls = 0;
  await assert.rejects(
    fetchImageBytes(async () => fakeResponse({ ok: false }), 'https://example.com/a.png'),
    /fetch-failed/,
  );
  await assert.rejects(
    fetchImageBytes(async () => { calls += 1; return fakeResponse(); }, 'ftp://example.com/a.png'),
    /bad-url/,
  );
  assert.equal(calls, 0, 'bad URL must never be fetched');
});

await test('fetchImageBytes times out after 10 s (fast probe with a 20 ms timeout)', async () => {
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
  });
  await assert.rejects(
    fetchImageBytes(hanging, 'https://example.com/slow.png', { timeoutMs: 20 }),
    /timeout/,
  );
  assert.equal(HIST_THUMB_FETCH_TIMEOUT_MS, 10_000, 'default timeout is 10 s');
});

await test('selectBackfillTargets caps at 12, newest first, skips no-url and thumbed records', () => {
  const recs = [];
  for (let i = 0; i < 20; i += 1) {
    const r = { id: `r${i}`, filename: `f${i}.jpg` };
    if (i % 4 === 0) r.url = undefined; // no url, skipped
    else r.url = `https://example.com/${i}.jpg`;
    if (i % 5 === 0) r.thumb = 'data:image/jpeg;base64,AAAA'; // already thumbed, skipped
    recs.push(r);
  }
  assert.equal(HIST_THUMB_BACKFILL_MAX, 12);
  const targets = selectBackfillTargets(recs);
  assert.equal(targets.length, 12);
  assert.ok(targets.every((r) => r.url && !r.thumb), 'every target has a url and no thumb');
  assert.equal(targets[0].id, 'r1', 'newest eligible record first');
  assert.deepEqual(targets.map((r) => r.id), ['r1', 'r2', 'r3', 'r6', 'r7', 'r9', 'r11', 'r13', 'r14', 'r17', 'r18', 'r19']);
  assert.deepEqual(selectBackfillTargets([]), []);
  assert.deepEqual(selectBackfillTargets(null), []);
});

await test('thumbFetchAllowed: toggle off means no request, ever', () => {
  const rec = { url: 'https://example.com/a.png' };
  assert.equal(thumbFetchAllowed(null, rec), true, 'old settings default on');
  assert.equal(thumbFetchAllowed({ historyShowThumbnails: true }, rec), true);
  assert.equal(thumbFetchAllowed({ historyShowThumbnails: false }, rec), false, 'toggle off blocks the fetch');
  assert.equal(thumbFetchAllowed({ historyShowThumbnails: false }, { url: 'https://example.com/b.png' }), false);
  assert.equal(thumbFetchAllowed({ historyEnabled: false }, rec), false, 'history off blocks the fetch');
  assert.equal(thumbFetchAllowed({}, { url: 'data:image/png;base64,AAAA' }), false, 'data: urls are never fetched');
  assert.equal(thumbFetchAllowed({}, {}), false, 'records without a url are skipped');
  assert.equal(thumbFetchAllowed({}, { url: 'ftp://example.com/a.png' }), false);
});

await test('bytesToDataUrl round-trips through base64', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const url = bytesToDataUrl(bytes, 'image/png');
  assert.ok(url.startsWith('data:image/png;base64,'));
  const back = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));
  assert.deepEqual([...back], [...bytes]);
  assert.ok(bytesToDataUrl(bytes, 'text/html').startsWith('data:image/png;base64,'), 'non-image mime falls back to png');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
