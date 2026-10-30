'use strict';
// Read-only checks of package.json: published paths exist, the launcher is runnable,
// and the declared Node.js floor agrees with lib/node-support.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { nodeAdvice, PATCHED_MINIMUM, EOL_BELOW } = require('../lib/node-support');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('every entry of "files" exists in the package directory', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);
  for (const entry of pkg.files) {
    assert.ok(fs.existsSync(path.join(root, entry)), 'missing files entry: ' + entry);
  }
});

test('every "bin" target exists and is a file', () => {
  const targets = Object.values(pkg.bin);
  assert.ok(targets.length > 0);
  for (const target of targets) {
    const full = path.join(root, target);
    assert.ok(fs.existsSync(full), 'missing bin target: ' + target);
    assert.ok(fs.statSync(full).isFile(), 'bin target is not a file: ' + target);
  }
});

test('every bin target starts with a node shebang line', () => {
  for (const target of new Set(Object.values(pkg.bin))) {
    const first = fs.readFileSync(path.join(root, target), 'utf8').split(/\r?\n/, 1)[0];
    assert.equal(first, '#!/usr/bin/env node', target);
  }
});

test('engines.node is a ">=MAJOR" floor that lib/node-support.js knows about', () => {
  const m = /^>=\s*(\d+)(?:\.\d+\.\d+)?$/.exec(pkg.engines.node);
  assert.ok(m, 'unexpected engines.node: ' + pkg.engines.node);
  const floor = Number(m[1]);
  // The floor must not exclude any line that node-support.js still calls patched.
  for (const major of Object.keys(PATCHED_MINIMUM)) {
    assert.ok(floor <= Number(major), 'engines.node excludes patched line ' + major);
  }
  // A Node.js at the floor still runs; below the patched lines it only gets an end-of-life warning.
  const advice = nodeAdvice(floor + '.0.0');
  if (floor < EOL_BELOW && floor % 2 === 0) {
    assert.equal(advice.level, 'eol');
    assert.equal(advice.minimum, PATCHED_MINIMUM[EOL_BELOW]);
  }
});

test('the version guard in bin/cli.js names the same floor as engines.node', () => {
  const floor = /^>=\s*(\d+)/.exec(pkg.engines.node)[1];
  const head = fs.readFileSync(path.join(root, 'bin', 'cli.js'), 'utf8').split('\n').slice(0, 12).join('\n');
  assert.ok(head.includes('Node.js ' + floor + ' or later'), 'guard text does not mention Node.js ' + floor);
});
