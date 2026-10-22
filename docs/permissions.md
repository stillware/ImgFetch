# ImgFetch Permissions

Every permission ImgFetch requests, why it is needed, and what happens without it.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Introduction

ImgFetch requests all of its permissions at install time.
The extension declares no optional permissions, so the browser never shows a permission prompt during use.
Every entry below matches `manifest.json` exactly: eight permissions and two host permissions.
The security reasoning behind this list is in [the security model](security-model.md).

## Permissions

| Permission | Why it is needed | Feature that uses it | What happens without it | User-visible consequence |
|---|---|---|---|---|
| `contextMenus` | Registers the ImgFetch entries in the browser right click menu for images and pages | Right click actions: download, Save as, Copy Image Link, scan shortcuts | The menu entries cannot be created | No ImgFetch entries appear in the right click menu |
| `downloads` | Saves files through the browser download manager and observes completion events | All downloads, bulk downloads, ZIP saves, screenshot saves | No file can be saved and completion cannot be tracked | Downloads never start and the queue cannot confirm success |
| `storage` | Persists settings, download history, and the file counter on the device | Settings, History view, filename numbering, last scan cache | Nothing can be stored between sessions | Settings reset on every restart and history is always empty |
| `scripting` | Injects the scanner and overlay content scripts into the active tab on demand | Page scanning, Area selection, Element picking | Page content cannot be read or overlaid | Scanning finds nothing and Area and Element capture cannot start |
| `activeTab` | Grants temporary access to the tab the user just invoked ImgFetch from | Screenshot capture started by a keyboard shortcut or menu action | The capture call has no access to the current tab | Visible, Area, Element, and Full page captures fail on the current tab |
| `offscreen` | Creates the offscreen document used for conversion, stitching, ZIP building, and clipboard work | Save as conversion, Full page stitching, ZIP downloads, Copy actions | Conversion, stitching, and ZIP work have no execution context | Save as formats, multi part captures, and ZIP saves fail |
| `notifications` | Shows a completion alert when a download or capture finishes | After download alerts, controlled by the `afterDownload` setting | No alert can be shown when work finishes | The user gets no completion alert and must check the popup |
| `clipboardWrite` | Writes a link or image bytes to the clipboard when the user clicks a Copy action | Copy Image Link, the editor Copy button, Parts overview Copy | Clipboard writes are rejected by the browser | Copy actions fail and nothing is placed on the clipboard |

## Host permissions

| Permission | Why it is needed | Feature that uses it | What happens without it | User-visible consequence |
|---|---|---|---|---|
| `https://*/*` | Fetches image bytes from secure sites for conversion and reads image URLs on pages the user scans | Scanning, best source detection, format conversion, ZIP building | Images on secure sites cannot be fetched for conversion | Scans miss images and conversion falls back or fails on most sites |
| `http://*/*` | Fetches image bytes from plain HTTP sites for conversion and reads image URLs on pages the user scans | Scanning, best source detection, format conversion, ZIP building | Images on plain HTTP sites cannot be fetched for conversion | Scans miss images and conversion falls back or fails on HTTP sites |

## Notes

Host access is scheme wide because image hosts are unpredictable: a single page can load images from many content delivery networks.
Narrower host patterns would break scanning and conversion on sites the user has never visited before.
ImgFetch does not request the `tabs`, `bookmarks`, `history`, `cookies`, `webRequest`, or `debugger` permissions.
The extension reads the clipboard never: `clipboardWrite` only writes data after an explicit Copy action.
All data touched under these permissions stays on the device, as described in the privacy policy.
