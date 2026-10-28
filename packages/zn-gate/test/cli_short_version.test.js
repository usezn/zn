'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const { version } = require('../package.json');

test('-v, -V and --version all print the version', () => {
  for (const flag of ['-v', '-V', '--version']) {
    const r = spawnSync(process.execPath, [CLI, flag], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, flag);
    assert.ok(r.stdout.startsWith('zn-gate ' + version + ' '), flag);
  }
});
