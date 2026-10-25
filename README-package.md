# ImgFetch

Free image downloader and screenshot extension for Chrome and Edge. Bulk download images, save image as PNG, JPG or WebP, and take full page screenshots. No accounts, no tracking.

This folder is the ImgFetch extension itself. The full README with screenshots is on GitHub: https://github.com/stillware/ImgFetch

## Install

**Microsoft Edge:** install the official extension from the Microsoft Edge Add-ons store: https://microsoftedge.microsoft.com/addons/detail/obblfdlgliblmpngaidjianbkahcplea

**Google Chrome** (the Chrome Web Store listing is coming soon): install this folder unpacked.

1. Unzip the downloaded ZIP file. The unzipped folder must contain `manifest.json` at the top level.
2. Open `chrome://extensions` (or `edge://extensions` in Edge).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder.
5. Pin ImgFetch from the extensions menu if you want it on the toolbar.

Do not delete the unzipped folder afterwards, because the browser loads the extension from it. Extensions installed this way do not update automatically. To update, download the newest release from https://github.com/stillware/ImgFetch/releases/latest and repeat these steps.

Requires Chrome 116 or later, or Microsoft Edge (Chromium based).

## Quick start

1. Open a page with images and click the ImgFetch toolbar button to scan the page.
2. Preview the results, filter if needed, and download one image or a selection (as separate files or one ZIP).
3. Or right-click any image and choose **Smart Download** to save its best valid source at once.
4. Use the popup screenshot buttons to capture the Visible area, an Area, an Element or the Full page.
5. Annotate or Crop the screenshot in the editor, then choose Save or Copy.

Default shortcuts (change them at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`):

| Command | Default key |
| --- | --- |
| Scan page | Ctrl+Shift+S |
| Capture area | Ctrl+Shift+X |
| Capture element | Ctrl+Shift+E |
| Select element | Alt+Shift+E |

## Privacy

ImgFetch has no accounts, no analytics, no telemetry and no tracking. It loads no remote code. Everything runs on your device. See [PRIVACY.md](PRIVACY.md) and [docs/permissions.md](docs/permissions.md).

## Files in this package

- [docs/user-guide.md](docs/user-guide.md): a guide to every feature.
- [docs/permissions.md](docs/permissions.md): every permission and why it exists.
- [docs/limitations.md](docs/limitations.md): known limits and workarounds.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
- [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md): privacy policy and terms.
- [LICENSE](LICENSE): the full GNU GPL text.

## Help and source code

- Report a problem or ask a question: https://github.com/stillware/ImgFetch/issues
- Source code, architecture docs and tests: https://github.com/stillware/ImgFetch

## License

ImgFetch is free software under the GNU General Public License, version 3 or (at your option) any later version. See [LICENSE](LICENSE).

The GPL covers the source code. It does not grant the right to use the ImgFetch name or logo as branding for a modified version. See https://github.com/stillware/ImgFetch/blob/main/TRADEMARK.md

Official sources: the GitHub repository above, its GitHub Releases and the Microsoft Edge Add-ons listing. A copy that uses the ImgFetch name from anywhere else is not official.

Copyright (C) 2026 ImgFetch Developer.
