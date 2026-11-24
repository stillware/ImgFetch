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
 * ImgFetch Phase 5 bug-fix tests (D1, D2, D3, D5), plain Node, no deps:
 *   node tests/test-phase5-bugs.mjs
 *
 * D1: rename page keeps user-typed text when the async suggestion lands
 *     late, and bulk payloads carry a custom name through.
 * D2: data:image URLs up to 50 MB decoded are accepted for download.
 * D3: re-downloading already downloaded images runs again (queue).
 * D5: the scanner counts exact-URL duplicates in scanPage().deduped.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeUrl, dataUrlDecodedSize, DATA_URL_DOWNLOAD_MAX_DECODED } from '../core/urls.js';
import { DownloadQueue } from '../core/queue.js';
import { bulkItemPayload } from '../core/bulk-payload.js';

// ---- minimal browser globals so content/scanner.js loads ----
globalThis.window = {};
globalThis.chrome = { runtime: { sendMessage() {} } };
globalThis.getComputedStyle = (el) =>
  (el && el.__style) || { display: 'block', visibility: 'visible', opacity: '1' };
globalThis.location = { href: 'https://example.com/page' };

await import('../content/scanner.js');
const { scanPage } = globalThis.window.__imgfetch;
assert.equal(typeof scanPage, 'function', 'scanPage is exposed');

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
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------------- D2: data URL size cap ---------------- */

await test('D2: dataUrlDecodedSize measures base64, padding and percent payloads', () => {
  assert.equal(dataUrlDecodedSize('data:image/png;base64,ABCD'), 3);
  assert.equal(dataUrlDecodedSize('data:image/png;base64,ABC='), 2);
  assert.equal(dataUrlDecodedSize('data:image/png;base64,AB=='), 1);
  assert.equal(dataUrlDecodedSize('data:image/png;base64,AB==\n'), 1);
  assert.equal(dataUrlDecodedSize('data:image/svg+xml,%3Csvg%3E'), 5);
  assert.equal(dataUrlDecodedSize('data:image/svg+xml,plain'), 5);
  assert.equal(dataUrlDecodedSize('data:image/png;base64,%ZZ'), Infinity);
  assert.equal(dataUrlDecodedSize('data:image/png;base64'), Infinity);
  assert.equal(dataUrlDecodedSize('https://example.com/a.png'), Infinity);
  assert.equal(dataUrlDecodedSize(null), Infinity);
  assert.equal(DATA_URL_DOWNLOAD_MAX_DECODED, 50_000_000);
});

await test('D2: normalizeUrl accepts 5 MB and 30 MB data URLs', () => {
  for (const mb of [5, 30]) {
    const b64 = Buffer.alloc(mb * 1_000_000).toString('base64');
    const url = `data:image/png;base64,${b64}`;
    assert.equal(dataUrlDecodedSize(url), mb * 1_000_000);
    assert.equal(normalizeUrl(url, null), url);
  }
});

await test('D2: normalizeUrl rejects over-cap data URLs, non-images, long http URLs', () => {
  const over = `data:image/png;base64,${Buffer.alloc(DATA_URL_DOWNLOAD_MAX_DECODED + 1).toString('base64')}`;
  assert.equal(normalizeUrl(over, null), null);
  assert.equal(normalizeUrl('data:text/plain,hi', null), null);
  assert.equal(normalizeUrl('data:image/png;base64,AAAA', null), 'data:image/png;base64,AAAA');
  assert.equal(normalizeUrl(`https://example.com/${'a'.repeat(8192)}`, null), null);
  assert.equal(normalizeUrl('https://example.com/a.png', null), 'https://example.com/a.png');
});

/* ---------------- D1: custom names ---------------- */

