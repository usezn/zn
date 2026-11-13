'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

// npm and PyPI spell a pre-release differently: 1.16.0-rc.1 on npm is 1.16.0rc1 on PyPI (PEP 440), and alpha and beta
// become a and b. A final X.Y.Z is the same string on both.
function pep440(npmVersion) {
  const m = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/.exec(npmVersion);
  if (!m) return null;
  return m[2] ? m[1] + { alpha: 'a', beta: 'b', rc: 'rc' }[m[2]] + m[3] : m[1];
}

test('pep440: final and pre-release forms', () => {
  assert.equal(pep440('1.16.0'), '1.16.0');
  assert.equal(pep440('1.16.0-rc.1'), '1.16.0rc1');
  assert.equal(pep440('2.0.0-alpha.3'), '2.0.0a3');
  assert.equal(pep440('2.0.0-beta.12'), '2.0.0b12');
  assert.equal(pep440('1.16.0-rc.0'), null);
  assert.equal(pep440('1.16.0-dev.1'), null);
  assert.equal(pep440('1.16'), null);
});

test('npm package and Python package declare the same version string', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'zn-gate', 'package.json'), 'utf8'));
  const toml = fs.readFileSync(path.join(root, 'zn-gate-py', 'pyproject.toml'), 'utf8');
  const project = toml.split(/^\[project\]\s*$/m)[1] || '';
  const body = project.split(/^\[/m)[0];
  const m = /^version\s*=\s*"([^"]+)"\s*$/m.exec(body);
  assert.ok(m, 'pyproject.toml has a version in [project]');
  assert.equal(typeof pkg.version, 'string');
  assert.ok(pep440(pkg.version), 'package.json version is X.Y.Z or X.Y.Z-(alpha|beta|rc).N: ' + pkg.version);
  assert.equal(m[1], pep440(pkg.version));
});
