// Tests for license-check.mjs: the npm license report against the allowlist.
// The script is informational, so it exits 0 whenever it can read its inputs.
// Each test runs the real CLI on a small node_modules tree built in a temp dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'license-check.mjs');
const ALLOWLIST_TEXT = ['MIT', 'BSD-3-Clause', 'BSD-2-Clause', 'Apache-2.0', 'ISC'].join('\n') + '\n';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'license-check-'));
  dirs.push(d);
  return d;
}

// entries: { "<path under node_modules>": package.json object }. A path may be scoped
// ("@scope/name") or nested ("outer/node_modules/inner").
function nodeModules(entries = {}) {
  const root = join(tempDir(), 'node_modules');
  mkdirSync(root, { recursive: true });
  for (const [rel, pkg] of Object.entries(entries)) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }
  return root;
}

function allowlistFile(text = ALLOWLIST_TEXT) {
  const path = join(tempDir(), 'license-allowlist.txt');
  writeFileSync(path, text);
  return path;
}

function run(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!('GITHUB_STEP_SUMMARY' in env)) delete childEnv.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: childEnv });
}

const check = (root, allow = allowlistFile(), env = {}) => run([root, allow], env);
const row = (name, version, license, status) => `| ${name} | ${version} | ${license} | ${status} |`;
const warning = (name, version, license) =>
  `::warning title=License outside the allowlist::${name}@${version} is ${license}`;
const header = (total, outside) =>
  `### npm production dependencies: ${total} package(s), ${outside} outside the allowlist`;

test('allowed licenses are reported ok, with no warning and exit 0', () => {
  const root = nodeModules({
    alpha: { name: 'alpha', version: '1.0.0', license: 'MIT' },
    beta: { name: 'beta', version: '2.0.0', license: 'Apache-2.0' },
  });
  const r = check(root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(header(2, 0)), r.stdout);
  assert.ok(r.stdout.includes(row('alpha', '1.0.0', 'MIT', 'ok')));
  assert.ok(r.stdout.includes(row('beta', '2.0.0', 'Apache-2.0', 'ok')));
  assert.doesNotMatch(r.stdout, /::warning/);
});

test('a license outside the allowlist is flagged as review, with a warning, and still exits 0', () => {
  const root = nodeModules({
    copyleft: { name: 'copyleft', version: '3.1.4', license: 'GPL-3.0' },
    fine: { name: 'fine', version: '1.0.0', license: 'MIT' },
  });
  const r = check(root);
  assert.equal(r.status, 0, 'the report is informational and must not fail the job');
  assert.ok(r.stdout.includes(header(2, 1)), r.stdout);
  assert.ok(r.stdout.includes(row('copyleft', '3.1.4', 'GPL-3.0', 'review')));
  assert.ok(r.stdout.includes(row('fine', '1.0.0', 'MIT', 'ok')));
  assert.ok(r.stdout.includes(warning('copyleft', '3.1.4', 'GPL-3.0')));
  assert.doesNotMatch(r.stdout, /::warning[^\n]*is MIT/);
});

test('a package with no license field is reported as UNKNOWN and flagged for review', () => {
  const root = nodeModules({ mystery: { name: 'mystery', version: '0.1.0' } });
  const r = check(root);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(row('mystery', '0.1.0', 'UNKNOWN', 'review')));
  assert.ok(r.stdout.includes(warning('mystery', '0.1.0', 'UNKNOWN')));
});

test('the object form and the array form of "license" and "licenses" are read', () => {
  const root = nodeModules({
    objectForm: { name: 'object-form', version: '1.0.0', license: { type: 'GPL-3.0' } },
    arrayForm: {
      name: 'array-form',
      version: '1.0.0',
      licenses: [{ type: 'MIT' }, { type: 'GPL-3.0' }],
    },
    bareArray: { name: 'bare-array', version: '1.0.0', licenses: ['ISC'] },
  });
  const r = check(root);
  assert.ok(r.stdout.includes(row('object-form', '1.0.0', 'GPL-3.0', 'review')), r.stdout);
  // Several licenses are joined with OR: one allowed alternative is enough.
  assert.ok(r.stdout.includes(row('array-form', '1.0.0', 'MIT OR GPL-3.0', 'ok')), r.stdout);
  assert.ok(r.stdout.includes(row('bare-array', '1.0.0', 'ISC', 'ok')), r.stdout);
});

test('dual licenses: OR needs one allowed alternative, AND needs all of them', () => {
  const root = nodeModules({
    or_allowed: { name: 'or-allowed', version: '1.0.0', license: '(MIT OR GPL-3.0)' },
    or_denied: { name: 'or-denied', version: '1.0.0', license: '(GPL-3.0 OR AGPL-3.0)' },
    and_allowed: { name: 'and-allowed', version: '1.0.0', license: '(MIT AND BSD-3-Clause)' },
    and_bare_allowed: { name: 'and-bare', version: '1.0.0', license: 'MIT AND BSD-3-Clause' },
    and_denied: { name: 'and-denied', version: '1.0.0', license: 'MIT AND GPL-3.0' },
  });
  const r = check(root);
  assert.ok(r.stdout.includes(row('or-allowed', '1.0.0', '(MIT OR GPL-3.0)', 'ok')), r.stdout);
  assert.ok(r.stdout.includes(row('or-denied', '1.0.0', '(GPL-3.0 OR AGPL-3.0)', 'review')), r.stdout);
  assert.ok(r.stdout.includes(row('and-allowed', '1.0.0', '(MIT AND BSD-3-Clause)', 'ok')), r.stdout);
  assert.ok(r.stdout.includes(row('and-bare', '1.0.0', 'MIT AND BSD-3-Clause', 'ok')), r.stdout);
  assert.ok(r.stdout.includes(row('and-denied', '1.0.0', 'MIT AND GPL-3.0', 'review')), r.stdout);
  assert.ok(r.stdout.includes(header(5, 2)), r.stdout);
});

