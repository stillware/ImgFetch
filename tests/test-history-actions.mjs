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
 * ImgFetch, tests/test-history-actions.mjs
 * Node tests for Phase 5 items B2 (Open opens the file in the default
 * app) and B3 (Copy copies the image, not the link), plus the B1 thumb
 * visibility rule, against the shared row in shared/history-ui.js with
 * hand-rolled browser stubs (no jsdom). Runs with plain Node:
 *   node tests/test-history-actions.mjs
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { strict as assert } from 'node:assert';
import { decideOpenFile } from '../core/history.js';

/* ---------------- hand-rolled browser stubs ---------------- */

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this._attrs = new Map();
    this._listeners = new Map();
    this._classes = new Set();
    this._text = '';
    this.title = '';
    this.alt = '';
    this.draggable = false;
    this.width = 0;
    this.height = 0;
    this.src = '';
    this.type = '';
    this.checked = false;
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    return {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); }
  get childNodes() { return this.children; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      n.parentNode = this;
      this.children.push(n);
    }
    return this;
  }
  appendChild(n) { return this.append(n); }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  querySelector(sel) {
    const found = this.findAll((el) => matches(el, sel));
    return found[0] || null;
  }
  findAll(pred) {
    const out = [];
    const walk = (el) => {
      if (pred(el)) out.push(el);
      for (const c of el.children) walk(c);
    };
    walk(this);
    return out;
  }
  click() {
    const handlers = this._listeners.get('click') || [];
    for (const fn of handlers) fn({ stopPropagation() {} });
  }
}

function matches(el, sel) {
  if (sel.startsWith('.')) return el._classes.has(sel.slice(1));
  return false;
}

const drawnImages = [];
const bitmapCalls = [];
let canvasToBlobBehavior = 'ok';

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...a) => drawnImages.push(a) }),
    toBlob: (cb, type) => {
      if (canvasToBlobBehavior === 'null') cb(null);
      else cb({ type: type || 'image/png', size: 9 });
    },
  };
}

globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : new FakeElement(tag)),
  createElementNS: (ns, tag) => new FakeElement(tag),
};

const clipboardWrites = [];
let clipboardBehavior = 'ok';
Object.defineProperty(globalThis, 'navigator', {
  value: {
    clipboard: {
      // Like a real browser, a promise-backed ClipboardItem whose
      // promise rejects makes the write itself reject, so only a
      // successful write is recorded here.
      write: async (items) => {
        const v = items && items[0] && items[0].map && items[0].map['image/png'];
        if (v && typeof v.then === 'function') await v;
        if (clipboardBehavior === 'throw') throw new Error('denied');
        clipboardWrites.push(items);
      },
    },
  },
  configurable: true,
  writable: true,
});

class StubClipboardItem {
  constructor(map) { this.map = map; }
}
globalThis.ClipboardItem = StubClipboardItem;

globalThis.createImageBitmap = async (blob) => {
  bitmapCalls.push(blob);
  return { width: 8, height: 6, close() {} };
};

/* fetch stub: configured per test through fetchImpl */
let fetchCalls = [];
let fetchImpl = null;
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    fetchCalls.push([url, init]);
    return fetchImpl(url, init);
  },
  configurable: true,
  writable: true,
});

