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
 * ImgFetch unit tests for shared/undo-redo.js (FIX 1, round 2).
 * Pure undo/redo stack logic used by pages/annotate.js.
 *
 * shared/undo-redo.js is a browser classic script, so it is loaded in a
 * window stub via node:vm, the same pattern tests use for shared/ui.js.
 *
 * Run: node tests/test-undo-redo.mjs
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

/** Load the classic script in a fresh window stub, like the ui.js tests. */
async function loadBrowser() {
  const vm = await import('node:vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(join(PROJ, 'shared', 'undo-redo.js'), 'utf8'),
    sandbox,
    { filename: 'undo-redo.js' },
  );
  return sandbox.window.ImgFetchUndoRedo;
}

const browserApi = await loadBrowser();
assert.ok(typeof browserApi.UndoRedoStack === 'function', 'window.ImgFetchUndoRedo.UndoRedoStack exists');
assert.ok(typeof browserApi.cloneState === 'function', 'window.ImgFetchUndoRedo.cloneState exists');

// The same file must also load under plain node (module.exports branch).
// NOTE: the logic tests below use the node-realm API on purpose: snapshots
// cloned inside the vm realm carry that realm's Array/Object prototypes,
// which node:assert/strict deepEqual rejects. The vm load above only proves
// the browser attachment works.
const require = createRequire(import.meta.url);
const nodeApi = require(join(PROJ, 'shared', 'undo-redo.js'));
assert.ok(typeof nodeApi.UndoRedoStack === 'function', 'module.exports.UndoRedoStack exists');
const { UndoRedoStack, cloneState } = nodeApi;

const stroke = (kind, extra = {}) => ({ kind, color: '#e5484d', width: 6, ...extra });

await test('fresh stack cannot undo or redo', () => {
  const h = new UndoRedoStack();
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.undoDepth, 0);
  assert.equal(h.redoDepth, 0);
  assert.equal(h.undo([]), null);
  assert.equal(h.redo([]), null);
});

await test('commit then undo restores the pre-change list', () => {
  const h = new UndoRedoStack();
  let strokes = [];
  h.commit(strokes);
  strokes = [...strokes, stroke('pen')];
  assert.equal(h.canUndo, true);
  const prev = h.undo(strokes);
  assert.deepEqual(prev, []);
  strokes = prev;
  assert.equal(h.canRedo, true);
});

await test('redo restores the undone change', () => {
  const h = new UndoRedoStack();
  let strokes = [];
  const s1 = stroke('pen', { points: [[0, 0], [1, 1]] });
  h.commit(strokes);
  strokes = [...strokes, s1];
  strokes = h.undo(strokes);
  assert.deepEqual(strokes, []);
  const next = h.redo(strokes);
  assert.deepEqual(next, [s1]);
});

await test('multiple undos walk back through history in order', () => {
  const h = new UndoRedoStack();
  let strokes = [];
  const kinds = ['pen', 'rect', 'circle', 'text', 'pixelate'];
  for (const kind of kinds) {
    h.commit(strokes);
    strokes = [...strokes, stroke(kind)];
  }
  assert.equal(strokes.length, 5);
  for (let want = 4; want >= 0; want -= 1) {
    strokes = h.undo(strokes);
    assert.equal(strokes.length, want, `after undo, want ${want} strokes`);
    assert.deepEqual(strokes.map((s) => s.kind), kinds.slice(0, want));
  }
  assert.equal(h.canUndo, false);
  assert.equal(h.undo([]), null, 'extra undo is a no-op');
});

await test('redos replay in LIFO order after several undos', () => {
  const h = new UndoRedoStack();
  let strokes = [];
  for (const kind of ['pen', 'rect', 'text']) {
    h.commit(strokes);
    strokes = [...strokes, stroke(kind)];
  }
  strokes = h.undo(strokes);
  strokes = h.undo(strokes);
  assert.deepEqual(strokes.map((s) => s.kind), ['pen']);
  strokes = h.redo(strokes);
  assert.deepEqual(strokes.map((s) => s.kind), ['pen', 'rect']);
  strokes = h.redo(strokes);
  assert.deepEqual(strokes.map((s) => s.kind), ['pen', 'rect', 'text']);
  assert.equal(h.canRedo, false);
  assert.equal(h.redo(strokes), null, 'extra redo is a no-op');
});

