'use strict';
// zn secret set rejects a name with spaces before it asks for a value: usage exit 64, nothing printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-secret-name-test-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (args) => {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZN_HOME: path.join(home, '.zn'),
    TMPDIR: home,
    ZN_LOCAL_ONLY: 'true',
  };
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input: '' });
};

test('secret set with a name that has spaces exits 64 and says the name is invalid', () => {
  const r = run(['secret', 'set', 'MY KEY']);
  assert.equal(r.status, 64, r.stdout + r.stderr);
  assert.match(r.stderr, /invalid name/);
  assert.equal(r.stdout, '', 'nothing is printed to stdout');
});
