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
 * ImgFetch, pages/annotate.js
 * Extracted from pages/annotate.html: MV3 blocks inline scripts (CSP),
 * so page logic must live in an external file.
 */
(() => {
'use strict';
const UI = window.ImgFetchUI;

/* B: runtime localization. Classic script: no static imports, so the
 * i18n module loads lazily; English defaults stay until it resolves. */
let __t = null;
(async () => {
  try {
    const { initI18n, t, applyI18n, onLanguageChange } = await import('../shared/i18n.js');
    await initI18n();
    __t = t;
    applyI18n();
    applyPartLabel();
    refreshWindowsNote();
    onLanguageChange(() => { applyI18n(); applyPartLabel(); refreshWindowsNote(); renderCropOverlay(); });
  } catch { /* English defaults remain */ }
})();

/** Translate a key; falls back to the given English when i18n is unavailable. */
let partLabel = ''; // "Part i of N" for split captures, re-applied after applyI18n()
function applyPartLabel() {
  if (!partLabel) return;
  try {
    const sub = document.querySelector('.brand-sub');
    if (sub) sub.textContent = partLabel;
    document.title = partLabel;
  } catch { /* never break the editor */ }
}

let recordDims = null; // { width, height, isMultiPart } of the loaded record
let platformMod = null; // shared/platform.js, lazy-loaded like the copy module
let cropGeom = null; // core/crop-rect.js, lazy-loaded like the platform module
const cropGeomReady = import('../core/crop-rect.js')
  .then((m) => { cropGeom = m; })
  .catch(() => { cropGeom = null; });

/**
 * Windows clipboard-history note under the Tip: visible only on Windows
 * and only for a large image (the shared rule in shared/platform.js:
 * over ~2 MP, or any part of a multi-part capture). The paragraph is
 * hidden by default in the HTML, so non-Windows platforms and small
 * images never flash it.
 */
function refreshWindowsNote() {
  const note = document.getElementById('windowsNote');
  if (!note) return;
  let show = false;
  if (platformMod && recordDims) {
    try {
      show = platformMod.shouldShowWindowsClipboardNote(
        undefined, recordDims.width, recordDims.height, recordDims.isMultiPart);
    } catch { show = false; }
  }
  note.hidden = !show;
  if (show) {
    note.textContent = tr('copy_windowsNote', 'Note: Large screenshots, such as full pages, copy correctly but do not appear in the Windows clipboard history (Win+V). This is a Windows limit, not a problem with the copy. Press Ctrl+V to paste the image where you need it.');
  }
}

function tr(key, english, vars) {
  if (__t) {
    try { return __t(key, vars); } catch { /* fall through */ }
  }
  return english;
}

const $ = (id) => document.getElementById(id);
const id = location.hash.replace('#', '');
UI.applyTheme('system');

const state = {
  tool: 'pen',
  color: '#e5484d',
  width: 6,
  strokes: [], // {kind, ...}, vector list for undo
  crop: null, // round 6: active crop {x, y, w, h} in ORIGINAL image px, or null
  drawing: null,
  selected: -1,  // index of the selected text stroke (-1 = none)
  dragText: null, // {dx, dy} while dragging a selected text stroke
  moveSnapshot: null, // pre-drag stroke list, committed on pointerup if moved
  textMoved: false,   // set while a text drag actually moves the stroke
};

let baseImage = null;    // original screenshot: the decoded <img> itself, never copied to a canvas
let annotCanvas = null;  // annotation layer (full res), allocated LAZILY on first use
let actx = null;

/**
 * Round 4 (editor memory): a tens-of-megapixels part costs hundreds of
 * MB per full-size canvas. The base image is drawn straight from the
 * decoded <img> (no full-size copy), and the annotation layer is only
 * allocated when a stroke actually needs it, so merely VIEWING a huge
 * part never pays for the annotation canvas.
 */
function ensureAnnotCanvas() {
  if (annotCanvas) return annotCanvas;
  if (!baseImage) return null;
  annotCanvas = document.createElement('canvas');
  annotCanvas.width = baseImage.naturalWidth || baseImage.width;
  annotCanvas.height = baseImage.naturalHeight || baseImage.height;
  actx = annotCanvas.getContext('2d');
  return annotCanvas;
}
const editor = $('editor');
const ectx = editor.getContext('2d');

function fail(msg) {
  const loading = $('loading');
  loading.replaceChildren();
  const p = document.createElement('p');
  p.textContent = msg;
  loading.append(p);
}

/**
 * M11: layered rendering. The committed-strokes layer is repainted only when
 * the stroke list actually changes; the display canvas is a cheap composite
 * of cached layers. Drag previews and selection moves never repaint strokes.
 */
function repaintAnnotLayer(exclude = -1) {
  if (!state.strokes.length && !annotCanvas) return; // nothing to paint, stay lazy
  if (!ensureAnnotCanvas()) return;
  actx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  state.strokes.forEach((s, i) => {
    if (i !== exclude) paintStroke(actx, s);
  });
}

/** Cheap composite of cached layers onto the display canvas (no selection). */
/**
 * The visible region of the original image: the active crop, or the
 * whole image when no crop is applied. The display canvas is exactly
 * this size, so compositing draws the region 1:1 (no scaling, lossless)
 * and never paints outside the crop.
 */
function viewRect() {
  if (state.crop) return state.crop;
  if (!baseImage) return { x: 0, y: 0, w: editor.width, h: editor.height };
  return { x: 0, y: 0, w: baseImage.naturalWidth, h: baseImage.naturalHeight };
}

function composite() {
  const v = viewRect();
  ectx.clearRect(0, 0, editor.width, editor.height);
  if (baseImage) ectx.drawImage(baseImage, v.x, v.y, v.w, v.h, 0, 0, v.w, v.h);
  if (annotCanvas) ectx.drawImage(annotCanvas, v.x, v.y, v.w, v.h, 0, 0, v.w, v.h);
}

/**
 * Paint a not-yet-committed stroke (drag preview) on the display canvas.
 * Strokes live in original image coordinates, so the preview is shifted
 * by the crop offset; with no crop this is a plain paintStroke.
 */
function paintPreviewStroke(s) {
  const v = viewRect();
  ectx.save();
  if (v.x || v.y) ectx.translate(-v.x, -v.y);
  paintStroke(ectx, s);
  ectx.restore();
}

/**
 * B6: drag rendering via requestAnimationFrame + preview. Pointermove can
 * fire faster than the display refresh, coalesce into one frame, and draw
 * the dragged stroke as a preview on top of the cheap composite instead of
 * repainting every committed stroke on every move event.
 */
let dragRaf = 0;
function scheduleDragRender() {
  if (dragRaf) return;
  const idx = state.selected;
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0;
    repaintAnnotLayer(idx); // committed strokes minus the dragged one
    composite();
    const s = state.strokes[idx];
    if (s) paintPreviewStroke(s); // preview: dragged stroke on top
  });
}

