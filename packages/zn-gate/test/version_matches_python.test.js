'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('npm package and Python package declare the same version string', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'zn-gate', 'package.json'), 'utf8'));
  const toml = fs.readFileSync(path.join(root, 'zn-gate-py', 'pyproject.toml'), 'utf8');
  const project = toml.split(/^\[project\]\s*$/m)[1] || '';
  const body = project.split(/^\[/m)[0];
  const m = /^version\s*=\s*"([^"]+)"\s*$/m.exec(body);
  assert.ok(m, 'pyproject.toml has a version in [project]');
  assert.equal(typeof pkg.version, 'string');
  assert.equal(m[1], pkg.version);
});
