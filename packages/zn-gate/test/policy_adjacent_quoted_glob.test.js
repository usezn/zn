'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../lib/hooks/policy');

// An empty home and project folder, so nothing else on the disk decides a verdict.
function emptyOpts(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-adjq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cwd: dir, home: dir, env: {} };
}

// Adjacent quoted parts are one literal word: the shell never expands a quoted "*", so these name the file "*.log".
test('adjacent quoted parts of a word are one literal word', (t) => {
  const o = emptyOpts(t);
  for (const q of [`'*''.log'`, `"*"".log"`, `'*'".log"`, `"*"'.log'`, `'*''.l''og'`, `"*.log"`, `'*.log'`]) {
    for (const prog of ['perl', 'python3', 'node', 'bash', 'cat', 'frobnic']) {
      assert.strictEqual(policy.bashDenial(`${prog} ${q}`, o), null, `${prog} ${q}`);
    }
  }
  assert.strictEqual(policy.bashDenial(`xargs perl '*''.log' x`, o), null);
});

// What stays refused: a glob the shell expands (unquoted, or mixed with unquoted text) and a protected name.
test('unquoted and mixed globs keep their verdicts', (t) => {
  const o = emptyOpts(t);
  for (const cmd of [
    `perl '*'.log`, `perl '*'`, `perl "*"`, `perl '*'*`, `perl "$X"*`, `perl '.'*`, `perl '*'/.env`, `perl '*''/.env'`,
    `perl '~/''.ssh/id_fake'`, `perl .e*`, `perl *`,
  ]) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
});

test('a protected name split over quotes is still refused', (t) => {
  const o = emptyOpts(t);
  for (const cmd of [`perl '.e''nv'`, `perl ".e"'nv'`, `perl '.'"env"`, `perl '~/.ss''h/id_rsa'`]) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
});