function redraw() {
  // Composite base + all strokes onto the display canvas.
  // Pure: the saved image comes from this, never from selection chrome.
  repaintAnnotLayer();
  composite();
}

/** Display render: repaint the committed-strokes layer + composite. */
function render() {
  redraw();
}

/** Text selection is invisible (drag only), just the cheap composite. */
function renderSelection() {
  composite();
}

/* ---------------- selectable text ---------------- */

function textFont(s) {
  return `600 ${Math.max(14, s.width * 4)}px system-ui, sans-serif`;
}

function textBounds(s) {
  const mctx = textBounds.ctx || (textBounds.ctx = document.createElement('canvas').getContext('2d'));
  mctx.font = textFont(s);
  const m = mctx.measureText(s.text);
  const size = Math.max(14, s.width * 4);
  const asc = m.actualBoundingBoxAscent || size * 0.8;
  const desc = m.actualBoundingBoxDescent || size * 0.2;
  const pad = 6;
  return { x: s.at[0] - pad, y: s.at[1] - asc - pad, w: m.width + pad * 2, h: asc + desc + pad * 2 };
}

/** Topmost text stroke under (x, y), or -1. Coordinates are full-res. */
function hitText(x, y) {
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (!s || s.kind !== 'text') continue;
    const b = textBounds(s);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

function deleteSelectedText() {
  if (state.selected < 0 || state.selected >= state.strokes.length) return;
  commitStrokes();
  state.strokes.splice(state.selected, 1);
  state.selected = -1;
  state.dragText = null;
  render();
  updateHistoryButtons();
}

function paintStroke(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'pen') {
    ctx.beginPath();
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  } else if (s.kind === 'arrow' || s.kind === 'line') {
    const [x1, y1] = s.from;
    const [x2, y2] = s.to;
    if (s.kind === 'arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      // Head scales with the line so short arrows don't get swallowed:
      // never larger than ~38% of the shaft, never invisibly small.
      const head = Math.max(8, Math.min(s.width * 2.6, len * 0.38));
      const spread = 0.46; // ~26° per side, clean modern head
      // Shaft stops at the head base so the head sits exactly on the end.
      const bx = x2 - head * Math.cos(ang);
      const by = y2 - head * Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - spread), y2 - head * Math.sin(ang - spread));
      ctx.lineTo(x2 - head * Math.cos(ang + spread), y2 - head * Math.sin(ang + spread));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  } else if (s.kind === 'rect') {
    const [x, y, w, h] = s.rect;
    ctx.strokeRect(x, y, w, h);
  } else if (s.kind === 'circle') {
    const [cx, cy, rx, ry] = s.ellipse;
    if (rx >= 1 && ry >= 1) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (s.kind === 'text') {
    ctx.font = `600 ${Math.max(14, s.width * 4)}px system-ui, sans-serif`;
    ctx.fillText(s.text, s.at[0], s.at[1]);
  } else if (s.kind === 'pixelate') {
    // Pixelate the region from the BASE image onto the annotation layer.
    // L8: block size scales with the image (not a fixed 14 px), so a 4K
    // screenshot gets the same hiding strength as a small one.
    const [x, y, w, h] = s.rect.map(Math.round);
    if (w < 2 || h < 2) return;
    const block = Math.min(64, Math.max(8, Math.round(Math.min(baseImage.width, baseImage.height) / 48)));
    const tiny = document.createElement('canvas');
    const tw = Math.max(1, Math.round(w / block));
    const th = Math.max(1, Math.round(h / block));
    tiny.width = tw;
    tiny.height = th;
    const tctx = tiny.getContext('2d');
    tctx.drawImage(baseImage, x, y, w, h, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, 0, 0, tw, th, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }
  ctx.restore();
}

function canvasPos(e) {
  const r = editor.getBoundingClientRect();
  const sx = editor.width / r.width;
  const sy = editor.height / r.height;
  return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
}

/**
 * Pointer positions come back in display-canvas (view) pixels. Stroke
 * geometry always lives in ORIGINAL image coordinates, so with a crop
 * active the position is converted through the crop offset.
 */
function toImageCoords(x, y) {
  if (!state.crop) return [x, y];
  if (cropGeom) {
    const p = cropGeom.viewToImagePoint(x, y, state.crop);
    if (p) return p;
  }
  return [x + state.crop.x, y + state.crop.y];
}

editor.addEventListener('pointerdown', (e) => {
  if (state.tool === 'crop') {
    cropPointerDown(e);
    return;
  }
  if (state.tool === 'text') {
    const [vx, vy] = canvasPos(e);
    const [x, y] = toImageCoords(vx, vy);
    const hit = hitText(x, y);
    if (hit >= 0) {
      // Select existing text, drag to move it.
      state.selected = hit;
      const s = state.strokes[hit];
      state.dragText = { dx: x - s.at[0], dy: y - s.at[1] };
      // Snapshot before the drag so undo can restore the pre-move position.
      state.moveSnapshot = window.ImgFetchUndoRedo.cloneState(snapshotState());
      state.textMoved = false;
      editor.setPointerCapture(e.pointerId);
      render();
      return;
    }
    state.selected = -1;
    state.dragText = null;
    placeText(e);
    return;
  }
  if (state.selected >= 0) {
    state.selected = -1;
    renderSelection();
  }
  editor.setPointerCapture(e.pointerId);
  const [vx, vy] = canvasPos(e);
  const [x, y] = toImageCoords(vx, vy);
  state.drawing = { tool: state.tool, from: [x, y], points: [[x, y]] };
});

editor.addEventListener('pointermove', (e) => {
  if (cropDragActive()) {
    cropDragMove(e);
    return;
  }
  if (state.dragText && state.selected >= 0) {
    const s = state.strokes[state.selected];
    if (s && s.kind === 'text') {
      const [vx, vy] = canvasPos(e);
      const [x, y] = toImageCoords(vx, vy);
      s.at = [x - state.dragText.dx, y - state.dragText.dy];
      state.textMoved = true;
      scheduleDragRender(); // B6: rAF-throttled preview, no full repaint
    }
    return;
  }
  // No selection chrome, the cursor tells the user text is draggable.
  if (!state.drawing && state.tool === 'text') {
    const [vx, vy] = canvasPos(e);
    const [hx, hy] = toImageCoords(vx, vy);
    editor.style.cursor = hitText(hx, hy) >= 0 ? 'move' : 'text';
  }
  if (!state.drawing) return;
  const [vx, vy] = canvasPos(e);
  const [x, y] = toImageCoords(vx, vy);
  const d = state.drawing;
  if (d.tool === 'pen') d.points.push([x, y]);
  else d.to = [x, y];
  // M11: live preview on the cheap composite, never repaint all strokes here.
  composite();
  const preview = previewStroke(d);
  if (preview) paintPreviewStroke(preview);
});

editor.addEventListener('pointerup', (e) => {
  if (cropDragActive()) {
    cropDragEnd();
    return;
  }
  if (state.dragText) {
    state.dragText = null;
    if (dragRaf) {
      // A preview frame is still queued, commit the final position now.
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    if (state.textMoved && state.moveSnapshot) {
      // A real move is a change: record it so undo/redo covers moved text.
      undoHistory.commit(state.moveSnapshot);
      updateHistoryButtons();
    }
    state.moveSnapshot = null;
    state.textMoved = false;
    render();
    return;
  }
  if (!state.drawing) return;
  const d = state.drawing;
  state.drawing = null;
  const [vx, vy] = canvasPos(e);
  const [x, y] = toImageCoords(vx, vy);
  const stroke = finalizeStroke(d, x, y);
  if (stroke) {
    commitStrokes();
    state.strokes.push(stroke);
  }
  render();
  updateHistoryButtons();
});

editor.addEventListener('pointercancel', () => {
  if (cropDragActive()) cropDragEnd();
});

function previewStroke(d) {
  const base = { color: state.color, width: state.width };
  if (d.tool === 'pen') return { ...base, kind: 'pen', points: d.points };
  if (!d.to) return null;
  if (d.tool === 'arrow') return { ...base, kind: 'arrow', from: d.from, to: d.to };
  if (d.tool === 'rect' || d.tool === 'pixelate') {
    return { ...base, kind: d.tool, rect: rectOf(d.from, d.to) };
  }
  if (d.tool === 'circle') return { ...base, kind: 'circle', ellipse: ellipseOf(d.from, d.to) };
  return null;
}

function rectOf(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}

/** Ellipse from a drag: [centerX, centerY, radiusX, radiusY]. */
function ellipseOf(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2];
}

function finalizeStroke(d, x, y) {
  const base = { color: state.color, width: state.width };
  if (d.tool === 'pen') {
    return d.points.length > 1 ? { ...base, kind: 'pen', points: d.points } : null;
  }
  const to = d.to || [x, y];
  const dist = Math.hypot(to[0] - d.from[0], to[1] - d.from[1]);
  if (dist < 4) return null;
  if (d.tool === 'arrow') return { ...base, kind: 'arrow', from: d.from, to };
  if (d.tool === 'rect' || d.tool === 'pixelate') return { ...base, kind: d.tool, rect: rectOf(d.from, to) };
  if (d.tool === 'circle') return { ...base, kind: 'circle', ellipse: ellipseOf(d.from, to) };
  return null;
}

function hideTextBox() {
  const wrap = $('textWrap');
  if (wrap) wrap.style.display = 'none';
}

function placeText(e) {
  const [vx, vy] = canvasPos(e);
  const [x, y] = toImageCoords(vx, vy); // the stroke anchor lives in image coords
  const input = $('textInput');
  const wrap = $('textWrap');
  const r = editor.getBoundingClientRect();
  const stageR = $('stage').getBoundingClientRect();
  wrap.style.display = 'block';
  wrap.style.left = `${r.left - stageR.left + vx / (editor.width / r.width)}px`;
  wrap.style.top = `${r.top - stageR.top + vy / (editor.height / r.height)}px`;
  input.value = '';
  input.focus();
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter' && input.value.trim()) {
      commitStrokes();
      state.strokes.push({ kind: 'text', text: input.value.trim().slice(0, 120), at: [x, y], color: state.color, width: state.width });
      state.selected = state.strokes.length - 1; // select it so it can be dragged right away
      hideTextBox();
      render();
      updateHistoryButtons();
    } else if (ev.key === 'Escape') {
      hideTextBox();
    }
    ev.stopPropagation();
  };
}

