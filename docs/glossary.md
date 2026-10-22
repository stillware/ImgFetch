# Glossary

Short definitions of the terms used in the ImgFetch code, tests and docs.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

| Term | Meaning |
| --- | --- |
| tile | One viewport sized screenshot taken while scrolling during a Full page capture. Tiles are placed by the stitcher or grouped into parts. |
| part | One balanced section of a long Full page capture, up to 32767 pixels per side and about 100 megapixels. Parts are stored as Blobs in IndexedDB and listed in the Parts overview. |
| group | The set of parts and capture records that belong to one Full page capture. A group is opened, finalized and pruned as a unit. |
| capture record | The stored entry for one capture or part in IndexedDB, holding the image data and metadata such as its group and part number. Records expire after 1 hour and at most 60 are kept. |
| offscreen document | A hidden extension page (`offscreen/offscreen.html`) that does canvas and file work the service worker cannot do, such as conversion, stitching, ZIP building and clipboard writes. |
| service worker | The background script (`background/service-worker.js`) that routes messages, runs downloads and coordinates captures. It can stop and restart between events. |
| lossless crop | A crop that copies the exact pixels of the selected region with no quality conversion, used for Area and Element captures in the service worker. |
| non-destructive crop | The editor Crop model: the original image and annotations are never changed, the crop rectangle is stored in state, and the region is applied only when rendering, saving or copying. |
| rate-limit gap | The pause between tile screenshots in a Full page capture, set by `TILE_GAP_MS` at 520 milliseconds, because the browser allows about 2 captures per second. |
| scan | One pass over a page that collects image candidates from the document, scores them and shows the results in the popup. |
| candidate | One possible source for an image found during scanning, such as the original file, a srcset entry or a picture element source, before the best valid one is chosen. |
| queue | The download queue that runs pending downloads with limited concurrency, progress, cancel and one automatic retry. It survives service worker restarts. |
| history | The local record of finished downloads, kept up to 200 entries and pruned by the retention setting, which defaults to 30 days. |
| site preference | A per-site setting (Smart, As shown or Paused) stored by host name and honored by the menu, the popup and the shortcuts. |
| smart quality | The default quality mode, which probes the real sources of an image and saves the best one that verifies, without upscaling or inventing a better source. |
| capture group finalize | The closing step for a capture group, run in the offscreen document, which writes the final part count onto each capture record before exactly one result tab opens. |
| stitch | Joining tiles in order into one image in the offscreen document, placing each tile at its measured offset with no seams or duplicated rows. |
| data URL | A URL that carries the file data inline, usually as base64 text, instead of pointing to a network address. Large annotated saves travel this way within the message size caps. |
| blob | A binary object held in memory or in IndexedDB rather than as text. Capture parts are stored as Blobs to avoid large base64 strings. |
