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

test('scan reads test directories and skips caches and reports the editor and venv folders', () => {
  const dir = tree({
    'tests/fixture.md': 'hello\n',
    '__tests__/fixture.md': 'hello\n',
    'test/fixture.md': 'hello\n',
    '.venv/r.md': 'hello\n',
    '__pycache__/r.md': 'hello\n',
    '.eggs/r.md': 'hello\n',
    'venv/r.md': 'hello\n',
  });
  try {
    const data = scanJson(dir);
    assert.strictEqual(data.total_files, 3);
    assert.strictEqual(data.total_skipped_dirs, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan names the dependencies reason for vendor next to a manifest', () => {
  const dir = tree({ 'go/go.mod': 'module x\n', 'go/vendor/dep.md': 'hello\n' });
  try {
    const data = scanJson(dir);
    assert.strictEqual(data.skipped_dirs.length, 1);
    assert.strictEqual(data.skipped_dirs[0].reason, 'skipped by name: dependencies next to go.mod');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan text output escapes control characters in directory and file names', (t) => {
  const esc = String.fromCharCode(27);
  const bs = String.fromCharCode(92);
  const dir = tree({ ok: 'x' });
  try {
    const odd = 'x' + esc + '[2Jx';
    try {
      fs.mkdirSync(path.join(dir, odd, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, odd, 'dist', 'a.md'), 'hello\n');
    } catch (err) {
      t.skip('filesystem refuses control characters in names: ' + err.code);
      return;
    }
    const text = spawnSync(process.execPath, [CLI, 'scan', dir], { encoding: 'utf8', env: ENV }).stdout;
    assert.ok(!text.includes(esc), 'no raw ESC in the output');
    assert.ok(text.includes('x' + bs + 'x1b[2Jx'), text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan lists editor and virtual-environment directories it skips', () => {
  const dir = tree({
    'ok.md': 'hello\n',
    '.idea/agent.md': 'hello\n',
    '.venv/a.md': 'hello\n',
    'venv/a.md': 'hello\n',
    '__pycache__/a.md': 'hello\n',
    '.eggs/a.md': 'hello\n',
  });
  try {
    const data = scanJson(dir);
    assert.strictEqual(data.total_files, 1);
    assert.deepStrictEqual(data.skipped_dirs.map((s) => path.basename(s.dir)).sort(), ['.eggs', '.idea', '.venv', '__pycache__', 'venv']);
    const reasons = Object.fromEntries(data.skipped_dirs.map((s) => [path.basename(s.dir), s.reason]));
    assert.deepStrictEqual(reasons, {
      '.eggs': 'skipped by name: Python build files',
      '.idea': 'skipped by name: editor settings',
      '.venv': 'skipped by name: virtual environment',
      __pycache__: 'skipped by name: Python cache',
      venv: 'skipped by name: virtual environment',
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan text output escapes control characters in the path of a finding and in an empty target', (t) => {
  const esc = String.fromCharCode(27);
  const bs = String.fromCharCode(92);
  const fakeKey = 'AKIA' + 'ZNTESTFAKE' + '000000';
  const dir = tree({ ok: 'x' });
  try {
    const odd = 'f' + esc + '[2Jf.md';
    const emptyDir = path.join(dir, 'e' + esc + '[2Je');
    try {
      fs.writeFileSync(path.join(dir, odd), 'key = ' + fakeKey + '\n');
      fs.mkdirSync(emptyDir);
    } catch (err) {
      t.skip('filesystem refuses control characters in names: ' + err.code);
      return;
    }
    const found = spawnSync(process.execPath, [CLI, 'scan', dir], { encoding: 'utf8', env: ENV }).stdout;
    assert.ok(!found.includes(esc), 'no raw ESC in the findings output');
    assert.ok(found.includes('f' + bs + 'x1b[2Jf.md:1'), found);
    const empty = spawnSync(process.execPath, [CLI, 'scan', emptyDir], { encoding: 'utf8', env: ENV }).stdout;
    assert.ok(!empty.includes(esc), 'no raw ESC in the empty-target output');
    assert.ok(empty.includes('No files were scanned in ') && empty.includes('e' + bs + 'x1b[2Je'), empty);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