$('textClose').addEventListener('click', (ev) => {
  ev.stopPropagation();
  hideTextBox();
});

/* ---------------- undo / redo ---------------- */
// Pure stack logic lives in shared/undo-redo.js; the editor snapshots its
// stroke list around every mutating action.
const undoHistory = new window.ImgFetchUndoRedo.UndoRedoStack();

/** Keep the Undo/Redo disabled states mirroring their stacks. */
function updateHistoryButtons() {
  $('btnUndo').disabled = !undoHistory.canUndo;
  $('btnRedo').disabled = !undoHistory.canRedo;
}

/**
 * One history snapshot: the stroke list AND the active crop (round 6).
 * A crop apply is a single step in this same stack, so Undo after a
 * crop brings the full image (and any strokes outside it) back exactly.
 */
function snapshotState() {
  return { strokes: state.strokes, crop: state.crop };
}

/** Apply a snapshot returned by undo/redo (strokes, crop, layout). */
function applySnapshot(snap) {
  const s = Array.isArray(snap) ? { strokes: snap, crop: state.crop } : snap;
  if (!s) return;
  endCropSession();
  state.strokes = s.strokes || [];
  state.crop = null;
  if (s.crop) {
    // Stored crops come from this editor, but never trust them blindly:
    // the core module validates and clamps before the value is used.
    state.crop = cropGeom
      ? (cropGeom.clampRect(s.crop, imgW(), imgH()) || s.crop)
      : s.crop;
  }
  if (state.selected >= state.strokes.length) state.selected = -1;
  state.dragText = null;
  state.moveSnapshot = null;
  state.textMoved = false;
  layoutEditor();
  syncRecordDims();
  render();
  updateHistoryButtons();
}

