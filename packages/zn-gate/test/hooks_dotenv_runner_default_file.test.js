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

const BYPASS_FORMS = [
  'dotenvx --log-level info run -- printenv',
  'dotenvx -l info run -- printenv',
  'dotenvx --log-level debug get',
  'dotenv printenv -f x',
  'dotenv node app.js -e x',
  'dotenvx run node app.js -f x',
  'dotenvx run -- printenv -f x',
  'dotenvx frobnicate',
  'dotenvx',
];

test('a dotenvx option with a value before the step, or a file option of the wrapped command, does not hide the default .env', async (t) => {
  const dir = project(t, SECRET);
  for (const c of BYPASS_FORMS) assert.equal(await verdict(dir, c), 'deny', c);
  const enc = project(t, ENCRYPTED);
  for (const c of BYPASS_FORMS) assert.equal(await verdict(enc, c), 'deny', c);
});

test('the same forms pass when .env has no plain secret or does not exist', async (t) => {
  for (const dir of [project(t, 'PORT=1\n'), project(t, null)]) {
    for (const c of BYPASS_FORMS) assert.equal(await verdict(dir, c), 'allow', c);
  }
});

test('a file option that belongs to the runner still stands in for the default .env', async (t) => {
  const dir = project(t, SECRET);
  for (const c of [
    'dotenvx --log-level info run -f other.txt -- printenv',
    'dotenvx run -f other.txt -- printenv -f x',
    'dotenv -e other.txt printenv',
    'dotenv -e other.txt -- node app.js -e x',
    'dotenvx --log-level info ls',
    'dotenvx --version',
  ]) assert.equal(await verdict(dir, c), 'allow', c);
});

test('dotenvx -f takes several values and dotenv -e may repeat: a later .env is still read', async (t) => {
  const dir = project(t, SECRET);
  for (const c of [
    'dotenvx run -f other.txt .env -- printenv',
    'dotenvx run -f other.txt -f .env -- printenv',
    'dotenvx run --env-file other.txt .env -- printenv',
    'dotenvx run --env-file=other.txt .env -- printenv',
    'dotenvx run -f other.txt more.txt .env -- printenv',
    'npx dotenvx run -f other.txt .env -- printenv',
    'dotenv -e other.txt -e .env -- printenv',
    'dotenv -e other.txt -e .env printenv',
  ]) assert.equal(await verdict(dir, c), 'deny', c);
  const enc = project(t, ENCRYPTED);
  for (const c of ['dotenvx run -f other.txt .env -- printenv', 'dotenvx run -f other.txt -f .env -- printenv']) assert.equal(await verdict(enc, c), 'deny', c);
  for (const c of [
    'dotenvx run -f other.txt -- node app.js',
    'dotenvx run -f other.txt more.txt -- node app.js',
    'dotenv -e other.txt -e more.txt -- printenv',
  ]) assert.equal(await verdict(dir, c), 'allow', c);
  const plain = project(t, 'PORT=1\n');
  assert.equal(await verdict(plain, 'dotenvx run -f other.txt .env -- printenv'), 'allow');
});

test('dotenv-cli has no -f / --env-file: it still loads the default .env', async (t) => {
  const forms = ['dotenv -f x -- printenv', 'dotenv --env-file=x -- printenv', 'dotenv --env-file x -- printenv', 'dotenv -f x printenv', 'dotenv-cli -f x -- printenv', 'npx dotenv -f x -- printenv'];
  for (const content of [SECRET, ENCRYPTED]) {
    const dir = project(t, content);
    for (const c of forms) assert.equal(await verdict(dir, c), 'deny', c);
    assert.equal(await verdict(dir, 'dotenv -e other.txt -- printenv'), 'allow');
    assert.equal(await verdict(dir, 'dotenvx run -f other.txt -- printenv'), 'allow');
  }
  for (const dir of [project(t, 'PORT=1\n'), project(t, null)]) for (const c of forms) assert.equal(await verdict(dir, c), 'allow', c);
});

test('every dotenvx step takes several -f values, also after an option before the step', async (t) => {
  const forms = [
    'dotenvx get -f other.txt .env',
    'dotenvx get KEY -f other.txt .env',
    'dotenvx get -f other.txt more.txt .env',
    'dotenvx decrypt -f other.txt .env',
    'dotenvx encrypt -f other.txt .env',
    'dotenvx set KEY 1 -f other.txt .env',
    'dotenvx --log-level debug run -f other.txt .env -- printenv',
    'dotenvx --log-level debug get -f other.txt .env',
  ];
  for (const content of [SECRET, ENCRYPTED]) {
    const dir = project(t, content);
    for (const c of forms) assert.equal(await verdict(dir, c), 'deny', c);
    for (const c of ['dotenvx get -f other.txt', 'dotenvx run -f other.txt -- node app.js', 'dotenvx --log-level debug run -f other.txt -- node app.js']) {
      assert.equal(await verdict(dir, c), 'allow', c);
    }
  }
  const plain = project(t, 'PORT=1\n');
  for (const c of ['dotenvx run -f other.txt .env -- printenv', 'dotenvx get -f other.txt']) assert.equal(await verdict(plain, c), 'allow', c);
});

