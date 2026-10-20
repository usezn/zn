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

// Scaling check instead of a wall-clock limit: a busy CI host can make any absolute bound flaky, but a
// quadratic blowup still multiplies the time by about 16 when the input grows 4x (linear: about 4).
function fastest(fn, runs) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

function scalingRatio(run, small, large) {
  run(small); // warm up
  run(large);
  const tSmall = fastest(() => run(small), 5);
  const tLarge = fastest(() => run(large), 5);
  // The floor keeps a sub-millisecond base from turning timer noise into a huge ratio.
  return tLarge / Math.max(tSmall, 2);
}

// The floor above can hide a quadratic scan whose small input runs in under 2 ms, so the large size is also
// compared with twice its size (both under the 100 KB cap): linear gives about 2x, quadratic about 4x.
// Skipped when the base is under 1 ms, where timer noise dominates the ratio.
function doublingRatio(run, n) {
  run(n); // warm up
  run(2 * n);
  const tN = fastest(() => run(n), 5);
  const t2N = fastest(() => run(2 * n), 5);
  return tN < 1 ? null : t2N / tN;
}

test('a very long writing command naming .agents is refused in linear time', () => {
  const run = (n) => {
    const r = policy.bashDenial('cp x ' + '.agents/'.repeat(n), OPTS);
    assert.ok(r);
  };
  const ratio = scalingRatio(run, 3000, 12000);
  assert.ok(ratio < 10, 'time grew ' + ratio.toFixed(1) + 'x for 4x the input (quadratic would be about 16x)');
  const doubled = doublingRatio(run, 6000);
  if (doubled !== null) assert.ok(doubled < 3, 'time grew ' + doubled.toFixed(1) + 'x for 2x the input (quadratic would be about 4x)');
  // long but not naming .agents: still checked in linear time (both sizes stay under the 100 KB cap, above it the command is refused unscanned)
  const runPlain = (n) => policy.bashDenial('cp x ' + 'a/'.repeat(n), OPTS);
  const plainRatio = scalingRatio(runPlain, 12500, 50000);
  assert.ok(plainRatio < 10, 'time grew ' + plainRatio.toFixed(1) + 'x for 4x the input (quadratic would be about 16x)');
  const plainDoubled = doublingRatio(runPlain, 25000);
  if (plainDoubled !== null) assert.ok(plainDoubled < 3, 'time grew ' + plainDoubled.toFixed(1) + 'x for 2x the input (quadratic would be about 4x)');
});

test('denied: a glob that expands to the hooks file (the folder exists)', (t) => {
  const dir = tempDir(t, 'zn-agents-glob-');
  fs.mkdirSync(path.join(dir, '.agents'));
  fs.writeFileSync(path.join(dir, '.agents', 'hooks.json'), '{}');
  assert.match(String(policy.bashDenial('rm .ag*/hooks.json', { cwd: dir })), /protected/);
});

// A link that is already on disk: ".." is applied to where the link leads, not to the text before it.
function projectWithLink(t) {
  const dir = tempDir(t, 'zn-agents-link-');
  fs.mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'hooks.json'), '{}');
  fs.symlinkSync(path.join('.agents', 'skills'), path.join(dir, 'ag'));
  return dir;
}

test('denied with a link on disk: .. through the link reaches the hooks file', (t) => {
  const dir = projectWithLink(t);
  for (const c of ['rm ag/../hooks.json', 'echo {} > ag/../hooks.json', 'cd ag && rm ../hooks.json', 'cd -P ag/.. && rm hooks.json', 'cd ag; sed -i s/a/b/ ../hooks.json']) {
    assert.match(String(policy.bashDenial(c, { cwd: dir })), /protected/, c);
  }
  assert.ok(policy.writeDenial(dir + '/ag/../hooks.json', { cwd: dir }));
  assert.ok(policy.classifyPath(dir + '/ag/../hooks.json', { cwd: dir }));
});

