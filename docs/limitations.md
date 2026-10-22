# Limitations

Known limits of ImgFetch 1.1.0, grouped by area, with the reason for each limit and the workaround where one exists.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Capture

| Limit | Reason | Workaround |
| --- | --- | --- |
| One Full page part is at most 32767 device pixels on its longest side and at most 100 megapixels in area. A capture has at most 48 parts. | Browser canvas limits make one stitched image impossible at full resolution on very long pages. | Parts open in the Parts overview. Use Save all there to download every part. |
| Tile shots are spaced 520 ms apart, so a long page takes time to capture. | The browser allows only about 2 visible tab captures per second. | None. The progress row shows progress, and Stop ends the capture and keeps the finished parts. |
| One Full page capture stops after 10 minutes. | A hard duration cap in `core/fullpage-capture.js` stops runaway pages. | Capture the page in sections with Area, or stop infinite loading first. |
| Stored captures expire after 1 hour. At most 60 capture records and 500 MB of captures are kept. | Captures are previews stored in IndexedDB, not an archive. | Save or copy the parts you need before they expire. |
| Area and Element crops are at most 16000 pixels per side. | The crop limit in `core/crop-image.js` bounds worker memory. | Use Full page for larger regions. |
| Browser internal pages, store pages, and the built-in PDF viewer cannot be scanned. Area, Element, and Full page need script injection and fall back to a Visible capture with a notice where injection is blocked. Store pages refuse even a Visible capture. | The browser blocks extensions on those pages. | Use a Visible capture where the browser allows it, or use the operating system screenshot tool. |
| Visible captures only the active tab, and only after a user gesture such as a click or a shortcut. | The browser grants tab capture through the `activeTab` permission, tied to the tab you invoked ImgFetch from. | Switch to the tab you want first, then capture. |
| Page `blob:` URLs download only while the page is open. | A `blob:` URL lives in the memory of the page that created it. | Download before closing the tab. |
| The scanner skips inline data URL images over about 500 KB, and scan data URLs are capped at 2 MB. | Large inline images would cost too much memory and message size during a scan. | Open the image on its own and use the ImgFetch context menu on it. |
| Images behind login walls, DRM, or canvas only renderers may not download. Screenshots record rendered pixels only and never bypass a protection. | ImgFetch does not circumvent access controls. | Sign in first, or use the export the site itself offers. |
| Smart Download is best effort. Some sites serve the original only after an interaction such as opening a lightbox or signing in. | The best source cannot be validated until the site offers it. | Interact with the page first, then retry. ImgFetch falls back with a notice and never invents quality. |

Open capture groups are never pruned by the expiry cleanup, and closed groups are pruned as a whole, never one part at a time.
If you cancel a capture or switch away from the source tab, capture stops, finished parts are kept, and your scroll position is restored.

## Editor

| Limit | Reason | Workaround |
| --- | --- | --- |
| The minimum Crop size is 8 by 8 image pixels, and there is no aspect ratio lock. | The geometry floor in `core/crop-rect.js` keeps the rectangle valid and draggable. | None. Drag any of the 8 handles to fine tune the rectangle. |
| Selecting the whole image in Crop is a no-op. Apply adds no history step and stores no crop. | A crop equal to the current view changes nothing, so `pages/annotate.js` skips it. | After a real crop, use Undo to return to the full image. |
| An annotated save fails with a too-large error when the exported data URL is longer than 40,000,000 characters. The message itself is capped at 45,000,000 characters. | Annotated saves travel through runtime message passing, which has a size cap. | Crop to a smaller region, or save the unannotated part from the Parts overview. |
| The editor keeps the decoded original image in memory while you edit. Very large parts need substantial memory. | Lossless editing works on the decoded original, and Crop adds no full size copy. | Edit one part at a time and close other heavy tabs. |
| Pixelate is weak redaction. Blocked out detail can sometimes be recovered. | Pixelate only averages blocks of the base image. | Treat Pixelate as hiding from casual viewing only. Crop sensitive content out instead. |
| Text labels are limited to 120 characters each. | The editor input cap in `pages/annotate.js` keeps labels readable. | Split long text into more than one Text label. |
| Clear removes every stroke and discards the undo history. A cleared canvas cannot be restored with Undo. | Clear resets the history stack by design. | Save a copy first if you may need the annotations. |

## Clipboard

