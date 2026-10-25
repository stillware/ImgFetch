/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch: tests/test-offscreen-bridge.mjs
 * Node tests for shared/offscreen-bridge.js with hand-rolled stubs
 * (no jsdom), plus the real offscreen listener's sender validation.
 *
 * The bridge is the Round 9 Firefox route to the offscreen jobs:
 * document mode through chrome.offscreen on Chrome and Edge, and
 * in-process mode in the Firefox background page, where the offscreen
 * module runs directly. The tests pin the contract: one route only,
 * one handling per request, unchanged message types and payloads,
 * and sender validation still enforced for runtime messages.
 *
 * The offscreen listener section loads the real offscreen/offscreen.js
 * under a stub chrome namespace (it only touches chrome at listener
 * registration time, and only touches document inside its handlers).
 * If that import fails, that section SKIPS with a clear message
 * instead of failing the bridge sections.
 *
 * Prints "N passed, M failed", exits nonzero on failure.
 * Run: node tests/test-offscreen-bridge.mjs
 */
import {
  createOffscreenBridge,
  hasOffscreenApi,
  isOffscreenMessageType,
  OFFSCREEN_MESSAGE_TYPES,
  OFFSCREEN_IDLE_REAP_MS,
  OFFSCREEN_MAX_ATTEMPTS,
  HOST_PERMISSION_ORIGINS,
  hasHostPermission,
  requestHostPermission,
  openPopupBestEffort,
} from '../shared/offscreen-bridge.js';
import { friendlyError } from '../core/validation.js';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}
function skip(name) {
  skipped += 1;
  console.log(`  SKIP ${name}`);
}
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
async function rejectsWith(promise, message) {
  try {
    await promise;
    return false;
  } catch (err) {
    return String((err && err.message) || err) === message;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 10));

/* ---------------- feature detection, not browser sniffing ---------------- */

check('hasOffscreenApi: full API is present', hasOffscreenApi({
  offscreen: { hasDocument: () => {}, createDocument: () => {}, closeDocument: () => {} },
}) === true);
check('hasOffscreenApi: missing offscreen object is absent', hasOffscreenApi({}) === false);
check('hasOffscreenApi: null chrome object is absent', hasOffscreenApi(null) === false);
check('hasOffscreenApi: partial API counts as absent', hasOffscreenApi({
  offscreen: { createDocument: () => {} },
}) === false);
check('hasOffscreenApi: extra properties do not change the answer', hasOffscreenApi({
  offscreen: undefined,
  runtime: {},
  appVersion: 'Firefox/142.0',
}) === false);
check('OFFSCREEN_IDLE_REAP_MS is 30000', OFFSCREEN_IDLE_REAP_MS === 30_000);
check('OFFSCREEN_MAX_ATTEMPTS is 4', OFFSCREEN_MAX_ATTEMPTS === 4);
check('HOST_PERMISSION_ORIGINS mirrors the root manifest hosts',
  sameJson(HOST_PERMISSION_ORIGINS, ['https://*/*', 'http://*/*']));

const bridgeSource = readFileSync(new URL('../shared/offscreen-bridge.js', import.meta.url), 'utf-8');
check('bridge source has no identity string check (userAgent)', !bridgeSource.includes('userAgent'));
check('bridge source has no vendor string check', !bridgeSource.includes('.vendor'));
check('bridge source detects the API object, not a browser name',
  bridgeSource.includes('hasOffscreenApi') && bridgeSource.includes('chromeApi.offscreen'));

/* ---------------- message type allowlist ---------------- */

const EXPECTED_TYPES = [
  'CONVERT_IMAGE',
  'STRIP_METADATA',
  'SNIFF_TYPE',
  'CLIPBOARD_WRITE',
  'CLIPBOARD_IMAGE',
  'BUILD_ZIP',
  'ZIP_ABORT',
  'REVOKE_URL',
  'CONVERT_BMP',
  'CONVERT_SVG',
  'SANITIZE_SVG',
  'CONVERT_GIF',
  'STITCH_BEGIN',
  'STITCH_TILE',
  'STITCH_END',
  'STITCH_END_BLOB',
  'STITCH_PROBE',
  'STITCH_EXTEND',
  'CAPTURE_GROUP_FINALIZE',
  'STITCH_ABORT',
  'SUPPORTS_AVIF',
  'MEMORY_SAMPLE',
];
check('offscreen type allowlist matches the handler switch exactly',
  sameJson(OFFSCREEN_MESSAGE_TYPES, EXPECTED_TYPES));