test('allowed with a link on disk: reading, and a plain use of the link', (t) => {
  const dir = projectWithLink(t);
  assert.equal(policy.bashDenial('cat ag/../hooks.json', { cwd: dir }), null);
  assert.equal(policy.bashDenial('git status ag', { cwd: dir }), null);
  assert.equal(policy.bashDenial('cd ag', { cwd: dir }), null);
});

test('denied in one command: a link made and used together (no link on disk yet)', () => {
  for (const c of [
    'env ln -s .agents/skills ag2 && rm ag2/../hooks.json',
    'ln -s .agents/skills ag2 && rm ag2/../hooks.json',
    'sudo ln -s .agents/skills ag2',
    '/bin/ln -s .agents/skills ag2',
    'command ln -s .agents/skills ag2',
    'exec ln -s .agents/skills ag2',
    'nohup ln -s .agents/skills ag2',
    'time ln -s .agents/skills ag2',
    'busybox ln -s .agents/skills ag2',
    'env -i FOO=1 ln -s .agents/skills ag2',
    'echo x | xargs ln -s .agents/skills ag2',
    "cp '-s' .agents/skills ag2",
    'cp "-r" "-s" .agents/skills ag2',
    'cp -r a b -s .agents/skills',
    'gcp -s .agents/skills ag2',
    'env New-Item -ItemType SymbolicLink -Path ag2 -Target .agents/skills',
    'touch x && rm ag2/../hooks.json; echo .agents',
  ]) {
    assert.match(String(policy.bashDenial(c, OPTS)), /protected/, c);
  }
});

test('allowed: link options are read only from their own command', () => {
  for (const c of [
    'curl -s https://example.com/x -o y && cp y .agents/skills/y',
    'ln -s ../shared/x src/x && cp a .agents/skills/a',
    'cp ../shared/s.md .agents/skills/',
    'git add .agents/skills/x && cp ../a b',
    'tar -s x f && mkdir -p .agents/skills/new',
  ]) {
    assert.equal(policy.bashDenial(c, OPTS), null, c);
  }
});

test('documented limit: a link made by interpreter code is not seen; the link on disk is followed instead', () => {
  assert.equal(policy.bashDenial("python3 -c \"import os; os.symlink('x', 'y')\"", OPTS), null);
});

test('denied: hard links and the folder written as .agents/.', () => {
  for (const c of [
    'cp -al .agents/. bk && echo {} > bk/hooks.json',
    'cp -l .agents/hooks.json bk',
    'cp -la .agents bk',
    'cp -rl .agents/skills bk',
    'cp --link .agents/skills bk',
    'mklink /H bk .agents' + BS + 'hooks.json',
    'rm -rf .agents/.',
    'rm -rf .agents/./',
    'mv .agents/. old',
    'cp x .agents/./hooks.json',
    'D=.age; ln -s ${D}nts/skills ag2 && rm ag2/../hooks.json',
    'ln -s .age*/skills ag2 && rm ag2/../hooks.json',
  ]) {
    assert.match(String(policy.bashDenial(c, OPTS)), /protected/, c);
  }
});

test('allowed: copying with -a and a dot source, and other dot segments', () => {
  for (const c of ['cp -a src/. dst', 'cp -r src/./a dst', 'git add .agents/skills/./x.md', 'ls -l .agents']) {
    assert.equal(policy.bashDenial(c, OPTS), null, c);
  }
});

test('allowed: cp -L and cp -S are not link options; -l and -s still are', () => {
  assert.equal(policy.bashDenial('cp -L x .agents/skills/x', OPTS), null);
  assert.equal(policy.bashDenial('cp -S .bak y .agents/skills/y', OPTS), null);
  assert.match(String(policy.bashDenial('cp -Rs .agents/skills ag2', OPTS)), /protected/);
  assert.match(String(policy.bashDenial('cp -l .agents/skills bk', OPTS)), /protected/);
});