test('the glued -f=X / --env-file=X is judged like the separate form in every position', async (t) => {
  const glued = [
    'dotenvx --log-level debug get -f=.env',
    'dotenvx --log-level info run -f=.env -- printenv',
    'dotenvx decrypt -f=.env',
    'dotenvx encrypt --env-file=.env',
    'dotenvx set K 1 -f=.env',
    'dotenvx --log-level debug decrypt --env-file=.env',
    'dotenvx run -f=other.txt -f=.env -- printenv',
  ];
  for (const content of [SECRET, ENCRYPTED]) {
    const dir = project(t, content);
    for (const c of glued) assert.equal(await verdict(dir, c), 'deny', c);
    for (const c of ['dotenvx run -f=other.txt -- node app.js', 'dotenvx --log-level debug run -f=other.txt -- node app.js', 'dotenvx get -f=other.txt', 'dotenvx decrypt --env-file=other.txt']) {
      assert.equal(await verdict(dir, c), 'allow', c);
    }
  }
});

test('every step x option position x -f form reads a secret .env', async (t) => {
  const steps = ['run', 'get', 'set K 1', 'encrypt', 'decrypt'];
  const befores = ['', '--log-level debug '];
  const forms = ['-f other.txt .env', '-f=.env', '--env-file=.env', '-f other.txt -f .env', '--env-file other.txt .env'];
  const secret = project(t, SECRET);
  const enc = project(t, ENCRYPTED);
  for (const step of steps) for (const before of befores) for (const form of forms) {
    const c = 'dotenvx ' + before + step + ' ' + form + (step === 'run' ? ' -- printenv' : '');
    assert.equal(await verdict(secret, c), 'deny', c);
    assert.equal(await verdict(enc, c), 'deny', c);
  }
});

test('a cd before the runner judges the .env of the folder it leads to', async (t) => {
  const dir = project(t, null);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, 'ok'));
  fs.writeFileSync(path.join(dir, 'sub', '.env'), SECRET);
  fs.writeFileSync(path.join(dir, 'ok', '.env'), 'PORT=1\n');
  for (const c of [
    'cd sub && dotenvx run -- printenv',
    'cd sub; dotenv -- printenv',
    'pushd sub && dotenvx get',
    'cd ./sub && npx dotenvx run -- env',
    'cd $APP_DIR && dotenvx run -- printenv',
    'cd sub && dotenv -e other.txt -- printenv && dotenvx run -- printenv',
  ]) assert.equal(await verdict(dir, c), 'deny', c);
  for (const c of [
    'cd ok && dotenvx run -- printenv',
    'cd ok && dotenv -- printenv',
    'cd sub && dotenvx run -f other.txt -- printenv',
  ]) assert.equal(await verdict(dir, c), 'allow', c);
});

