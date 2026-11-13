'use strict';

process.env.ZN_STATS = 'off';

// Small CLI fixes: the env shadow help names the real default mode, vault log refuses an unknown option, init --wrap-mcp
// exits 1 when a config cannot be wrapped, and the top-level help lists the wrap alias and the secret options.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Writable } = require('stream');

const { tempDir } = require('./helpers/tmp');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

function cli(t, args, setup) {
  const home = tempDir(t, 'zn-cli-small-');
  if (setup) setup(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('ZN_') && k !== 'ZN_STATS') delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd: home, encoding: 'utf8', timeout: 60000 });
}

test('env shadow help names env as the default mode, as the code uses', () => {
  const help = require('../lib/vault/help');
  const text = JSON.stringify(help);
  assert.match(text, /--mode {11}how the secret may be used: proxy, env or file \(default env\)/);
  assert.doesNotMatch(text, /default proxy, or env with --command/);
});

test('vault log refuses an unknown option instead of taking the next word as its value', async () => {
  const { dispatch } = require('../lib/broker/cli');
  for (const args of [['log', '--bogus', 'x'], ['log', '--sinse', '1h'], ['log', 'extra']]) {
    const stderr = sink();
    const code = await dispatch('vault', args, { stdout: sink(), stderr, stdin: { isTTY: false } });
    assert.equal(code, 64, args.join(' '));
    assert.match(stderr.text(), /usage: zn vault log \[--since 1h\]/);
  }
});

test('top-level help lists the wrap alias and the secret import and env shadow options', (t) => {
  const r = cli(t, ['--help']);
  assert.match(r.stdout, /shield, mcp-shield, wrap/);
  assert.match(r.stdout, /secret import FILE[^\n]*\n\s+\[--all\] \[--keys A,B\] \[--force\]/);
  assert.match(r.stdout, /env shadow \[FILE\][^\n]*\n\s+\[--all\] \[--keys A,B\] \[--dry-run\]/);
  assert.match(r.stdout, /\[--in header\|query\|body\] \[--force\]/);
});

test('init --wrap-mcp exits 1 when a config cannot be wrapped, 0 when there is nothing to wrap', (t) => {
  const clean = cli(t, ['init', '--wrap-mcp', '--dry-run']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  // A Claude Code config that is not valid JSON: zn leaves it to be wrapped by hand, so the run is not a success.
  const broken = cli(t, ['init', '--wrap-mcp', '--dry-run'], (home) => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{not valid json');
  });
  assert.match(broken.stdout, /manual_required/);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
});
