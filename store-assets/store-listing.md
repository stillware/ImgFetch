# ImgFetch Store Listing

Ready to paste listing text for the Edge Add-ons store and the Chrome Web Store, with permission justifications and a pre-submission checklist.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Store status

| Store | Listing URL | Status |
|---|---|---|
| Microsoft Edge Add-ons | https://microsoftedge.microsoft.com/addons/detail/obblfdlgliblmpngaidjianbkahcplea | Published.  The live listing serves 1.1.1. |
| Chrome Web Store | No URL yet | Coming soon |
| Firefox Add-ons | No URL yet | Coming soon. Firefox needs a separate port; no date is promised. |
| GitHub Releases | https://github.com/stillware/ImgFetch/releases | Version 1.1.0 released on 2026-10-22, tag `v1.1.0`. Version 1.0.0 was released on 2026-10-12. |

Do not publish a store URL before the listing is live.

## Product name

```text
ImgFetch
```

The manifest name is `ImgFetch` (message key `appName` in `_locales/en/messages.json`) and the manifest short name is also `ImgFetch` (`short_name` in `manifest.json`). Use the same name in both stores.

## Short description

Chrome Web Store limit: 132 characters. The text below is 114 characters, including spaces and the final period.

```text
Save images in the best available quality, scan whole pages, and capture screenshots. No accounts and no tracking.
```

## Detailed description

Paste the text between the lines into the detailed description field of either store.

---

ImgFetch is a free and open source extension that saves images in their best genuinely available quality. It never upscales and never invents quality.

Smart Download
Right-click any image and choose Smart Download. ImgFetch finds every real source for that image (the original, srcset and picture variants, and lazy loaded variants), checks which sources actually load, and saves the best valid one.

Save as
Convert an image while saving it. Formats include PNG, JPG, WebP, AVIF (when the browser can encode it), GIF, SVG, and BMP. Quality settings apply per format, and the PNG quality setting is lossless at 100 percent.

Scan This Page
Click the toolbar button to find the images on a page. Filter by size, format, and orientation, preview the results, then download selected images one by one or packed into a single ZIP file.

Screenshots
Capture the Visible area, a selected Area, a single Element, or the Full page. Very long pages are captured at full resolution and split into balanced parts, which open in the Parts overview page where each part can be reviewed, edited, saved, copied, or discarded. A live progress row with a Stop button shows in the popup during a full page capture.

Screenshot editor
Annotate a capture before saving it with Pen, Arrow, Rectangle, Circle, Text, and Pixelate. The Crop tool (shortcut C) is non-destructive: the original image and your annotations are never modified, and Save and Copy export exactly the cropped region. Undo and Redo cover both annotations and the crop. Undo works with Ctrl+Z (Cmd+Z on macOS) and Redo with Ctrl+Y or Ctrl+Shift+Z (Cmd+Shift+Z on macOS).

Queue and history
A download queue shows live progress for each file, with retry and cancel. Download history records file names and sizes and can be searched, cleared, or turned off in Settings.

Private by design
ImgFetch has no accounts, no sign-in, no analytics, no telemetry, and no tracking. Settings and history stay in your browser on your device. Captures wait in local browser storage for up to 1 hour. All conversion and capture work happens on your device.

Languages
The interface is available in 21 locales covering 19 languages, switchable at runtime in Settings. Arabic uses a right-to-left layout.

ImgFetch is free software under the GNU General Public License v3 or later. Source code: https://github.com/stillware/ImgFetch

---

## Category suggestion

| Store field | Suggested value |
|---|---|
| Category | Productivity |
| Language of the listing | English, with localized listings optional later |

## Single purpose statement

ImgFetch has one purpose: to download and capture images from web pages. It finds the images on a page or in a screenshot, saves them in the best available quality or a format the user chooses, and does all of this locally in the browser.

## Permission justifications

Reviewer facing text for every permission and host permission declared in `manifest.json`. One row per permission. Keep these answers consistent with [docs/permissions.md](../docs/permissions.md).

| Permission | Justification for reviewers |
|---|---|
| `contextMenus` | Creates the right-click ImgFetch menu on images and pages. That menu is the main way users start a download, a conversion, or a screenshot. |
| `downloads` | Saves the files the user asked for through the browser download manager, and tracks each download to show completion in the queue. Without it, the extension cannot save anything. |
| `storage` | Stores user settings, per-site preferences, and the download history list in local browser storage on the device. Nothing is synced or sent to a server. |
| `scripting` | Injects the page scanner and the selection overlay into the active tab only when the user starts a scan, an Area capture, or an Element capture. |
| `activeTab` | Gives temporary access to the tab the user invoked ImgFetch from, which the browser requires to capture a screenshot of that tab. |
| `offscreen` | Runs a hidden document for work the service worker cannot do: image format conversion, full page stitching, ZIP building, and clipboard writes. |
| `notifications` | Shows an optional notification when a download finishes. The user can turn notifications off in Settings. |
| `clipboardWrite` | Powers the copy actions the user clicks: Copy Image Link, and Copy in the screenshot editor. The extension writes to the clipboard and never reads it. |
| Host permission `https://*/*` | Fetches image bytes from HTTPS sites the user visits, so images can be downloaded, converted, or packed into a ZIP. Image hosts are unpredictable, so access cannot be limited to a fixed list of sites. |
| Host permission `http://*/*` | The same as above for the minority of image hosts still served over HTTP. Without it, those images would fail to download or convert. |

