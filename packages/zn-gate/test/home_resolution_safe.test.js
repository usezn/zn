'use strict';
// An unusable home folder (unset with no passwd entry, empty, relative, "/") never moves state into the current
// folder or the disk root: nothing is written and the message names HOME and ZN_HOME. ZN_HOME rescues each case.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const MOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-nopasswd-mock-')), 'mock.js');
// A uid with no passwd entry and no HOME: os.homedir() throws ENOENT, as libuv does.
fs.writeFileSync(MOCK, "const os=require('os');const orig=os.homedir;os.homedir=function(){if(process.env.ZN_TEST_NO_PASSWD==='1'){const e=new Error('A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)');e.code='ERR_SYSTEM_ERROR';throw e;}return orig.call(os);};\n");

const EVENT = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello' }, cwd: '/' });

const BAD_HOMES = {
  'no home and no passwd entry': { ZN_TEST_NO_PASSWD: '1' },
  'empty HOME': { HOME: '', USERPROFILE: '' },
  'relative HOME': { HOME: 'relhome', USERPROFILE: 'relhome' },
  'HOME is the root folder': { HOME: '/', USERPROFILE: '/' },
};
if (process.platform === 'win32') delete BAD_HOMES['HOME is the root folder'];

function work() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-home-safe-')); }
function run(cwd, env, args, input) {
  const base = { PATH: process.env.PATH, NODE_OPTIONS: '--require ' + MOCK };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', env: { ...base, ...env } });
}
function listing(dir) { return fs.readdirSync(dir).sort(); }

for (const [name, env] of Object.entries(BAD_HOMES)) {
  test('hook refuses with a clear message and writes nothing: ' + name, () => {
    const cwd = work();
    const r = run(cwd, env, ['hook', 'claude-code'], EVENT);
    // Claude Code blocks on exit 2 and shows stderr to the model; it is never an allow.
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /ZN_HOME/);
    assert.match(r.stderr, /HOME/);
    assert.deepEqual(listing(cwd), []);
  });

  test('commands stop with a clear message, no stack trace, nothing written: ' + name, () => {
    for (const args of [['stats'], ['hooks', 'install', 'claude-code'], ['check'], ['evidence']]) {
      const cwd = work();
      const r = run(cwd, env, args);
      assert.notEqual(r.status, 0, args.join(' '));
      const out = r.stdout + r.stderr;
      assert.match(out, /ZN_HOME/, args.join(' ') + ': ' + out);
      assert.doesNotMatch(out, /ERR_SYSTEM_ERROR|at Object\.|node:internal/, args.join(' '));
      assert.deepEqual(listing(cwd), [], args.join(' '));
    }
  });

  test('an absolute ZN_HOME makes it work, and the state goes there only: ' + name, () => {
    const cwd = work();
    const zn = path.join(work(), 'state');
    const r = run(cwd, { ...env, ZN_HOME: zn }, ['hook', 'claude-code'], EVENT);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(listing(cwd), []);
    assert.ok(fs.existsSync(zn), 'state folder created under ZN_HOME');
  });
}

test('status and --version still work and write nothing with no home folder', () => {
  const cwd = work();
  for (const args of [['--version'], ['status']]) {
    const r = run(cwd, BAD_HOMES['no home and no passwd entry'], args);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(listing(cwd), []);
});

test('home.js resolves lazily and applies one rule', () => {
  const saved = { ...process.env };
  const home = require('../lib/home');
  try {
    process.env.ZN_HOME = path.resolve(os.tmpdir(), 'x');
    assert.equal(home.znHome(), path.resolve(os.tmpdir(), 'x'));
    delete process.env.ZN_HOME;
    process.env.HOME = process.env.USERPROFILE = os.tmpdir();
    assert.equal(home.znHome(), path.join(os.tmpdir(), '.zn'));
    process.env.HOME = process.env.USERPROFILE = '';
    assert.throws(() => home.homeDir(), (e) => e.name === 'HomeError' && /HOME/.test(e.message) && /ZN_HOME/.test(e.message));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
