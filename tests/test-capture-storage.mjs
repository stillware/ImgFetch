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
 * ImgFetch, tests/test-capture-storage.mjs
 * Round 4: capture record storage rules. Blob records (stitched parts)
 * and legacy dataUrl records coexist; pruning is bounded by age AND
 * total bytes AND count, and it never deletes part of a group that is
 * still open (a closed group is pruned whole or not at all). The
 * shared reader helpers (shared/capture-io.js) resolve either record
 * form. The IndexedDB round-trip itself is proven in the browser by
 * tests/test-e2e/tileloop-e2e.mjs and capture-e2e C12; here the pure
 * rules and the record-shape helpers are pinned down.
 */
import {
  captureRecordBytes,
  captureRecordMeta,
  pruneCaptureRecords,
  CAPTURE_STORAGE_MAX_BYTES,
  CAPTURE_STORAGE_MAX_AGE_MS,
  CAPTURE_STORAGE_MAX_RECORDS,
} from '../core/capture-storage.js';
import {
  captureRecordBlob,
  captureRecordObjectUrl,
} from '../shared/capture-io.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `, ${extra}` : ''}`); }
}

const NOW = 1_700_000_000_000;
const meta = (id, at, extra = {}) => ({ id, at, bytes: 100, ...extra });

// --- byte accounting ---
{
  const blob = new Blob([new Uint8Array(1234)], { type: 'image/png' });
  check('blob record bytes come from the blob', captureRecordBytes({ blob }) === 1234);
  check('explicit bytes win over nothing', captureRecordBytes({ bytes: 77 }) === 77);
  // 'data:image/png;base64,' is 22 chars; a 400-char payload decodes to 300 bytes.
  const dataUrl = `data:image/png;base64,${'A'.repeat(400)}`;
  check('dataUrl record bytes are the decoded size', captureRecordBytes({ dataUrl }) === 300);
  check('empty record is zero bytes', captureRecordBytes({}) === 0 && captureRecordBytes(null) === 0);
  check('meta normalizes group fields', (() => {
    const m = captureRecordMeta({ id: 'x', at: 5, groupId: 'g1', groupOpen: true, blob });
    return m.id === 'x' && m.at === 5 && m.groupId === 'g1' && m.groupOpen === true && m.bytes === 1234;
  })());
  check('caps are sane', CAPTURE_STORAGE_MAX_BYTES === 500_000_000
    && CAPTURE_STORAGE_MAX_AGE_MS === 3600_000 && CAPTURE_STORAGE_MAX_RECORDS === 60);
}

// --- reader helpers: both record forms ---
{
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  check('blob helper finds the blob', captureRecordBlob({ blob }) === blob);
  check('blob helper ignores dataUrl records', captureRecordBlob({ dataUrl: 'data:image/png;base64,AAAA' }) === null);
  check('blob helper ignores empty blobs', captureRecordBlob({ blob: new Blob([]) }) === null);
  const fromBlob = captureRecordObjectUrl({ blob });
  check('object url for a blob record is a blob: url', fromBlob.url.startsWith('blob:'));
  fromBlob.revoke();
  fromBlob.revoke(); // idempotent
  check('double revoke does not throw', true);
  const legacy = captureRecordObjectUrl({ dataUrl: 'data:image/png;base64,AAAA' });
  check('object url for a legacy record is the data url itself', legacy.url === 'data:image/png;base64,AAAA');
  legacy.revoke();
  let threw = false;
  try { captureRecordObjectUrl({}); } catch { threw = true; }
  check('object url for an empty record throws', threw);
  check('blob record round-trips through the meta path', (() => {
    const m = captureRecordMeta({ id: 'cap-1-1', at: NOW, blob, groupId: 'g', partIndex: 2 });
    return m.bytes === 4 && m.groupId === 'g';
  })());
}

// --- pruning: age ---
{
  const old = meta('old', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 1);
  const fresh = meta('fresh', NOW - 1000);
  const drop = pruneCaptureRecords([old, fresh], { now: NOW });
  check('age: stale record pruned, fresh kept', drop.length === 1 && drop[0] === 'old');
}

// --- pruning: open groups are untouchable, closed groups are atomic ---
{
  const openParts = [
    meta('p1', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 5000, { groupId: 'g-open', groupOpen: true }),
    meta('p2', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 4000, { groupId: 'g-open', groupOpen: true }),
  ];
  const drop = pruneCaptureRecords(openParts, { now: NOW, openGroupIds: [] });
  check('open group: fully stale means abandoned, pruned whole', drop.length === 2);
  const liveOpen = [
    meta('p1', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 5000, { groupId: 'g-live', groupOpen: true }),
    meta('p2', NOW - 1000, { groupId: 'g-live', groupOpen: true }),
  ];
  check('open group with a fresh part: never pruned', pruneCaptureRecords(liveOpen, { now: NOW }).length === 0);
  const viaOption = pruneCaptureRecords(
    [meta('p1', NOW - 1000, { groupId: 'g2' })],
    { now: NOW, openGroupIds: ['g2'] },
  );
  check('open group via option: protected too', viaOption.length === 0);
  const closedOld = [
    meta('c1', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 3000, { groupId: 'g-closed' }),
    meta('c2', NOW - 1000, { groupId: 'g-closed' }), // one fresh part
  ];
  const drop2 = pruneCaptureRecords(closedOld, { now: NOW });
  check('closed group: not pruned while any part is fresh', drop2.length === 0);
  const closedStale = [
    meta('c1', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 3000, { groupId: 'g-closed' }),
    meta('c2', NOW - CAPTURE_STORAGE_MAX_AGE_MS - 2000, { groupId: 'g-closed' }),
  ];
  const drop3 = pruneCaptureRecords(closedStale, { now: NOW });
  check('closed group: pruned whole when fully stale', drop3.length === 2);
}

// --- pruning: total bytes cap, oldest first, group-atomic ---
{
  const recs = [
    meta('a1', NOW - 3000, { bytes: 400, groupId: 'ga' }),
    meta('a2', NOW - 2900, { bytes: 400, groupId: 'ga' }),
    meta('b1', NOW - 2000, { bytes: 400 }),
    meta('c1', NOW - 1000, { bytes: 400 }),
  ];
  // Total 1600 over a 1000 cap: the oldest GROUP (800) goes whole,
  // never just one of its parts, then the total (800) fits.
  const drop = pruneCaptureRecords(recs, { now: NOW, maxBytes: 1000 });
  check('bytes cap: oldest group pruned whole', drop.length === 2 && drop.includes('a1') && drop.includes('a2'), drop.join(','));
  const withOpen = [
    meta('o1', NOW - 9000, { bytes: 900, groupId: 'go', groupOpen: true }),
    meta('n1', NOW - 1000, { bytes: 900 }),
  ];
  const drop2 = pruneCaptureRecords(withOpen, { now: NOW, maxBytes: 1000 });
  check('bytes cap: open group survives even when over cap alone remains', drop2.length === 1 && drop2[0] === 'n1');
}

// --- pruning: record count cap ---
{
  const recs = [];
  for (let i = 0; i < 10; i += 1) recs.push(meta(`r${i}`, NOW - 10000 + i * 100));
  const drop = pruneCaptureRecords(recs, { now: NOW, maxRecords: 4 });
  check('count cap: oldest dropped down to the cap', drop.length === 6 && drop[0] === 'r0' && !drop.includes('r9'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
