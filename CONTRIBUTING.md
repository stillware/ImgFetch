# Contributing to ImgFetch

How to set up a development copy, run the checks, and submit a change.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Before you start

Open an issue first and describe what you want to change and why, so the approach can be agreed before you write code. Small, focused changes are easier to review than large mixed ones.

Contributions are accepted under the GNU General Public License v3 or later, the same license as ImgFetch itself. By contributing, you agree that your changes will be distributed under those terms. Contribute only code and text that you wrote yourself or that you have the right to submit under that license.

## Development setup

### Prerequisites

| Tool | Used for |
|---|---|
| Node.js | Running the unit tests and the checker scripts |
| Python 3 | Running the static validator, `scripts/validate.py` |
| Google Chrome or Microsoft Edge | Loading and testing the extension |
| Git | Cloning the repository |

### Clone the repository

```bash
git clone https://github.com/stillware/ImgFetch
cd ImgFetch
```

### Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (the toggle in the top right corner of the page).
3. Click **Load unpacked**.
4. Select the `ImgFetch` folder you cloned.
5. Click the ImgFetch toolbar button to open the popup and confirm the extension loads.

### Load the extension in Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (the toggle in the left sidebar of the page).
3. Click **Load unpacked**.
4. Select the `ImgFetch` folder you cloned.
5. Click the ImgFetch toolbar button to open the popup and confirm the extension loads.

After you change code, click the reload button on the ImgFetch card on the extensions page, then test again.

## Where the code lives

| Folder or file | What it holds |
|---|---|
| `background/` | The service worker: menus, message routing, the download queue, and screenshot capture |
| `content/` | The page scanner and the overlay injected into tabs |
| `core/` | Pure logic modules with no browser APIs: URLs, queue, settings, filenames, capture planning, and validation |
| `offscreen/` | The hidden offscreen document: format conversion, stitching, ZIP building, and clipboard work |
| `popup/` | The toolbar popup |
| `options/` | The Settings page |
| `pages/` | Full pages: Welcome, Capture, the annotation editor, the Parts overview, Rename, and Info |
| `shared/` | Shared UI styles, components, the localization loader, and helpers |
| `_locales/` | User visible strings, one `messages.json` file per locale |
| `tests/` | Unit suites in `tests/` and real browser suites in `tests/test-e2e/` |
| `scripts/` | Validation, checking, and packaging scripts |
| `docs/` | The documentation set |

The full annotated tree is in [docs/project-structure.md](docs/project-structure.md). The documentation index is [docs/README.md](docs/README.md).

## How to run checks

Run these from the repository root. Every check must pass before you open a pull request.

### Syntax check

Check one file, or every JavaScript file, with Node:

```bash
node --check background/service-worker.js
for f in background/*.js content/*.js core/*.js offscreen/*.js options/*.js pages/*.js popup/*.js shared/*.js; do node --check "$f" || exit 1; done
```

### Unit tests

The unit suites print a summary line with the number of checks passed and failed. Run them all:

```bash
for t in tests/test-*.mjs; do echo "-- $t"; node "$t" || exit 1; done
```

One suite needs jsdom for its full run. Without jsdom it skips itself and still passes. To run it in full, point `IMGFETCH_TESTDEPS` at a folder whose `node_modules` holds the test dependencies:

```bash
IMGFETCH_TESTDEPS=<folder-with-node_modules> NODE_PATH=<folder-with-node_modules>/node_modules node tests/test-svg-real-dom.mjs
```

### Localization and duplicate checks

```bash
node scripts/check-i18n.mjs
node scripts/check-duplicates.mjs
```

The i18n checker prints `check-i18n: OK` when every locale matches the English key set, placeholders, and plural rules.

### Static validator

```bash
python3 scripts/validate.py
```

The validator must end with `ALL CHECKS PASSED`. It checks the manifest, permissions, forbidden patterns such as `innerHTML` and remote code, and the claims made in the documentation.

### End to end tests

The suites in `tests/test-e2e/` run the real extension in Chromium through Playwright. Prerequisites:

- Playwright installed, with its Chromium browser downloaded.
- A display, or a virtual display on Linux (`xvfb-run`).
- The `PLAYWRIGHT_PACKAGE` environment variable pointing at the Playwright install, because ES modules ignore `NODE_PATH`.
- Run one suite at a time. Suites interfere with each other when run in parallel.

