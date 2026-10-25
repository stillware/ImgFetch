#!/usr/bin/env node
/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch, scripts/make-firefox-manifest.mjs
 * Derives the Firefox (AMO) manifest from the Chrome/Edge root manifest.
 * The root manifest stays the single source of truth. This script applies
 * only the Firefox differences and fails loudly on any root field it does
 * not know how to handle, so the two builds cannot silently drift apart.
 *
 * Firefox differences applied here:
 *   background.service_worker becomes background.scripts (event page
 *   form). The background type is kept when it is "module" or "classic",
 *   because Firefox loads background scripts as ES modules when type is
 *   "module" (MDN, background key). The service_worker key is dropped,
 *   because Firefox does not support it.
 *   minimum_chrome_version is dropped (Chrome only).
 *   The offscreen permission is dropped (Firefox has no Offscreen API;
 *   the background event page itself has a document).
 *   browser_specific_settings.gecko is added (see GECKO_ID below).
 *   optional_host_permissions repeats the root host_permissions, so
 *   the extension can request host access at runtime with
 *   chrome.permissions.request (Firefox does not grant host
 *   permissions at install time; MDN, permissions.request and
 *   optional_permissions). Supported in Firefox 128 and later, which
 *   the 142.0 floor covers.
 *   Two command suggested keys are replaced with Firefox-specific
 *   defaults, because the Chrome defaults collide with Firefox
 *   built-in shortcuts (see FIREFOX_COMMAND_KEYS below).
 * Every other root field is copied unchanged.
 *
 * Usage: node scripts/make-firefox-manifest.mjs [input] [output]
 * Defaults: input is the manifest.json next to this script's parent
 * directory (the project root manifest), output is stdout when the
 * output argument is omitted. Runs under plain node, no dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The AMO extension id. Permanent once published: changing it later
 * creates a new AMO listing instead of an update, so this value must
 * never change. Defined here and nowhere else in this file.
 */
const GECKO_ID = 'imgfetch@stillware';

/**
 * Lowest Firefox version the build supports. 142.0 is the floor for the
 * built-in data consent experience on Android (140 on desktop), so a
 * single 142.0 floor covers both and needs no separate consent control.
 */
const STRICT_MIN_VERSION = '142.0';

/**
 * AMO data collection declaration for an extension that collects no
 * data: required is exactly ["none"] (MDN, browser_specific_settings;
 * Extension Workshop, Firefox built-in consent for data collection).
 */
const DATA_COLLECTION_PERMISSIONS = { required: ['none'] };

/**
 * Firefox-specific command keys. Two Chrome defaults collide with
 * Firefox built-in shortcuts: Ctrl+Shift+S is Firefox Take a
 * Screenshot, and Ctrl+Shift+E is the Firefox Network monitor. Those
 * two commands use Alt+Shift+S and Alt+Shift+C in the Firefox build.
 * The other commands keep the root defaults. These candidates still
 * need a press test in a real Firefox before release.
 */
const FIREFOX_COMMAND_KEYS = {
  'imgfetch-scan-page': 'Alt+Shift+S',
  'imgfetch-capture-element': 'Alt+Shift+C',
};

/**
 * Root manifest fields this script knows how to handle. Any other field
 * in the root manifest is an error, never a silent pass-through.
 * browser_specific_settings is listed here only so that its presence in
 * the root manifest is rejected with a clear message: this script owns
 * that field and generates it from the constants above.
 */
const HANDLED_FIELDS = new Set([
  'action',
  'background',
  'browser_specific_settings',
  'commands',
  'content_security_policy',
  'default_locale',
  'description',
  'host_permissions',
  'icons',
  'manifest_version',
  'minimum_chrome_version',
  'name',
  'options_page',
  'permissions',
  'short_name',
  'version',
]);