check('offscreen type allowlist has no duplicates',
  new Set(OFFSCREEN_MESSAGE_TYPES).size === OFFSCREEN_MESSAGE_TYPES.length);
check('isOffscreenMessageType accepts a known type', isOffscreenMessageType('SNIFF_TYPE') === true);
check('isOffscreenMessageType rejects an unknown type', isOffscreenMessageType('NOPE') === false);
check('isOffscreenMessageType rejects a non string', isOffscreenMessageType(null) === false);

/* ---------------- document mode: Chrome and Edge path ---------------- */

{
  const creates = [];
  const sends = [];
  const mockChrome = {
    offscreen: {
      hasDocument: async () => false,
      createDocument: async (opts) => { creates.push(opts); },
      closeDocument: async () => {},
    },
  };
  const bridge = createOffscreenBridge({
    chromeApi: mockChrome,
    runtimeSendMessage: async (payload) => { sends.push(payload); return { ok: true, echoed: payload.type }; },
    offscreenPath: 'offscreen/offscreen.html',
    getJustification: async () => 'test justification',
  });
  const msg = { type: 'CONVERT_IMAGE', srcUrl: 'https://example.com/a.png', pageUrl: 'https://example.com/' };
  const res = await bridge.call(msg);
  check('document mode: result comes back from runtime send', res && res.ok === true && res.echoed === 'CONVERT_IMAGE');
  check('document mode: one document created', creates.length === 1);
  check('document mode: createDocument gets path, reasons, justification',
    creates[0] && creates[0].url === 'offscreen/offscreen.html' &&
    sameJson(creates[0].reasons, ['BLOBS', 'CLIPBOARD']) &&
    creates[0].justification === 'test justification');
  check('document mode: payload is the message plus target only',
    sends.length === 1 && sameJson(sends[0], { ...msg, target: 'offscreen' }));
  check('document mode: caller message object is not mutated', !('target' in msg));
  check('document mode: mode sticks to document', bridge.getMode() === 'document');
  check('document mode: inflight returns to zero', bridge.getInflight() === 0);
}

{
  // Retry: two listener-not-ready failures, then success.
  const sends = [];
  const sleeps = [];
  let attempts = 0;
  const bridge = createOffscreenBridge({
    chromeApi: {
      offscreen: {
        hasDocument: async () => true,
        createDocument: async () => { throw new Error('must not create when a document exists'); },
        closeDocument: async () => {},
      },
    },
    runtimeSendMessage: async (payload) => {
      sends.push(payload);
      attempts += 1;
      if (attempts <= 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true };
    },
    sleep: async (ms) => { sleeps.push(ms); },
    // lastUsed starts at 0 and now is small, so no reap: the existing
    // document is reused and createDocument is never called.
    now: () => 1000,
  });
  const res = await bridge.call({ type: 'SNIFF_TYPE', srcUrl: 'https://example.com/b.png', pageUrl: 'https://example.com/' });
  check('document mode: retry succeeds after listener registers', res && res.ok === true);
  check('document mode: retried exactly twice before success', sends.length === 3);
  check('document mode: retry delays grow 150 then 300 ms', sameJson(sleeps, [150, 300]));
  // Non retryable errors throw at once.
  let boomCalls = 0;
  const bridge2 = createOffscreenBridge({
    chromeApi: {
      offscreen: {
        hasDocument: async () => true,
        createDocument: async () => {},
        closeDocument: async () => {},
      },
    },
    runtimeSendMessage: async () => { boomCalls += 1; throw new Error('boom'); },
    now: () => 1000,
  });
  check('document mode: non retryable error throws at once',
    (await rejectsWith(bridge2.call({ type: 'SNIFF_TYPE' }), 'boom')) && boomCalls === 1);
}

{
  // Idle reap: old document reaped after 30 s idle, fresh one reused.
  let nowValue = 100_000;
  const closes = [];
  const creates = [];
  const bridge = createOffscreenBridge({
    chromeApi: {
      offscreen: {
        hasDocument: async () => true,
        createDocument: async (opts) => { creates.push(opts); },
        closeDocument: async () => { closes.push(1); },
      },
    },
    runtimeSendMessage: async () => ({ ok: true }),
    now: () => nowValue,
  });
  await bridge.call({ type: 'SUPPORTS_AVIF' });
  check('document mode: idle document is reaped then recreated', closes.length === 1 && creates.length === 1);
  nowValue = 100_050;
  await bridge.call({ type: 'SUPPORTS_AVIF' });
  check('document mode: recently used document is reused, not reaped',
    closes.length === 1 && creates.length === 1);
}

