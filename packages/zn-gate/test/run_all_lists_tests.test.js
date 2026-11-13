'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = __dirname;
const root = path.resolve(testDir, '..');
const TEST_NAME = /(\.test\.[cm]?js|_test\.js)$/;

function walk(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function listed() {
  const r = spawnSync(process.execPath, [path.join(testDir, 'run-all.js'), '--list'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

test('--list prints every test-looking file under test/', () => {
  const lines = new Set(listed());
  const missing = walk(testDir, '')
    .filter((f) => TEST_NAME.test(f))
    .filter((f) => !lines.has('test/' + f));
  assert.deepStrictEqual(missing, []);
});

test('--list prints the explicit integration step and the cli step', () => {
  const lines = listed();
  assert.ok(lines.includes('test/integration/test_agent_workflows.js'));
  assert.ok(lines.includes('bin/cli.js test'));
});

test('--list prints no file twice', () => {
  const lines = listed();
  assert.strictEqual(new Set(lines).size, lines.length);
});

test('every name in runner-plain.json exists and is printed', () => {
  const plain = JSON.parse(fs.readFileSync(path.join(testDir, 'runner-plain.json'), 'utf8'));
  const lines = new Set(listed());
  for (const f of plain) {
    assert.ok(fs.existsSync(path.join(testDir, f)), f + ' is missing');
    assert.ok(lines.has('test/' + f), f + ' is not listed');
  }
});
