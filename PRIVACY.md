# ImgFetch Privacy Policy

What ImgFetch stores on your device, what it sends, and what it never does.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22
Effective date: 2026-10-13

## Short version

ImgFetch does not collect, store, or transmit your browsing activity. It has no account, no server, no analytics, and no telemetry.

## What stays on your device

All of the following stays in your browser, on your device:

| Data | Where it is stored | Notes |
|---|---|---|
| Settings and per-site preferences | `chrome.storage.local` | Your choices in Settings, saved locally |
| Download history | `chrome.storage.local` | File names, source hosts, formats, and sizes. No image bytes. At most 200 records are kept, for the retention period you set in Settings (30 days by default) |
| The file counter | `chrome.storage.local` | Used for automatic file naming |
| The last page scan | `chrome.storage.session` | Kept for the browser session only |
| Screenshots and full page capture parts waiting in a preview or editor page | IndexedDB in the browser | Capture records expire after 1 hour, and at most 60 records are kept. Saving a capture downloads it through the browser like any other download |

Downloads themselves are saved by the browser to your Downloads folder, or to the folder you choose when the save dialog is shown.

## What leaves your device

Only network requests that your own actions require:

- **Image downloads and conversions.** When you ask ImgFetch to download or convert an image, it fetches that image from its host. Fetching an image necessarily reveals your IP address to that host, as with any download. ImgFetch adds no cookies or credentials to these requests.
- **Result thumbnails.** When you scan a page, the popup loads small previews directly from the image hosts so you can see what was found. This contacts those hosts, as any image view would. Nothing is sent to ImgFetch or to any third party.
- **Google Lens, only if you click it.** The "Search Image with Google Lens" menu item opens a Google Lens tab with the image address so Google can search for it. This happens only after you click the menu item. ImgFetch never contacts Google otherwise, and nothing is sent to ImgFetch servers, because there are none.

## What ImgFetch never does

- No analytics, telemetry, crash reporting, or A/B testing.
- No accounts, no sign-in, and no sync to any server.
- No reading of browsing history, bookmarks, cookies, or page text. Scans look at image elements only, and only when you start a scan.
- No advertising, no affiliate links, and no data sale. There is no data to sell.

## Permissions

ImgFetch requests only the permissions its features need. The full list, with the reason for each one, is also in [docs/permissions.md](docs/permissions.md).

| Permission | Why ImgFetch needs it |
|---|---|
| `contextMenus` | The right-click ImgFetch menu on images and pages |
| `downloads` | Saving files to your Downloads folder through the browser |
| `storage` | Settings, site preferences, and download history on this device |
| `scripting` | Running the page scanner when you start a scan |
| `activeTab` | Capturing screenshots of the page you invoked ImgFetch from |
| `offscreen` | Format conversion and ZIP building in a hidden document |
| `notifications` | An optional note when a download finishes. You can turn it off in Settings |
| `clipboardWrite` | Copy actions: "Copy Image Link", and the Copy button in the screenshot editor, which copies the edited image. ImgFetch writes to the clipboard and never reads it |
| Host access (`https://*/*` and `http://*/*`) | Downloading images from the sites you visit |

## Your controls

- **Settings, Privacy:** disable history, shorten its retention (1 to 365 days), export or import settings as JSON, or reset everything.
- **Popup, History:** clear history at any time.
- Uninstalling ImgFetch removes its on-device storage with it.

## Contact

Open an issue on the GitHub repository: https://github.com/umr-x/ImgFetch/issues
