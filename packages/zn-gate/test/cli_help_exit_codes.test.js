'use strict';
/* The general help is built from the adapter registry, and the exit codes follow one table. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listAdapters } = require('../lib/agents');
const { EXIT } = require('../lib/exit-codes');
const { unlockCmd, ALREADY_UNLOCKED } = require('../lib/vault/cli');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exit-'));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', NO_COLOR: '1' },
  });
}

test('the general help names every agent of the adapter registry for hooks install', () => {
  const r = run(['--help']);
  assert.equal(r.status, EXIT.OK);
  const m = r.stdout.match(/hooks install <agent> \[--project\]\n\s+Install zn's hooks for ([^\n]+)\n/);
  assert.ok(m, 'the hooks install line has an agent list');
  assert.ok(listAdapters().length >= 5);
  for (const id of listAdapters()) assert.ok(m[1].includes(id), id + ' is in the help');
});

test('the general help lists vault team', () => {
  assert.match(run(['--help']).stdout, /^ {2}vault team /m);
  assert.match(run(['vault', '--help']).stdout, /^ {2}team /m);
});

test('the exit code table has the documented values', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, FAILED: 1, USAGE: 2, BLOCKED: 2, BAD_USAGE: 64, REFUSED: 77, NOT_FOUND: 127 });
});

test('exit codes: done is 0, wrong usage is 2', () => {
  const missing = path.join(home, 'no-such-folder');
  const cases = [
    [['version'], EXIT.OK],
    [['--help'], EXIT.OK],
    [['vault', 'team'], EXIT.OK],
    [['no-such-command'], EXIT.USAGE],
    [['scan', missing], EXIT.USAGE],
    [['scan', home, '--format', 'xml'], EXIT.USAGE],
    [['audit', missing], EXIT.USAGE],
    [['vault', 'no-such-subcommand'], EXIT.USAGE],
    [['shield', '--'], EXIT.USAGE],
  ];
  for (const [args, code] of cases) {
    const r = run(args);
    assert.equal(r.status, code, 'zn-gate ' + args.join(' ') + ' exits ' + code + ' (got ' + r.status + ': ' + r.stderr + ')');
  }
});

test('zn unlock on an unlocked vault is a no-op success: it says so, asks nothing and returns', async () => {
  let asked = 0;
  const printed = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { printed.push(String(s)); return true; };
  try {
    const res = await unlockCmd(['unlock'], {
      agent: null,
      clientFactory: () => ({ status: async () => ({ unlocked: true, expiresAt: 'x', features: ['resolve-policy'] }), close() {} }),
      getPassphrase: async () => { asked += 1; return 'fake-pass-12345'; },
    });
    assert.equal(res, undefined, 'no error and no failing code');
  } finally { process.stdout.write = write; }
  assert.equal(asked, 0);
  assert.ok(printed.join('').includes(ALREADY_UNLOCKED));
});
