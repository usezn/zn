'use strict';

// Everyday yarn and pnpm commands (install, test, a package script, adding a dev dependency) must stay allowed by the
// Bash hook policy and by the destructive-command check. The commands are fictional and harmless: no registry, no
// credentials, no network host.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');
const { tempDir } = require('./helpers/tmp');

const COMMANDS = [
  'yarn install',
  'yarn test',
  'pnpm install',
  'pnpm test',
  'pnpm run build',
  'yarn add -D vitest',
];

function project(t) {
  const dir = tempDir(t, 'zn-yarn-pnpm-');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"my-app","version":"1.0.0"}\n');
  return { cwd: dir, home: dir, env: {} };
}

test('yarn and pnpm install, test, build and add commands are allowed by the policy', (t) => {
  const o = project(t);
  for (const cmd of COMMANDS) {
    const hook = policy.bashDenial(cmd, o);
    assert.ok(!hook, `policy denied "${cmd}": ${String(hook).slice(0, 120)}`);
  }
});

test('yarn and pnpm install, test, build and add commands are allowed by the destructive-command check', () => {
  for (const cmd of COMMANDS) {
    const destructive = checkCommand(cmd);
    assert.equal(destructive.verdict, 'allow', `destructive check flagged "${cmd}": ${destructive.rule}`);
  }
});