{
  // One shared ensure: two concurrent calls create one document.
  let release;
  const gate = new Promise((r) => { release = r; });
  const creates = [];
  const sends = [];
  const bridge = createOffscreenBridge({
    chromeApi: {
      offscreen: {
        hasDocument: async () => false,
        createDocument: async (opts) => { creates.push(opts); await gate; },
        closeDocument: async () => {},
      },
    },
    runtimeSendMessage: async (payload) => { sends.push(payload); return { ok: true }; },
  });
  const p1 = bridge.call({ type: 'SUPPORTS_AVIF' });
  const p2 = bridge.call({ type: 'MEMORY_SAMPLE' });
  await tick();
  release();
  await Promise.all([p1, p2]);
  check('document mode: concurrent calls share one document creation', creates.length === 1);
  check('document mode: both concurrent jobs are still sent', sends.length === 2);
}

/* ---------------- in-process mode: Firefox background page ---------------- */

{
  const handled = [];
  const sends = [];
  const handler = async (payload) => {
    handled.push(payload);
    return { ok: true, echoed: payload.type };
  };
  const bridge = createOffscreenBridge({
    chromeApi: {},
    runtimeSendMessage: async (payload) => { sends.push(payload); throw new Error('must not send in-process'); },
    inProcessHandler: handler,
  });
  const msg = { type: 'CONVERT_IMAGE', srcUrl: 'https://example.com/c.png', pageUrl: 'https://example.com/' };
  const res = await bridge.call(msg);
  check('in-process mode: handler runs and returns', res && res.ok === true && res.echoed === 'CONVERT_IMAGE');
  check('in-process mode: handled exactly once', handled.length === 1);
  check('in-process mode: no runtime message is sent', sends.length === 0);
  check('in-process mode: payload is the message plus target only',
    sameJson(handled[0], { ...msg, target: 'offscreen' }));
  check('in-process mode: mode sticks to in-process', bridge.getMode() === 'in-process');
  check('in-process mode: inflight returns to zero', bridge.getInflight() === 0);

  // Nested payloads pass through untouched.
  const record = { id: 'cap-1', partIndex: 0, partTotal: 2, groupId: 'g-1', groupOpen: true, at: 123 };
  await bridge.call({ type: 'STITCH_END_BLOB', format: 'png', record });
  check('in-process mode: nested record payload is preserved',
    sameJson(handled[1], { type: 'STITCH_END_BLOB', format: 'png', record, target: 'offscreen' }));

  // Unknown types never reach the handler.
  const before = handled.length;
  check('in-process mode: unknown type is rejected before handling',
    await rejectsWith(bridge.call({ type: 'NOPE' }), 'unknown'));
  check('in-process mode: unknown type adds no handling', handled.length === before);
  check('in-process mode: non object message is rejected',
    await rejectsWith(bridge.call(null), 'unknown'));

  // Handler errors are not retried: retrying could run a side
  // effecting job (ZIP accumulate, stitch tile) twice.
  let errCalls = 0;
  const bridge2 = createOffscreenBridge({
    chromeApi: {},
    inProcessHandler: async () => { errCalls += 1; throw new Error('handler-boom'); },
  });
  check('in-process mode: handler error surfaces',
    await rejectsWith(bridge2.call({ type: 'ZIP_ABORT', zipToken: 'z-1' }), 'handler-boom'));
  check('in-process mode: handler error is not retried', errCalls === 1);
}

/* ---------------- real offscreen listener: sender validation ---------------- */

