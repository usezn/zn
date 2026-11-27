'use strict';
// Benign near-misses for the rules added or changed in 1.19: commands that look close to a rule but must stay allowed by the Bash
// hook policy and by the destructive-command check, and the dotenv runner cases whose answer depends on what the project .env holds.
// The commands are fictional and harmless; the strings are only analysed, never run. The Python package reads the same
// fixture (test_benign_near_miss_1_19.py), and the sentences of the same kind are in benign_phrases.json (bench/rules_fp_gate.js).

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');
const { evaluate } = require('../lib/rules');
const { tempDir } = require('./helpers/tmp');

const FIXTURES = path.join(__dirname, 'fixtures');
const COMMANDS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'benign_near_miss_commands.json'), 'utf8')).commands;
const PHRASES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'benign_phrases.json'), 'utf8')).phrases;

const SECRET = 'API_KEY=not-a-real-value-0123456789abcdef\n';

function project(t, files) {
  const dir = tempDir(t, 'zn-near-miss-');
  for (const d of ['src', 'notes', 'build', 'dist']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const [name, content] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), content);
  return { cwd: dir, home: dir, env: {} };
}

function allowed(cmd, o) {
  return { hook: policy.bashDenial(cmd, o), destructive: checkCommand(cmd).verdict };
}

test('commands close to a 1.19 rule stay allowed by the hook policy and the destructive check', (t) => {
  const o = project(t, { '.env': 'PORT=3000\n' });
  assert.ok(COMMANDS.length >= 30);
  assert.equal(new Set(COMMANDS).size, COMMANDS.length, 'duplicate lines in the fixture');
  for (const cmd of COMMANDS) {
    const r = allowed(cmd, o);
    assert.equal(r.hook, null, 'hook: ' + cmd + ' -> ' + String(r.hook).slice(0, 100));
    assert.equal(r.destructive, 'allow', 'destructive: ' + cmd);
  }
});

test('an empty command is a string: it is allowed, only a non-string is refused', () => {
  assert.equal(checkCommand('').verdict, 'allow');
  assert.equal(checkCommand('   ').verdict, 'allow');
  assert.equal(checkCommand(null).verdict, 'block');
});

test('a shell command nested three levels deep is still allowed', () => {
  assert.equal(checkCommand('sh -c "sh -c \\"sh -c \'echo hi\'\\""').verdict, 'allow');
});

// The default .env of a dotenv runner is judged as a read of that file: a runner that names another file, a step that loads nothing,
// a project .env without a secret and a project without a .env are not affected.
const DOTENV_GROUPS = [
  { label: 'a project .env that holds a secret, commands that do not load it',
    files: { '.env': SECRET, 'other.txt': 'A=1\n' },
    commands: [
      'dotenvx run -f other.txt -- node app.js',
      'dotenvx run -f other.txt more.txt -- node app.js',
      'dotenvx get -f other.txt',
      'dotenvx set -f other.txt NAME value',
      'dotenv -e other.txt -- node app.js',
      'dotenvx help',
      'dotenvx ls',
      'dotenvx gitignore',
      'dotenvx --version',
      'echo dotenvx run -- node app.js',
      'git commit -m "document dotenvx run -- usage"',
      'sort -o.sorted other.txt',
      'sed -n \'w.log\' other.txt',
      'docker run -v ./other.txt:/app/other.txt:ro img',
      'docker run -v ./.env.example:/app/.env.example:ro img',
      'sort -o.env.example other.txt',
      'sed -n \'w.env.sample\' other.txt',
    ] },
  { label: 'a project .env without a secret and template files that hold one',
    files: { '.env': 'PORT=3000\nLOG_LEVEL=debug\n', '.env.example': SECRET, '.env.sample': SECRET, '.env.staging': 'LOG_LEVEL=info\n' },
    commands: [
      'dotenvx run -- node app.js',
      'dotenvx run -f .env -- node app.js',
      'dotenvx run --convention nextjs -- node app.js',
      'dotenvx run --convention=flow -- node app.js',
      'dotenv -- node app.js',
      'dotenv -c -- node app.js',
      'dotenv -c staging -- node app.js',
      'dotenv -e .env -- node app.js',
      'dotenv -f other.txt -- node app.js',
      'npx dotenvx run -- node app.js',
      'npx -y dotenv -- node app.js',
      'pnpm dlx dotenvx run -- node app.js',
      'dotenvx keypair',
      'dotenvx get',
    ] },
  { label: 'a project with no .env',
    files: {},
    commands: [
      'dotenvx run -- node app.js',
      'dotenv -- node app.js',
      'dotenv -c -- node app.js',
      'dotenvx run --convention nextjs -- node app.js',
      'dotenvx get',
      'dotenvx keypair',
      'npx dotenvx run -- node app.js',
    ] },
];

for (const g of DOTENV_GROUPS) {
  test('dotenv runners stay allowed: ' + g.label, (t) => {
    const o = project(t, g.files);
    for (const cmd of g.commands) {
      const r = allowed(cmd, o);
      assert.equal(r.hook, null, 'hook: ' + cmd + ' -> ' + String(r.hook).slice(0, 100));
      assert.equal(r.destructive, 'allow', 'destructive: ' + cmd);
    }
  });
}

test('the sentences of the glued-name and path near-misses in benign_phrases.json are allowed', () => {
  for (const p of PHRASES) assert.notEqual(evaluate(p).verdict, 'block', p);
});
