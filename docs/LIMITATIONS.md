# ImgFetch, Known limitations

Honest edges of v1.1.0, things ImgFetch won't do, or does with caveats.

1. **No bypassing protections.** Images behind login walls, DRM or
   canvas-only renderers may not download. Page `blob:` URLs (e.g. GIF
   sites) *do* download while the page is open, ImgFetch resolves them
   in-page to real bytes; they can't be re-fetched after the tab closes.
   ImgFetch never circumvents access controls; screenshots capture only
   what's visibly rendered.
2. **Smart Download is best-effort.** It validates real candidates
   (srcset, zoom attributes, size-suffix variants), but some sites serve the
   “original” only after interaction (lightbox open, login). When nothing
   validates, ImgFetch says so and falls back, never invents quality.
3. **Format support follows the browser.** AVIF/WebP *decoding* depends on
   the browser; *encoding* to AVIF is offered only if the browser supports
   it (probed with a real encode at runtime, otherwise a clear message
   explains the PNG fallback; encoded output is MIME-verified so a file is
   never mislabeled). **PNG quality:** the PNG slider is real - 100% is
   lossless and pixel-identical; lower values reduce the colour count
   (median-cut) to make smaller files, with alpha preserved. Animated GIF/WebP are saved as-is; converting an animation to
   PNG/JPG/WebP/AVIF keeps the first frame only (ImgFetch says so in a notice).
   **GIF:** ImgFetch ships its own pure-JS GIF89a encoder (median-cut 256-color
   palette, LZW, 1-bit transparency), “Save as GIF” now genuinely produces a
   .gif from any source. Animated GIF sources download directly (animation
   intact); animated WebP/APNG sources are converted to real multi-frame
   animated GIFs (up to 60 frames) via WebCodecs frame decoding; a still
   source can only ever produce a still GIF, animation needs multiple
   frames. **SVG:** a valid SVG document wrapping the best source’s raster
   (vector tracing is out of scope). **BMP:** real 24-bit encoding; alpha is
   flattened (no standard alpha channel).
4. **Screenshots.** “Visible page” captures whatever tab is active
   right now: http/https sites, `chrome://`, `edge://`, `about:` and New Tab
   pages, `chrome-extension://` pages (including ImgFetch's own Settings
   page), `data:` URLs, and `file://` URLs when the user granted file access.
   It never captures a different tab. This is a browser security rule:
   `chrome.tabs.captureVisibleTab` needs the `activeTab` permission (granted
   by your toolbar click, shortcut or context menu) and ImgFetch adds no host
   permissions, so capturing only ever covers the page you asked about.

5. **Full page, Select area and Capture element** need script injection, and
   the browser forbids injection on `chrome://`, `edge://`, the Chrome Web
   Store, Edge Add-ons, other extensions' pages, and `chrome-extension://`
   pages (including ImgFetch's own Settings page). On pages where injection is
   forbidden, ImgFetch falls back to a visible-area capture of the active
   tab and says so: “{mode} is not available on this page. The visible part
   was captured instead.” On the Chrome Web Store and Edge Add-ons pages even
   visible capture is refused by the browser; there you get a clear error
   (“The browser does not allow capturing this page.”) instead of a silent
   failure. Pages that change height while scrolling (infinite scroll) may
   stitch imperfectly, and your scroll position is always restored afterward,
   even on failure. Very large area selections are capped (16,000 px per
   side).

6. **Very long pages** are captured whole at full device resolution and
   split into numbered parts (Part 1 of N), because a single stitched image
   is limited by what the browser's canvas can hold (max side 16,384 device
   px, max area about 64 megapixels; these are browser limits, not ImgFetch
   limits). A high sanity cap (48 parts) stops runaway pages, and ImgFetch
   says so clearly instead of stopping silently. **Annotated screenshots**
   save through the browser's message passing, which caps data-URL messages
   at about 40 MB: an annotated part whose PNG does not compress under that
   limit cannot be saved (known pre-existing issue, left as is).

7. **Download progress is per-file, not per-byte.** The queue shows each
   file's state (pending → active → done/failed); byte-level progress lives in
   the browser's own download shelf.
8. **Languages.** The UI is localized in 19 languages (21 locales),
   picked in Settings → General → Language (default Auto, which follows the
   browser language, switchable at runtime without reload). Arabic uses a
   right-to-left layout. Translations are AI-assisted and have not been
   reviewed by native speakers; see docs/TRANSLATING.md.
9. **Chrome/Edge only.** Manifest V3 as implemented here targets
   Chromium-based browsers. Firefox and Safari ports are deferred (different
   APIs for offscreen documents and screenshots).
10. **Huge inline images.** Images embedded as data-URLs larger than ~500 KB
   are skipped by the scanner to protect memory and storage quotas.
11. **Google Lens.** Google Lens search depends on Google keeping its
   upload-by-URL address working; if Google changes it, the menu item may
   stop working.

# Deferred features (Tier 2/3, not in v1)

- Cloud upload targets (Drive/Dropbox/S3)
- OCR on screenshots
- Video frame capture
- Batch download from a pasted URL list
- AI upscaling
- Firefox and Safari ports

# Rejected (deliberately not built)

- **Background scraping without user action**: scans and downloads always
  start from an explicit user gesture.
- **`<all_urls>` host permission**: scheme-scoped `https/http` is sufficient
  and less alarming.
- **`tabs` permission**: unnecessary; host permissions already expose tab URLs.
- **Remote code / analytics SDKs**: incompatible with the privacy promise and
  with store policy; all code ships in the package.
- **Automatic “HD-ify” claims**: ImgFetch never labels an unvalidated file as
  best/original quality.