/**
 * Snapshot the editor state BEFORE a mutating action. Any new action
 * clears the redo stack.
 */
function commitStrokes() {
  undoHistory.commit(snapshotState());
  updateHistoryButtons();
}

function doUndo() {
  const prev = undoHistory.undo(snapshotState());
  if (!prev) return;
  applySnapshot(prev);
}

function doRedo() {
  const next = undoHistory.redo(snapshotState());
  if (!next) return;
  applySnapshot(next);
}

/* ---------------- crop tool (round 6) ----------------
 * Non-destructive: the original image and the stroke list (in original
 * image coordinates) are never touched by a crop. state.crop is the
 * applied crop; while the Crop tool is active, cropSession.rect is the
 * pending selection in VIEW coordinates (the current crop, or the full
 * image when no crop is applied). All geometry goes through
 * core/crop-rect.js, which validates and clamps every value.
 */
const cropOverlay = $('cropOverlay');
const cropBox = $('cropBox');
const cropSizeEl = $('cropSize');
const cropActions = $('cropActions');
let cropSession = null; // { rect, drag } while the Crop tool is active

function imgW() { return baseImage ? baseImage.naturalWidth : 0; }
function imgH() { return baseImage ? baseImage.naturalHeight : 0; }

/** Size the display canvas to the current view (the crop, or full image). */
function layoutEditor() {
  const v = viewRect();
  if (v.w > 0 && v.h > 0) {
    editor.width = v.w;
    editor.height = v.h;
  }
  // Fit large screenshots on screen via CSS while keeping full res.
  const maxW = Math.min(1040, window.innerWidth - 40);
  editor.style.width = v.w > maxW ? `${maxW}px` : '';
}

