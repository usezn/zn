// Tests of check-docs-command-names.mjs. Run: node --test .github/scripts/check-docs-command-names.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFiles, commandName, usedNames } from './check-docs-command-names.mjs';

const script = fileURLToPath(new URL('./check-docs-command-names.mjs', import.meta.url));

test('a command is a span whose first word is zn or zn-gate and that has a subcommand or flag', () => {
  assert.equal(commandName('zn-gate check'), 'zn-gate');
  assert.equal(commandName('zn hooks --help'), 'zn');
  assert.equal(commandName('zn --version'), 'zn');
  assert.equal(commandName('zn-gate'), null, 'one word names no command');
  assert.equal(commandName('npx zn-gate check'), null, 'only the first word counts');
  assert.equal(commandName('zn.ps1'), null);
  assert.equal(commandName('zn-gate-py check'), null);
});

test('a page that uses one name is not mixed', () => {
  const text = 'Run `zn-gate check` first, then `zn-gate scan` and `zn-gate status`.\n';
  assert.deepEqual(Object.keys(usedNames(text)), ['zn-gate']);
  assert.equal(usedNames(text)['zn-gate'].count, 3);
});

test('a page that uses both names records the first line of each', () => {
  const used = usedNames('Intro.\n\nRun `zn-gate check`.\n\nThen `zn hooks` again.\n');
  assert.deepEqual(used, { 'zn-gate': { count: 1, line: 3 }, zn: { count: 1, line: 5 } });
});

test('code blocks are skipped, both fenced and tilde fenced', () => {
  assert.deepEqual(usedNames('```sh\nzn-gate check\nzn hooks\n```\nOnly `zn-gate check` here.\n'), {
    'zn-gate': { count: 1, line: 5 },
  });
  assert.deepEqual(usedNames('~~~\n`zn hooks`\n~~~\n'), {});
});

test('a name in prose, outside code, is not a command', () => {
  assert.deepEqual(usedNames('zn hooks and zn-gate check are words here, not code.\n'), {});
});

test('a byte order mark at the start does not hide the first line', () => {
  assert.deepEqual(usedNames('﻿`zn hooks`\n'), { zn: { count: 1, line: 1 } });
});

test('checkFiles lists only the pages that use both names', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cmdnames-'));
  try {
    fs.writeFileSync(path.join(dir, 'one.md'), 'Use `zn-gate check`.\n');
    fs.writeFileSync(path.join(dir, 'two.md'), 'Use `zn-gate check` or `zn check`.\n');
    const r = checkFiles([path.join(dir, 'one.md'), path.join(dir, 'two.md')]);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.mixed.map((m) => path.basename(m.file)), ['two.md']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the script warns and exits 0 by default, and fails with --strict', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cmdnames-cli-'));
  try {
    const bad = path.join(dir, 'bad.md');
    fs.writeFileSync(bad, 'Use `zn-gate check` and `zn hooks`.\n');
    const warn = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' });
    assert.equal(warn.status, 0);
    assert.match(warn.stdout, /bad\.md: uses zn \(1 use\(s\), first at line 1\) and zn-gate \(1 use\(s\), first at line 1\)/);
    assert.match(warn.stdout, /warning: 1 of 1 page\(s\)/);
    const strict = spawnSync(process.execPath, [script, '--strict', bad], { encoding: 'utf8' });
    assert.equal(strict.status, 1);
    const good = path.join(dir, 'good.md');
    fs.writeFileSync(good, 'Use `zn-gate check`.\n');
    assert.equal(spawnSync(process.execPath, [script, '--strict', good], { encoding: 'utf8' }).status, 0);
    assert.match(execFileSync(process.execPath, [script, good], { encoding: 'utf8' }), /docs command names OK: 1 file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
