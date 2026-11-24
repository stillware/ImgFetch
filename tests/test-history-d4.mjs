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
 * ImgFetch, tests/test-history-d4.mjs
 * Node test for Phase 5 item D4 (history read-modify-write race):
 * 20 parallel adds through one serial queue must all land, in order,
 * with nothing lost. A fake async store with a delay between read and
 * write reproduces the race: without serialisation the interleaved
 * writes overwrite each other. Runs with plain Node, no dependencies:
 *   node tests/test-history-d4.mjs
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { strict as assert } from 'node:assert';
import { createSerialQueue, addRecord } from '../core/history.js';

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

await test('D4: 20 parallel adds through one writer all land, in order', async () => {
  const queue = createSerialQueue();
  let stored = [];
  // Fake async store: read, wait (the race window), write back.
  const writeOne = (entry) => queue.enqueue(async () => {
    const read = [...stored];
    await sleep(5);
    stored = addRecord(read, entry);
    return stored[0].id;
  });
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) => writeOne({ filename: `photo-${i}.jpg`, url: `https://example.com/${i}.jpg`, dlId: i })),
  );
  assert.equal(new Set(ids).size, 20, 'every add returns a distinct id');
  assert.equal(stored.length, 20, `all 20 records must survive, got ${stored.length}`);
  assert.deepEqual(
    stored.map((r) => r.filename),
    Array.from({ length: 20 }, (_, i) => `photo-${19 - i}.jpg`),
    'newest first, in enqueue order',
  );
  assert.ok(stored.every((r) => typeof r.url === 'string' && Number.isInteger(r.dlId)), 'every record keeps its url and dlId');
});

await test('D4: without the queue the same interleaving loses records (race reproduced)', async () => {
  let stored = [];
  const writeOne = async (entry) => {
    const read = [...stored];
    await sleep(5);
    stored = addRecord(read, entry);
  };
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => writeOne({ filename: `photo-${i}.jpg` })),
  );
  assert.ok(stored.length < 20, `unserialised writes must lose records, got ${stored.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