/**
 * Dimensions used anywhere else (the Windows clipboard note, Copy size
 * planning via the canvas) follow the cropped size after Apply, and go
 * back to the full size when a crop is undone.
 */
function syncRecordDims() {
  const v = viewRect();
  if (recordDims && v.w > 0 && v.h > 0) {
    recordDims.width = v.w;
    recordDims.height = v.h;
  }
  refreshWindowsNote();
}

function cropUnavailable() {
  UI.toast(tr('crop_unavailable', 'Crop is unavailable because the image could not be loaded.'));
}

function startCropSession() {
  if (!cropGeom || !baseImage) {
    cropUnavailable();
    return;
  }
  hideTextBox();
  state.selected = -1;
  // No pending rectangle yet, even on an already cropped image: the
  // user drags the sub-rectangle they want (it crops the current view).
  // Growing the previous crop back is Undo's job, per the spec.
  cropSession = { rect: null, drag: null };
  renderCropOverlay();
}

function endCropSession() {
  cropSession = null;
  if (cropOverlay) cropOverlay.hidden = true;
}

function cropDragActive() {
  return !!(cropSession && cropSession.drag);
}

let cropRaf = 0;
function scheduleCropRender() {
  if (cropRaf) return;
  cropRaf = requestAnimationFrame(() => {
    cropRaf = 0;
    renderCropOverlay();
  });
}

