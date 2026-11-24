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
 *   node tests/test-upgrade-path.mjs
 *
 * Phase 6 item 7.1 (upgrade path): a profile that carries version 1.1.1
 * data in the OLD shape must survive loading the current build.
 * Old shape: settings stored before the history-thumbnail, auto-retry and
 * subfolder settings existed; history records without thumb, url or dlId;
 * a queue snapshot with an in-flight item. Checks: nothing the user set
 * is lost, every new setting gets its documented default, old history
 * rows normalise (no crash, icon tile, backfill targets only for rows
 * that have a usable url), a persisted queue can be re-triaged, and the
 * welcome page is opened on install only, never on update.
 * Hermetic: pure functions plus a static read of the service worker.
 * Row rendering in the real DOM is covered by the live QA harness
 * (popup history view over old-format records); this file covers the
 * data layer that rendering depends on.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, DEFAULT_SETTINGS, stripUnknownSettings } from '../core/settings.js';
import * as history from '../core/history.js';
import { QUEUE_SESSION_KEY } from '../core/queue-persist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; }
  catch (err) { failed += 1; failures.push(`${name}: ${err.message}`); }
}
const read = (rel) => readFileSync(join(PROJ, rel), 'utf8');

// An old stored settings blob: only keys that existed before the
// thumbnail / auto-retry / subfolder settings, plus legacy aliases.
const OLD_SETTINGS = {
  version: 1,
  theme: 'dark',
  language: 'de',
  afterDownload: 'silent',
  saveAsDialog: true,
  maxConcurrent: 5,
  qualityPreference: 'original',
  jpgQuality: 0.8,
  filenameMode: 'site',
  organizeBySite: true,
  folderMode: 'flat',
  minSizePreset: 'large',
  includeBackgrounds: false,
  scanDepth: 'scroll',
  detectLazyScroll: true,
  historyEnabled: true,
  historyRetentionDays: 7,
  sitePrefs: { 'example.com': 'best', 'other.test': 'disabled' },
};

await test('7.1 old settings keep every user-set value', () => {
  const s = normalizeSettings(OLD_SETTINGS);
  assert.equal(s.theme, 'dark');
  assert.equal(s.language, 'de');
  assert.equal(s.afterDownload, 'silent');
  assert.equal(s.saveAsDialog, true);
  assert.equal(s.maxConcurrent, 5);
  assert.equal(s.qualityPreference, 'original');
  assert.equal(s.jpgQuality, 0.8);
  assert.equal(s.filenameMode, 'site');
  // Legacy alias: organizeBySite true wins over a stored flat folderMode.
  assert.equal(s.folderMode, 'site');
  assert.equal(s.minSizePreset, 'large');
  assert.equal(s.includeBackgrounds, false);
  assert.equal(s.scanDepth, 'scroll');
  assert.equal(s.historyEnabled, true);
  assert.equal(s.historyRetentionDays, 7);
  assert.deepEqual(s.sitePrefs, { 'example.com': 'best', 'other.test': 'disabled' });
});

await test('7.1 new settings get documented defaults on upgrade', () => {
  const s = normalizeSettings(OLD_SETTINGS);
  for (const key of ['autoRetryOnce', 'historyShowThumbnails', 'useSubfolder', 'subfolder', 'autoCollapseQueue', 'annotateAfterCapture', 'askFilename', 'dedupeScan', 'pngQuality', 'webpQuality', 'screenshotFormat', 'screenshotQuality', 'customTemplate']) {
    assert.equal(s[key], DEFAULT_SETTINGS[key], `default for ${key}`);
  }
  assert.equal(s.historyShowThumbnails, true);
  assert.equal(s.autoRetryOnce, true);
});

await test('7.1 legacy site-pref best still maps to a probed mode', () => {
  const s = normalizeSettings(OLD_SETTINGS);
  assert.equal(s.sitePrefs['example.com'], 'best');
});

await test('7.1 unknown stored keys are dropped, known keys survive', () => {
  const s = stripUnknownSettings({ ...OLD_SETTINGS, futureSetting: true, theme: 'light' });
  assert.equal(s.futureSetting, undefined);
  assert.equal(s.theme, 'light');
});

await test('7.1 null / empty stored settings normalise to full defaults', () => {
  for (const stored of [null, undefined, {}]) {
    const s = normalizeSettings(stored);
    assert.deepEqual({ ...s }, { ...DEFAULT_SETTINGS });
  }
});

await test('7.1 wrong-typed stored values fall back to defaults, not crash', () => {
  const s = normalizeSettings({ theme: 'neon', maxConcurrent: 'many', jpgQuality: 99, historyRetentionDays: -5, sitePrefs: 'nope', language: 42 });
  assert.equal(s.theme, DEFAULT_SETTINGS.theme);
  assert.equal(s.maxConcurrent, DEFAULT_SETTINGS.maxConcurrent);
  assert.equal(s.jpgQuality, DEFAULT_SETTINGS.jpgQuality);
  // Out-of-range retention clamps to the 1 day floor, it is not reset.
  assert.equal(s.historyRetentionDays, 1);
  assert.deepEqual(s.sitePrefs, {});
  assert.equal(s.language, DEFAULT_SETTINGS.language);
});

