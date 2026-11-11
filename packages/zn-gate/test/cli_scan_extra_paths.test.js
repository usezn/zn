'use strict';
// scan takes one path. A second path is refused with exit 2 and named, instead of being ignored: the old code read
// only the first path and reported as if everything was checked. Options and their values are not paths, and a path
// after a bare "--" may start with "-".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' },
  });
}

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-extra-'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'Release notes for the example project.\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'console.log("example");\n');
  fs.writeFileSync(path.join(dir, 'c.md'), 'Second example note.\n');
  fs.writeFileSync(path.join(dir, '-weird-name.md'), 'A note in a file whose name starts with a dash.\n');
  return dir;
}

test('scan with two paths exits 2 and names the extra path', () => {
  const dir = folder();
  try {
    const r = run(['scan', 'a.md', 'b.js'], dir);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /zn-gate scan: takes one path; got extra: b\.js\. Scan a folder, or run scan once per file\./);
    assert.strictEqual(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan with options and two paths names every extra path', () => {
  const dir = folder();
  try {
    const r = run(['scan', '--format', 'json', 'a.md', 'b.js', '--allow-partial', 'c.md'], dir);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /got extra: b\.js, c\.md\./);
    assert.strictEqual(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan with one path and options reads only that path, as before', () => {
  const dir = folder();
  try {
    for (const args of [
      ['scan', 'a.md', '--format', 'json'],
      ['scan', '--format', 'json', 'a.md'],
      ['scan', 'a.md', '--format', 'json', '--allow-partial'],
    ]) {
      const r = run(args, dir);
      assert.strictEqual(r.status, 0, args.join(' ') + '\n' + r.stdout + r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).total_files, 1, args.join(' '));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan -- takes a path that starts with a dash', () => {
  const dir = folder();
  try {
    const r = run(['scan', '--', '-weird-name.md', '--format', 'json'], dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).total_files, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan -- with a dash path and a second path exits 2 and names the second path', () => {
  const dir = folder();
  try {
    const r = run(['scan', '--', '-weird-name.md', 'b.js'], dir);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /got extra: b\.js\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
