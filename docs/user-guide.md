# User guide

How to install ImgFetch and use every feature: scanning, downloading, screenshots, the editor, and settings.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Install

ImgFetch runs in Google Chrome and Microsoft Edge, with Chrome 116 or later.
Microsoft Edge: published on [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/obblfdlgliblmpngaidjianbkahcplea). The live listing currently serves 1.0.0; the 1.1.0 update is submitted after the GitHub release and goes live when Microsoft approves it.
Google Chrome: the Chrome Web Store listing is coming soon. Firefox is coming soon and needs a separate port.
Version 1.1.0 was released on GitHub Releases on 2026-10-22 (tag `v1.1.0`). To install 1.1.0 now, or to install in Chrome, use the release zip:

1. Download the release zip and unpack it. Keep the unpacked `ImgFetch` folder in a fixed place, because the browser loads it from there.
2. In Chrome, open `chrome://extensions`. In Edge, open `edge://extensions`.
3. Turn on Developer mode.
4. Choose Load unpacked and select the unpacked `ImgFetch` folder.
5. Pin ImgFetch to the toolbar so its button is always visible.

There is no sign-in and no account. Everything runs on your device. See [Permissions](permissions.md) for what each permission is for.

## First run

Click the ImgFetch toolbar button to open the popup. The popup opens on Home, which holds the Scan this page button,
the four screenshot buttons (Visible, Area, Element, Full page), and status cards for any running capture, scan, or download queue.
The icons at the top open Home, download History, and Settings. Reopening the popup always starts at Home.
The Home button returns to the dashboard and clears the current selection. It never stops a running download.

## Save a single image

Right-click any image on a normal web page and open the ImgFetch menu:

| Action | What it does |
| --- | --- |
| Smart Download | Finds every genuinely available source (original, `srcset`, `picture`, lazy loaded, size variants), checks that each one really loads, and saves the best valid one. It never upscales and never invents quality. If the best source fails, it tries the next one and tells you. |
| Save as | Saves the best valid source converted once into the format you pick: PNG, JPG, WebP, AVIF, GIF, SVG, or BMP. Transparency is preserved where the format supports it. |
| Open Original | Opens the image address in a new tab. |
| Copy Image Link | Copies the image address to the clipboard. |
| Copy Image | Copies the image itself to the clipboard. |
| Image Info | Opens a details page for the image, including a clean copy option with metadata stripped. |
| Search Image with Google Lens | Opens a Google Lens search for the image. It runs only when you click it. |
| More | Holds Open Original, Search Image with Google Lens, Scan This Page, Screenshot, Add Site Preference, Disable on This Site, and Settings. |

Downloads go to the browser Downloads folder, organized by your Folders settings. See [Limitations](limitations.md) for the cases a site can block.

## Scan a page and download images

1. Open the page and click the ImgFetch toolbar button.
2. Click Scan this page. A progress view runs while ImgFetch collects the images on the page.
3. In the results, search by name, alt text, or site. Filter by size, format, and orientation, and sort by page order or by size.
4. Click a thumbnail to preview it. The preview holds the same Smart Download and Save as actions as the context menu.
5. Select images with the checkboxes, or with Shift+click and Ctrl+click, or with Space and Enter on a focused thumbnail. Use Select all, Select none, and Invert to adjust the selection.
6. Choose Smart Download or As shown, pick a target format, then click Download selected. Download selected as ZIP packs the selection into one zip file, exactly as shown on the page.

Scanning only works on normal http and https pages. The browser blocks extensions on internal pages, store pages, and the PDF viewer.

## Quality and formats

Smart Download is the default quality mode. It probes candidate sources and saves the best one that really loads.
The original quality preference skips probing and saves the exact source, which is faster and makes fewer requests.
A per-site preference can override the global mode. See Settings below.

| Format | Notes |
| --- | --- |
| PNG | Lossless at quality 1. Lower quality reduces the color count to shrink the file. |
| JPG | Quality slider applies. Transparency is flattened onto a white background. |
| WebP | Quality slider applies. Transparency is preserved. |
| AVIF | Always encoded at 100 percent quality. Encoding needs Chrome or Edge 130 or later; otherwise a PNG is saved with a notice. |
| GIF | Encoded by ImgFetch itself. An animated WebP or APNG source becomes a real multi-frame GIF, up to 60 frames. A still source makes a still GIF. |
| SVG | Wraps the best raster source in a valid SVG document. Network SVG files saved directly are sanitized first; see the [Security model](security-model.md). |
| BMP | Real 24-bit encoding. Transparency is flattened. |