/** Position the overlay (dim, handles, size label, actions) over the view. */
function renderCropOverlay() {
  if (!cropOverlay || !cropBox) return;
  if (!cropSession || !cropSession.rect) {
    cropOverlay.hidden = true;
    return;
  }
  cropOverlay.hidden = false;
  const rect = cropSession.rect;
  const r = editor.getBoundingClientRect();
  const sr = $('stage').getBoundingClientRect();
  const sx = editor.width ? r.width / editor.width : 1;
  const sy = editor.height ? r.height / editor.height : 1;
  const left = (r.left - sr.left) + rect.x * sx;
  const top = (r.top - sr.top) + rect.y * sy;
  cropBox.style.left = `${left}px`;
  cropBox.style.top = `${top}px`;
  cropBox.style.width = `${Math.max(1, rect.w * sx)}px`;
  cropBox.style.height = `${Math.max(1, rect.h * sy)}px`;
  cropSizeEl.textContent = `${rect.w} x ${rect.h}`;
  cropSizeEl.setAttribute('aria-label', tr('crop_sizeAria',
    `Crop size: ${rect.w} by ${rect.h} pixels`, { width: rect.w, height: rect.h }));
  // Keep the label and the Apply/Cancel row inside the stage at the edges.
  cropSizeEl.classList.toggle('is-inside', top < 30);
  cropBox.classList.toggle('actions-inside', top + rect.h * sy + 46 > sr.height);
  // The actions row hangs off the box's inline-end edge; near the stage
  // border it would overflow and be clipped, so flip it to the other
  // edge when the flipped position fits instead. Same for the label.
  const aw = cropActions ? cropActions.offsetWidth : 0;
  if (aw > 0) {
    const rtl = document.documentElement.dir === 'rtl';
    const boxW = rect.w * sx;
    const endLeft = rtl ? left : left + boxW - aw;
    const startLeft = rtl ? left + boxW - aw : left;
    const over = (l) => l < 0 || l + aw > sr.width;
    cropBox.classList.toggle('actions-start', over(endLeft) && !over(startLeft));
  }
  const lw = cropSizeEl.offsetWidth;
  cropSizeEl.classList.toggle('is-end', lw > 0 && left + lw > sr.width);
}

function beginCropDrag(e, mode, handle) {
  const [x, y] = canvasPos(e);
  cropSession.drag = {
    mode,
    handle: handle || null,
    anchor: [x, y],
    startX: x,
    startY: y,
    startRect: cropSession.rect,
    prevRect: cropSession.rect,
    maxDist: 0,
  };
  if (mode === 'new') {
    const v = viewRect();
    cropSession.rect = cropGeom.rectFromPoints(x, y, x, y, v.w, v.h);
    renderCropOverlay();
  }
}

/** Canvas pointerdown while the Crop tool is active (drag = new or move). */
function cropPointerDown(e) {
  if (!cropGeom || !baseImage) {
    cropUnavailable();
    return;
  }
  if (!cropSession) startCropSession();
  if (!cropSession) return;
  try { editor.setPointerCapture(e.pointerId); } catch { /* noop */ }
  const [x, y] = canvasPos(e);
  const r = cropSession.rect;
  if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
    beginCropDrag(e, 'move', null);
  } else {
    beginCropDrag(e, 'new', null);
  }
}

function cropDragMove(e) {
  const d = cropSession && cropSession.drag;
  if (!d || !cropGeom) return;
  const [x, y] = canvasPos(e);
  const v = viewRect();
  d.maxDist = Math.max(d.maxDist, Math.hypot(x - d.anchor[0], y - d.anchor[1]));
  if (d.mode === 'new') {
    cropSession.rect = cropGeom.rectFromPoints(d.anchor[0], d.anchor[1], x, y, v.w, v.h);
  } else if (d.mode === 'move') {
    cropSession.rect = cropGeom.moveRect(d.startRect,
      Math.round(x - d.startX), Math.round(y - d.startY), v.w, v.h);
  } else {
    cropSession.rect = cropGeom.resizeRect(d.startRect, d.handle,
      Math.round(x - d.startX), Math.round(y - d.startY), v.w, v.h);
  }
  scheduleCropRender();
}

function cropDragEnd() {
  const d = cropSession && cropSession.drag;
  if (!d) return;
  cropSession.drag = null;
  if (d.mode === 'new' && d.maxDist < 3) {
    // A plain click, not a drag: keep the previous selection.
    cropSession.rect = d.prevRect;
  }
  renderCropOverlay();
}

/**
 * Apply the pending selection: ONE history step carrying the previous
 * crop. Applying the rectangle that is already active (or the full
 * image over no crop) changes nothing and adds no history step.
 */
function applyCrop() {
  if (!cropSession || !cropSession.rect || !cropGeom) return;
  const target = cropGeom.viewToImageRect(cropSession.rect, state.crop, imgW(), imgH());
  const full = cropGeom.fullRect(imgW(), imgH());
  const current = state.crop || full;
  endCropSession();
  if (!target || cropGeom.rectsEqual(target, current)) return;
  commitStrokes(); // snapshot with the PREVIOUS crop state
  state.crop = cropGeom.rectsEqual(target, full) ? null : target;
  state.selected = -1;
  layoutEditor();
  syncRecordDims();
  render();
  updateHistoryButtons();
}

