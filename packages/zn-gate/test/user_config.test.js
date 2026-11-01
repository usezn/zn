'use strict';

// An unusable ~/.zn/config.json is reported by `zn status`, `zn check` and the
// hook (once per process, on stderr), while the settings fall back to their
// defaults exactly as before. A missing or valid file gives no report.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');
const CLI = path.join(PKG, 'bin', 'cli.js');
const RUNNER = path.join(PKG, 'lib', 'hooks', 'runner.js');
const { readUserConfig, displayPath } = require(path.join(PKG, 'lib', 'user-config.js'));

const INVALID = 'is not valid JSON, so zn-gate is using default settings. Fix or remove the file.';

const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

// mode: 'missing' (no file), 'valid' (object), 'invalid' (not JSON)
function tmpHome(mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-userconfig-'));
  created.push(home);
  if (mode !== 'missing') {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const text = mode === 'valid' ? JSON.stringify({ hooks: { blockDestructiveCommands: 'off' } }) : '{ this is not json';
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), text);
  }
  return home;
}

function envFor(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const k of ['ZN_HOME', 'ZN_API_KEY', 'ZN_CLOUD', 'ZN_CLOUD_API_KEY']) if (!(k in extra)) delete env[k];
  return env;
}

function cli(args, home, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000, env: envFor(home, extra) });
}

function hook(input, home) {
  return spawnSync(process.execPath, [RUNNER, 'claude-code'], { input, encoding: 'utf8', timeout: 60000, env: envFor(home) });
}

const BASH_LS = JSON.stringify({
  session_id: 'abc123', cwd: os.tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse',
  tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01',
});

test('readUserConfig: missing file is not an error', () => {
  const home = tmpHome('missing');
  assert.deepEqual(readUserConfig(path.join(home, '.zn', 'config.json')), { config: {}, error: null });
});

test('readUserConfig: valid object is returned without an error', () => {
  const home = tmpHome('valid');
  const r = readUserConfig(path.join(home, '.zn', 'config.json'));
  assert.equal(r.error, null);
  assert.deepEqual(r.config, { hooks: { blockDestructiveCommands: 'off' } });
});

test('readUserConfig: invalid JSON gives empty settings and one sentence', () => {
  const home = tmpHome('invalid');
  const file = path.join(home, '.zn', 'config.json');
  const r = readUserConfig(file);
  assert.deepEqual(r.config, {});
  assert.equal(r.error, displayPath(file) + ' ' + INVALID);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'the file is not changed');
});

test('readUserConfig: a JSON array is not settings', () => {
  const home = tmpHome('missing');
  const file = path.join(home, '.zn', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[1, 2]');
  const r = readUserConfig(file);
  assert.deepEqual(r.config, {});
  assert.match(r.error, /is not a JSON object, so zn-gate is using default settings/);
});

test('status: invalid file is reported, valid and missing files are not', () => {
  const bad = cli(['status'], tmpHome('invalid'));
  assert.match(bad.stdout, new RegExp('Settings        : ~/\\.zn/config\\.json ' + INVALID.replace(/\./g, '\\.')));
  assert.doesNotMatch(cli(['status'], tmpHome('valid')).stdout, /Settings        :/);
  assert.doesNotMatch(cli(['status'], tmpHome('missing')).stdout, /Settings        :/);
});

test('status: ZN_HOME pointing at an invalid file is reported too', () => {
  const zh = tmpHome('invalid');
  const res = cli(['status'], tmpHome('missing'), { ZN_HOME: path.join(zh, '.zn') });
  assert.match(res.stdout, /config\.json is not valid JSON/);
});

test('check: invalid file is reported and the exit code is the same as without it', () => {
  const bad = cli(['check'], tmpHome('invalid'));
  const none = cli(['check'], tmpHome('missing'));
  assert.match(bad.stdout, /Settings: ~\/\.zn\/config\.json is not valid JSON/);
  assert.doesNotMatch(none.stdout, /Settings:/);
  assert.equal(bad.status, none.status);
});

test('hook: invalid file gives one stderr line per process and the same verdict', () => {
  const bad = hook(BASH_LS, tmpHome('invalid'));
  const none = hook(BASH_LS, tmpHome('missing'));
  const line = 'zn hook: ~/.zn/config.json ' + INVALID;
  assert.equal(bad.stderr.split(line).length - 1, 1, 'warning written exactly once');
  assert.equal(none.stderr.includes('zn hook:'), false);
  assert.equal(bad.status, none.status);
  assert.equal(bad.stdout, none.stdout);
});

test('hook: valid file gives no warning', () => {
  const res = hook(BASH_LS, tmpHome('valid'));
  assert.equal(res.stderr.includes('zn hook:'), false);
});