await test('D1: bulkItemPayload carries customName, caps at 120, drops non-strings', () => {
  const p = bulkItemPayload(
    { srcUrl: 'https://cdn.test/a.jpg', mode: 'normal', format: 'as-is', customName: 'my bulk pic' },
    { mode: 'normal', pageUrl: 'https://site.test/', pageTitle: 'T', tabId: 3 },
  );
  assert.equal(p.kind, 'bulk');
  assert.equal(p.customName, 'my bulk pic');
  const capped = bulkItemPayload(
    { srcUrl: 'https://cdn.test/a.jpg', customName: 'x'.repeat(200) },
    { mode: 'normal' },
  );
  assert.equal(capped.customName.length, 120);
  const dropped = bulkItemPayload(
    { srcUrl: 'https://cdn.test/a.jpg', customName: 42 },
    { mode: 'normal' },
  );
  assert.equal(dropped.customName, '');
  // A non-ASCII (RTL) custom name is preserved verbatim by the payload;
  // whether the browser accepts it as a filename is the download API's
  // decision, not the payload's.
  const rtl = bulkItemPayload(
    { srcUrl: 'https://cdn.test/a.jpg', customName: 'صورة مخصصة' },
    { mode: 'normal' },
  );
  assert.equal(rtl.customName, 'صورة مخصصة');
});

/** Load pages/rename.js in a vm with stub DOM + controllable UI.send. */
function loadRenamePage() {
  const src = fs.readFileSync(new URL('../pages/rename.js', import.meta.url), 'utf-8');
  const el = () => ({
    value: '',
    textContent: '',
    src: '',
    disabled: false,
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    focus() {},
    select() {},
  });
  const els = {
    preview: el(),
    filename: el(),
    formatHint: el(),
    btnSave: el(),
    btnCancel: el(),
  };
  const sent = [];
  let resolveSettings;
  let resolveSuggest;
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document: { getElementById: (id) => els[id] || el() },
    location: { search: '?src=https%3A%2F%2Fx.test%2Fa.png&mode=smart&format=as-is&pageUrl=https%3A%2F%2Fx.test%2F&tabId=1' },
  };
  sandbox.window = sandbox;
  sandbox.window.ImgFetchUI = {
    applyTheme() {},
    send(type, payload) {
      sent.push({ type, payload });
      if (type === 'GET_SETTINGS') return new Promise((r) => { resolveSettings = r; });
      if (type === 'SUGGEST_FILENAME') return new Promise((r) => { resolveSuggest = r; });
      return Promise.resolve({ ok: true });
    },
  };
  sandbox.window.close = () => {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'rename.js' });
  const fire = (element, ev) => {
    for (const fn of element.listeners[ev] || []) fn({ key: ev === 'keydown' ? 'Enter' : undefined });
  };
  return {
    els,
    sent,
    fire,
    resolveSettings: (v) => { resolveSettings(v); },
    resolveSuggest: (v) => { resolveSuggest(v); },
  };
}

await test('D1: rename page keeps typed text when the suggestion lands late, Save sends it', async () => {
  const page = loadRenamePage();
  await tick();
  // The user types before the async suggestion resolves (slow worker wake).
  page.els.filename.value = 'my custom name';
  page.fire(page.els.filename, 'input');
  page.resolveSettings({ settings: { theme: 'light' } });
  await tick();
  await tick();
  page.resolveSuggest({ name: 'suggested.png' });
  await tick();
  await tick();
  assert.equal(page.els.filename.value, 'my custom name');
  // Save sends the typed name, not the suggestion.
  page.fire(page.els.btnSave, 'click');
  await tick();
  await tick();
  const dl = page.sent.find((s) => s.type === 'DOWNLOAD_IMAGE');
  assert.ok(dl, 'DOWNLOAD_IMAGE was sent');
  assert.equal(dl.payload.customName, 'my custom name');
});

await test('D1: rename page applies the suggestion when the field is untouched', async () => {
  const page = loadRenamePage();
  await tick();
  page.resolveSettings({ settings: { theme: 'light' } });
  await tick();
  await tick();
  page.resolveSuggest({ name: 'suggested.png' });
  await tick();
  await tick();
  assert.equal(page.els.filename.value, 'suggested.png');
});

