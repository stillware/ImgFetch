# ImgFetch Permissions

Every permission ImgFetch requests, why it is needed, and what happens without it.

Applies to: ImgFetch 1.1.1
Last verified: 2026-11-23

## Introduction

ImgFetch requests its required permissions at install time.
It declares one optional permission, `downloads.open`, which is requested only when you click Open on a history row, never at install and never in the background.
Every entry below matches `manifest.json` exactly: eight required permissions, one optional permission, and two host permissions.
The security reasoning behind this list is in [the security model](security-model.md).

## Permissions

| Permission | Why it is needed | Feature that uses it | What happens without it | User-visible consequence |
|---|---|---|---|---|
| `contextMenus` | Registers the ImgFetch entries in the browser right click menu for images and pages | Right click actions: download, Save as, Copy Image Link, scan shortcuts | The menu entries cannot be created | No ImgFetch entries appear in the right click menu |
| `downloads` | Saves files through the browser download manager and observes completion events | All downloads, bulk downloads, ZIP saves, screenshot saves | No file can be saved and completion cannot be tracked | Downloads never start and the queue cannot confirm success |
| `storage` | Persists settings, download history (each record also keeps a small preview image, the source link and the browser download id, all stored locally only), and the file counter on the device | Settings, History view, filename numbering, last scan cache | Nothing can be stored between sessions | Settings reset on every restart and history is always empty |
| `scripting` | Injects the scanner and overlay content scripts into the active tab on demand | Page scanning, Area selection, Element picking | Page content cannot be read or overlaid | Scanning finds nothing and Area and Element capture cannot start |
| `activeTab` | Grants temporary access to the tab the user just invoked ImgFetch from | Screenshot capture started by a keyboard shortcut or menu action | The capture call has no access to the current tab | Visible, Area, Element, and Full page captures fail on the current tab |
| `offscreen` | Creates the offscreen document used for conversion, stitching, ZIP building, and clipboard work | Save as conversion, Full page stitching, ZIP downloads, Copy actions | Conversion, stitching, and ZIP work have no execution context | Save as formats, multi part captures, and ZIP saves fail |
| `notifications` | Shows a completion alert when a download or capture finishes | After download alerts, controlled by the `afterDownload` setting | No alert can be shown when work finishes | The user gets no completion alert and must check the popup |
| `clipboardWrite` | Writes a link or image bytes to the clipboard when the user clicks a Copy action | Copy Image Link, the editor Copy button, Parts overview Copy, history Copy image | Clipboard writes are rejected by the browser | Copy actions fail and nothing is placed on the clipboard |

## Optional permissions

| Permission | Why it is needed | Feature that uses it | What happens without it | User-visible consequence |
|---|---|---|---|---|
| `downloads.open` | Opens a downloaded file with the system default app (for example Windows Photos) instead of opening its source link in a browser tab | History row Open button, in the popup and in Settings, Download history | The Open button falls back to showing the file in its folder, with a short note saying so | The file does not open in its app; it is shown in the folder instead |

Why `downloads.open` is optional, not required: a required permission would disable the extension for existing users on update until they accept the new permission. As an optional permission it is requested once, from the Open click itself (a user gesture), only the first time it is needed. If the user declines, or the browser has no such API, nothing breaks: the fallback above applies. If the popup closes while the permission prompt is shown, the prompt belongs to the browser and stays up; the grant is stored by the browser, so the next Open click finds the permission already granted and opens the file. The permission is never requested for any other action, and nothing else is remembered about the request. The open itself runs in the popup or options page, not in the service worker: `chrome.downloads.open` needs the click's user gesture, and the worker round-trip loses it (the worker call fails with "User gesture required"). If opening fails even though the file exists, for example because the gesture expired while the prompt was up, the file is shown in its folder instead rather than reported as missing.

## Host permissions

| Permission | Why it is needed | Feature that uses it | What happens without it | User-visible consequence |
|---|---|---|---|---|
| `https://*/*` | Fetches image bytes from secure sites for conversion and reads image URLs on pages the user scans | Scanning, best source detection, format conversion, ZIP building, history thumbnails for direct downloads (one extra request per download, after it finishes) | Images on secure sites cannot be fetched for conversion | Scans miss images and conversion falls back or fails on most sites |
| `http://*/*` | Fetches image bytes from plain HTTP sites for conversion and reads image URLs on pages the user scans | Scanning, best source detection, format conversion, ZIP building, history thumbnails for direct downloads (one extra request per download, after it finishes) | Images on plain HTTP sites cannot be fetched for conversion | Scans miss images and conversion falls back or fails on HTTP sites |

## Notes

Host access is scheme wide because image hosts are unpredictable: a single page can load images from many content delivery networks.
Narrower host patterns would break scanning and conversion on sites the user has never visited before.
ImgFetch does not request the `tabs`, `bookmarks`, `history`, `cookies`, `webRequest`, or `debugger` permissions.
The extension reads the clipboard never: `clipboardWrite` only writes data after an explicit Copy action.
All data touched under these permissions stays on the device, as described in the privacy policy.