function fail(message) {
  console.error(`make-firefox-manifest: error: ${message}`);
  process.exit(1);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function convertBackground(rootBackground) {
  if (!isPlainObject(rootBackground)) {
    fail('background must be an object');
  }
  for (const key of Object.keys(rootBackground)) {
    if (key !== 'service_worker' && key !== 'type') {
      fail(`background field not handled for Firefox: background.${key}`);
    }
  }
  const worker = rootBackground.service_worker;
  if (typeof worker !== 'string' || worker.length === 0) {
    fail('background.service_worker must be a non-empty string');
  }
  const converted = { scripts: [worker] };
  if (rootBackground.type !== undefined) {
    if (rootBackground.type !== 'module' && rootBackground.type !== 'classic') {
      fail(`background.type not handled for Firefox: ${JSON.stringify(rootBackground.type)}`);
    }
    converted.type = rootBackground.type;
  }
  return converted;
}

function convertCommands(rootCommands) {
  if (!isPlainObject(rootCommands)) {
    fail('commands must be an object');
  }
  const converted = deepCopy(rootCommands);
  for (const [name, key] of Object.entries(FIREFOX_COMMAND_KEYS)) {
    if (converted[name] !== undefined && converted[name].suggested_key !== undefined) {
      converted[name].suggested_key.default = key;
    }
  }
  return converted;
}

function convertPermissions(rootPermissions) {
  if (!Array.isArray(rootPermissions)) {
    fail('permissions must be an array');
  }
  for (const perm of rootPermissions) {
    if (typeof perm !== 'string') {
      fail('permissions entries must be strings');
    }
  }
  return rootPermissions.filter((perm) => perm !== 'offscreen');
}

export function makeFirefoxManifest(rootManifest) {
  if (!isPlainObject(rootManifest)) {
    fail('root manifest must be a JSON object');
  }
  for (const key of Object.keys(rootManifest)) {
    if (!HANDLED_FIELDS.has(key)) {
      fail(`unknown manifest field: ${key}`);
    }
  }
  if (rootManifest.browser_specific_settings !== undefined) {
    fail('browser_specific_settings is already present in the root manifest; this script generates it');
  }
  if (rootManifest.manifest_version !== 3) {
    fail(`manifest_version must be 3, got ${JSON.stringify(rootManifest.manifest_version)}`);
  }
  if (rootManifest.background === undefined) {
    fail('background is missing from the root manifest');
  }
  const firefox = {};
  for (const key of Object.keys(rootManifest)) {
    if (key === 'minimum_chrome_version') {
      continue;
    }
    if (key === 'background') {
      firefox.background = convertBackground(rootManifest.background);
    } else if (key === 'permissions') {
      firefox.permissions = convertPermissions(rootManifest.permissions);
    } else if (key === 'commands') {
      firefox.commands = convertCommands(rootManifest.commands);
    } else {
      firefox[key] = deepCopy(rootManifest[key]);
    }
  }
  if (rootManifest.host_permissions !== undefined) {
    firefox.optional_host_permissions = deepCopy(rootManifest.host_permissions);
  }
  firefox.browser_specific_settings = {
    gecko: {
      data_collection_permissions: deepCopy(DATA_COLLECTION_PERMISSIONS),
      id: GECKO_ID,
      strict_min_version: STRICT_MIN_VERSION,
    },
  };
  const ordered = {};
  for (const key of Object.keys(firefox).sort()) {
    ordered[key] = firefox[key];
  }
  return ordered;
}

function main(argv) {
  if (argv.length > 2) {
    fail('expected at most 2 arguments: input manifest path and output manifest path');
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultInput = join(scriptDir, '..', 'manifest.json');
  const inputPath = argv[0] !== undefined ? resolve(argv[0]) : defaultInput;
  const outputPath = argv[1] !== undefined ? resolve(argv[1]) : null;
  let text;
  try {
    text = readFileSync(inputPath, 'utf-8');
  } catch (error) {
    fail(`cannot read input manifest: ${inputPath} (${error.message})`);
  }
  let rootManifest;
  try {
    rootManifest = JSON.parse(text);
  } catch (error) {
    fail(`input manifest is not valid JSON: ${error.message}`);
  }
  const firefox = makeFirefoxManifest(rootManifest);
  const out = `${JSON.stringify(firefox, null, 2)}\n`;
  if (outputPath === null) {
    process.stdout.write(out);
  } else {
    try {
      writeFileSync(outputPath, out, 'utf-8');
    } catch (error) {
      fail(`cannot write output manifest: ${outputPath} (${error.message})`);
    }
  }
}

main(process.argv.slice(2));
