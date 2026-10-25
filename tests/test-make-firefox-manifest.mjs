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
 * ImgFetch: tests/test-make-firefox-manifest.mjs
 * Node tests for scripts/make-firefox-manifest.mjs, the script that
 * derives the Firefox manifest from the Chrome/Edge root manifest.
 * Covers the event page background form, the dropped Chrome only
 * fields, the gecko block, the Firefox-only host permission entries
 * and command keys, preservation of every other field, loud
 * failure on unknown fields, and byte identical repeat runs.
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function deepEq(a, b) {
  if (a === b) { return true; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { return false; }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, index) => deepEq(item, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length
    && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEq(a[key], b[key]));
}

const generator = fileURLToPath(new URL('../scripts/make-firefox-manifest.mjs', import.meta.url));
const rootPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
const root = JSON.parse(readFileSync(rootPath, 'utf-8'));
const tmp = mkdtempSync(join(tmpdir(), 'imgfetch-firefox-manifest-'));

function runGenerator(args) {
  return spawnSync(process.execPath, [generator, ...args], { encoding: 'utf-8' });
}
function writeInput(name, value) {
  const path = join(tmp, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf-8');
  return path;
}

/* ---------------- derived manifest from the real root manifest ---------------- */

const outPath = join(tmp, 'manifest-firefox.json');
const mainRun = runGenerator([rootPath, outPath]);
check('generator exits zero on the real root manifest', mainRun.status === 0, mainRun.stderr);
check('generator writes the derived manifest file', existsSync(outPath));
let derived = null;
try {
  derived = JSON.parse(readFileSync(outPath, 'utf-8'));
  check('derived manifest is valid JSON', true);
} catch (error) {
  check('derived manifest is valid JSON', false, error.message);
}
if (derived !== null) {
  check('service_worker is replaced by scripts with the same file',
    eq(derived.background && derived.background.scripts, ['background/service-worker.js']));
  check('derived background has no service_worker key',
    derived.background && !('service_worker' in derived.background));
  check('derived background keeps type module', derived.background && derived.background.type === 'module');
  check('derived manifest has no offscreen permission',
    Array.isArray(derived.permissions) && !derived.permissions.includes('offscreen'));
  check('derived permissions equal root permissions minus offscreen',
    eq(derived.permissions, root.permissions.filter((perm) => perm !== 'offscreen')));
  check('derived manifest has no minimum_chrome_version', !('minimum_chrome_version' in derived));
  check('derived manifest has a gecko block', derived.browser_specific_settings !== undefined
    && derived.browser_specific_settings.gecko !== undefined);
  const gecko = (derived.browser_specific_settings || {}).gecko || {};
  check('gecko id is present and exact', gecko.id === 'imgfetch@stillware');
  check('gecko strict_min_version is present and exact', gecko.strict_min_version === '142.0');
  check('data collection declaration is present and exact',
    eq(gecko.data_collection_permissions, { required: ['none'] }));
  check('optional_host_permissions repeat the root host_permissions',
    eq(derived.optional_host_permissions, root.host_permissions));
  check('Firefox scan page command uses Alt+Shift+S',
    derived.commands && derived.commands['imgfetch-scan-page']
      && derived.commands['imgfetch-scan-page'].suggested_key
      && derived.commands['imgfetch-scan-page'].suggested_key.default === 'Alt+Shift+S');
  check('Firefox capture element command uses Alt+Shift+C',
    derived.commands && derived.commands['imgfetch-capture-element']
      && derived.commands['imgfetch-capture-element'].suggested_key
      && derived.commands['imgfetch-capture-element'].suggested_key.default === 'Alt+Shift+C');
  const strippedRoot = { ...root };
  delete strippedRoot.background;
  delete strippedRoot.permissions;
  delete strippedRoot.minimum_chrome_version;
  delete strippedRoot.commands;
  const strippedDerived = { ...derived };
  delete strippedDerived.background;
  delete strippedDerived.permissions;
  delete strippedDerived.browser_specific_settings;
  delete strippedDerived.commands;
  delete strippedDerived.optional_host_permissions;
  check('all other fields are preserved unchanged', deepEq(strippedDerived, strippedRoot));
  const otherCommandsRoot = { ...root.commands };
  delete otherCommandsRoot['imgfetch-scan-page'];
  delete otherCommandsRoot['imgfetch-capture-element'];
  const otherCommandsDerived = { ...derived.commands };
  delete otherCommandsDerived['imgfetch-scan-page'];
  delete otherCommandsDerived['imgfetch-capture-element'];
  check('all other commands are unchanged', deepEq(otherCommandsDerived, otherCommandsRoot));
  check('version is preserved', derived.version === root.version);
}

/* ---------------- loud failure on fields the script cannot handle ---------------- */

const unknownInput = writeInput('unknown.json', { ...root, invented_field: true });
const unknownRun = runGenerator([unknownInput, join(tmp, 'unknown-out.json')]);
check('unknown top level field fails with nonzero exit', unknownRun.status !== 0);
check('unknown field error names the field', (unknownRun.stderr || '').includes('invented_field'));

const badBackground = JSON.parse(JSON.stringify(root));
badBackground.background = { scripts: ['background/service-worker.js'] };
const badBgRun = runGenerator([writeInput('badbg.json', badBackground), join(tmp, 'badbg-out.json')]);
check('background without service_worker fails', badBgRun.status !== 0);

const badVersion = JSON.parse(JSON.stringify(root));
badVersion.manifest_version = 2;
const badVersionRun = runGenerator([writeInput('badv.json', badVersion), join(tmp, 'badv-out.json')]);
check('non-MV3 root manifest fails', badVersionRun.status !== 0);

/* ---------------- repeat runs and stdout mode ---------------- */

const outPath2 = join(tmp, 'manifest-firefox-2.json');
const secondRun = runGenerator([rootPath, outPath2]);
check('second run exits zero', secondRun.status === 0, secondRun.stderr);
check('running twice gives identical output bytes',
  readFileSync(outPath, 'utf-8') === readFileSync(outPath2, 'utf-8'));
const stdoutRun = runGenerator([rootPath]);
check('stdout mode prints the same manifest as file mode',
  stdoutRun.status === 0 && stdoutRun.stdout === readFileSync(outPath, 'utf-8'));
const extraArgRun = runGenerator([rootPath, outPath, 'extra']);
check('more than two arguments fails', extraArgRun.status !== 0);

rmSync(tmp, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
