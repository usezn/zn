// Tests of check-docs-examples-names.mjs. Run: node --test .github/scripts/check-docs-examples-names.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDir, fileProblem, folderProblem } from './check-docs-examples-names.mjs';

const script = fileURLToPath(new URL('./check-docs-examples-names.mjs', import.meta.url));

test('lowercase names with digits and hyphens pass, README.md is allowed', () => {
  assert.equal(fileProblem('first-cloud-check.md'), null);
  assert.equal(fileProblem('step2-setup.md'), null);
  assert.equal(fileProblem('README.md'), null);
});

test('upper case, underscores, spaces and other characters fail', () => {
  for (const name of ['Install.md', 'first_check.md', 'my example.md', 'a.b.md', 'café.md', 'Readme.md']) {
    assert.notEqual(fileProblem(name), null, name);
  }
});

test('names not ending in .md fail', () => {
  for (const name of ['notes.txt', 'page', 'page.md.bak', 'page.MD', '.hidden']) {
    assert.notEqual(fileProblem(name), null, name);
  }
});

test('folder names follow the same letters, digits and hyphens rule', () => {
  assert.equal(folderProblem('sub-folder2'), null);
  assert.notEqual(folderProblem('Sub'), null);
  assert.notEqual(folderProblem('sub_folder'), null);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'examplenames-'));
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), 'x\n');
  }
  return dir;
}

test('a folder of good names passes and counts its files', () => {
  const dir = tree(['README.md', 'a-b.md', 'c1.md']);
  assert.deepEqual(checkDir(dir), { checked: 3, bad: [] });
});

test('every bad file is named, in sorted order', () => {
  const dir = tree(['README.md', 'Zeta.md', 'alpha.txt', 'good.md', 'Bad_Name.md']);
  const r = checkDir(dir);
  assert.equal(r.checked, 5);
  assert.deepEqual(r.bad.map((b) => b.file), ['Bad_Name.md', 'Zeta.md', 'alpha.txt']);
});

test('files in a subfolder are checked by their path, and a bad folder is named', () => {
  const dir = tree(['sub/ok.md', 'Sub2/ok.md', 'sub/Not_Ok.md']);
  const r = checkDir(dir);
  assert.deepEqual(r.bad.map((b) => b.file), ['Sub2/', 'sub/Not_Ok.md']);
});

test('run through a symlinked path, the script still checks and fails on a bad name', () => {
  const dir = tree(['Bad.md']);
  const link = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'examplenames-link-')), 'check.mjs');
  fs.symlinkSync(script, link);
  const r = spawnSync(process.execPath, [link, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Bad name Bad\.md/);
});

test('the check does not rename or touch files', () => {
  const dir = tree(['Bad.md']);
  checkDir(dir);
  assert.deepEqual(fs.readdirSync(dir), ['Bad.md']);
});
