'use strict';

// Every way of spelling a path in a shell command, around every way of reading it: a .env file with values is
// refused in all of them, and an ordinary file spelled the same way is allowed in all of them.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const SPELLINGS = [
  (p) => p,
  (p) => "'" + p + "'",
  (p) => '"' + p + '"',
  (p) => './' + p,
  (p) => "$'" + p + "'",
  (p) => p.replace(/\.env$/, ".e''nv").replace(/notes\.txt$/, "no''tes.txt"),
];

const READS = [
  (w) => 'cat ' + w,
  (w) => 'head -n 1 ' + w,
  (w) => 'cat <' + w,
  (w) => 'cat 0<' + w,
  (w) => 'true && cat ' + w,
  (w) => '{ cat ' + w + '; }',
  (w) => '(cat ' + w + ')',
  (w) => 'cat ' + w + ' | head',
  (w) => 'cd . && cat ' + w,
  (w) => 'dd if=' + w,
  (w) => 'grep KEY ' + w,
  (w) => 'cat ' + w + ' 2>/dev/null',
];

function project(t) {
  const dir = tempDir(t, 'zn-forms-');
  fs.mkdirSync(path.join(dir, 'app1', 'inner'), { recursive: true });
  for (const d of ['', path.join('app1', 'inner')]) {
    fs.writeFileSync(path.join(dir, d, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
    fs.writeFileSync(path.join(dir, d, 'notes.txt'), 'hello\n');
  }
  return { cwd: dir, home: dir, env: {} };
}

test('a .env file with values is refused however the path is spelled and read', (t) => {
  const o = project(t);
  const missed = [];
  for (const p of ['.env', 'app1/inner/.env']) {
    for (const spell of SPELLINGS) {
      for (const read of READS) {
        const cmd = read(spell(p));
        if (!policy.bashDenial(cmd, o)) missed.push(cmd);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('an ordinary file spelled and read the same ways is allowed', (t) => {
  const o = project(t);
  const refused = [];
  for (const p of ['notes.txt', 'app1/inner/notes.txt']) {
    for (const spell of SPELLINGS) {
      for (const read of READS) {
        const cmd = read(spell(p));
        if (policy.bashDenial(cmd, o)) refused.push(cmd);
      }
    }
  }
  assert.deepEqual(refused, []);
});

test('decoding $-quoting stays linear on long input', () => {
  for (const body of ['\\'.repeat(100000), '\\x'.repeat(50000), "\\'".repeat(50000)]) {
    const t0 = process.hrtime.bigint();
    policy._decodeAnsiC("cat $'" + body + "'");
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500, 'too slow');
  }
});
