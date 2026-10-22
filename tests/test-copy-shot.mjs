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
 * ImgFetch: tests/test-copy-shot.mjs
 * Node tests for shared/copy-shot.js with hand-rolled stubs (no jsdom).
 *
 * shared/copy-shot.js statically imports ./i18n.js, which is owned by the
 * Feature B agent and may not exist yet. If the import fails the suite
 * SKIPS with a clear message (exit 0) instead of failing.
 *
 * Prints "N passed, M failed", exits nonzero on failure.
 */
let initCopyButton;
let copyImageBlob;
try {
  ({ initCopyButton, copyImageBlob } = await import('../shared/copy-shot.js'));
} catch (err) {
  console.log(`SKIPPED: shared/i18n.js not ready (${(err && err.code) || err})`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

/* ---------------- hand-rolled browser stubs ---------------- */

const writes = [];        // navigator.clipboard.write calls (each: ClipboardItem[])
const createdCanvases = [];// document.createElement('canvas') results
const toasts = [];        // toast messages (strings)
const toastCalls = [];    // toast invocations as [message, ms]
const tCalls = [];        // [key, vars] seen by the t stub
const bitmapCalls = [];   // createImageBitmap calls as { source, width, height }
let writeBehavior = 'ok'; // 'ok' | 'throw'
let encodeBehavior = 'ok';// 'ok' | 'null' (toBlob yields null)
let fakePlatform = 'Linux x86_64'; // navigator.platform seen by the code
let fakeBlobSize = 42;    // size of the PNG blob the canvas stub encodes

function makeCanvas(w, h) {
  const drawn = [];
  const canvas = {
    width: w,
    height: h,
    drawn,
    getContext: () => ({
      drawImage: (...a) => drawn.push(a),
      imageSmoothingQuality: 'low',
    }),
    toBlob: (cb, type) => {
      if (encodeBehavior === 'null') cb(null);
      else cb({ type: type || 'image/png', size: fakeBlobSize });
    },
  };
  return canvas;
}

Object.defineProperty(globalThis, 'navigator', {
  value: {
    get platform() { return fakePlatform; },
    clipboard: {
      write: async (items) => {
        writes.push(items);
        // Like a real browser: a promise-backed ClipboardItem whose
        // promise rejects makes the write itself reject.
        const v = items && items[0] && items[0].map && items[0].map['image/png'];
        if (v && typeof v.then === 'function') await v;
        if (writeBehavior === 'throw') throw new Error('denied');
      },
    },
  },
  configurable: true,
  writable: true,
});

// createImageBitmap stub: honours resize options like the real decode,
// and reports the source blob's own dimensions (__w/__h) when no resize
// is requested (the copyImageBlob dimension probe).
globalThis.createImageBitmap = async (source, opts) => {
  if (opts && Number(opts.resizeWidth) > 0) {
    bitmapCalls.push({ source, width: opts.resizeWidth, height: opts.resizeHeight });
    return { width: opts.resizeWidth, height: opts.resizeHeight, close() {} };
  }
  const w = (source && source.__w) || 640;
  const h = (source && source.__h) || 480;
  bitmapCalls.push({ source, width: w, height: h });
  return { width: w, height: h, close() {} };
};

class StubClipboardItem {
  constructor(map) { this.map = map; }
}
globalThis.ClipboardItem = StubClipboardItem;

globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    const c = makeCanvas(0, 0);
    createdCanvases.push(c);
    return c;
  },
};