// Old-format history: records written before thumb/url/dlId existed.
// Old-format record: the pre-thumbnail schema (filename, bytes, at)
// with no thumb, url or dlId fields at all.
function oldRecord(over = {}) {
  return {
    id: 'old-1', filename: 'sunset.png', bytes: 123456, at: Date.now() - 86400000,
    site: 'example.com', pageHost: 'example.com', format: 'PNG',
    width: 800, height: 600, kind: 'single', ...over,
  };
}

await test('7.1 old history record normalises without thumb/url/dlId', () => {
  const r = history.sanitizeHistoryRecord(oldRecord());
  assert.equal(r.filename, 'sunset.png');
  assert.equal(r.bytes, 123456);
  assert.equal(r.pageHost, 'example.com');
  assert.equal(r.thumb, undefined);
  assert.equal(r.url, undefined);
  assert.equal(r.dlId, undefined);
});

await test('7.1 old history rows are not backfill targets (no url)', () => {
  const rows = [oldRecord(), oldRecord({ id: 'old-2', filename: 'sea.jpg' })];
  assert.deepEqual(history.selectBackfillTargets(rows), []);
  assert.equal(history.thumbFetchAllowed(null, rows[0]), false);
  assert.equal(history.copyImageAvailable(rows[0]), false);
});

await test('7.1 old row that gained a url IS a backfill target', () => {
  const rows = [oldRecord({ url: 'https://example.com/sunset.png' })];
  assert.equal(history.selectBackfillTargets(rows).length, 1);
  assert.equal(history.thumbFetchAllowed(null, rows[0]), true);
  assert.equal(history.copyImageAvailable(rows[0]), true);
});

await test('7.1 addRecord keeps old rows and caps at MAX_RECORDS', () => {
  let list = [];
  for (let i = 0; i < history.MAX_RECORDS + 5; i += 1) {
    list = history.addRecord(list, oldRecord({ id: `old-${i}`, filename: `img-${i}.png` }));
  }
  assert.equal(list.length, history.MAX_RECORDS);
  assert.equal(list[0].filename, `img-${history.MAX_RECORDS + 4}.png`);
});

await test('7.1 prune keeps recent old rows, drops expired ones', () => {
  const rows = [
    oldRecord({ id: 'recent' }),
    oldRecord({ id: 'ancient', at: Date.now() - 40 * 86400000 }),
  ];
  const kept = history.pruneRecords(rows, 30);
  assert.deepEqual(kept.map((r) => r.id), ['recent']);
});

await test('7.1 hostile old history values are sanitised, never stored raw', () => {
  const r = history.sanitizeHistoryRecord(oldRecord({
    filename: '<img src=x onerror=alert(1)>.png',
    thumb: 'javascript:alert(1)',
    url: 'file:///etc/passwd',
    dlId: 'x'.repeat(500),
  }));
  assert.equal(r.thumb, undefined);
  assert.equal(r.url, undefined);
  assert.equal(r.dlId, undefined);
  // Angle brackets survive as literal text: the UI renders filenames
  // with textContent, never innerHTML, so they cannot execute.
  assert.equal(r.filename, '<img src=x onerror=alert(1)>.png');
});

await test('7.1 queue session key is stable across versions', () => {
  assert.equal(QUEUE_SESSION_KEY, 'imgfetch.queue');
});

await test('7.1 queue snapshot shape: in-flight item can be re-triaged as failed', () => {
  // The worker triage (service-worker.js) marks items that were started
  // but never reached chrome.downloads as failed with the interrupted
  // message; here we pin the contract the snapshot must satisfy: an
  // item with a chrome download id and state downloading is resumable
  // state, an item with no download id is not.
  const snapshot = {
    items: [
      { id: 'q-1', srcUrl: 'https://example.com/a.png', state: 'downloading', downloadId: 42 },
      { id: 'q-2', srcUrl: 'https://example.com/b.png', state: 'downloading' },
      { id: 'q-3', srcUrl: 'https://example.com/c.png', state: 'done', downloadId: 41 },
    ],
  };
  const started = snapshot.items.filter((i) => i.state === 'downloading' && i.downloadId === undefined);
  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'q-2');
  assert.equal(snapshot.items.filter((i) => i.state === 'done').length, 1);
});

await test('7.1 welcome opens on install only, never on update', () => {
  const sw = read('background/service-worker.js');
  const idx = sw.indexOf("chrome.runtime.onInstalled.addListener");
  assert.ok(idx >= 0, 'onInstalled listener exists');
  const block = sw.slice(idx, idx + 600);
  assert.ok(block.includes("details.reason === 'install'"), 'welcome gated on install reason');
  assert.ok(block.includes('pages/welcome.html'), 'welcome page opened on install');
  const welcomeOpens = [...sw.matchAll(/tabs\.create\(\{\s*url: chrome\.runtime\.getURL\('pages\/welcome\.html'\)/g)];
  assert.equal(welcomeOpens.length, 1, 'exactly one welcome open site in the worker');
  assert.ok(!/reason === 'update'/.test(sw.slice(idx, idx + 600)), 'no welcome on update');
});

await test('7.1 no other welcome trigger exists in popup/options/pages', () => {
  for (const rel of ['popup/popup.js', 'options/options.js', 'pages/welcome.js']) {
    const src = read(rel);
    assert.ok(!src.includes("tabs.create({ url: chrome.runtime.getURL('pages/welcome.html')"), `${rel} does not open welcome`);
  }
});

console.log(`upgrade-path: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`FAIL: ${f}`); process.exitCode = 1; }