await test('any new commit clears the redo stack', () => {
  const h = new UndoRedoStack();
  let strokes = [];
  h.commit(strokes);
  strokes = [...strokes, stroke('pen')];
  h.commit(strokes);
  strokes = [...strokes, stroke('rect')];
  strokes = h.undo(strokes);
  assert.equal(h.canRedo, true);
  // New drawing action: the redo stack must be discarded.
  h.commit(strokes);
  strokes = [...strokes, stroke('circle')];
  assert.equal(h.canRedo, false);
  assert.equal(h.redo(strokes), null);
  assert.deepEqual(strokes.map((s) => s.kind), ['pen', 'circle']);
});

await test('snapshots are deep copies, later mutation cannot corrupt them', () => {
  const h = new UndoRedoStack();
  const strokes = [stroke('text', { text: 'hi', at: [10, 20] })];
  h.commit(strokes);
  strokes[0].at = [999, 999]; // mutate after commit
  strokes.push(stroke('pen'));
  const prev = h.undo(strokes);
  assert.deepEqual(prev[0].at, [10, 20], 'undo restores the pristine snapshot');
  assert.equal(prev.length, 1);
});

await test('undo after deleteSelectedText restores the deleted text', () => {
  const h = new UndoRedoStack();
  let strokes = [stroke('pen'), stroke('text', { text: 'hello', at: [5, 5] })];
  h.commit(strokes);
  strokes.splice(1, 1); // deleteSelectedText
  assert.equal(strokes.length, 1);
  strokes = h.undo(strokes);
  assert.equal(strokes.length, 2);
  assert.equal(strokes[1].text, 'hello');
  strokes = h.redo(strokes);
  assert.equal(strokes.length, 1, 'redo re-applies the delete');
});

await test('moved text: undo restores the pre-move position', () => {
  const h = new UndoRedoStack();
  let strokes = [stroke('text', { text: 'drag me', at: [10, 10] })];
  // pointerdown on the text: snapshot before the drag can mutate it.
  const beforeMove = cloneState(strokes);
  strokes[0].at = [80, 90]; // pointermove drag
  h.commit(beforeMove); // pointerup: a real move is a change
  assert.equal(h.canUndo, true);
  strokes = h.undo(strokes);
  assert.deepEqual(strokes[0].at, [10, 10], 'undo restores the pre-move position');
  strokes = h.redo(strokes);
  assert.deepEqual(strokes[0].at, [80, 90], 'redo restores the moved position');
});

await test('reset clears both stacks (Clear button semantics)', () => {
  const h = new UndoRedoStack();
  let strokes = [];
  h.commit(strokes);
  strokes = [...strokes, stroke('pen')];
  strokes = h.undo(strokes);
  assert.equal(h.canRedo, true);
  h.reset();
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo([]), null);
  assert.equal(h.redo([]), null);
});

await test('undo depth is capped by the limit, oldest entries drop', () => {
  const h = new UndoRedoStack(3);
  let strokes = [];
  for (let i = 0; i < 5; i += 1) {
    h.commit(strokes);
    strokes = [...strokes, stroke('pen', { n: i })];
  }
  assert.equal(h.undoDepth, 3);
  strokes = h.undo(strokes);
  strokes = h.undo(strokes);
  strokes = h.undo(strokes);
  assert.equal(h.canUndo, false);
  assert.deepEqual(strokes.map((s) => s.n), [0, 1], 'only the two oldest strokes survive');
});

await test('constructor sanitizes a bad limit', () => {
  assert.equal(new UndoRedoStack(0).constructor === UndoRedoStack, true);
  const h = new UndoRedoStack('nope');
  let strokes = [];
  h.commit(strokes);
  assert.equal(h.canUndo, true);
});

await test('cloneState deep-copies nested stroke data', () => {
  const s = [stroke('pen', { points: [[0, 0], [3, 4]] }), stroke('rect', { rect: [1, 2, 3, 4] })];
  const c = cloneState(s);
  assert.deepEqual(c, s);
  c[0].points[0][0] = 999;
  assert.equal(s[0].points[0][0], 0, 'original untouched');
});

if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  ${f}`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
