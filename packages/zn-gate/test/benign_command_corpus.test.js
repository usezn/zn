'use strict';

// Everyday developer shell commands (git, npm, pip, cargo, docker, make, file tools, curl to example.com, ssh to example
// hosts, kubectl get ...) must stay allowed by the Bash hook policy and by the destructive-command check. The corpus is
// fictional and harmless: example.com and example.org hosts, ./src style paths, no credentials. The rm -rf lines are
// the realistic cleanup commands (node_modules, ./dist, ./coverage), not root or home targets.
// The threshold is the measured allow rate rounded down; a rise in false positives fails the test.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');
const { tempDir } = require('./helpers/tmp');

const CORPUS = path.join(__dirname, 'fixtures', 'benign-commands.txt');
const MIN_ALLOW_RATE = 0.99;

const commands = fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim() !== '');

function project(t) {
  const dir = tempDir(t, 'zn-benign-corpus-');
  for (const d of ['src', 'data', 'config', 'build', 'notes', 'docs', 'tmp', 'old', 'new', 'downloads', 'vendor', 'out',
    'node_modules', 'dist', 'coverage', 'public', 'logs', 'scripts', 'test', 'cmd', 'assets', 'tests']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"my-app","version":"1.0.0"}\n');
  return { cwd: dir, home: dir, env: {} };
}

test('the corpus has 200 distinct everyday commands, one per line', () => {
  assert.equal(commands.length, 200);
  assert.equal(new Set(commands).size, commands.length, 'duplicate lines in the corpus');
});

test('the benign corpus is allowed at or above the measured rate', (t) => {
  const o = project(t);
  const flagged = [];
  let allowed = 0;
  for (const cmd of commands) {
    const hook = policy.bashDenial(cmd, o);
    const destructive = checkCommand(cmd);
    if (!hook && destructive.verdict === 'allow') {
      allowed += 1;
      continue;
    }
    flagged.push({ cmd, hook: hook ? String(hook).slice(0, 120) : null, destructive: destructive.rule });
  }
  const rate = allowed / commands.length;
  assert.ok(rate >= MIN_ALLOW_RATE,
    `allow rate ${rate} is below ${MIN_ALLOW_RATE}: ${JSON.stringify(flagged, null, 1)}`);
});

test('benign-commands.expected.json matches the current Node decisions (run test/fixtures/make_benign_expected.js)', () => {
  const { render, OUT } = require('./fixtures/make_benign_expected');
  assert.equal(fs.readFileSync(OUT, 'utf8'), render(),
    'benign-commands.expected.json is stale: run `node test/fixtures/make_benign_expected.js` and commit it');
});