if (cropBox) {
  cropBox.addEventListener('pointerdown', (e) => {
    if (!cropSession || !cropGeom) return;
    if (e.target.closest('#cropActions')) return; // the buttons keep their clicks
    e.preventDefault();
    try { cropBox.setPointerCapture(e.pointerId); } catch { /* noop */ }
    const handleBtn = e.target.closest('[data-handle]');
    beginCropDrag(e, handleBtn ? 'resize' : 'move',
      handleBtn ? handleBtn.dataset.handle : null);
  });
  cropBox.addEventListener('pointermove', cropDragMove);
  cropBox.addEventListener('pointerup', cropDragEnd);
  cropBox.addEventListener('pointercancel', cropDragEnd);
}
$('cropApply').addEventListener('click', applyCrop);
$('cropCancel').addEventListener('click', () => endCropSession());
window.addEventListener('resize', () => {
  if (cropSession) renderCropOverlay();
});

// Toolbar wiring
document.querySelectorAll('.tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    state.tool = b.dataset.tool;
    state.selected = -1;
    state.dragText = null;
    editor.style.cursor = state.tool === 'text' ? 'text' : 'crosshair';
    renderSelection();
    // L8: pixelation is weak redaction, warn once per session.
    if (state.tool === 'pixelate' && !state.pixelateWarned) {
      state.pixelateWarned = true;
      UI.toast(tr('annotate_pixelateWarning', 'Pixelation hides details from casual viewing, but it can sometimes be reversed, don’t rely on it for sensitive text.'), 5000);
    }
    document.querySelectorAll('.tool[data-tool]').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
    if (state.tool === 'crop') startCropSession();
    else endCropSession();
  });
});
document.querySelectorAll('.swatch').forEach((b) => {
  b.addEventListener('click', () => {
    state.color = b.dataset.color;
    document.querySelectorAll('.swatch').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
  });
});
document.querySelectorAll('.tool[data-width]').forEach((b) => {
  b.addEventListener('click', () => {
    state.width = Number(b.dataset.width);
    document.querySelectorAll('.tool[data-width]').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
  });
});
$('btnUndo').addEventListener('click', doUndo);
$('btnRedo').addEventListener('click', doRedo);
updateHistoryButtons(); // both disabled on an empty canvas
$('btnClear').addEventListener('click', () => {
  // Clear resets the canvas; history is discarded (undo was already a
  // no-op after Clear before redo existed).
  undoHistory.reset();
  state.strokes = [];
  state.selected = -1;
  state.dragText = null;
  state.moveSnapshot = null;
  state.textMoved = false;
  render();
  updateHistoryButtons();
});

// Delete / Escape for the selected text (ignored while typing in the box).
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  // Undo and Redo shortcuts. Ctrl+Z (Cmd+Z on macOS, via metaKey) does
  // exactly what the Undo button does (doUndo, one stack for strokes and
  // crop); Ctrl+Y and Ctrl+Shift+Z (Cmd+Shift+Z) redo. preventDefault()
  // only when a shortcut is handled: Undo with an empty history (the
  // Undo button disabled) leaves the event alone, and the INPUT and
  // TEXTAREA early return above keeps native text undo working there.
  // During a pending crop rectangle this undoes the last committed step
  // (applySnapshot ends the crop session, exactly like the Undo button);
  // the pending rectangle is never applied by the shortcut.
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      if (undoHistory.canUndo) {
        e.preventDefault();
        doUndo();
      }
      return;
    }
    if (k === 'y' || (e.shiftKey && k === 'z')) {
      e.preventDefault();
      doRedo();
      return;
    }
  }
  // C selects the Crop tool (the button click does the rest).
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
    const btn = document.querySelector('.tool[data-tool="crop"]');
    if (btn && !btn.disabled) {
      btn.click();
      return;
    }
  }
  // Crop session keys: Esc cancels, Enter applies, arrows nudge the
  // pending rectangle (Shift = 10 px). Buttons keep their native keys.
  if (cropSession) {
    if (e.key === 'Escape') {
      e.preventDefault();
      endCropSession();
      return;
    }
    if (cropSession.rect && cropGeom) {
      if (e.key === 'Enter' && !(t && t.tagName === 'BUTTON')) {
        e.preventDefault();
        applyCrop();
        return;
      }
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (dx || dy) {
          const v = viewRect();
          cropSession.rect = cropGeom.nudgeRect(cropSession.rect, dx, dy, v.w, v.h);
          e.preventDefault();
          renderCropOverlay();
          return;
        }
      }
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
    e.preventDefault();
    deleteSelectedText();
  } else if (e.key === 'Escape' && state.selected >= 0 && !state.drawing) {
    state.selected = -1;
    renderSelection();
  }
});

