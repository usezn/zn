'use strict';

process.env.ZN_STATS = 'off';

// The .agents folder is shared (Codex reads .agents/skills, Antigravity keeps rules and workflows there):
// only the folder itself, its hooks file, globs or ".." inside it, and changing into it are protected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const BS = String.fromCharCode(92);
const OPTS = { cwd: '/work/proj' };

const ALLOW = [
  'git add .agents/skills/x/SKILL.md',
  'git diff .agents/skills',
  'git status .agents/rules',
  'mkdir -p .agents/skills/new',
  'cp -r s .agents/skills/',
  'sed -i s/a/b/ .agents/rules/style.md',
  'node b.js src/my.agents/x.js',
  'cp a.md .agents/workflows/deploy.md',
  'ls .agents',
  'cat .agents/hooks.json',
  'grep -r foo .agents/skills',
  'cp -r a b .agents/skills/',
  'ln -s src/a src/b',
];

const DENY = [
  'rm -rf .agents',
  'rm -rf .agents/',
  'mv .agents old',
  'cp x .agents/',
  'rm .agents/*',
  'rm .agents/hooks.json',
  'echo {} > .agents/hooks.json',
  'cd .agents && rm hooks.json',
  'cd .agents/skills && rm ../hooks.json',
  'rm .agents/skills/../hooks.json',
  'sh -c "rm .agents/hooks.json"',
  'pushd .agents/rules && rm ../hooks.json',
  'ln -sf /dev/null .agents/hooks.json',
  'git checkout -- .agents/hooks.json',
  'git rm -r .agents',
  'rm ./.agents/hooks.json',
  'rm -rf /work/proj/.agents',
  'rm .agents' + BS + 'hooks.json',
  'Remove-Item .agents' + BS + 'hooks.json',
  'mv .agents/skills/../hooks.json /tmp/x',
  'rm -rf ~/.gemini/config/hooks.json',
  'sed -i s/true/false/ .gemini/config/hooks.json',
  'rm ".agents"',
  'ln -s .agents/skills ag',
  'ln -s "$PWD/.agents/rules" r',
  'cp -rs .agents/skills ag',
  'cp --symbolic-link .agents/skills ag',
  'New-Item -ItemType SymbolicLink -Path ag -Target .agents' + BS + 'skills',
  'New-Item -ItemType Junction -Path ag -Value .agents/skills',
  'mklink /D ag .agents' + BS + 'skills',
  'H=hooks.json; rm .agents/$H',
  'rm .agents/`echo hooks.json`',
  'rm .agents/${H}',
];

for (const c of ALLOW) {
  test('allowed (no agent-config mention): ' + c, () => {
    assert.equal(policy.bashDenial(c, OPTS), null);
  });
}

for (const c of DENY) {
  test('denied (touches the hook or its folder): ' + c, () => {
    assert.match(String(policy.bashDenial(c, OPTS)), /agent hook or plugin settings|protected/);
  });
}

test('a very long writing command naming .agents is refused in linear time', () => {
  for (const n of [12500, 50000]) {
    const t0 = Date.now();
    const r = policy.bashDenial('cp x ' + '.agents/'.repeat(n), OPTS);
    assert.ok(Date.now() - t0 < 200, 'took ' + (Date.now() - t0) + ' ms');
    assert.ok(r);
  }
  // long but not naming .agents: still checked quickly
  const t1 = Date.now();
  policy.bashDenial('cp x ' + 'a/'.repeat(50000), OPTS);
  assert.ok(Date.now() - t1 < 500);
});

test('denied: a glob that expands to the hooks file (the folder exists)', (t) => {
  const dir = tempDir(t, 'zn-agents-glob-');
  fs.mkdirSync(path.join(dir, '.agents'));
  fs.writeFileSync(path.join(dir, '.agents', 'hooks.json'), '{}');
  assert.match(String(policy.bashDenial('rm .ag*/hooks.json', { cwd: dir })), /protected/);
});
