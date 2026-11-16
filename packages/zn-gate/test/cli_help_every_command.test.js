'use strict';
// Every command that has a section in docs/cli.md answers --help with exit
// code 0, some text on stdout and nothing on stderr. This pins the behaviour
// as it is today. It runs with an empty temporary home and no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const DOC = path.join(__dirname, '..', '..', '..', 'docs', 'cli.md');

// Headings like "### `scan`" or "#### `secret set`" give the command words.
function documentedCommands() {
  const out = [];
  for (const line of fs.readFileSync(DOC, 'utf8').split(/\r?\n/)) {
    const m = /^#{3,4} `([a-z][a-z -]*)`\s*$/.exec(line);
    if (m) out.push(m[1].trim().split(/\s+/));
  }
  return out;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-help-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function help(words) {
  return spawnSync(process.execPath, [CLI, ...words, '--help'], {
    encoding: 'utf8',
    input: '',
    timeout: 20000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true' },
  });
}

test('docs/cli.md lists commands to check', () => {
  const cmds = documentedCommands();
  assert.ok(cmds.length > 30, 'found ' + cmds.length);
  for (const known of ['init', 'scan', 'vault', 'team']) {
    assert.ok(cmds.some((c) => c.join(' ') === known), known);
  }
});

// Known gap, pinned as it is today: "vault log export --help" prints its usage
// on stderr and exits 2 instead of answering like the other commands.
const HELP_ON_STDERR = new Set(['vault log export']);

test('vault log export --help prints usage on stderr and exits 2', () => {
  const r = help(['vault', 'log', 'export']);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /^usage: zn vault log export/);
});

for (const words of documentedCommands()) {
  if (HELP_ON_STDERR.has(words.join(' '))) continue;
  test(`${words.join(' ')} --help exits 0 with text on stdout and nothing on stderr`, () => {
    const r = help(words);
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.status, 0, 'exit code; stderr: ' + r.stderr);
    assert.ok(r.stdout.trim().length > 0, 'stdout is empty');
    assert.strictEqual(r.stderr, '');
  });
}
