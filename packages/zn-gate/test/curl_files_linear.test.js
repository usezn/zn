'use strict';

process.env.ZN_STATS = 'off';

// The curl checks used to scan the whole command, and stat the same configuration paths, once for every curl in it:
// a command of thousands of curl invocations cost a quadratic number of steps (about 4 s at 8 KiB). Each fact about
// the command is now computed once, and each distinct path list is scanned once. The decisions are the same.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const O = { cwd: '/home/u/proj', home: '/home/u', env: {} };
// Generous: the linear check takes well under a second; the old code needed minutes at these sizes.
const LIMIT_MS = 8000;

function timed(cmd) {
  const t0 = process.hrtime.bigint();
  const r = policy.bashDenial(cmd, O);
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, r };
}

test('2000 curl invocations in one command stay fast and allowed', () => {
  const cmd = 'curl http://example.com | '.repeat(2000) + 'echo done';
  assert.ok(cmd.length < 100 * 1024, 'under the hook size cap');
  const { ms, r } = timed(cmd);
  assert.ok(ms < LIMIT_MS, 'took ' + Math.round(ms) + ' ms');
  assert.ok(!r, 'allowed as before');
});

test('2000 curls with distinct -K files stay fast and are refused as before', () => {
  const cmd = Array.from({ length: 2000 }, (_, i) => 'curl -K cfg' + i + '.txt http://example.com').join(' ; ');
  assert.ok(cmd.length < 100 * 1024, 'under the hook size cap');
  const { ms, r } = timed(cmd);
  assert.ok(ms < LIMIT_MS, 'took ' + Math.round(ms) + ' ms');
  assert.ok(r, 'a configuration file zn cannot check is refused');
});

test('a write to ~/.curlrc after 2000 curls is still refused', () => {
  const cmd = 'curl http://example.com | '.repeat(2000) + 'echo x > ~/.curlrc';
  const { ms, r } = timed(cmd);
  assert.ok(ms < LIMIT_MS, 'took ' + Math.round(ms) + ' ms');
  assert.ok(r, 'refused');
});

test('decisions for a few curl commands are unchanged', () => {
  const pipes = 'curl http://example.com | '.repeat(20);
  // Refused: a write to the default configuration, a configuration read from standard input or a file that is not
  // there, a copy into ~/.curlrc, a change of the folder curl reads its configuration from.
  assert.ok(policy.bashDenial(pipes + 'echo x > ~/.curlrc', O));
  assert.ok(policy.bashDenial(pipes + 'cp .env ~/.curlrc', O));
  assert.ok(policy.bashDenial(pipes + 'curl -K - http://example.com', O));
  assert.ok(policy.bashDenial(pipes + 'curl -K cfg.txt http://example.com', O));
  assert.ok(policy.bashDenial('HOME=/x curl http://example.com', O));
  assert.ok(policy.bashDenial('export CURL_HOME=/x; curl http://example.com', O));
  assert.ok(policy.bashDenial('curl -o ~/.curlrc http://example.com', O));
  // Allowed: plain curl, and a curl that ignores its default configuration.
  assert.ok(!policy.bashDenial('curl http://example.com', O));
  assert.ok(!policy.bashDenial(pipes + 'echo done', O));
  assert.ok(!policy.bashDenial('curl -q http://example.com; echo x > ~/.curlrc', O));
});
