'use strict';
// The `exports` map of package.json is the list of import paths that stay supported. This test keeps it honest:
// every listed path loads, the paths the docs, the examples and our own CI use are all listed, the hooks and the
// plugin do not depend on the map (they start the runner by absolute file path), and the rest of lib/ is closed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const pkg = require('../package.json');

// Import paths users may rely on. Changing this list is a breaking change: say so in the changelog.
const PUBLIC = [
  '.', './package.json',
  './lib/client', './lib/client.js',
  './lib/rules', './lib/rules.js',
  './lib/evidence', './lib/evidence.js',
  './lib/guard', './lib/guard.js',
];

const spec = (key) => (key === '.' ? 'zn-gate' : 'zn-gate/' + key.slice(2));
const targetOf = (v) => (typeof v === 'string' ? v : v.default);

test('exports map lists exactly the supported paths', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), PUBLIC.slice().sort());
  for (const k of Object.keys(pkg.exports)) assert.ok(!k.includes('*'), k + ' must not be a pattern');
});

test('every exported path points at a shipped file and loads through the package name', () => {
  const shipped = (p) => p === './package.json' || pkg.files.some((f) => (f.endsWith('/') ? p.startsWith('./' + f) : p === './' + f));
  for (const [k, v] of Object.entries(pkg.exports)) {
    const target = targetOf(v);
    assert.ok(fs.existsSync(path.join(root, target)), k + ' -> ' + target + ' is missing');
    assert.ok(shipped(target), k + ' -> ' + target + ' is not in "files", so it would not be published');
    // Self-reference: this test lives inside the package, so the bare name goes through the map.
    assert.equal(require.resolve(spec(k)), path.join(root, target), k);
    const m = require(spec(k));
    assert.ok(m && (typeof m === 'object' || typeof m === 'function'), k);
    if (typeof v === 'object' && v.types) assert.ok(fs.existsSync(path.join(root, v.types)), k + ' types file is missing');
  }
});

test('the extension and the extensionless path give the same module', () => {
  for (const base of ['client', 'rules', 'evidence', 'guard']) {
    assert.strictEqual(require('zn-gate/lib/' + base), require('zn-gate/lib/' + base + '.js'));
  }
  assert.strictEqual(require('zn-gate'), require('zn-gate/lib/client'));
});

test('the rest of lib/ is closed to deep imports, but still loads by file path', () => {
  for (const internal of ['zn-gate/lib/hooks/runner', 'zn-gate/lib/vault/store.js', 'zn-gate/lib/check', 'zn-gate/bin/cli.js']) {
    assert.throws(() => require(internal), (e) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', internal);
  }
  assert.equal(typeof require('../lib/vault/store.js').generateIdentity, 'function');
});

test('hooks and the plugin start the runner by file path, so they do not need the map', () => {
  const runner = path.join(root, 'lib', 'hooks', 'runner.js');
  const cli = path.join(root, 'bin', 'cli.js');
  assert.ok(fs.existsSync(runner) && fs.existsSync(cli));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const bare = /\brequire\(\s*['"]zn-gate[/'"]|\bfrom\s+['"]zn-gate[/'"]|\bimport\(\s*['"]zn-gate[/'"]/;
  for (const dir of [path.join(root, 'lib'), path.join(root, 'bin')]) {
    for (const f of walk(dir).filter((p) => /\.[cm]?js$/.test(p))) {
      // A bare "zn-gate/..." import in shipped code would go through the map. Text that only describes such a
      // command (the hook policy that refuses `node -e` snippets) is not an import.
      const hits = fs.readFileSync(f, 'utf8').split('\n').filter((l) => bare.test(l) && !/node -e/.test(l));
      assert.deepEqual(hits, [], path.relative(root, f) + ' imports zn-gate by name');
    }
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exports-'));
  try {
    const env = { ...process.env, ZN_HOME: home };
    const r = spawnSync(process.execPath, [runner, 'claude-code'], { input: '{}', encoding: 'utf8', timeout: 20000, env });
    assert.ok(!/ERR_PACKAGE_PATH_NOT_EXPORTED/.test(r.stderr || ''), r.stderr);
    const v = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 20000, env });
    assert.equal(v.status, 0);
    assert.ok(v.stdout.startsWith('zn-gate ' + pkg.version), v.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const launcher = path.join(repo, 'plugins', 'zn-gate', 'scripts', 'zn-launch.js');
  if (fs.existsSync(launcher)) {
    assert.ok(!bare.test(fs.readFileSync(launcher, 'utf8')), 'the plugin launcher imports zn-gate by name');
  }
});

test('every zn-gate import path in docs, examples and CI is on the list', { skip: !fs.existsSync(path.join(repo, 'docs')) }, () => {
  const files = [path.join(repo, 'README.md'), path.join(root, 'README.md')];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'target', 'out'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|js|mjs|cjs|ts|yml)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['docs', 'examples', '.github', 'plugins', 'bench']) {
    if (fs.existsSync(path.join(repo, d))) walk(path.join(repo, d));
  }
  const self = path.relative(repo, __filename);
  const re = /(?:require\(\s*|from\s+|import\(\s*)['"](zn-gate(?:\/[A-Za-z0-9_./-]+)?)['"]|`(zn-gate\/lib\/[A-Za-z0-9_./-]+)`/g;
  const seen = new Map();
  for (const f of files) {
    if (path.relative(repo, f) === self) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
      const s = (m[1] || m[2]).replace(/\/+$/, '');
      if (!seen.has(s)) seen.set(s, path.relative(repo, f));
    }
  }
  const allowed = new Set(PUBLIC.map(spec));
  const bad = [...seen].filter(([s]) => !allowed.has(s)).map(([s, f]) => s + ' (' + f + ')');
  assert.deepEqual(bad, [], 'import paths that the exports map would block');
});