/* ---------------- D3: re-download ---------------- */

await test('D3: queue re-enqueues done items, a second download runs', async () => {
  const calls = [];
  const q = new DownloadQueue({
    concurrency: 2,
    maxAttempts: 1,
    starter: async (item) => { calls.push(item.id); },
  });
  q.enqueue([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]);
  await sleep(50);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(q.snapshot().done, 2);
  q.enqueue([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]);
  await sleep(50);
  assert.deepEqual(calls, ['a', 'b', 'a', 'b']);
  assert.equal(q.snapshot().total, 2);
  assert.equal(q.snapshot().done, 2);
});

await test('D3: queue does not duplicate an item that is still active', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const q = new DownloadQueue({
    concurrency: 1,
    maxAttempts: 1,
    starter: async (item) => { calls.push(item.id); await gate; },
  });
  q.enqueue([{ id: 'a', label: 'a' }]);
  await sleep(30);
  q.enqueue([{ id: 'a', label: 'a' }]);
  await sleep(30);
  assert.deepEqual(calls, ['a']);
  assert.equal(q.snapshot().total, 1);
  release();
  await sleep(30);
  assert.equal(q.snapshot().done, 1);
});

await test('D3: queue re-enqueues failed items', async () => {
  const tries = new Map();
  const q = new DownloadQueue({
    concurrency: 1,
    maxAttempts: 1,
    starter: async (item) => {
      const n = (tries.get(item.id) || 0) + 1;
      tries.set(item.id, n);
      if (n === 1) throw new Error('boom');
    },
  });
  q.enqueue([{ id: 'a', label: 'a' }]);
  await sleep(50);
  assert.equal(q.snapshot().failed, 1);
  q.enqueue([{ id: 'a', label: 'a' }]);
  await sleep(50);
  assert.equal(tries.get('a'), 2);
  assert.equal(q.snapshot().done, 1);
});

/* ---------------- D5: scanner dedupe counter ---------------- */

function fakeImg(src, w = 300, h = 200) {
  return {
    currentSrc: src,
    src,
    naturalWidth: w,
    naturalHeight: h,
    parentElement: null,
    getBoundingClientRect: () => ({ width: w, height: h }),
    getAttribute: (n) => (n === 'src' ? src : ''),
    hasAttribute: () => false,
    closest: (sel) => (/main|article|figure/.test(sel) ? {} : null),
    __style: undefined,
  };
}

function fakeDocument(imgs) {
  return {
    title: 'dup page',
    baseURI: 'https://example.com/page',
    querySelectorAll: (sel) => {
      if (sel === 'img') return imgs;
      return [];
    },
    querySelector: () => null,
  };
}

await test('D5: scanPage counts exact-URL duplicates in deduped', async () => {
  const red = 'https://example.com/red.png';
  const green = 'https://example.com/green.png';
  const blue = 'https://example.com/blue.png';
  globalThis.document = fakeDocument([
    fakeImg(red), fakeImg(red), fakeImg(red),
    fakeImg(green), fakeImg(green),
    fakeImg(blue),
  ]);
  const res = await scanPage({ includeBackgrounds: false, minLongest: 0 });
  assert.equal(res.images.length, 3);
  assert.equal(res.deduped, 3);
  assert.deepEqual(
    res.images.map((i) => i.src).sort(),
    [blue, green, red].sort(),
  );
});

await test('D5: scanPage reports deduped 0 with no duplicates', async () => {
  globalThis.document = fakeDocument([
    fakeImg('https://example.com/a.png'),
    fakeImg('https://example.com/b.png'),
  ]);
  const res = await scanPage({ includeBackgrounds: false, minLongest: 0 });
  assert.equal(res.images.length, 2);
  assert.equal(res.deduped, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