| Limit | Reason | Workaround |
| --- | --- | --- |
| Editor copies larger than 12 megapixels are downscaled before the clipboard write. | The copy budget in `core/clipboard-image.js` keeps the PNG write fast and reliable. | Use Save when you need the copy at full resolution. |
| On Windows, clipboard history (Win+V) may not show very large copies. ImgFetch shows a note for images over about 2 megapixels and for any part of a multi-part capture. | The size limit is in Windows clipboard history, not in the copy itself. | Paste with Ctrl+V. The copy succeeded even when history does not list it. |
| Copied link text is truncated at 8,192 characters in the offscreen clipboard write. | The cap in `offscreen/offscreen.js` bounds clipboard messages. | Image URLs are far below this cap in practice. Open the image and copy its address from the browser if a link is ever cut. |

## Formats

| Limit | Reason | Workaround |
| --- | --- | --- |
| AVIF encoding needs Chrome or Edge 130 or later. Support is probed with a real encode at runtime. | Older browsers cannot encode AVIF. | Update the browser. Until then ImgFetch saves a PNG instead and says so. |
| Converting an animated image to PNG, JPG, WebP, or AVIF keeps the first frame only. | Still image formats hold one frame. ImgFetch shows a notice when this happens. | Keep the original format, or save as GIF. |
| Converting an animated WebP or APNG source to GIF keeps at most 60 frames. Animated GIF sources download as they are, with the animation intact. | Frame decoding work in the offscreen document is bounded. | Save the original file when you need every frame. |
| PNG quality below 100 percent reduces the color count to shrink the file. At 100 percent PNG output is lossless. | PNG has no native quality control, so ImgFetch quantizes colors with a median-cut palette and preserves alpha. | Keep PNG quality at 1 for lossless output. |
| BMP output is 24-bit and flattens transparency. | BMP has no standard alpha channel. | Use PNG when you need transparency. |
| Save as SVG wraps the best raster source in a valid SVG document. It does not trace vectors. | Vector tracing is out of scope for this version. | None. Use a dedicated tracing tool for true vector output. |
| GIF output uses a palette of at most 256 colors. | The GIF89a format limit applies to the encoder in `core/gif.js`. | Expect banding on photographs. Use PNG or WebP for still images. |

## Browsers

| Limit | Reason | Workaround |
| --- | --- | --- |
| ImgFetch runs in Google Chrome and Microsoft Edge only, with Chrome 116 or later. There is no Firefox or Safari version. | The Manifest V3 offscreen document and capture APIs used here differ outside Chromium. | Use Chrome or Edge. The Edge Add-ons listing is published and currently serves 1.0.0, with the 1.1.0 update pending Microsoft review. The Chrome Web Store listing is coming soon. Until the store version you need is live, install from the release zip as the [User guide](user-guide.md) describes. |
| Image decoding and encoding support follows the browser build. | Codecs ship with the browser, not with the extension. | Keep the browser up to date. |

## Platform

| Limit | Reason | Workaround |
| --- | --- | --- |
| Every save lands through the browser Downloads folder. ImgFetch cannot write to an arbitrary folder. Optional subfolders inside Downloads are supported. | The downloads API is the only file destination an extension gets. | Use the Folders settings to organize by site, type, or date, or set a fixed subfolder. |
| Download progress in the queue is per file, not per byte. | The queue tracks file states: pending, active, done, failed. | Byte level progress lives in the browser download shelf. |
| Download history keeps at most 200 records. The default retention is 30 days. | Local history storage is bounded in `core/history.js`. | Adjust retention from 1 to 365 days in Settings, or turn history off. |
| Translations in the 21 locales are AI assisted and have not been reviewed by native speakers. | Project resources. Arabic uses a right-to-left layout. | Report wording problems through GitHub Issues. See [Translating](translating.md). |
| Search Image with Google Lens depends on the Google upload by URL address staying available. | It is an external service outside this project. | None. If Google changes the address, the menu item may stop working. |
| Scans and downloads start only from an explicit user gesture. There is no background scraping. | A deliberate design decision, also covered in the [Security model](security-model.md). | None. |

## Not in this version

The following are not in this version: cloud upload targets, OCR on screenshots, video frame capture, batch download from a pasted URL list, and AI upscaling. There is no Firefox or Safari version, and none is promised.
Also deliberately not built: the `tabs` permission, the `<all_urls>` host permission, remote code, and analytics. The reasons are in the [Security model](security-model.md) and in [Permissions](permissions.md).