test('a cascade or convention reads the files of the real environment name', async (t) => {
  const dir = project(t, 'PORT=1\n');
  const only = (name, body) => { for (const n of fs.readdirSync(dir)) if (n !== '.env') fs.rmSync(path.join(dir, n)); fs.writeFileSync(path.join(dir, name), body); };
  only('.env.staging', SECRET);
  assert.equal(await verdict(dir, 'dotenv -c staging -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'dotenv --cascade staging -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'NODE_ENV=staging dotenvx run --convention flow -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'dotenvx run --convention nextjs -- printenv'), 'deny');
  only('.env.staging.local', SECRET);
  assert.equal(await verdict(dir, 'dotenv -c staging -- printenv'), 'deny');
  only('.env.qa', SECRET);
  assert.equal(await verdict(dir, 'dotenvx run --convention flow -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'dotenv -c staging -e other.txt -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'dotenv -c printenv -f x'), 'deny');
  only('.env.staging', 'PORT=1\n');
  assert.equal(await verdict(dir, 'dotenv -c staging -- printenv'), 'allow');
  assert.equal(await verdict(dir, 'dotenvx run --convention flow -- printenv'), 'allow');
  only('.env.example', SECRET);
  assert.equal(await verdict(dir, 'dotenv -c staging -- printenv'), 'allow');
  assert.equal(await verdict(dir, 'dotenv -- printenv'), 'allow');
});

test('a cascade follows a cd to the folder with the environment files', async (t) => {
  const dir = project(t, null);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', '.env.qa'), SECRET);
  assert.equal(await verdict(dir, 'cd sub && dotenv -c qa -- printenv'), 'deny');
  assert.equal(await verdict(dir, 'dotenv -c qa -- printenv'), 'allow');
});

test('info flags only count where the runner honours them; keypair and ext are checked', async (t) => {
  const dir = project(t, SECRET);
  for (const c of ['dotenv -V -- printenv', 'dotenv -h -- printenv', 'dotenv --version -- printenv', 'dotenvx run --help', 'dotenvx run -V -- printenv']) {
    assert.equal(await verdict(dir, c), 'deny', c);
  }
  for (const c of ['dotenvx --version', 'dotenvx --help', 'dotenvx -h', 'dotenvx ls', 'dotenvx help']) assert.equal(await verdict(dir, c), 'allow', c);
  const enc = project(t, ENCRYPTED);
  fs.writeFileSync(path.join(enc, '.env.keys'), 'DOTENV_PRIVATE_KEY="fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake"\n');
  for (const c of ['dotenvx keypair', 'dotenvx ext vault', 'dotenvx precommit', 'dotenvx genexample', 'dotenvx radar']) assert.equal(await verdict(enc, c), 'deny', c);
  const keysOnly = project(t, null, '.env.keys');
  fs.writeFileSync(path.join(keysOnly, '.env.keys'), 'DOTENV_PRIVATE_KEY="fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake"\n');
  assert.equal(await verdict(keysOnly, 'dotenvx keypair'), 'deny');
  assert.equal(await verdict(project(t, 'PORT=1\n'), 'dotenvx keypair'), 'allow');
});

test('a cd the hook cannot follow, with a cascade or convention, is refused', async (t) => {
  for (const dir of [project(t, 'PORT=1\n'), project(t, null)]) {
    for (const c of ['cd $APP_DIR && dotenv -c qa -- printenv', 'cd $APP_DIR && dotenvx run --convention flow -- printenv', 'cd $APP_DIR && dotenv -c qa -e other.txt -- printenv']) {
      assert.equal(await verdict(dir, c), 'deny', c);
    }
  }
});

test('a dotenv runner behind a wrapper is judged like the runner alone', async (t) => {
  const dir = project(t, SECRET);
  for (const c of [
    'env dotenvx run -- printenv', 'env dotenvx get', 'env -i dotenvx get', 'env FOO=1 dotenvx run -- printenv', 'env -u HOME dotenvx get',
    'sudo dotenvx get', 'sudo dotenvx run -- printenv', 'sudo -u root dotenvx get', 'command dotenvx get', 'nice dotenvx get',
    'nice -n 5 dotenvx run -- printenv', 'nohup dotenvx get', 'time dotenvx get', 'timeout 5 dotenvx get', 'stdbuf -o0 dotenvx get',
    'env dotenv -- printenv', 'sudo dotenv -- printenv', 'sudo env dotenv -- printenv', 'env npx dotenvx run -- env',
    'sudo -u root npx dotenv -c qa -- printenv',
    // named file through a wrapper
    'env dotenvx run -f .env -- printenv', 'sudo dotenv -e .env -- printenv',
  ]) assert.equal(await verdict(dir, c), 'deny', c);
  for (const c of [
    'env dotenvx run -f other.txt -- printenv', 'sudo -u root dotenvx get -f other.txt', 'sudo dotenv -e other.txt -- printenv',
    'env dotenvx --version', 'sudo dotenvx ls', 'env printenv', 'sudo echo dotenvx get',
  ]) assert.equal(await verdict(dir, c), 'allow', c);
  for (const quiet of [project(t, 'PORT=1\n'), project(t, null)]) {
    for (const c of ['env dotenvx run -- printenv', 'sudo -u root dotenvx get', 'command dotenv -- printenv']) assert.equal(await verdict(quiet, c), 'allow', c);
  }
});

test('a wrapper the head resolver reads but the wrapper list does not still marks the runner', async (t) => {
  const dir = project(t, SECRET);
  for (const c of ['exec dotenvx run -- printenv', 'doas dotenvx get', 'xargs dotenvx get', 'setsid dotenvx get', 'ionice dotenvx get', 'flock /x/lock dotenvx get', 'taskset 1 dotenvx get']) {
    assert.equal(await verdict(dir, c), 'deny', c);
  }
  assert.equal(await verdict(dir, 'exec dotenvx run -f other.txt -- printenv'), 'allow');
  assert.equal(await verdict(dir, 'doas dotenv -e other.txt -- printenv'), 'allow');
});

test('a cascade in a folder that cannot be listed is refused', async (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return t.skip('needs a non-root POSIX user');
  const dir = project(t, null);
  const sub = path.join(dir, 'locked');
  fs.mkdirSync(sub);
  try {
    fs.chmodSync(sub, 0o000);
    assert.equal(await verdict(dir, 'cd locked && dotenv -c qa -- printenv'), 'deny');
    assert.equal(await verdict(dir, 'cd missing && dotenv -c qa -- printenv'), 'allow');
  } finally { fs.chmodSync(sub, 0o755); }
});
