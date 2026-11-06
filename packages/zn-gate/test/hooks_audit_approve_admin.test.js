'use strict';

// `zn audit --approve` records what the person accepts of a project; an agent that rewrote the configuration must not be able to run it.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

test('an agent may not run zn audit --approve, in any spelling', () => {
  for (const c of ['zn audit --approve', 'npx -y zn-gate audit --approve', 'npx -y zn-gate audit . --approve', 'zn-gate audit --approve --format json', 'zn-gate audit ./some/dir --format json --approve',
    'node node_modules/zn-gate/bin/cli.js audit --approve', 'zn-gate.cmd audit --approve', 'cd app && zn audit --approve', 'echo ok; zn audit --approve', '"zn" audit --approve',
    'zn-gate@1.14.1 audit --approve']) {
    assert.match(policy.bashDenial(c) || '', /zn audit --approve/, c);
  }
});

test('zn audit itself, and other uses of the word approve, are allowed', () => {
  for (const c of ['zn audit', 'zn audit --format json', 'npx -y zn-gate audit ./some-repo', 'zn audit --fail-on high', 'echo audit --approve', 'git commit -m "audit --approve"',
    'npm audit', 'npm audit --approve-all', 'zn-gate audit . --output report.sarif']) {
    assert.equal(policy.bashDenial(c), null, c);
  }
});

test('a quoted, split or escaped --approve is the same command', () => {
  for (const c of ['zn audit "--approve"', "zn audit '--approve'", 'npx zn-gate audit "--approve"', "zn audit --appr''ove", 'zn audit --appr""ove', 'zn audit --appr\\ove', "zn audit $'--approve'",
    'zn audit --"approve"', 'zn "audit" --approve', 'zn a\\udit --approve', 'z\\n audit --approve', 'zn audit \\\n--approve', 'echo --approve | xargs zn audit', 'echo --approve | xargs -n1 npx zn-gate audit',
    'zn-gate pins appr\'\'ove --all', 'zn secret "reveal" X', 'zn "secret" reveal X']) {
    assert.match(policy.bashDenial(c) || '', /zn blocked this/, c);
  }
});

test('the dequoted reading does not make ordinary commands admin commands', () => {
  for (const c of ['zn audit "./some dir"', "zn audit 'x'", 'zn audit --format "json"', 'echo "audit --approve"', 'echo zn audit', 'xargs echo audit', 'xargs -n1 grep audit', 'printf "%s" zn',
    'git commit -m "zn audit"', 'npm run "audit"']) {
    assert.equal(policy.bashDenial(c), null, c);
  }
});