Converting an animated image to a still format keeps the first frame only, and ImgFetch shows a notice when that happens.

## The download queue

Downloading one or many images opens the queue view. Each file shows its state (pending, active, done, failed) and its current stage, such as finding the best quality.
Progress is per file, not per byte. Byte level progress lives in the browser download shelf.

| Button | What it does |
| --- | --- |
| Retry failed | Runs every failed file again. Files also retry once automatically when that setting is on. |
| Cancel | Stops the files that have not finished. |
| Clear finished | Removes done and failed entries from the list. |
| Back to results | Returns to the scan results. Your selection is kept. |

Up to 3 downloads run at the same time by default. Raise or lower this with the Max concurrent downloads setting, from 1 to 6.

## Screenshots

Open the popup and use the screenshot buttons, or right-click the page and use ImgFetch, then Screenshot. You can also use the keyboard shortcuts in the table at the end of this guide.

| Mode | What it captures | How it works |
| --- | --- | --- |
| Visible | The visible part of the active tab. | Captures the tab you invoked it from, including browser pages such as the New Tab page and ImgFetch pages of its own. It never captures a different tab. |
| Area | A rectangle you drag on the page. Shortcut: Ctrl+Shift+X. | Drag the rectangle, then preview and save. Esc cancels the drag. |
| Element | One page element. Shortcut: Ctrl+Shift+E. | Click the element to capture exactly that element. |
| Full page | The whole page at full device resolution. | ImgFetch scrolls the page, captures viewport tiles, and stitches them. If the page scrolls inside an inner container, that container is captured. Your scroll position is restored afterward, even on failure. |

Area, Element, and Full page need script injection. On pages where the browser forbids injection, such as browser internal pages and other extension pages,
ImgFetch captures the visible part of the active tab instead and tells you. On store pages the browser refuses capture entirely and ImgFetch shows a clear error.
Pages that grow while scrolling are followed as more content loads, until the page settles or a capture limit applies. See [Limitations](limitations.md).

### Parts and the Parts overview

A long Full page capture is split into numbered parts (Part 1 of N, Part 2 of N, and so on) instead of being truncated or downscaled.
No tabs open during capture. When a capture needs more than one part, exactly one Parts overview page opens at the end.
A page that fits in one image keeps the single image flow and opens the editor as usual.

In the Parts overview, each card shows a thumbnail that loads as you scroll, with four actions:

| Action | What it does |
| --- | --- |
| Edit | Opens that part in the editor. The editor title reads Part i of N. |
| Save | Downloads that part. |
| Copy | Copies that part to the clipboard. |
| Discard | Removes that part. |
| Save all | Downloads every part, one by one. |
| Discard all | Removes the whole set. |

Parts are stored on your device only, in the browser storage for this extension (IndexedDB), as image files (Blobs).
A set is kept together and removed as a whole. Sets expire after 1 hour, at most 60 records are kept, and a set whose capture is still running is never removed by cleanup.

### The progress row and Stop

While a Full page capture runs, the popup shows one live status row under the screenshot buttons: the current part and tile, a progress bar, and a Stop button.
The screenshot buttons are disabled until the capture ends. Reopening the popup during a capture shows the progress as it stands.
If you stop a capture or switch away from the source tab, capture ends and the parts already finished are kept.

## The editor

Captures open in the annotation editor when the Annotate after capture setting is on, and parts open there from the Parts overview with Edit.
Pick a tool, a color, and a stroke width, then draw on the image. Annotations are stored as strokes over the original image, which is never modified.

| Tool | Shortcut | What it does |
| --- | --- | --- |
| Pen | None | Draws a freehand stroke. |
| Arrow | None | Draws an arrow between two points. |
| Rectangle | None | Draws a rectangle outline. |
| Circle | None | Draws an ellipse. |
| Text | None | Click to place a label, type, and press Enter to confirm. Click an existing label to select it, drag to move it, and press Delete to remove it. Esc inside the input cancels. |
| Pixelate | None | Drag over a region to block it out. Pixelate hides detail from casual viewing only; see [Limitations](limitations.md). |
| Crop | C | Selects the Crop tool. See Crop in detail below. |

### Crop in detail

Crop is non-destructive. The original image and your strokes stay untouched underneath, and Save and Copy export exactly the cropped region.