```bash
PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright xvfb-run -a node tests/test-e2e/e2e.mjs --dpr=1
```

See `tests/test-e2e/README.md` for the full list of suites and options.

### PowerShell variants

On Windows, the same checks run in PowerShell with small syntax changes:

```powershell
node --check background/service-worker.js
Get-ChildItem tests/test-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "failed: $($_.Name)" } }
node scripts/check-i18n.mjs
node scripts/check-duplicates.mjs
python scripts/validate.py
```

PowerShell variants are translations of the bash commands and were not run in the build sandbox (no PowerShell there).

## Coding conventions

- **No `innerHTML`.** Build DOM nodes with document APIs and set text with `textContent`. The validator rejects `innerHTML` in extension code.
- **Strings live in `_locales` only.** Every user visible string goes into `_locales/en/messages.json` and every other locale. Never hard code display text in JavaScript, HTML, or CSS.
- **Use logical CSS properties.** Write `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, and similar properties instead of left and right physical properties, so the Arabic right-to-left layout works without extra rules.
- **GPL header on source files.** New source files start with the same GNU General Public License header block used by the existing files.
- **Original code only.** Do not copy code from other projects unless its license is compatible with the GPL and the source is credited in the file.
- **File naming standard.** Root project files are uppercase (`README.md`, `CONTRIBUTING.md`). Files under `docs/` are lowercase kebab-case (`docs/user-guide.md`). Source and test files are lowercase kebab-case. Locale folders use underscores (`pt_BR`, `zh_CN`).
- **No em dashes in documentation.** Use a comma, a period, a colon, or parentheses instead. The same rule applies to translations.
- Do not bump the version number. Releases are prepared by the maintainers.
- Do not add a permission to `manifest.json` without a documented reason in [docs/permissions.md](docs/permissions.md).

## Commit convention

ImgFetch uses Conventional Commits. Write the subject as a type, an optional scope in parentheses, a colon, and a short summary in the imperative mood.

Examples:

```text
feat(editor): add Crop tool to the annotation editor
fix(capture): wait for the scrolled view to paint before the first tile
docs: describe the Parts overview in the user guide
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, and `chore`. Keep one logical change per commit.

## Branch and pull request process

1. Fork the repository, or create a branch if you have write access. Branch from `main`.
2. Name the branch after the change, for example `fix/capture-first-tile` or `docs/store-listing`.
3. Keep the change focused. Unrelated cleanup belongs in its own pull request.
4. Run every check listed above and confirm they all pass.
5. Open the pull request against `main` and complete the pull request template.
6. Respond to review comments with new commits. A maintainer merges when the checks pass and the review is approved.

## Pull request checklist

Before requesting review, confirm each item. The pull request template repeats this list.

- [ ] The change is focused and matches an agreed issue or a clear bug fix.
- [ ] Syntax checks, unit tests, the i18n checker, the duplicates checker, and `scripts/validate.py` all pass.
- [ ] Tests were added or updated for behavior changes.
- [ ] Documentation was updated where behavior, settings, or limits changed.
- [ ] New user visible strings were added to English and to every other locale.
- [ ] No new manifest permission was added, or the new permission is justified in `docs/permissions.md`.
- [ ] A `CHANGELOG.md` entry was added if the change is visible to users.
- [ ] No em dashes, no personal data, and no local file paths in any file.

## Reporting bugs

Use the bug report form: [open a bug report](https://github.com/stillware/ImgFetch/issues/new/choose) and choose **Bug report**. The form is defined in [.github/ISSUE_TEMPLATE/bug_report.yml](.github/ISSUE_TEMPLATE/bug_report.yml). Include your browser and its version, your operating system, the ImgFetch version, exact steps to reproduce the problem, what you expected, what happened instead, and whether the page was a restricted page (a browser internal page or a store page).

For a security vulnerability, do not open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Proposing features

Open an issue with the feature request form and describe the problem first, then your proposal and any alternatives you considered. Features must fit the product rules: no accounts, no sign-in, no tracking, and all processing stays on the device.

## Adding a language

Translations live in `_locales/`. The full guide, covering key naming, placeholders, plural forms, and right-to-left layout, is [docs/translating.md](docs/translating.md). Run `node scripts/check-i18n.mjs` before submitting, and include its output in your pull request.

## Documentation

The index of every document, with its audience, is [docs/README.md](docs/README.md). Update the matching document in the same pull request whenever you change behavior.