// Feature A: Copy button. The module is lazy-loaded so a load failure can
// never break the editor; getEditor() calls redraw() first so the copied
// image is the current flattened canvas (no selection chrome, no previews).
(async () => {
  const btn = $('btnCopy');
  if (!btn) return;
  try {
    const mod = await import('../shared/copy-shot.js');
    mod.initCopyButton(btn, () => { redraw(); return editor; });
  } catch {
    btn.disabled = true;
    try {
      const { t } = await import('../shared/i18n.js');
      btn.title = t('copyUnavailable');
    } catch { btn.title = 'Copy is unavailable right now.'; }
  }
})();

$('btnSave').addEventListener('click', async () => {
  $('btnSave').disabled = true;
  try {
    redraw();
    const dataUrl = editor.toDataURL('image/png');
    await UI.send('SAVE_ANNOTATED', { id, dataUrl });
    UI.toast(tr('annotate_saved', 'Screenshot saved.'));
    setTimeout(() => window.close(), 800);
  } catch (err) {
    UI.toast(err.message || tr('annotate_saveFailed', 'Save failed.'));
    $('btnSave').disabled = false;
  }
});
$('btnCancel').addEventListener('click', () => window.close());

async function init() {
  try {
    const { settings } = await UI.send('GET_SETTINGS');
    UI.applyTheme(settings.theme);
    UI.watchSystemTheme(() => settings.theme);
  } catch {
    UI.applyTheme('system');
  }
  if (!id) {
    fail(tr('annotate_invalidLink', 'This editor link is invalid.'));
    return;
  }
  let cap;
  try {
    // Fast path: read the capture straight from IndexedDB (same extension
    // origin) instead of a multi-MB worker round trip; retries briefly
    // while the worker finishes storing, then falls back to the worker.
    const { loadCaptureRecord } = await import('../shared/capture-io.js');
    cap = await loadCaptureRecord(id, (t, pl) => UI.send(t, pl));
  } catch (err) {
    fail(err.message);
    return;
  }
  // Parts of a split full-page capture show their "Part i of N" title
  // in the subtitle and the tab title (same contract as capture.js).
  if (cap.partTotal > 1 && cap.partIndex > 0) {
    partLabel = tr('part_title', `Part ${cap.partIndex} of ${cap.partTotal}`,
      { count: cap.partIndex, total: cap.partTotal });
    applyPartLabel();
  }
  recordDims = {
    width: Number(cap.width) || 0,
    height: Number(cap.height) || 0,
    isMultiPart: cap.partTotal > 1,
  };
  try {
    platformMod = await import('../shared/platform.js');
  } catch { platformMod = null; }
  await cropGeomReady; // settled (module or null) before the editor opens
  refreshWindowsNote();
  const img = new Image();
  img.onload = () => {
    // The decoded <img> IS the base layer (no full-size canvas copy),
    // and the annotation canvas stays unallocated until the first
    // stroke, so opening a tens-of-megapixels part stays light.
    baseImage = img;
    if (recordDims && !(recordDims.width > 0 && recordDims.height > 0)) {
      recordDims.width = img.naturalWidth;
      recordDims.height = img.naturalHeight;
    }
    refreshWindowsNote();
    // No crop yet: the display canvas is the full image, fitted on
    // screen via CSS while keeping full resolution.
    layoutEditor();
    if (!cropGeom) {
      // The geometry module failed to load: Crop stays visibly disabled.
      const btn = document.querySelector('.tool[data-tool="crop"]');
      if (btn) {
        btn.disabled = true;
        btn.title = tr('crop_unavailable', 'Crop is unavailable because the image could not be loaded.');
      }
    }
    redraw();
    $('loading').hidden = true;
    $('content').hidden = false;
  };
  img.onerror = () => fail(tr('annotate_loadFailed', 'Could not load the screenshot.'));
  try {
    const { captureRecordObjectUrl } = await import('../shared/capture-io.js');
    const source = captureRecordObjectUrl(cap);
    window.addEventListener('unload', () => source.revoke());
    img.src = source.url;
  } catch {
    img.src = cap.dataUrl;
  }
}

document.addEventListener('DOMContentLoaded', init);
})();
