# Building and Packaging ImgFetch

How to validate, test, package, and load the extension for local testing.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Prerequisites

ImgFetch has no build step and no runtime dependencies. The extension loads
from the source tree as it is. You need:

| Tool | Used for |
|---|---|
| Python 3 | `scripts/validate.py` and reading the version from `manifest.json` |
| Node.js | The unit suites and the checker scripts |
| A zip tool | Packaging in `scripts/package.sh` |
| Google Chrome or Microsoft Edge | Loading the unpacked extension |
| Firefox 142 or later | Loading the Firefox staging build for testing |
| Pillow (optional) | Regenerating icons with `scripts/make-icons.py` |

PowerShell variants are translations of the bash commands and were not run in the build sandbox (no PowerShell there).

## Validate and test

Run these commands from the repository root. All of them were run in this
session in bash.

```bash
python3 scripts/validate.py
node scripts/check-i18n.mjs
node scripts/check-duplicates.mjs
for t in tests/test-*.mjs; do node "$t" || exit 1; done
```

`scripts/validate.py` checks the manifest, file references, JavaScript
syntax, security rules, and documentation claims.

`scripts/check-i18n.mjs` checks all 21 locales. See
[the translating guide](translating.md).
The unit suite loop runs all 33 suites in `tests/`. See
[the tests guide](tests/README.md) for the expected counts, including the
optional jsdom setup for `tests/test-svg-real-dom.mjs`.

PowerShell variants:

```powershell
python scripts/validate.py
node scripts/check-i18n.mjs
node scripts/check-duplicates.mjs
Get-ChildItem tests/test-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "failed: $($_.Name)" } }
```

On Windows, `python` may be named `py`. Use the name your install provides.

## Regenerate icons (optional)

```bash
python3 scripts/make-icons.py
```

This writes `icons/icon-16.png`, `icons/icon-32.png`, `icons/icon-48.png`,
and `icons/icon-128.png`. It needs Pillow. Skip this step unless the icon
artwork changed.

## Package with scripts/package.sh

`scripts/package.sh` was not run in this Linux sandbox. Its line endings
are CRLF and it targets the owner's Git Bash or WSL setup.
The description below is its logic, verified by reading the script.

```bash
bash scripts/package.sh
```

The script does the following, in order:

1. Runs `python3 scripts/validate.py`.
2. Runs every suite in `tests/test-*.mjs`. If the `IMGFETCH_TESTDEPS`
   environment variable is set, it passes that folder's `node_modules`
   through `NODE_PATH`, so the jsdom suite runs instead of skipping.
   It fails if the variable is set but the folder has no `node_modules`.
3. Runs `node scripts/check-duplicates.mjs` and
   `node scripts/regression-diff.mjs`.
4. Reads the version from `manifest.json` and clears and recreates `dist/`.
5. Builds three store zips in `dist/`, named with the target and the version:
   `imgfetch-chrome-<version>.zip`, `imgfetch-edge-<version>.zip`, and `imgfetch-firefox-<version>.zip`.
6. Extracts the Chrome and Edge zips and compares them with `diff -r`. The build fails if
   their contents differ. Only the file names differ.
7. Builds the Firefox zip from a staging tree with the same file list, but with the derived Firefox manifest at the root (see the Firefox section below). The build fails if the Firefox zip differs from the Chrome zip anywhere except `manifest.json`.

### What the store zips contain

The Chrome and Edge zips contain identical files. The include list is:

| Included | Notes |
|---|---|
| `manifest.json` | The extension manifest |
| `background`, `content`, `core`, `offscreen`, `options`, `pages`, `popup`, `shared`, `icons`, `_locales` | All code, icons, and locales |
| `LICENSE`, `README.md`, `PRIVACY.md`, `TERMS.md`, `CHANGELOG.md` | Root documents |
| `docs/user-guide.md`, `docs/permissions.md`, `docs/limitations.md` | User facing docs only |

Hidden files, Python cache folders, and e2e results files are excluded
from the zips even inside included folders.

### What stays in the repository only

The store zips do not contain `tests/`, `scripts/`, `store-assets/`,
`assets/`, `docs/history`, `docs/tests`, the other files under `docs/`,
or `dist/` itself.

## Firefox zip

Firefox is in development, not released. The Firefox zip is built by the same normal run that builds the Chrome and Edge zips, plus a Firefox only staging mode for local testing. See [the Firefox document](firefox.md) for the full status, compatibility matrix, and manual test notes.

```bash
bash scripts/package.sh
```

The normal run builds `dist/imgfetch-firefox-<version>.zip` alongside the Chrome and Edge zips. The Firefox zip uses the same INCLUDE file list as the Chrome and Edge zips, with one difference: the manifest at the zip root is the derived Firefox manifest from `scripts/make-firefox-manifest.mjs`, not the root manifest. The README inside all three zips is the repository `README.md`, byte-identical across the three zips. Note that `scripts/package.sh` ships the repository `README.md`, not `README-package.md`, in all three zips. The packaging check extracts the Chrome and Firefox zips and fails the build if they differ anywhere except `manifest.json`, or if their entry lists differ.

Firefox only staging, which runs no tests and is the folder to point web-ext at:

```bash
bash scripts/package.sh --firefox-only
```

This builds only `dist/firefox-staging/`, with the same file list and the derived Firefox manifest at the staging root. Run web-ext lint against that folder before any Firefox claim is repeated outside the Firefox document:

```bash
npx web-ext lint --source-dir dist/firefox-staging
```

CRLF note: `scripts/package.sh` keeps CRLF line endings and cannot run under Linux bash. The owner uses Git Bash or WSL for packaging. The Firefox staging in this round was verified with an LF copy of the script in a `/tmp` sandbox plus a Python replication of the INCLUDE logic: 91 files, Chrome compared with Edge identical, Firefox differing only in `manifest.json`.

## Release flow

`scripts/release-check.sh` is the full release check in bash. It runs the
unit suites, runs the validator on the development tree, runs the duplicate
check, runs `scripts/package.sh`, then extracts both store zips and runs
the validator on each extracted zip.

It writes `docs/tests/test-report.md` from the real command output,
including the total counts and the SHA-256 of each zip.
Run it before a store submission:

```bash
bash scripts/release-check.sh
```

Store submission itself is manual. Upload the Chrome zip in the Chrome
Web Store Developer Dashboard and the Edge zip in Microsoft Partner Center,
and fill in the listing from `store-assets/store-listing.md`.

Version 1.1.0 was released on GitHub Releases on 2026-10-22 (tag `v1.1.0`).
The Microsoft Edge Add-ons listing is published and serves 1.1.1.
The Chrome Web Store listing is coming soon.
Before submission, work through
[the manual test checklist](tests/manual-test-checklist.md) on real Chrome
and real Edge builds.

## Load the unpacked extension for testing

In Google Chrome:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Select Load unpacked and choose the repository root folder, the folder
   that contains `manifest.json`.
4. After a code change, select the Reload button on the ImgFetch card.

In Microsoft Edge:

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Select Load unpacked and choose the same repository root folder.
4. After a code change, select Reload on the ImgFetch card.

## Versioning

To change the version, update `version` in `manifest.json`, add a
`CHANGELOG.md` entry, then rerun validation, the unit suites, and the
packaging steps above.