function pngResponse(bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime = 'image/png', length = null) {
  return {
    ok: true,
    url: 'https://example.com/photo.jpg',
    headers: { get: (name) => (name === 'content-length' ? length : name === 'content-type' ? mime : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

/* chrome stub: permissions plus downloads, configured per test */
let permissionGranted = false;
let permissionRequestCalls = 0;
let permissionRequestResult = true;
let downloadSearchResult = [{ id: 7 }];
let downloadOpenBehavior = 'ok'; // 'ok' | 'throw-gesture' | 'throw-other' | 'missing'
let downloadOpenCalls = [];
function setChromePermissions(mode) {
  // mode: 'granted' | 'denied' | 'missing'
  if (mode === 'missing') {
    globalThis.chrome = {};
    return;
  }
  permissionGranted = mode === 'granted';
  permissionRequestCalls = 0;
  downloadOpenCalls = [];
  const downloads = {
    search: async () => downloadSearchResult,
  };
  if (downloadOpenBehavior !== 'missing') {
    downloads.open = async (dlId) => {
      downloadOpenCalls.push(dlId);
      if (downloadOpenBehavior === 'throw-gesture') throw new Error('User gesture required');
      if (downloadOpenBehavior === 'throw-other') throw new Error('no app to open it');
    };
  }
  globalThis.chrome = {
    permissions: {
      contains: async () => permissionGranted,
      request: async () => {
        permissionRequestCalls += 1;
        permissionGranted = permissionRequestResult;
        return permissionRequestResult;
      },
    },
    downloads,
  };
}
setChromePermissions('granted');

const { buildHistoryRow, updateHistoryRowThumb } = await import('../shared/history-ui.js');

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
const t = (key) => key;

function thumbOf(bytes) {
  const chars = Math.ceil(bytes * 4 / 3);
  return `data:image/jpeg;base64,${'A'.repeat(chars)}`;
}

function record(over = {}) {
  return {
    id: 'h1', filename: 'photo.jpg', site: 'example.com', pageHost: 'example.com',
    format: 'jpg', bytes: 100, at: Date.now(), kind: 'single',
    url: 'https://example.com/photo.jpg', dlId: 7, thumb: thumbOf(1000),
    ...over,
  };
}

function deps(over = {}) {
  const toasts = [];
  const shown = [];
  return {
    d: {
      t,
      formatSize: () => '1 KB',
      showDownload: async (dlId) => { shown.push(dlId); },
      toast: (msg) => toasts.push(msg),
      showThumbnails: true,
    },
    toasts, shown,
    ...over,
  };
}

function buttons(row) {
  return row.findAll((el) => el.tagName === 'BUTTON');
}

function buttonByLabel(row, label) {
  return buttons(row).find((b) => b.getAttribute('aria-label') === label);
}

function iconOf(button) {
  const use = button.findAll((el) => el.tagName === 'USE')[0];
  return use ? use.getAttribute('href') : null;
}

/* ---------------- B2: decideOpenFile ---------------- */

await test('B2: decideOpenFile covers the whole decision table', () => {
  const base = { exists: true, permissionHeld: true, permissionAvailable: true, openSupported: true };
  assert.equal(decideOpenFile(base), 'open');
  assert.equal(decideOpenFile({ ...base, permissionHeld: false }), 'request');
  assert.equal(decideOpenFile({ ...base, permissionHeld: false, permissionAvailable: false }), 'show');
  assert.equal(decideOpenFile({ ...base, exists: false }), 'not-found');
  assert.equal(decideOpenFile({ ...base, exists: false, permissionHeld: false }), 'not-found');
  assert.equal(decideOpenFile({ ...base, openSupported: false }), 'show');
});

/* ---------------- B2: the row ---------------- */

await test('B2: row with dlId has Open (file icon, Open file label), Show, Copy; no source-link action', () => {
  const { d } = deps();
  const row = buildHistoryRow(record(), d);
  const labels = buttons(row).map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(labels, ['history_openFile', 'queue_showInFolder', 'history_copyImage']);
  const open = buttonByLabel(row, 'history_openFile');
  assert.equal(open.title, 'history_openFile');
  assert.ok(iconOf(open).endsWith('#file-text'), `open icon must be the file icon, got ${iconOf(open)}`);
  assert.equal(buttonByLabel(row, 'history_openSource'), undefined, 'the source-link action is removed');
});

await test('B2: row without dlId has no Open or Show button', () => {
  const { d } = deps();
  const row = buildHistoryRow(record({ dlId: undefined }), d);
  assert.deepEqual(buttons(row).map((b) => b.getAttribute('aria-label')), ['history_copyImage']);
});

await test('B2: open with permission already granted opens the file in the page, no prompt, no toast', async () => {
  setChromePermissions('granted');
  downloadSearchResult = [{ id: 7 }];
  downloadOpenBehavior = 'ok';
  const { d, toasts, shown } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(downloadOpenCalls, [7], 'downloads.open called in the page with the download id');
  assert.deepEqual(shown, []);
  assert.deepEqual(toasts, []);
  assert.equal(permissionRequestCalls, 0, 'no permission prompt when already granted');
});

await test('B2: open requests the permission once, then the next click opens directly', async () => {
  setChromePermissions('denied');
  permissionRequestResult = true; // the user grants in the prompt
  downloadSearchResult = [{ id: 7 }];
  downloadOpenBehavior = 'ok';
  const { d } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(downloadOpenCalls, [7], 'first click opens after the grant');
  assert.equal(permissionRequestCalls, 1);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(downloadOpenCalls, [7, 7], 'second click opens directly, no second prompt');
  assert.equal(permissionRequestCalls, 1, 'the grant persists, the prompt is not shown again');
});

await test('B2: open denied falls back to show in folder with the quiet toast', async () => {
  setChromePermissions('denied');
  permissionRequestResult = false; // the user declines
  const { d, toasts, shown } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(downloadOpenCalls, [], 'no open attempt after a decline');
  assert.deepEqual(shown, [7]);
  assert.deepEqual(toasts, ['history_showInFolderInstead']);
});

await test('B2: open with no permissions API falls back to show in folder', async () => {
  setChromePermissions('missing');
  const { d, toasts, shown } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(shown, [7]);
  assert.deepEqual(toasts, ['history_showInFolderInstead']);
});

await test('B2: open when the file is gone shows File not found', async () => {
  setChromePermissions('granted');
  downloadSearchResult = []; // the download no longer exists
  const { d, toasts, shown } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(downloadOpenCalls, [], 'a missing file is never opened');
  assert.deepEqual(shown, []);
  assert.deepEqual(toasts, ['history_fileNotFound']);
});

await test('B2: open-unavailable falls back to show in folder', async () => {
  setChromePermissions('granted');
  downloadSearchResult = [{ id: 7 }];
  downloadOpenBehavior = 'missing'; // the browser has no downloads.open
  setChromePermissions('granted');
  const { d, toasts, shown } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(shown, [7]);
  assert.deepEqual(toasts, ['history_showInFolderInstead']);
});

await test('B2: open fails after the gesture expires falls back, never claims the file is gone', async () => {
  setChromePermissions('granted');
  downloadSearchResult = [{ id: 7 }];
  downloadOpenBehavior = 'throw-gesture'; // gesture expired while the prompt was up
  setChromePermissions('granted');
  const { d, toasts, shown } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(downloadOpenCalls, [7], 'the open was attempted');
  assert.deepEqual(shown, [7], 'falls back to showing in the folder');
  assert.deepEqual(toasts, ['history_showInFolderInstead']);
  assert.ok(!toasts.includes('history_fileNotFound'), 'an open failure is not a missing file');
});

await test('B2: denied and show fails shows File not found', async () => {
  setChromePermissions('denied');
  permissionRequestResult = false;
  const { d, toasts, shown } = deps();
  d.showDownload = async () => { throw new Error('gone'); };
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_openFile').click();
  await sleep(30);
  assert.deepEqual(shown, []);
  assert.deepEqual(toasts, ['history_fileNotFound']);
});

/* ---------------- B3: copy the image ---------------- */

await test('B3: copy hidden for screenshots without a url and for data: downloads', () => {
  const { d } = deps();
  const shot = buildHistoryRow(record({ kind: 'screenshot', url: undefined }), d);
  assert.deepEqual(buttons(shot).map((b) => b.getAttribute('aria-label')), ['history_openFile', 'queue_showInFolder']);
  const data = buildHistoryRow(record({ url: 'data:image/png;base64,AAAA' }), d);
  assert.deepEqual(buttons(data).map((b) => b.getAttribute('aria-label')), ['history_openFile', 'queue_showInFolder']);
});

await test('B3: copy copies the PNG image with one fetch, clipboard gets image/png', async () => {
  fetchCalls = [];
  fetchImpl = async () => pngResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  clipboardWrites.length = 0;
  const { d, toasts } = deps();
  const row = buildHistoryRow(record(), d);
  const copy = buttonByLabel(row, 'history_copyImage');
  assert.equal(copy.getAttribute('aria-label'), 'history_copyImage');
  assert.equal(copy.title, 'history_copyImage');
  copy.click();
  await sleep(30);
  assert.equal(fetchCalls.length, 1, 'the source is fetched exactly once');
  assert.equal(fetchCalls[0][1].credentials, 'omit');
  assert.equal(fetchCalls[0][1].referrerPolicy, 'no-referrer');
  assert.equal(clipboardWrites.length, 1);
  const item = clipboardWrites[0][0];
  const blob = await item.map['image/png'];
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(toasts, ['copySuccess']);
  const tip = copy.findAll((el) => el._classes.has('hist-copied'))[0];
  assert.equal(tip.classList.contains('is-visible'), true, 'the 1.2 s Copied! tip shows');
});

await test('B3: copy converts a non-PNG source through a canvas (first frame)', async () => {
  fetchCalls = [];
  bitmapCalls.length = 0;
  drawnImages.length = 0;
  fetchImpl = async () => pngResponse(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
  clipboardWrites.length = 0;
  const { d, toasts } = deps();
  const row = buildHistoryRow(record({ url: 'https://example.com/a.jpg' }), d);
  buttonByLabel(row, 'history_copyImage').click();
  await sleep(30);
  assert.equal(bitmapCalls.length, 1, 'the source is decoded once');
  assert.equal(drawnImages.length, 1, 'decoded into a canvas for the PNG re-encode');
  assert.equal(clipboardWrites.length, 1);
  const blob = await clipboardWrites[0][0].map['image/png'];
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(toasts, ['copySuccess']);
});

await test('B3: copy enforces the 25 MB cap', async () => {
  fetchCalls = [];
  fetchImpl = async () => pngResponse(new Uint8Array([1]), 'image/png', String(25_000_001));
  clipboardWrites.length = 0;
  const { d, toasts } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_copyImage').click();
  await sleep(30);
  assert.equal(clipboardWrites.length, 0, 'nothing reaches the clipboard');
  assert.deepEqual(toasts, ['history_copyImageFailed']);
});

await test('B3: copy fetch failure shows Could not copy the image quietly', async () => {
  fetchImpl = async () => { throw new Error('network down'); };
  clipboardWrites.length = 0;
  const { d, toasts } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_copyImage').click();
  await sleep(30);
  assert.equal(clipboardWrites.length, 0);
  assert.deepEqual(toasts, ['history_copyImageFailed']);
});

await test('B3: copy clipboard failure shows Could not copy the image quietly', async () => {
  fetchImpl = async () => pngResponse();
  clipboardWrites.length = 0;
  clipboardBehavior = 'throw';
  const { d, toasts } = deps();
  const row = buildHistoryRow(record(), d);
  buttonByLabel(row, 'history_copyImage').click();
  await sleep(30);
  assert.deepEqual(toasts, ['history_copyImageFailed']);
  clipboardBehavior = 'ok';
});

/* ---------------- B1: thumbnail visibility ---------------- */

await test('B1: thumbnail hidden when showThumbnails is false, shown when true', () => {
  const { d } = deps();
  const on = buildHistoryRow(record(), d);
  assert.ok(on.querySelector('.hist-thumb'), 'thumbnail shows by default');
  const off = buildHistoryRow(record(), { ...d, showThumbnails: false });
  assert.equal(off.querySelector('.hist-thumb'), null, 'no thumbnail when the setting is off');
  assert.ok(off.querySelector('.hist-tile'), 'the icon tile stays');
});

await test('B1: updateHistoryRowThumb adds the thumbnail in place', () => {
  const { d } = deps();
  const row = buildHistoryRow(record({ thumb: undefined }), d);
  assert.equal(row.querySelector('.hist-thumb'), null);
  assert.equal(updateHistoryRowThumb(row, thumbOf(2000)), true);
  const img = row.querySelector('.hist-thumb');
  assert.ok(img, 'the tile gains the thumbnail image');
  assert.equal(img.src, thumbOf(2000));
  assert.equal(updateHistoryRowThumb(row, 'not-a-thumb'), false);
  assert.equal(updateHistoryRowThumb(null, thumbOf(2000)), false);
});

await test('B1: the title tooltip carries the source URL', () => {
  const { d } = deps();
  const row = buildHistoryRow(record(), d);
  const name = row.findAll((el) => el._classes.has('hist-name'))[0];
  assert.ok(name.title.includes('https://example.com/photo.jpg'), 'source URL in the title tooltip');
  assert.ok(name.title.includes('photo.jpg'), 'file name still first in the tooltip');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