## Data usage and privacy answers

Use these answers for the data usage and privacy practice questions in both stores.

| Question | Answer |
|---|---|
| Does the extension collect user data? | No. ImgFetch collects no data of any kind. |
| Is data sold to third parties? | No. No data is collected, so nothing can be sold. |
| Is data transferred to third parties? | No. The only network requests are fetches of images the user asked to download, thumbnail loads from the image hosts during a scan the user started, and Google Lens only when the user clicks that menu item. |
| Is data used for purposes unrelated to the single purpose? | No. |
| Is data used to determine creditworthiness or for lending? | No. |
| Does the extension use remote code? | No. All code ships inside the extension package. The content security policy allows scripts from the extension itself only. |
| Does the extension use analytics, telemetry, or crash reporting? | No. None is present in the code. |
| Where is data processed? | Locally, in the browser on the user device. Settings and history are kept in `chrome.storage.local`. Captures are kept in IndexedDB and expire after 1 hour. |
| Privacy policy | See `PRIVACY.md` in the repository: https://github.com/stillware/ImgFetch/blob/main/PRIVACY.md |

## Support and source links

| Field | Value |
|---|---|
| Support URL | https://github.com/stillware/ImgFetch/issues |
| Source code | https://github.com/stillware/ImgFetch |
| Privacy policy file | `PRIVACY.md` in the repository root |
| License | GNU General Public License v3 or later (`LICENSE` in the repository root) |

No publisher or developer name is stated here. Use the name on the store developer account when submitting.

## Screenshot captions

One caption per existing file in this folder. Captions describe the screen each file name and the README screenshots section identify. They do not describe details inside the images.

The store screenshots live in `store-assets/store/` at 1280 by 800 pixels. Upload them in this order.

| File | Caption |
|---|---|
| `hero-scan-and-save.png` | Scan a page and save its images in the best available quality. |
| `scan-select-download.png` | Select images from the scan results and download them, one by one or as a ZIP. |
| `quality-and-formats.png` | Quality, format, and file name options for saved images. |
| `screenshot-modes.png` | Four screenshot modes: Visible, Area, Element, and Full page. |
| `fullpage-parts-overview.png` | A long full page capture split into parts, reviewed in the Parts overview. |
| `editor-crop.png` | The screenshot editor with the non-destructive Crop tool active. |

The promotional images in `store-assets/` are `promo-marquee-1400x560.png` (marquee, 1400 by 560 pixels) and `promo-tile-440x280.png` (small promo tile, 440 by 280 pixels).

## Release notes for 1.1.1

Paste into the "What is new" or release notes field at submission.

```text
The About and Privacy links in Settings now point to the project's new home on GitHub.
Documentation links were fixed and the downloaded package now carries a short README.
No change to features.
```

## Release notes for 1.1.0

Paste into the "What is new" or release notes field at submission.

```text
Undo shortcut in the screenshot editor: Ctrl+Z (Cmd+Z on macOS), with Redo on Ctrl+Y and Ctrl+Shift+Z.
New Crop tool in the screenshot editor. Cropping is non-destructive, shares Undo and Redo with your annotations, and Save and Copy export exactly the cropped region.
Capture progress now shows as one live row in the popup, with a progress bar and a Stop button.
Full page captures open in an improved Parts overview page, where each part can be edited, saved, copied, or discarded.
The interface is now available in 21 locales covering 19 languages, switchable in Settings, with a right-to-left layout for Arabic.
Redo in the screenshot editor, faster and lossless Area and Element captures, and screenshots on every tab the browser allows.
```

## Pre-submission checklist

- [ ] The package submitted is the store package for 1.1.0, built from the release tree with no test files, scripts, or documentation folders beyond the ones the packaging script includes.
- [ ] The version in `manifest.json` is 1.1.0 and matches the release notes above.
- [ ] The short description above is pasted unchanged and is within the 132 character Chrome Web Store limit (114 characters).
- [ ] Every permission in the submitted manifest has a justification in the table above, worded the same way in the store form.
- [ ] The data usage answers above match `PRIVACY.md`. No data collection is declared, because none happens.
- [ ] The single purpose statement above is pasted into the single purpose field.
- [ ] The six screenshots in `store-assets/store/` are uploaded in order, with the captions above.
- [ ] For every Edge update: submit the package after the GitHub release, and state in the README and in this file that a version is live on Edge only after Microsoft has approved and published it.
- [ ] The support URL points to GitHub Issues and the privacy policy is reachable from the listing.
- [ ] The Chrome Web Store URL is added to this file and to the README only after that listing is live.
- [ ] No claim appears in the listing that the extension does not deliver: no Firefox version, no store rating, and no feature that is not in 1.1.0.
