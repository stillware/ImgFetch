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
 * ImgFetch, shared/capture-io.js
 * Screenshot record loading for the result pages (pages/capture.js,
 * pages/annotate.js). Classic-script friendly: loaded via dynamic import().
 *
 * Fast path: extension pages share the service worker's IndexedDB origin,
 * so the capture record is read directly instead of asking the worker to
 * send several MB back as a message. The result tab opens early (see
 * captureRegion), so a missing record is retried briefly while the page
 * shows its loading state. When IndexedDB is unavailable, or the record
 * never appears, fall back to the worker (GET_CAPTURE) so the honest
 * localized error still surfaces.
 */

/**
 * The image payload of a capture record, whichever form it takes:
 * a Blob (stitched parts) or null when the record is a legacy dataUrl
 * record (or carries neither). One helper for every reader, so no
 * reader grows its own blob/dataUrl branching.
 */
export function captureRecordBlob(rec) {
  if (rec && rec.blob && typeof rec.blob === 'object' && Number(rec.blob.size) > 0) {
    return rec.blob;
  }
  return null;
}

/**
 * Turn a capture record into something an <img> or a canvas can use:
 * { url, revoke }. For blob records the url is a fresh object URL and
 * revoke() releases it (call it when the image is done); for legacy
 * dataUrl records the url is the data URL itself and revoke() is a
 * no-op. Throws when the record carries no image at all.
 */
export function captureRecordObjectUrl(rec) {
  const blob = captureRecordBlob(rec);
  if (blob) {
    const url = URL.createObjectURL(blob);
    let done = false;
    return {
      url,
      revoke() {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch { /* already gone */ }
      },
    };
  }
  if (rec && typeof rec.dataUrl === 'string' && rec.dataUrl) {
    return { url: rec.dataUrl, revoke() {} };
  }
  throw new Error('capture record has no image');
}

/**
 * Decode a capture record to an ImageBitmap (blob directly, legacy
 * dataUrl decoded locally via core/data-url.js, never fetch(dataUrl)).
 * The caller owns the bitmap and closes it.
 */
export async function captureRecordBitmap(rec) {
  const blob = captureRecordBlob(rec);
  if (blob) return createImageBitmap(blob);
  if (rec && typeof rec.dataUrl === 'string' && rec.dataUrl) {
    const { dataUrlToBlob } = await import('../core/data-url.js');
    return createImageBitmap(dataUrlToBlob(rec.dataUrl));
  }
  throw new Error('capture record has no image');
}

/**
 * Read one capture record straight from IndexedDB.
 * Returns the record object, undefined when the store is reachable but the
 * record is absent, or null when IndexedDB itself is unavailable.
 */
async function readDirect(id) {
  try {
    const { idb } = await import('../background/idb.js');
    const rec = await idb.get('captures', String(id));
    if (!rec) return undefined;
    const { id: _drop, ...data } = rec;
    return data;
  } catch {
    return null;
  }
}

/**
 * Load a capture record by id: direct IndexedDB read first, brief retry
 * while the worker finishes storing, worker fallback last.
 * send is (type, payload) => Promise, e.g. UI.send.
 */
export async function loadCaptureRecord(id, send) {
  const direct = await readDirect(id);
  if (direct) return direct;
  if (direct === undefined) {
    // The store is reachable but the worker has not stored the record yet
    // (early-opened result tab): poll briefly, then ask the worker.
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 50));
      const rec = await readDirect(id);
      if (rec) return rec;
      if (rec === null) break; // IndexedDB went away; use the worker
    }
  }
  // No IndexedDB, or the record never appeared: the worker answers from
  // its memory cache, or with the honest localized error.
  const cap = await send('GET_CAPTURE', { id });
  return {
    dataUrl: cap.dataUrl,
    blob: cap.blob || null,
    width: cap.width,
    height: cap.height,
    partIndex: cap.partIndex || 0,
    partTotal: cap.partTotal || 0,
    groupId: cap.groupId || '',
  };
}