let offscreenListener = null;
try {
  globalThis.chrome = {
    runtime: {
      id: 'imgfetch-test-id',
      onMessage: {
        addListener: (fn) => { offscreenListener = fn; },
      },
    },
  };
  await import('../offscreen/offscreen.js');
} catch (err) {
  skip(`offscreen listener section (import failed: ${(err && err.message) || err})`);
}
if (offscreenListener) {
  async function invoke(msg, sender) {
    const responses = [];
    const returned = offscreenListener(msg, sender, (res) => { responses.push(res); });
    await tick();
    await tick();
    return { returned, responses };
  }
  const goodSender = { id: 'imgfetch-test-id' };
  const bad = await invoke({ target: 'offscreen', type: 'MEMORY_SAMPLE' }, { id: 'someone-else' });
  check('sender validation: foreign sender is rejected', bad.returned === true &&
    bad.responses.length === 1 && bad.responses[0].error === 'foreign-sender');
  const missing = await invoke({ target: 'offscreen', type: 'MEMORY_SAMPLE' }, null);
  check('sender validation: missing sender is rejected', missing.responses.length === 1 &&
    missing.responses[0].error === 'foreign-sender');
  const wrongTarget = await invoke({ target: 'popup', type: 'MEMORY_SAMPLE' }, goodSender);
  check('sender validation: non offscreen target is not handled',
    wrongTarget.returned === false && wrongTarget.responses.length === 0);
  const good = await invoke({ target: 'offscreen', type: 'MEMORY_SAMPLE' }, goodSender);
  check('sender validation: own extension sender is handled',
    good.returned === true && good.responses.length === 1 && good.responses[0].ok === true);
  const unknown = await invoke({ target: 'offscreen', type: 'NOPE' }, goodSender);
  check('sender validation: unknown type is rejected by the allowlist',
    unknown.responses.length === 1 && unknown.responses[0].error === 'unknown');
  const probe = await invoke({ target: 'offscreen', type: 'SUPPORTS_AVIF' }, goodSender);
  check('sender validation: AVIF probe degrades instead of throwing in a documentless context',
    probe.responses.length === 1 && probe.responses[0].ok === false);
}

/* ---------------- compatibility wrappers ---------------- */

{
  const seen = [];
  const grantedApi = {
    permissions: {
      contains: async (req) => { seen.push(req); return true; },
      request: async () => true,
    },
  };
  check('host permission: granted state is reported', await hasHostPermission(grantedApi) === true);
  check('host permission: contains receives the manifest origins',
    seen.length === 1 && sameJson(seen[0], { origins: ['https://*/*', 'http://*/*'] }));
  const deniedApi = { permissions: { contains: async () => false, request: async () => false } };
  check('host permission: denied state is reported, not hidden', await hasHostPermission(deniedApi) === false);
  check('host permission: request reports a grant', await requestHostPermission(grantedApi) === true);
  check('host permission: request reports a decline', await requestHostPermission(deniedApi) === false);
  check('host permission: missing API does not newly block (old code never checked)',
    await hasHostPermission({}) === true);
  check('host permission: missing API cannot grant on request',
    await requestHostPermission({}) === false);
  const throwingApi = {
    permissions: {
      contains: async () => { throw new Error('contains-boom'); },
      request: async () => { throw new Error('request-boom'); },
    },
  };
  check('host permission: contains failure is not treated as a denial',
    await hasHostPermission(throwingApi) === true);
  check('host permission: request failure is reported as not granted',
    await requestHostPermission(throwingApi) === false);
  // Chrome and Edge (offscreen API present): never show the prompt, even
  // when the user narrowed site access and contains() reports false.
  const chromeLike = {
    offscreen: { hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} },
    permissions: { contains: async () => false, request: async () => false },
  };
  check('host permission: offscreen API present means always granted (no new prompt on Chrome and Edge)',
    await hasHostPermission(chromeLike) === true);
}

check('openPopup: success reports true',
  await openPopupBestEffort({ openPopup: async () => {} }) === true);
check('openPopup: rejection reports false, never throws',
  await openPopupBestEffort({ openPopup: async () => { throw new Error('no gesture'); } }) === false);
check('openPopup: missing API reports false',
  await openPopupBestEffort({}) === false);
check('openPopup: sync throw reports false',
  await openPopupBestEffort({ openPopup: () => { throw new Error('sync boom'); } }) === false);

{
  const avifMessage = friendlyError('avif-unavailable');
  check('AVIF message: browser neutral wording',
    avifMessage === 'AVIF encoding is not available in this browser. A PNG was saved instead.');
  check('AVIF message: names no browser and no version',
    !avifMessage.includes('Chrome') && !avifMessage.includes('Edge') && !avifMessage.includes('130'));
}

console.log(`${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (fail > 0) process.exit(1);