1. Press C or click the Crop tool button.
2. Drag on the image to draw the crop rectangle. The area outside the rectangle dims and the area inside stays clear.
3. Adjust the rectangle by dragging it to move it, or by dragging any of its 8 handles to resize it. Rule-of-thirds guides show inside the rectangle.
4. Watch the live size label: it shows the rectangle size in real image pixels. The minimum size is 8 by 8 pixels.
5. Nudge the rectangle with the arrow keys, 1 pixel at a time. Hold Shift with the arrow keys to move 10 pixels at a time.
6. Click the Apply button or press Enter to apply the crop. Click the Cancel button or press Esc to cancel and keep the previous view.
7. To get the full image back after applying, use Undo. Applying a crop is one step in the same undo history as your strokes.

Selecting the whole image is a no-op: no crop is stored and no history step is added. Strokes drawn after a crop are stored in original image coordinates, so undoing the crop restores them in the right place.

### Undo and Redo

Undo and Redo are toolbar buttons next to each other. Undo works with Ctrl+Z (Cmd+Z on macOS) and does exactly what the Undo button does, including the crop step in the same history. It does nothing when the Undo button would be disabled, and it does not fire while you type in the text annotation box, where the browser native text undo keeps working.
Redo works with Ctrl+Y and with Ctrl+Shift+Z (Cmd+Shift+Z on macOS). Any new drawing clears the redo stack.
Clear removes every stroke and discards the undo history, so a cleared canvas cannot be restored.

### Copy

The Copy button copies the current canvas, after undo and redo, exactly as you see it, including an applied crop.
Very large images are downscaled first so the copy fits the clipboard budget; Save keeps full resolution.
On Windows, a large copy may not appear in clipboard history (Win+V). The editor shows a note for large images, and you can paste the copy with Ctrl+V.

### Save

The Save button exports the current view as a PNG through the Downloads folder and closes the editor after a short confirmation.
Discard closes the editor without saving. If the exported image is too large for the annotated save message cap, Save fails with a too-large error; the fix is in [Limitations](limitations.md).

## History

Click the clock icon in the popup to open History. Entries are grouped by day, and you can clear the history at any time.
Finished downloads in the queue can also be revealed in the file manager. History holds at most 200 records.
Turn history off, or change how long it is kept, under Settings, Download History. The default retention is 30 days.

## Settings

Open Settings from the popup gear icon or the context menu. Settings uses a sidebar, or a dropdown on narrow windows. Every change saves automatically.
The table lists every option, its section, and its default value.

| Setting | Section | Default | What it does |
| --- | --- | --- | --- |
| Theme | General | System | Picks the light, dark, or system appearance. |
| Language | General | Auto | Picks the interface language. Auto follows the browser language. See Languages below. |
| After download | General | Notify | Shows a notification after a download, or stays silent. |
| Auto-collapse queue | General | On | Collapses the download progress pane when everything finishes. |
| Show save dialog | Downloads | Off | Asks where to save each download instead of using the Downloads folder directly. |
| Max concurrent downloads | Downloads | 3 | How many downloads run at once, from 1 to 6. |
| Auto retry once | Downloads | On | Retries a failed download one time automatically. |
| Ask for a file name | Downloads | Off | Opens a rename sheet before a single download. |
| Quality preference | Quality | Smart | Smart probes for the best genuine source. Original saves the exact source without probing. |
| JPG quality | Quality | 1 | Encoding quality for JPG output, from 0.1 to 1. |
| PNG quality | Quality | 1 | 1 is lossless. Lower values reduce the color count to shrink the file. |
| WebP quality | Quality | 1 | Encoding quality for WebP output, from 0.1 to 1. |
| Screenshot format | Screenshots | PNG | Default format for saved screenshots: PNG or JPG. |
| Screenshot quality | Screenshots | 1 | Encoding quality when the screenshot format is JPG. |
| Annotate after capture | Screenshots | On | Opens the editor after a capture. Turn it off to save captures directly. |
| File name mode | File Names | Original | Original keeps the source name. Site uses the site, date, and number pattern. Custom uses your template. |
| Custom template | File Names | `{site} - {date} - {num}` | Template tokens include site, name, date, time, width, height, dimensions, and num. The full list is in the collapsible helper in Settings. |
| Folder mode | Folders | Site | Organizes downloads inside Downloads: Flat, Site, Type, or Date. |
| Use subfolder | Folders | Off | Master switch for the fixed subfolder below. |
| Subfolder | Folders | Empty | One fixed subfolder name inside Downloads, used when Use subfolder is on. |
| Minimum size | Scanning | Any | Filters scan results by image size: Any, Medium, Large, or Extra large. |
| Include backgrounds | Scanning | On | Includes CSS background images in scan results. |
| Scan depth | Scanning | Loaded | Loaded scans what is on the page now. Scroll scrolls the page first to reveal lazy loaded images. |
| Deduplicate scan results | Scanning | On | Drops duplicate images from scan results. |
| Site preferences | Site Preferences | None set | Per-host behavior: Smart, Normal (as shown), or Disabled. A disabled site pauses ImgFetch there. |
| History enabled | Download History | On | Records finished downloads in History. |
| History retention days | Download History | 30 | Days to keep history, from 1 to 365. |

