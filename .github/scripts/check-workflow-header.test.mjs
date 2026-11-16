// Tests of check-workflow-header.mjs. Run: node --test .github/scripts/check-workflow-header.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, findMissingKeys } from './check-workflow-header.mjs';

test('a file with both keys passes', () => {
  assert.deepEqual(findMissingKeys('name: x\non: push\npermissions:\n  contents: read\njobs: {}\n'), []);
  assert.deepEqual(findMissingKeys('name: "x"\npermissions: {}\njobs: {}\n'), []);
  assert.deepEqual(findMissingKeys('name: x\r\npermissions: read-all\r\n'), []);
});

test('missing keys are named', () => {
  assert.deepEqual(findMissingKeys('on: push\npermissions: {}\n'), ['name']);
  assert.deepEqual(findMissingKeys('name: x\non: push\n'), ['permissions']);
  assert.deepEqual(findMissingKeys('on: push\n'), ['name', 'permissions']);
});

test('indented or commented keys do not count', () => {
  const text = 'on: push\njobs:\n  a:\n    name: step\n    permissions:\n      contents: read\n# name: x\n# permissions: {}\n';
  assert.deepEqual(findMissingKeys(text), ['name', 'permissions']);
});

test('keys that only start with the same letters do not count', () => {
  assert.deepEqual(findMissingKeys('name-x: a\npermissions-x: b\n'), ['name', 'permissions']);
});

test('checkDir reads every workflow file of a folder', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wfheader-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.yml'), 'name: x\npermissions: {}\n');
    fs.writeFileSync(path.join(dir, 'bad.yaml'), 'name: x\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const r = checkDir(dir);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.problems, [{ file: 'bad.yaml', missing: ['permissions'] }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
