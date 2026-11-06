'use strict';
/*
 * Every lib/**\/*.js file must load with require() in its own process without
 * printing anything and with exit code 0. Files that need an optional
 * dependency which is not installed are listed by name in OPTIONAL_MISSING.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const LIB = path.join(__dirname, '..', 'lib');

// File (relative to lib, with forward slashes) -> optional package it may name when missing.
const OPTIONAL_MISSING = {};

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

const files = listJs(LIB);

test('lib has files to check', () => {
  assert.ok(files.length > 10);
});

for (const file of files) {
  const rel = path.relative(LIB, file).split(path.sep).join('/');
  test('loads cleanly: ' + rel, (t) => {
    const home = tempDir(t, 'zn-load-');
    const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file], {
      cwd: home,
      encoding: 'utf8',
      input: '',
      timeout: 30000,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home },
    });
    const optional = OPTIONAL_MISSING[rel];
    if (optional) {
      const text = r.stderr + r.stdout;
      const named = text.includes("Cannot find module '" + optional + "'");
      if (r.status !== 0 || text !== '') {
        assert.ok(named, rel + ' failed for a reason other than missing ' + optional + ':\n' + text);
        return;
      }
    }
    assert.strictEqual(r.stdout, '', 'stdout of ' + rel);
    assert.strictEqual(r.stderr, '', 'stderr of ' + rel);
    assert.strictEqual(r.status, 0, 'exit code of ' + rel);
  });
}
