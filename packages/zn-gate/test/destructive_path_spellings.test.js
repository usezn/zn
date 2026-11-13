'use strict';

process.env.ZN_STATS = 'off';

// A disk device or a shell startup file written with repeated slashes or "." and ".." segments names the same file,
// so it gets the same verdict as the plain spelling. The cases are shared with the Python package
// (fixtures/path_spelling_cases.json). Only the text is checked: nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { checkCommand } = require('../lib/destructive');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'path_spelling_cases.json'), 'utf8')).cases;
const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('shared path spelling cases: each command gets the expected rule', () => {
  assert.ok(CASES.length >= 20);
  for (const c of CASES) assert.equal(rule(c.cmd), c.rule, c.cmd);
});

test('each blocked spelling matches its plain spelling', () => {
  const plain = (cmd) => cmd.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/').replace(/\/[^/ ]+\/\.\.\//g, '/');
  for (const c of CASES.filter((x) => x.rule !== 'allow')) assert.equal(rule(plain(c.cmd)), c.rule, plain(c.cmd));
});