The Shortcuts section shows your current key bindings with a link to the browser shortcut settings.
Backup and Reset can export and import settings as JSON and can reset everything, after asking first.
About shows the version and the permissions in plain language. Privacy explains what is stored and what is never collected; see also [Privacy](../PRIVACY.md).

## Languages

The interface is available in 21 locales (19 languages): English, Spanish (including Latin American Spanish), Brazilian Portuguese, French, German, Italian,
Dutch, Russian, Ukrainian, Polish, Czech, Turkish, Arabic, Simplified Chinese, Traditional Chinese, Japanese, Korean, Indonesian, Vietnamese, and Thai.
Arabic uses a right-to-left layout.

To switch language, open Settings, then General, then Language, and pick a language or Auto. The change applies at once, without a reload.
Auto follows the browser language and falls back to English when no translation matches.

## Keyboard shortcuts

These are the extension shortcuts from the manifest. Change them in the browser at `chrome://extensions/shortcuts` in Chrome or the matching Edge page.

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+S | Scan this page for images. |
| Ctrl+Shift+X | Capture a selected Area. |
| Ctrl+Shift+E | Capture an Element. |
| Alt+Shift+E | Pick an element and show its image details. |
| No default key | Scan this page, alternative command. Bind your own key in the browser shortcut settings. |

On Mac, use Command instead of Ctrl for these shortcuts.

Editor shortcuts:

| Shortcut | Action |
| --- | --- |
| C | Select the Crop tool. |
| Enter | Apply a pending crop, or confirm a Text label while typing it. |
| Esc | Cancel a pending crop, cancel a Text label, cancel an Area drag, or clear a text selection. |
| Arrow keys | Nudge a pending crop by 1 pixel. |
| Shift+arrow keys | Nudge a pending crop by 10 pixels. |
| Ctrl+Z (Cmd+Z on macOS) | Undo. |
| Ctrl+Y | Redo. |
| Ctrl+Shift+Z (Cmd+Shift+Z on macOS) | Redo. |
| Delete or Backspace | Delete the selected Text label. |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Scan finds no images | The page is restricted, the site is disabled in Site Preferences, or images load only on scroll. | Reload the page, set Scan depth to Scroll, and check Site Preferences. Scanning works only on http and https pages. |
| A screenshot falls back to the Visible part | The page blocks script injection, so Area, Element, and Full page cannot run there. | This is expected on browser internal pages and other extension pages. Use Visible, or an operating system screenshot. |
| The browser does not allow capturing this page | Store pages refuse capture by any extension. | Use the operating system screenshot tool. |
| Save in the editor fails with a too-large error | The annotated image data URL is longer than 40,000,000 characters. | Crop to a smaller region, or save the unannotated part from the Parts overview. |
| AVIF is not available | The browser is older than version 130 and cannot encode AVIF. | Update Chrome or Edge, or use PNG. |
| A copied image is missing from Win+V history | Windows clipboard history skips very large images. | Paste with Ctrl+V. The copy itself succeeded. |
| A private network image is blocked | The URL guard blocks extension fetches to private addresses, such as a router page, from a public page. | Open the image from a page on the same host, or save it with the browser itself. See the [Security model](security-model.md). |
| Capture parts disappear | Stored captures expire after 1 hour and at most 60 records are kept. | Save or copy parts soon after capture. |
| Downloads land in an unexpected folder or name | Folder mode, subfolder, or file name settings differ from what you expect. | Check Settings, Folders and File Names. Every save lands inside the Downloads folder. |
| ImgFetch does nothing on one site | The site is set to Disabled in Site Preferences. | Re-enable it in Settings, Site Preferences. |
