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
 * ImgFetch, core/capture-storage.js
 * Pure storage rules for screenshot capture records (IndexedDB
 * 'captures' store). A record carries either the legacy `dataUrl`
 * string (visible / area / element captures) or a `blob` (stitched
 * full-page parts, written straight to IndexedDB by the offscreen
 * document so a part never travels as a giant base64 string). Parts of
 * one full-page capture share a `groupId`; a group is "open" while its
 * capture is still running (or its overview has not been finalized).
 *
 * Pruning contract (enforced by pruneCaptureRecords, used by the
 * worker after every store):
 *  - a record belonging to a still-open group is NEVER pruned, and a
 *    closed group is only ever pruned as a whole (all its records at
 *    once), so a parts set can never lose a middle part;
 *  - records older than maxAgeMs are pruned (oldest first);
 *  - total stored bytes are capped at CAPTURE_STORAGE_MAX_BYTES:
 *    500 MB of screenshots is far beyond any honest working set for a
 *    transient preview store, and the cap keeps a runaway capture
 *    history from filling the user's disk;
 *  - at most CAPTURE_STORAGE_MAX_RECORDS records are kept.
 * No DOM, no chrome.*: unit-tested in Node.
 */

export const CAPTURE_STORAGE_MAX_BYTES = 500_000_000; // total bytes cap for stored captures
export const CAPTURE_STORAGE_MAX_AGE_MS = 3600_000; // captures are previews; they expire after 1 h
export const CAPTURE_STORAGE_MAX_RECORDS = 60; // hard record-count bound

/**
 * Byte size of one capture record (or record-shaped meta object).
 * Blob size wins, then an explicit `bytes`, then the decoded size of
 * the base64 payload of a data URL (length * 3/4, padding aside).
 */
export function captureRecordBytes(rec) {
  if (!rec) return 0;
  if (rec.blob && Number(rec.blob.size) > 0) return Number(rec.blob.size);
  if (Number(rec.bytes) > 0) return Number(rec.bytes);
  if (typeof rec.dataUrl === 'string') {
    const comma = rec.dataUrl.indexOf(',');
    const payload = comma >= 0 ? rec.dataUrl.length - comma - 1 : rec.dataUrl.length;
    return Math.max(0, Math.round(payload * 0.75));
  }
  return 0;
}

/** Minimal meta view of a record for pruning (no payload access). */
export function captureRecordMeta(rec) {
  return {
    id: String((rec && rec.id) || ''),
    at: Number(rec && rec.at) || 0,
    bytes: captureRecordBytes(rec),
    groupId: rec && rec.groupId ? String(rec.groupId) : '',
    groupOpen: !!(rec && rec.groupOpen),
  };
}

/**
 * Decide which records to delete. Input: meta objects as produced by
 * captureRecordMeta (or record-shaped equivalents). Options override
 * the module caps: { now, maxAgeMs, maxBytes, maxRecords, openGroupIds
 * (extra group ids to treat as open) }. Returns an array of record ids
 * to delete, oldest first. Pure: inputs are not mutated.
 */
export function pruneCaptureRecords(metas, opts = {}) {
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const maxAgeMs = Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : CAPTURE_STORAGE_MAX_AGE_MS;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : CAPTURE_STORAGE_MAX_BYTES;
  const maxRecords = Number(opts.maxRecords) > 0 ? Number(opts.maxRecords) : CAPTURE_STORAGE_MAX_RECORDS;
  const extraOpen = new Set(opts.openGroupIds || []);
  const list = (metas || []).filter((m) => m && m.id);
  const isOpen = (m) => !!m.groupOpen || (m.groupId && extraOpen.has(m.groupId));

  // Group records by groupId; standalone records are their own group.
  const groups = new Map(); // key -> { metas, open, oldestAt, bytes }
  for (const m of list) {
    const key = m.groupId ? `g:${m.groupId}` : `s:${m.id}`;
    if (!groups.has(key)) groups.set(key, { metas: [], open: false, oldestAt: Infinity, bytes: 0 });
    const g = groups.get(key);
    g.metas.push(m);
    if (isOpen(m)) g.open = true;
    if (m.at < g.oldestAt) g.oldestAt = m.at;
    g.bytes += captureRecordBytes(m);
  }
  // An "open" group whose newest record is already older than the age
  // cap is abandoned (its capture died with the worker); treating it
  // as closed keeps a crashed capture from leaking storage forever.
  // A live capture's parts are always fresh, so this never touches
  // one that is still running.
  for (const g of groups.values()) {
    const newest = Math.max(...g.metas.map((m) => m.at));
    if (g.open && now - newest > maxAgeMs) g.open = false;
  }
  const drop = new Set();
  const dropGroup = (g) => { for (const m of g.metas) drop.add(m.id); };
  const aliveGroups = () => [...groups.values()].filter((g) => !g.metas.every((m) => drop.has(m.id)));
  const byAge = (a, b) => a.oldestAt - b.oldestAt;

  // 1) Age: whole groups whose newest record is older than the cap.
  for (const g of [...groups.values()].sort(byAge)) {
    if (g.open) continue;
    const newest = Math.max(...g.metas.map((m) => m.at));
    if (now - newest > maxAgeMs) dropGroup(g);
  }
  // 2) Total bytes: oldest closed groups first, until under the cap.
  let totalBytes = aliveGroups().reduce((n, g) => n + g.bytes, 0);
  if (totalBytes > maxBytes) {
    for (const g of aliveGroups().filter((g) => !g.open).sort(byAge)) {
      if (totalBytes <= maxBytes) break;
      dropGroup(g);
      totalBytes -= g.bytes;
    }
  }
  // 3) Record count: oldest closed groups first, until under the cap.
  let totalCount = aliveGroups().reduce((n, g) => n + g.metas.length, 0);
  if (totalCount > maxRecords) {
    for (const g of aliveGroups().filter((g) => !g.open).sort(byAge)) {
      if (totalCount <= maxRecords) break;
      dropGroup(g);
      totalCount -= g.metas.length;
    }
  }
  return list.filter((m) => drop.has(m.id)).sort((a, b) => a.at - b.at).map((m) => m.id);
}
