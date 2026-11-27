'use strict';
// A dotenv runner given no file option (dotenvx run, dotenv) loads ./.env on its own: it is judged as a read of that file, like the
// same call with -f .env. A project whose .env holds no plain secret, or has none, keeps passing. Inert fixture text only.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const SECRET = 'API_KEY=not-a-real-value-0123456789abcdef\n';
const ENCRYPTED = 'DOTENV_PUBLIC_KEY="03fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake"\n' +
  'API_KEY="encrypted:BFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE=="\n';

function project(t, env, name = '.env') {
  const dir = tempDir(t, 'zn-dxdef-');
  if (env !== null) fs.writeFileSync(path.join(dir, name), env);
  return dir;
}

async function verdict(dir, command) {
  const raw = { session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' };
  const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  const out = JSON.stringify(res.output || {}) + ' ' + JSON.stringify(res.decision || {});
  return /"deny"|"block"|"permissionDecision":"deny"/.test(out) ? 'deny' : 'allow';
}

const DEFAULT_LOADS = [
  'dotenvx run -- printenv',
  'dotenvx run -- node app.js',
  'npx dotenvx run -- env',
  'npx -y dotenvx run -- env',
  'bunx dotenvx run -- env',
  'pnpm dlx dotenvx run -- env',
  'dotenvx get',
  'dotenv -- printenv',
  'dotenv-cli -- printenv',
  'npx dotenv -- node app.js',
  'dotenv printenv',
  'dotenv -c -- printenv',
  'dotenvx run --convention nextjs -- printenv',
  'dotenvx run --convention=flow -- printenv',
  'cd . && dotenvx run -- printenv',
];

for (const [label, content] of [['a plain secret', SECRET], ['an encrypted value', ENCRYPTED]]) {
  test('a dotenv runner without a file option is refused when .env holds ' + label, async (t) => {
    const dir = project(t, content);
    for (const c of DEFAULT_LOADS) assert.equal(await verdict(dir, c), 'deny', c);
    // The same call with -f .env was already refused.
    assert.equal(await verdict(dir, 'dotenvx run -f .env -- printenv'), 'deny');
  });
}

test('a cascade or convention also covers the .env.<environment> files', async (t) => {
  const dir = project(t, 'PORT=1\n');
  fs.writeFileSync(path.join(dir, '.env.local'), SECRET);
  assert.equal(await verdict(dir, 'dotenv -- printenv'), 'allow');
  assert.equal(await verdict(dir, 'dotenv -c -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'dotenvx run --convention nextjs -- printenv'), 'deny');
});

test('a dotenv runner passes when .env has no plain secret or does not exist', async (t) => {
  const plain = project(t, 'PORT=1\n');
  const none = project(t, null);
  for (const c of DEFAULT_LOADS) {
    assert.equal(await verdict(plain, c), 'allow', c);
    assert.equal(await verdict(none, c), 'allow', c);
  }
});

test('a runner given its own file option, or a step that loads nothing, does not read the default .env', async (t) => {
  const dir = project(t, SECRET);
  for (const c of [
    'dotenvx run -f other.txt -- printenv',
    'dotenvx run --env-file=other.txt -- printenv',
    'dotenv -e other.txt -- printenv',
    'dotenvx --version',
    'dotenvx help',
    'printenv',
    'echo dotenv -- printenv',
    'node -e "x" dotenvx run -- printenv',
  ]) assert.equal(await verdict(dir, c), 'allow', c);
});
