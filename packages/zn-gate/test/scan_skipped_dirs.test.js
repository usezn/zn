'use strict';
// `zn-gate scan` and `zn-gate audit` report the directories they do not enter,
// and read `target` and `vendor` when no build file explains them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { audit } = require('../lib/audit');
const { toJson, toText } = require('../lib/audit/report');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ENV = { ...process.env, ZN_LOCAL_ONLY: 'true' };

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-skipdirs-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

function scanJson(dir, extra) {
  const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'json', ...(extra || [])], { encoding: 'utf8', env: ENV });
  return JSON.parse(r.stdout);
}

const posix = (p) => p.split(path.sep).join('/');

test('scan lists the directories it skips by name, with a reason', () => {
  const dir = tree({
    'ok.md': 'hello\n',
    'build/prompt.md': 'hello\n',
    'dist/prompt.md': 'hello\n',
    'node_modules/pkg/readme.md': 'hello\n',
  });
  try {
    const data = scanJson(dir);
    assert.strictEqual(data.total_files, 1);
    const names = data.skipped_dirs.map((s) => path.basename(s.dir)).sort();
    assert.deepStrictEqual(names, ['build', 'dist']);
    assert.strictEqual(data.total_skipped_dirs, 2);
    assert.match(data.skipped_dirs[0].reason, /skipped by name/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan reads target and vendor without a build file, skips them with one', () => {
  const dir = tree({
    'plain/target/fixture.md': 'hello\n',
    'plain/vendor/notes.md': 'hello\n',
    'rust/Cargo.toml': '[package]\nname = "x"\n',
    'rust/target/out.md': 'hello\n',
    'go/go.mod': 'module x\n',
    'go/vendor/dep.md': 'hello\n',
  });
  try {
    const data = scanJson(dir);
    // plain/target/fixture.md, plain/vendor/notes.md and rust/Cargo.toml
    assert.strictEqual(data.total_files, 3);
    assert.strictEqual(data.skipped_dirs.length, 2);
    const rels = data.skipped_dirs.map((s) => posix(s.dir));
    assert.ok(rels.some((r) => r.endsWith('rust/target')), rels.join());
    assert.ok(rels.some((r) => r.endsWith('go/vendor')), rels.join());
    const t = data.skipped_dirs.find((s) => posix(s.dir).endsWith('rust/target'));
    assert.match(t.reason, /next to Cargo\.toml/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan always reads the directory it is given, whatever its name', () => {
  const dir = tree({ 'build/prompt.md': 'hello\n' });
  try {
    const data = scanJson(path.join(dir, 'build'));
    assert.strictEqual(data.total_files, 1);
    assert.strictEqual(data.total_skipped_dirs, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan --exclude skips quietly; text and github outputs mention the count', () => {
  const dir = tree({ 'ok.md': 'hello\n', 'mine/a.md': 'hello\n', 'dist/b.md': 'hello\n' });
  try {
    const data = scanJson(dir, ['--exclude', 'mine']);
    assert.deepStrictEqual(data.skipped_dirs.map((s) => path.basename(s.dir)), ['dist']);
    const text = spawnSync(process.execPath, [CLI, 'scan', dir], { encoding: 'utf8', env: ENV }).stdout;
    assert.match(text, /Directories not scanned \(1\):/);
    const gh = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'github'], { encoding: 'utf8', env: ENV }).stdout;
    assert.match(gh, /::notice file=[^,]*dist,title=Directory not scanned::/);
    assert.match(gh, /\(0 not scanned and 1 directory skipped\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit reports pruned directories and reads target without a build file', () => {
  const dir = tree({
    'AGENTS.md': 'Be careful.\n',
    'build/AGENTS.md': 'Be careful.\n',
    'node_modules/x/AGENTS.md': 'Be careful.\n',
    'sample/target/AGENTS.md': 'Be careful.\n',
    'rust/Cargo.toml': '[package]\n',
    'rust/target/AGENTS.md': 'Be careful.\n',
  });
  try {
    const result = audit({ root: dir, agents: ['all'], env: {} });
    const dirs = result.skippedDirs.map((d) => d.dir).sort();
    assert.deepStrictEqual(dirs, ['build', 'rust/target']);
    const json = JSON.parse(toJson(result, { toolVersion: 'x', failOn: 'high' }));
    assert.strictEqual(json.skippedDirs.length, 2);
    assert.strictEqual(json.summary.skippedDirs, 2);
    const text = toText(result, { toolVersion: 'x', failOn: 'high', displayRoot: dir, color: false });
    assert.match(text, /Directories not read \(2\):/);
    assert.match(text, /rust\/target \(skipped by name: build output next to Cargo\.toml\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
