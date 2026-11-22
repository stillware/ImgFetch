#!/usr/bin/env bash
# ImgFetch - smart image downloader
# Copyright (C) 2026 ImgFetch Developer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
# ImgFetch packaging: validate, test, then build Chrome/Edge/Firefox store zips.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FIREFOX_ONLY=0
if [ "${1:-}" = "--firefox-only" ]; then
  FIREFOX_ONLY=1
fi

if [ "$FIREFOX_ONLY" -eq 0 ]; then
echo "== ImgFetch: validating =="
python3 scripts/validate.py
for t in tests/test-*.mjs; do
  echo "-- $t"
  # test-svg-real-dom.mjs self-skips when jsdom is absent; give it jsdom when present.
  # Optional: set IMGFETCH_TESTDEPS to a folder whose node_modules holds the
  # dev-only test dependencies (jsdom). Unset: the jsdom suite self-skips.
  if [ -n "${IMGFETCH_TESTDEPS:-}" ]; then
    if [ -d "$IMGFETCH_TESTDEPS/node_modules" ]; then
      NODE_PATH="$IMGFETCH_TESTDEPS/node_modules${NODE_PATH:+:$NODE_PATH}" node "$t" || exit 1
    else
      echo "ERROR: IMGFETCH_TESTDEPS is set but '$IMGFETCH_TESTDEPS/node_modules' does not exist." >&2
      echo "Unset IMGFETCH_TESTDEPS (the jsdom suite then self-skips) or point it at the right folder." >&2
      exit 1
    fi
  else
    node "$t" || exit 1
  fi
done
node scripts/check-duplicates.mjs || exit 1
node scripts/regression-diff.mjs || exit 1
fi

VERSION="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
DIST="$ROOT/dist"
if [ "$FIREFOX_ONLY" -eq 1 ]; then
  mkdir -p "$DIST"
else
  rm -rf "$DIST"
  mkdir -p "$DIST"
fi

# Store zip contents (I3): manifest, code folders, icons, licence and the
# user-facing docs only. Excluded: assets/, docs/history, docs/tests,
# docs/architecture.md, docs/build.md, docs/performance.md,
# docs/security-model.md, SECURITY.md, tests/, scripts/, store-assets/,
# results JSON, dist/.
# The GitHub README.md is NOT shipped. Every ZIP gets README-package.md,
# a short text-only README, stored inside the ZIP as README.md.
INCLUDE=(
  manifest.json
  background content core offscreen options pages popup shared icons _locales
  LICENSE PRIVACY.md TERMS.md CHANGELOG.md
  docs/user-guide.md docs/permissions.md docs/limitations.md
)

if [ ! -f README-package.md ]; then
  echo "FATAL: README-package.md is missing" >&2
  exit 1
fi

# Build a staging tree: the INCLUDE file list plus the package README
# stored as README.md. Chrome, Edge and Firefox all start from this tree.
build_staging() {
  local DEST="$1"
  mkdir -p "$DEST/docs"
  for ITEM in "${INCLUDE[@]}"; do
    if [ -d "$ITEM" ]; then
      cp -r "$ITEM" "$DEST/"
    else
      mkdir -p "$DEST/$(dirname "$ITEM")"
      cp "$ITEM" "$DEST/$ITEM"
    fi
  done
  cp README-package.md "$DEST/README.md"
}

# Firefox staging tree: the same files, with the derived Firefox
# manifest at the root. Used by the firefox-only mode and by the
# Firefox zip step below, so both stay identical.
build_firefox_staging() {
  local DEST="$1"
  build_staging "$DEST"
  node scripts/make-firefox-manifest.mjs manifest.json "$DEST/manifest.json"
}

if [ "$FIREFOX_ONLY" -eq 1 ]; then
  STAGING="$DIST/firefox-staging"
  rm -rf "$STAGING"
  build_firefox_staging "$STAGING"
  echo "== firefox staging built: $STAGING =="
  exit 0
fi

CRSTAGE_TMP="$(mktemp -d)"
trap 'rm -rf "$CRSTAGE_TMP"' EXIT
CRSTAGE="$CRSTAGE_TMP/chrome"
build_staging "$CRSTAGE"
for TARGET in chrome edge; do
  ZIP="$DIST/imgfetch-${TARGET}-${VERSION}.zip"
  rm -f "$ZIP"
  (cd "$CRSTAGE" && zip -q -r "$ZIP" . -x "*/.*" "*/__pycache__/*")
  echo "built: $ZIP ($(du -h "$ZIP" | cut -f1))"
done

# F1: the two zips must be identical in content (only the file name differs).
# Extract both and diff; fail the build on any difference.
TMPD="$(mktemp -d)"
unzip -q "$DIST/imgfetch-chrome-${VERSION}.zip" -d "$TMPD/chrome"
unzip -q "$DIST/imgfetch-edge-${VERSION}.zip" -d "$TMPD/edge"
if ! diff -r "$TMPD/chrome" "$TMPD/edge" > "$TMPD/zipdiff.txt" 2>&1; then
  echo "FATAL: Chrome and Edge zips differ:"
  cat "$TMPD/zipdiff.txt"
  rm -rf "$TMPD"
  exit 1
fi
rm -rf "$TMPD"
echo "== zip content check: Chrome and Edge identical =="

# Firefox zip: same file list as Chrome/Edge, derived manifest only.
FFSTAGE_TMP="$(mktemp -d)"
FFSTAGE="$FFSTAGE_TMP/firefox"
build_firefox_staging "$FFSTAGE"
ZIP="$DIST/imgfetch-firefox-${VERSION}.zip"
rm -f "$ZIP"
(cd "$FFSTAGE" && zip -q -r "$ZIP" . -x "*/.*" "*/__pycache__/*")
echo "built: $ZIP ($(du -h "$ZIP" | cut -f1))"
rm -rf "$FFSTAGE_TMP"

# Firefox check: the extracted Firefox tree must differ from Chrome
# only in manifest.json (same entry list, same per-file bytes elsewhere).
TMPF="$(mktemp -d)"
unzip -q "$DIST/imgfetch-chrome-${VERSION}.zip" -d "$TMPF/chrome"
unzip -q "$ZIP" -d "$TMPF/firefox"
FFDIFF="$TMPF/firefoxdiff.txt"
diff -r "$TMPF/chrome" "$TMPF/firefox" > "$FFDIFF" 2>&1 || true
if [ ! -s "$FFDIFF" ]; then
  echo "FATAL: Firefox zip is identical to Chrome (manifest was not replaced)" >&2
  rm -rf "$TMPF"
  exit 1
fi
if grep -q "Only in" "$FFDIFF"; then
  echo "FATAL: Firefox zip entry list differs from Chrome:" >&2
  cat "$FFDIFF" >&2
  rm -rf "$TMPF"
  exit 1
fi
OTHER_DIFF="$(grep "differ" "$FFDIFF" | grep -v "manifest.json" || true)"
if [ -n "$OTHER_DIFF" ]; then
  echo "FATAL: Firefox zip differs from Chrome outside manifest.json:" >&2
  echo "$OTHER_DIFF" >&2
  rm -rf "$TMPF"
  exit 1
fi
if ! grep -q "manifest.json" "$FFDIFF"; then
  echo "FATAL: Firefox zip manifest.json does not differ from Chrome" >&2
  rm -rf "$TMPF"
  exit 1
fi
rm -rf "$TMPF"
echo "== zip content check: Firefox differs from Chrome only in manifest.json =="

echo "== done =="