function makeButton() {
  return {
    listeners: {},
    disabled: false,
    title: '',
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

const tStub = (key, vars) => {
  tCalls.push([key, vars]);
  return vars ? `${key}:${JSON.stringify(vars)}` : key;
};
const toastStub = (msg, ms) => { toasts.push(msg); toastCalls.push([msg, ms]); };

function reset() {
  writes.length = 0;
  createdCanvases.length = 0;
  toasts.length = 0;
  toastCalls.length = 0;
  tCalls.length = 0;
  bitmapCalls.length = 0;
  writeBehavior = 'ok';
  encodeBehavior = 'ok';
  fakePlatform = 'Linux x86_64';
  fakeBlobSize = 42;
}

async function click(btn) {
  // The click handler starts the copy synchronously but does not return
  // its promise; flush the async copy chain before asserting.
  btn.listeners.click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/* ---------------- cases ---------------- */

// 1. Success path: writes one image/png ClipboardItem, toasts copySuccess,
//    never touches a temp canvas, never modifies the editor canvas.
{
  reset();
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  let threw = false;
  try { await click(btn); } catch { threw = true; }
  check('success: handler does not throw', !threw);
  check('success: one clipboard write', writes.length === 1);
  check('success: wrote a ClipboardItem', writes[0] && writes[0][0] instanceof StubClipboardItem);
  const pngPromise = writes[0] && writes[0][0].map && writes[0][0].map['image/png'];
  check('success: item carries a promise for the PNG (gesture-safe write)',
    !!pngPromise && typeof pngPromise.then === 'function');
  const pngBlob = pngPromise ? await pngPromise : null;
  check('success: item promise resolves to an image/png blob',
    !!pngBlob && pngBlob.type === 'image/png');
  check('success: toasts copySuccess', tCalls.some(([k]) => k === 'copySuccess'));
  check('success: no temp canvas created', createdCanvases.length === 0);
  check('success: no bitmap decode needed', bitmapCalls.length === 0);
  check('success: editor canvas untouched', editor.width === 640 && editor.height === 480);
}

// 2. Downscale path: over-budget canvas is drawn into a temp canvas at the
//    planned size, clipboard gets the PNG, toast reports the downscaled dims.
{
  reset();
  const btn = makeButton();
  const editor = makeCanvas(6000, 4000); // 24 MP, over the 12 MP budget
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  await click(btn);
  check('downscale: one temp canvas', createdCanvases.length === 1);
  const tmp = createdCanvases[0];
  const scale = Math.sqrt(12_000_000 / (6000 * 4000));
  const expW = Math.max(1, Math.floor(6000 * scale));
  const expH = Math.max(1, Math.floor(4000 * scale));
  check('downscale: temp canvas at planned size',
    tmp.width === expW && tmp.height === expH, `got ${tmp.width}x${tmp.height} want ${expW}x${expH}`);
  check('downscale: editor drawn into the target-size temp canvas',
    tmp.drawn.length === 1 && tmp.drawn[0][0] === editor &&
    tmp.drawn[0][3] === expW && tmp.drawn[0][4] === expH,
    JSON.stringify(tmp.drawn && tmp.drawn[0] && tmp.drawn[0].slice(3)));
  check('downscale: no bitmap decode on the editor path', bitmapCalls.length === 0);
  check('downscale: clipboard write happened', writes.length === 1);
  const downCall = tCalls.find(([k]) => k === 'copyDownscaled');
  check('downscale: toasts copyDownscaled with dims',
    !!downCall && downCall[1] && downCall[1].width === expW && downCall[1].height === expH,
    JSON.stringify(downCall && downCall[1]));
  check('downscale: editor canvas untouched', editor.width === 6000 && editor.height === 4000);
}

// 3. Persistent clipboard failure: retry once, then an honest copyFailed
//    toast; no exception escapes; the screenshot survives.
{
  reset();
  writeBehavior = 'throw';
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  let threw = false;
  try { await click(btn); } catch { threw = true; }
  check('failure: handler does not throw', !threw);
  check('failure: retried once (2 attempts total)', writes.length === 2, `writes=${writes.length}`);
  check('failure: toasts copyFailed', tCalls.some(([k]) => k === 'copyFailed'));
  check('failure: no fake success toast',
    !tCalls.some(([k]) => k === 'copySuccess' || k === 'copyDownscaled'));
  check('failure: screenshot intact', editor.width === 640 && editor.height === 480);
}

// 4. Already-downscaled first attempt fails: no further retry, copyFailed.
{
  reset();
  writeBehavior = 'throw';
  const btn = makeButton();
  const editor = makeCanvas(6000, 4000);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  await click(btn);
  check('downscaled failure: single attempt, no extra retry', writes.length === 1, `writes=${writes.length}`);
  check('downscaled failure: toasts copyFailed', tCalls.some(([k]) => k === 'copyFailed'));
}

// 5. Clipboard API unavailable (no ClipboardItem): honest failure, no crash.
{
  reset();
  const saved = globalThis.ClipboardItem;
  delete globalThis.ClipboardItem;
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  let threw = false;
  try { await click(btn); } catch { threw = true; }
  globalThis.ClipboardItem = saved;
  check('no ClipboardItem: handler does not throw', !threw);
  check('no ClipboardItem: toasts copyFailed', tCalls.some(([k]) => k === 'copyFailed'));
}

// 6. toBlob yields null (encode failed): treated as failure, not success.
{
  reset();
  encodeBehavior = 'null';
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  let threw = false;
  try { await click(btn); } catch { threw = true; }
  check('encode failure: handler does not throw', !threw);
  check('encode failure: toasts copyFailed', tCalls.some(([k]) => k === 'copyFailed'));
  check('encode failure: never reports success',
    !tCalls.some(([k]) => k === 'copySuccess'));
}

// 7. getEditor itself throws (e.g. redraw failed): still an honest toast,
//    never a crash, never silent.
{
  reset();
  const btn = makeButton();
  initCopyButton(btn, () => { throw new Error('redraw blew up'); }, { t: tStub, toast: toastStub });
  let threw = false;
  try { await click(btn); } catch { threw = true; }
  check('getEditor throws: handler does not throw', !threw);
  check('getEditor throws: toasts copyFailed', tCalls.some(([k]) => k === 'copyFailed'));
}

// 8. Default deps resolve without calling t() at module top level: the
//    module imported fine above, and initCopyButton is a function.
check('initCopyButton exported', typeof initCopyButton === 'function');
check('copyImageBlob exported', typeof copyImageBlob === 'function');

// 9. Phase C3: Windows + a PNG over ~3.5 MB gets the long Ctrl+V toast
//    (key copy_windowsToast) with the longer display duration.
{
  reset();
  fakePlatform = 'Win32';
  fakeBlobSize = 4_000_000;
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  await click(btn);
  check('windows-large editor: one clipboard write', writes.length === 1);
  check('windows-large editor: toasts copy_windowsToast',
    tCalls.some(([k]) => k === 'copy_windowsToast'), JSON.stringify(tCalls));
  check('windows-large editor: no short success toast',
    !tCalls.some(([k]) => k === 'copySuccess'));
  const call = toastCalls.find(([m]) => m === 'copy_windowsToast');
  check('windows-large editor: toast stays up longer than normal',
    !!call && typeof call[1] === 'number' && call[1] > 2600, JSON.stringify(call));
}

// 10. Phase C3: non-Windows + large PNG keeps the short success toast.
{
  reset();
  fakePlatform = 'Linux x86_64';
  fakeBlobSize = 4_000_000;
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  await click(btn);
  check('non-windows large editor: toasts copySuccess',
    tCalls.some(([k]) => k === 'copySuccess'));
  check('non-windows large editor: no windows toast',
    !tCalls.some(([k]) => k === 'copy_windowsToast'));
}

// 11. Phase C3: Windows + small PNG keeps the short success toast.
{
  reset();
  fakePlatform = 'Win32';
  fakeBlobSize = 120_000;
  const btn = makeButton();
  const editor = makeCanvas(640, 480);
  initCopyButton(btn, () => editor, { t: tStub, toast: toastStub });
  await click(btn);
  check('windows small editor: toasts copySuccess',
    tCalls.some(([k]) => k === 'copySuccess'));
  check('windows small editor: no windows toast',
    !tCalls.some(([k]) => k === 'copy_windowsToast'));
}

// 12. Phase C3: the blob path (parts overview) shares the toast rule:
//     Windows + a stored PNG over ~3.5 MB gets the long toast, written
//     byte for byte (the exact stored blob reaches the clipboard).
{
  reset();
  fakePlatform = 'Win32';
  const stored = { type: 'image/png', size: 4_200_000, __w: 800, __h: 600 };
  await copyImageBlob(stored, { t: tStub, toast: toastStub });
  check('windows-large blob: one clipboard write', writes.length === 1);
  const v = writes[0] && writes[0][0].map && writes[0][0].map['image/png'];
  const writtenBlob = v && typeof v.then === 'function' ? await v : v;
  check('windows-large blob: written byte for byte', writtenBlob === stored);
  check('windows-large blob: toasts copy_windowsToast',
    tCalls.some(([k]) => k === 'copy_windowsToast'), JSON.stringify(tCalls));
  const call = toastCalls.find(([m]) => m === 'copy_windowsToast');
  check('windows-large blob: toast stays up longer than normal',
    !!call && typeof call[1] === 'number' && call[1] > 2600, JSON.stringify(call));
}

// 13. Phase C3: blob path, Windows + small PNG keeps the short toast.
{
  reset();
  fakePlatform = 'Win32';
  const stored = { type: 'image/png', size: 90_000, __w: 800, __h: 600 };
  await copyImageBlob(stored, { t: tStub, toast: toastStub });
  check('windows small blob: toasts copySuccess',
    tCalls.some(([k]) => k === 'copySuccess'));
  check('windows small blob: no windows toast',
    !tCalls.some(([k]) => k === 'copy_windowsToast'));
}

// 14. Phase C3: a downscaled blob copy keeps the downscaled toast even
//     on Windows with a large source (its toast already reports size).
{
  reset();
  fakePlatform = 'Win32';
  const stored = { type: 'image/png', size: 30_000_000, __w: 6000, __h: 4000 };
  await copyImageBlob(stored, { t: tStub, toast: toastStub });
  check('downscaled blob: toasts copyDownscaled',
    tCalls.some(([k]) => k === 'copyDownscaled'), JSON.stringify(tCalls));
  check('downscaled blob: no windows toast',
    !tCalls.some(([k]) => k === 'copy_windowsToast'));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