test('an AND group inside an OR is satisfied by its allowed alternative', () => {
  const root = nodeModules({
    nested: { name: 'nested', version: '1.0.0', license: 'MIT OR (Apache-2.0 AND GPL-3.0)' },
  });
  const r = check(root);
  assert.ok(r.stdout.includes(row('nested', '1.0.0', 'MIT OR (Apache-2.0 AND GPL-3.0)', 'ok')), r.stdout);
});

test('nested parentheses group as written: AND inside OR, OR inside AND', () => {
  const root = nodeModules({
    deepOk: { name: 'deep-ok', version: '1.0.0', license: '(MIT OR (Apache-2.0 AND GPL-3.0)) AND ISC' },
    deepDenied: { name: 'deep-denied', version: '1.0.0', license: 'GPL-3.0 AND (MIT OR Apache-2.0)' },
  });
  const r = check(root);
  assert.ok(r.stdout.includes(row('deep-ok', '1.0.0', '(MIT OR (Apache-2.0 AND GPL-3.0)) AND ISC', 'ok')), r.stdout);
  assert.ok(r.stdout.includes(row('deep-denied', '1.0.0', 'GPL-3.0 AND (MIT OR Apache-2.0)', 'review')), r.stdout);
});

test('scoped packages and nested node_modules are found; .bin and folders without package.json are skipped', () => {
  const root = nodeModules({
    '@scope/inner': { name: '@scope/inner', version: '1.0.0', license: 'MIT' },
    outer: { name: 'outer', version: '1.0.0', license: 'MIT' },
    'outer/node_modules/deep': { name: 'deep', version: '2.0.0', license: 'ISC' },
    '@scope/inner/node_modules/leaf': { name: 'leaf', version: '3.0.0', license: 'BSD-2-Clause' },
  });
  mkdirSync(join(root, '.bin'));
  writeFileSync(join(root, '.bin', 'tool'), '#!/bin/sh\n');
  mkdirSync(join(root, 'stray'));
  writeFileSync(join(root, 'stray', 'readme.txt'), 'no package.json here\n');
  const r = check(root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(header(4, 0)), r.stdout);
  for (const name of ['@scope/inner', 'outer', 'deep', 'leaf']) {
    assert.ok(r.stdout.includes(`| ${name} |`), `${name} missing from:\n${r.stdout}`);
  }
  assert.doesNotMatch(r.stdout, /\| tool \||\| stray \|/);
});

test('rows are sorted by name, then by version', () => {
  const root = nodeModules({
    zeta: { name: 'zeta', version: '1.0.0', license: 'MIT' },
    alpha: { name: 'alpha', version: '2.0.0', license: 'MIT' },
    'zeta/node_modules/alpha': { name: 'alpha', version: '0.9.0', license: 'MIT' },
  });
  const r = check(root);
  const at = (text) => r.stdout.indexOf(text);
  const older = at(row('alpha', '0.9.0', 'MIT', 'ok'));
  const newer = at(row('alpha', '2.0.0', 'MIT', 'ok'));
  const zeta = at(row('zeta', '1.0.0', 'MIT', 'ok'));
  assert.ok(older > -1 && newer > -1 && zeta > -1, r.stdout);
  assert.ok(older < newer && newer < zeta, 'expected alpha 0.9.0, alpha 2.0.0, zeta 1.0.0');
});

test('comments and blank lines in the allowlist are not license ids', () => {
  const root = nodeModules({
    commented: { name: 'commented', version: '1.0.0', license: 'GPL-3.0' },
    fine: { name: 'fine', version: '1.0.0', license: 'MIT' },
    padded: { name: 'padded', version: '1.0.0', license: 'Apache-2.0' },
  });
  const r = check(root, allowlistFile('# GPL-3.0 is not accepted\n\n   # AGPL-3.0\nMIT\n   Apache-2.0  \n'));
  assert.ok(r.stdout.includes(row('commented', '1.0.0', 'GPL-3.0', 'review')), r.stdout);
  assert.ok(r.stdout.includes(row('fine', '1.0.0', 'MIT', 'ok')), r.stdout);
  // Surrounding spaces in the allowlist are trimmed before the match.
  assert.ok(r.stdout.includes(row('padded', '1.0.0', 'Apache-2.0', 'ok')), r.stdout);
});

test('an empty node_modules tree reports zero packages and exits 0', () => {
  const r = check(nodeModules());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(header(0, 0)), r.stdout);
});

test('the step summary file gets the same markdown table when GITHUB_STEP_SUMMARY is set', () => {
  const root = nodeModules({ copyleft: { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0' } });
  const summary = join(tempDir(), 'summary.md');
  writeFileSync(summary, '');
  const r = check(root, allowlistFile(), { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 0);
  const text = readFileSync(summary, 'utf8');
  assert.ok(text.includes(header(1, 1)), text);
  assert.ok(text.includes(row('copyleft', '1.0.0', 'GPL-3.0', 'review')), text);
  assert.doesNotMatch(text, /::warning/, 'workflow commands belong to the log, not the summary');
});

test('usage: missing arguments exit 2 with a usage line', () => {
  const r = run([nodeModules()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: license-check\.mjs/);
});

test('a missing allowlist fails closed instead of reporting everything as allowed', () => {
  const root = nodeModules({ fine: { name: 'fine', version: '1.0.0', license: 'MIT' } });
  const r = check(root, join(tempDir(), 'does-not-exist.txt'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ENOENT/);
});
