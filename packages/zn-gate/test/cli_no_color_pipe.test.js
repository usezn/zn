'use strict';
// bin/cli.js help, version and status output: no ANSI escape codes when NO_COLOR
// is set, when it is unset, and when stdout is a pipe. The home directory is a
// temporary directory so the status output does not depend on the machine.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ESC = /\u001b/;

const COMMANDS = {
  help: ['--help'],
  'help (no arguments)': [],
  version: ['--version'],
  status: ['status'],
};

// NO_COLOR: undefined means the variable is removed from the environment.
const MODES = {
  'NO_COLOR set': '1',
  'NO_COLOR unset': undefined,
  'NO_COLOR empty': '',
};

function run(home, args, noColor, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true', ...extra };
  delete env.NO_COLOR;
  delete env.ZN_API_KEY;
  if (noColor !== undefined) env.NO_COLOR = noColor;
  // spawnSync captures stdout through a pipe, so it is never a terminal.
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-nocolor-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

for (const [cmdName, args] of Object.entries(COMMANDS)) {
  for (const [modeName, value] of Object.entries(MODES)) {
    test(`${cmdName}, ${modeName}, piped: no ANSI escape codes`, () => {
      const r = run(home, args, value);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.length > 0, 'no output');
      assert.doesNotMatch(r.stdout, ESC);
      assert.doesNotMatch(r.stderr, ESC);
    });
  }
}

test('TERM=xterm-256color and a pipe: still no ANSI escape codes in help, version and status', () => {
  for (const args of Object.values(COMMANDS)) {
    const r = run(home, args, undefined, { TERM: 'xterm-256color' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, ESC);
  }
});

test('output keeps its content with NO_COLOR set', () => {
  const { version } = require('../package.json');
  assert.match(run(home, ['--help'], '1').stdout, /USAGE:/);
  assert.ok(run(home, ['--version'], '1').stdout.startsWith('zn-gate ' + version + ' '));
  const status = run(home, ['status'], '1').stdout;
  assert.match(status, /zn-gate Status:/);
  assert.match(status, /Package Version : /);
  assert.doesNotMatch(status, /🛡/u, 'the symbol is dropped when NO_COLOR is set');
});
