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
 * ImgFetch: tests/test-validate-package-mode.mjs
 * Node tests for the validate.py --package mode (Phase 5 item E2) and the
 * release-check.sh CRLF safety (Phase 5 item E1).
 * Covers: normal mode still fails on an extracted package tree, package
 * mode passes that same tree, the flag works before and after the
 * directory, two directories are a usage error, the .gitattributes rule
 * is present, release-check.sh is LF only and carries the CRLF guard and
 * the --package call, and the guard line taken from the real script
 * re-runs a CRLF copy under Linux bash with the repo root intact.
 * Prints "N passed, M failed", exits nonzero on failure.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`); }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const validatePy = join(repoRoot, 'scripts', 'validate.py');
const releaseCheck = join(repoRoot, 'scripts', 'release-check.sh');
const tmp = mkdtempSync(join(tmpdir(), 'imgfetch-validate-package-'));

/* Stage an extracted package tree from the real repo, using the same
 * include list as scripts/package.sh, with the short package README. */
const stage = join(tmp, 'package');
mkdirSync(join(stage, 'docs'), { recursive: true });
const include = [
  'manifest.json', 'background', 'content', 'core', 'offscreen',
  'options', 'pages', 'popup', 'shared', 'icons', '_locales',
  'LICENSE', 'PRIVACY.md', 'TERMS.md', 'CHANGELOG.md',
  'docs/user-guide.md', 'docs/permissions.md', 'docs/limitations.md',
];
for (const item of include) {
  cpSync(join(repoRoot, item), join(stage, item), { recursive: true });
}
cpSync(join(repoRoot, 'README-package.md'), join(stage, 'README.md'));

check('staged package tree has manifest.json', existsSync(join(stage, 'manifest.json')));
check('staged package tree README is the package README',
  readFileSync(join(stage, 'README.md'), 'utf-8') === readFileSync(join(repoRoot, 'README-package.md'), 'utf-8'));
check('staged package tree ships no docs/project-structure.md',
  !existsSync(join(stage, 'docs', 'project-structure.md')));

function runValidate(args) {
  const r = spawnSync('python3', [validatePy, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const normal = runValidate([stage]);
check('normal mode fails on the extracted package tree', normal.status !== 0, `status=${normal.status}`);
check('normal mode names the unreadable docs listing',
  normal.out.includes('docs/project-structure.md is unreadable'));
check('normal mode lists unmentioned package files',
  normal.out.includes('does not mention real project file'));
check('normal mode reports static check failures',
  normal.out.includes('FAILURE(S) in static checks')
  && normal.out.split('\n').filter((l) => l.startsWith('FAIL:')).length > 0);

const packaged = runValidate(['--package', stage]);
check('package mode passes the extracted package tree', packaged.status === 0, packaged.out.slice(-300));
check('package mode reports all checks passed',
  packaged.out.includes('ALL CHECKS PASSED (including docs/claims linter)'));
check('package mode skips the docs listing check',
  packaged.out.includes('listing check skipped in package mode'));
check('package mode skips the README version line',
  packaged.out.includes('README version line skipped in package mode'));
check('package mode skips the test count check',
  packaged.out.includes('test count check skipped in package mode'));
check('package mode reports no failures', !packaged.out.includes('FAIL:'));

const packagedAfter = runValidate([stage, '--package']);
check('package mode works with the flag after the directory', packagedAfter.status === 0);
check('flag after directory still reports all checks passed',
  packagedAfter.out.includes('ALL CHECKS PASSED (including docs/claims linter)'));

const usage = runValidate(['--package', 'a', 'b']);
check('two directories are a usage error', usage.status === 2, `status=${usage.status}`);
check('usage error prints the usage line',
  usage.out.includes('usage: validate.py [--package] [directory]'));

/* E1: .gitattributes and release-check.sh CRLF safety. */
const gitattributes = join(repoRoot, '.gitattributes');
check('.gitattributes exists at the repo root', existsSync(gitattributes));
check('.gitattributes forces shell scripts to LF',
  existsSync(gitattributes) && readFileSync(gitattributes, 'utf-8').includes('*.sh text eol=lf'));

const releaseText = readFileSync(releaseCheck, 'utf-8');
check('release-check.sh is LF only (no carriage returns)', !releaseText.includes('\r'));
check('release-check.sh carries the CRLF guard',
  releaseText.includes('CRLF guard') && releaseText.includes("grep -q $'\\r'"));
check('release-check.sh validates extracted zips in package mode',
  releaseText.includes('python3 scripts/validate.py --package "$D"'));
check('release-check.sh keeps the repo root across the CRLF re-exec',
  releaseText.includes('IMGFETCH_RELEASE_ROOT'));

const validateText = readFileSync(validatePy, 'utf-8');
check('validate.py still fails on an unreadable docs listing in normal mode',
  validateText.includes('fail(f"docs/project-structure.md is unreadable: {e}")'));
check('validate.py still enforces the listing in normal mode',
  validateText.includes('missing_from_tree = [] if PACKAGE_MODE else'));

/* The CRLF guard, taken verbatim from the real release-check.sh, must
 * re-run a CRLF copy under Linux bash with the repo root intact. */
const guardLine = releaseText.split('\n').find((l) => l.includes('CRLF guard') && l.startsWith('if grep'));
check('guard line found in release-check.sh', typeof guardLine === 'string' && guardLine.length > 0);
if (typeof guardLine === 'string') {
  const probeDir = join(tmp, 'probe');
  const probeScripts = join(probeDir, 'scripts');
  mkdirSync(probeScripts, { recursive: true });
  const probeBody = '#!/usr/bin/env bash\n'
    + `${guardLine}\n`
    + 'set -euo pipefail\n'
    + 'ROOT="${IMGFETCH_RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"\n'
    + 'cd "$ROOT"\n'
    + 'echo "GUARD-OK ROOT=$ROOT args=$*"\n';
  const probeLf = join(probeScripts, 'probe.sh');
  const probeCrlf = join(probeScripts, 'probe-crlf.sh');
  writeFileSync(probeLf, probeBody, 'utf-8');
  writeFileSync(probeCrlf, probeBody.replace(/\n/g, '\r\n'), 'utf-8');
  const lfRun = spawnSync('bash', [probeLf, 'a', 'b'], { encoding: 'utf-8' });
  check('guard probe passes in LF', lfRun.status === 0, lfRun.stderr);
  check('guard probe reports the probe root in LF',
    (lfRun.stdout || '').includes(`GUARD-OK ROOT=${probeDir} args=a b`));
  const crlfRun = spawnSync('bash', [probeCrlf, 'a', 'b'], { encoding: 'utf-8' });
  check('guard probe passes in CRLF', crlfRun.status === 0, crlfRun.stderr);
  check('guard probe reports the probe root in CRLF',
    (crlfRun.stdout || '').includes(`GUARD-OK ROOT=${probeDir} args=a b`));
  check('guard probe passes args through in CRLF',
    (crlfRun.stdout || '').includes('args=a b'));
}

rmSync(tmp, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
