'use strict';

// Everyday Python project commands (run the tests, create a virtualenv, freeze and install
// requirements) must stay allowed by the Bash hook policy and by the destructive-command check.
// The project is a fake one in a temporary folder; no network, no keys.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');
const { tempDir } = require('./helpers/tmp');

const COMMANDS = [
  'pytest',
  'pytest -q tests',
  'python -m venv .venv',
  'python3 -m venv .venv',
  'pip freeze',
  'pip freeze > requirements.txt',
  'pip install -r requirements.txt',
];

function project(t) {
  const dir = tempDir(t, 'zn-python-everyday-');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.31.0\n');
  return { cwd: dir, home: dir, env: {} };
}

for (const cmd of COMMANDS) {
  test('everyday Python command is allowed by the hook policy and the destructive check: ' + cmd, (t) => {
    const o = project(t);
    assert.equal(policy.bashDenial(cmd, o), null, 'hook policy denied: ' + cmd);
    assert.equal(checkCommand(cmd).verdict, 'allow', 'destructive check flagged: ' + cmd);
  });
}
