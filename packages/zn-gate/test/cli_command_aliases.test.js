'use strict';
// Command aliases: `doctor` behaves like `check`, `logs` like `evidence`, and
// `export` like `evidence --export`. Each run uses a temporary HOME, so the
// real machine is never read or changed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true' };
  delete env.NO_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input: '', timeout: 60000 });
}

function firstLine(text) {
  return text.split('\n').find((l) => l.trim() !== '') || '';
}

function sameBehaviour(aliasArgs, mainArgs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-alias-'));
  try {
    const main = run(mainArgs, home);
    const alias = run(aliasArgs, home);
    assert.strictEqual(main.error, undefined);
    assert.strictEqual(alias.status, main.status, 'exit codes differ');
    assert.strictEqual(firstLine(alias.stdout), firstLine(main.stdout));
    return { main, alias };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('doctor gives the same exit code and first line as check', () => {
  const { alias } = sameBehaviour(['doctor'], ['check']);
  assert.match(firstLine(alias.stdout), /zn-gate check/);
});

test('logs gives the same exit code and first line as evidence', () => {
  const { alias } = sameBehaviour(['logs'], ['evidence']);
  assert.match(firstLine(alias.stdout), /Evidence Ledger Stats/);
  assert.strictEqual(alias.status, 0);
});

test('export gives the same exit code and output as evidence --export', () => {
  const { alias, main } = sameBehaviour(['export'], ['evidence', '--export']);
  assert.strictEqual(alias.status, 0);
  assert.strictEqual(alias.stdout, main.stdout);
});
