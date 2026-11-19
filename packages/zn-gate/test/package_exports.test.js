'use strict';
// The "exports" map of package.json: the documented entry points load from a packed tarball,
// and internal files do not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const SUPPORTED = [
  'zn-gate',
  'zn-gate/lib/client', 'zn-gate/lib/client.js',
  'zn-gate/lib/rules', 'zn-gate/lib/rules.js',
  'zn-gate/lib/evidence', 'zn-gate/lib/evidence.js',
  'zn-gate/lib/guard', 'zn-gate/lib/guard.js',
  'zn-gate/package.json',
];
const INTERNAL = [
  'zn-gate/lib/hooks/policy.js', 'zn-gate/lib/hooks/runner.js', 'zn-gate/lib/cloud-key.js',
  'zn-gate/lib/vault/client', 'zn-gate/lib/client-pool', 'zn-gate/lib/scrub/patterns.js',
  'zn-gate/bin/cli.js',
];

test('the exports map lists exactly the documented entry points', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), [
    '.', './lib/client', './lib/client.js', './lib/evidence', './lib/evidence.js',
    './lib/guard', './lib/guard.js', './lib/rules', './lib/rules.js', './package.json',
  ]);
  assert.equal(pkg.main, 'lib/client.js');
  for (const [key, v] of Object.entries(pkg.exports)) {
    for (const target of typeof v === 'string' ? [v] : Object.values(v)) {
      assert.ok(fs.existsSync(path.join(root, target)), key + ' -> missing ' + target);
    }
  }
});

test('from a packed tarball: documented paths load, internal paths are refused', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exports-'));
  try {
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', tmp], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(pack.status, 0, pack.stderr);
    const tgz = path.join(tmp, pack.stdout.trim().split(/\r?\n/).pop());
    const proj = path.join(tmp, 'proj');
    const dest = path.join(proj, 'node_modules', 'zn-gate');
    fs.mkdirSync(dest, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const script = path.join(proj, 'probe.js');
    fs.writeFileSync(script, [
      "const out = {};",
      "for (const s of JSON.parse(process.argv[2])) { try { require(s); out[s] = 'ok'; } catch (e) { out[s] = e.code || e.message; } }",
      "console.log(JSON.stringify(out));",
    ].join('\n'));
    const run = spawnSync(process.execPath, [script, JSON.stringify(SUPPORTED.concat(INTERNAL))], { cwd: proj, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const got = JSON.parse(run.stdout);
    for (const s of SUPPORTED) assert.equal(got[s], 'ok', s);
    for (const s of INTERNAL) assert.equal(got[s], 'ERR_PACKAGE_PATH_NOT_EXPORTED', s);
    // ESM import of a documented path (as the examples do) also works.
    const esm = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import r from 'zn-gate/lib/rules.js'; import c from 'zn-gate'; if (typeof r.evaluate !== 'function' || typeof c.analyze !== 'function') process.exit(3);"], { cwd: proj, encoding: 'utf8' });
    assert.equal(esm.status, 0, esm.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
