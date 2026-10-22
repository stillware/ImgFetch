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
 * ImgFetch, shared/undo-redo.js
 * Pure undo/redo stack logic for the annotate editor. No DOM, no
 * dependencies: the page (pages/annotate.js) owns the stroke list, this
 * module only tracks snapshots of it.
 *
 * Usage:
 *   const h = new UndoRedoStack();
 *   h.commit(strokes);            // before every mutating action;
 *                                 // snapshots `strokes`, clears the redo stack
 *   const prev = h.undo(strokes); // snapshot to restore, or null
 *   if (prev) strokes = prev;
 *   const next = h.redo(strokes);
 *   if (next) strokes = next;
 *
 * Classic script (MV3 pages cannot rely on static imports here): attaches
 * to window.ImgFetchUndoRedo in the browser, exports via module.exports
 * under node so the unit tests can load it.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = api; // node: tests/test-undo-redo.mjs
  } else if (root) {
    root.ImgFetchUndoRedo = api; // browser: <script src="../shared/undo-redo.js">
  }
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Deep copy of a stroke list. Strokes are plain JSON data, so this is safe. */
  function cloneState(strokes) {
    return JSON.parse(JSON.stringify(strokes));
  }

  class UndoRedoStack {
    constructor(limit = 200) {
      this._undo = [];
      this._redo = [];
      const n = Number(limit) | 0;
      this._limit = n > 0 ? n : 200;
    }
    get canUndo() { return this._undo.length > 0; }
    get canRedo() { return this._redo.length > 0; }
    get undoDepth() { return this._undo.length; }
    get redoDepth() { return this._redo.length; }

    /**
     * Record the stroke list as it is BEFORE a mutating action, then the
     * caller applies the change. Any new action clears the redo stack.
     */
    commit(current) {
      this._undo.push(cloneState(current));
      if (this._undo.length > this._limit) this._undo.shift();
      this._redo.length = 0;
    }

    /** Undo: returns the snapshot to restore, or null when nothing to undo. */
    undo(current) {
      if (!this.canUndo) return null;
      this._redo.push(cloneState(current));
      return this._undo.pop();
    }

    /** Redo: returns the snapshot to restore, or null when nothing to redo. */
    redo(current) {
      if (!this.canRedo) return null;
      this._undo.push(cloneState(current));
      if (this._undo.length > this._limit) this._undo.shift();
      return this._redo.pop();
    }

    /** Discard both stacks (used by Clear, which resets the canvas). */
    reset() {
      this._undo.length = 0;
      this._redo.length = 0;
    }
  }

  return { UndoRedoStack, cloneState };
}));
