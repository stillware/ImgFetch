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
 * ImgFetch, core/data-url.js
 * Chunked decoding of data: URLs into bytes / a Blob, WITHOUT going
 * through fetch(dataUrl). A screenshot data URL can be tens of MB;
 * fetch() makes the browser parse and materialize the whole URL again
 * internally, while decoding here in fixed-size chunks keeps the peak
 * memory close to the output size. No DOM and no chrome.* APIs, so the
 * helper runs in the service worker, the offscreen document and pages
 * alike, and is unit-testable in Node.
 */

/**
 * Base64 characters decoded per step. A multiple of 4, so a chunk never
 * splits a base64 quantum and atob() only ever sees whole quanta (the
 * final chunk may carry the padding).
 */
const CHUNK_CHARS = 131072;

/** Split a data URL into { mime, isBase64, payload }; throws on bad input. */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('bad-data-url');
  }
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('bad-data-url');
  const header = dataUrl.slice(5, comma);
  const parts = header.split(';');
  const mime = parts[0] || 'text/plain';
  const isBase64 = parts.slice(1).some((p) => p.toLowerCase() === 'base64');
  return { mime, isBase64, payload: dataUrl.slice(comma + 1) };
}

/**
 * Decode a data URL to its exact bytes. Base64 payloads are decoded
 * with atob() in chunks (never one giant intermediate string copy);
 * plain payloads are percent-decoded as UTF-8. Throws a plain Error on
 * malformed input; atob's own error propagates for bad base64.
 */
export function dataUrlToBytes(dataUrl) {
  const { isBase64, payload } = parseDataUrl(dataUrl);
  if (!isBase64) {
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const clean = payload.replace(/\s+/g, '');
  const chunks = [];
  let total = 0;
  for (let i = 0; i < clean.length; i += CHUNK_CHARS) {
    const bin = atob(clean.slice(i, i + CHUNK_CHARS));
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j += 1) bytes[j] = bin.charCodeAt(j);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Decode a data URL to a Blob carrying the URL's own media type. */
export function dataUrlToBlob(dataUrl) {
  const { mime } = parseDataUrl(dataUrl);
  return new Blob([dataUrlToBytes(dataUrl)], { type: mime });
}
