'use strict';
// bin/cli.js team: with no subcommand it does the same as `team status`, and an
// unknown subcommand exits 2 with a one-line usage message on stderr. The home
// directory is a fresh temporary directory, so this machine has not joined an
// organization and no vault is running.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const NOT_JOINED = 'Not in a zn organization. Join with: zn team join <token> (from your organization admin).';
const UNKNOWN = "[zn] 'zn team frobnicate' is not a zn command. Commands: zn team join <token>, zn team status, zn team sync, zn team leave. All options: zn team --help";

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-usage-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function run(args) {
  const env = { ...process.env };
  // Nothing from the machine running the tests may point zn-gate elsewhere.
  for (const k of Object.keys(env)) if (k.startsWith('ZN_')) delete env[k];
  delete env.XDG_CONFIG_HOME;
  Object.assign(env, { HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true', NO_COLOR: '1' });
  return spawnSync(process.execPath, [CLI, 'team', ...args], { encoding: 'utf8', env, timeout: 30000 });
}

const firstLine = (s) => s.split(/\r?\n/)[0];

test('team with no subcommand prints the same as team status and exits 0', () => {
  const bare = run([]);
  const status = run(['status']);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.strictEqual(status.status, 0, status.stderr);
  assert.strictEqual(firstLine(bare.stdout), NOT_JOINED);
  assert.strictEqual(bare.stdout, status.stdout);
  assert.strictEqual(bare.stderr, status.stderr);
});

test('team with an unknown subcommand exits 2 with a usage line on stderr only', () => {
  const r = run(['frobnicate']);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(firstLine(r.stderr), UNKNOWN);
  assert.strictEqual(r.stderr.trim().split(/\r?\n/).length, 1);
});
