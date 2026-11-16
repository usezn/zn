'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// ZN_STRICT and ZN_BLOCK_TRUNCATED turn on only with "1": any other value leaves the hardening off and says so once on stderr.
// Each case runs in a fresh process so the once-per-process memory starts empty.
const lib = path.join(__dirname, '..', 'lib');
const script = `
  const rules = require(${JSON.stringify(path.join(lib, 'rules.js'))});
  let blocks = 0;
  for (let i = 0; i < 3; i++) {
    rules.evaluate('hello', {});
    if (rules.truncatedBlocks({})) blocks++;
  }
  console.log(JSON.stringify({ blocks }));
`;

function run(env) {
  const clean = { ...process.env, ZN_STATS: 'off' };
  delete clean.ZN_STRICT;
  delete clean.ZN_BLOCK_TRUNCATED;
  delete clean.ZN_ALLOW_TRUNCATED;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...clean, ...env }, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, lines: r.stderr.split('\n').filter((l) => l.includes('turns it on')) };
}

for (const value of ['true', 'yes']) {
  test(`ZN_STRICT=${value} warns once on stderr and stays off`, () => {
    const r = run({ ZN_STRICT: value });
    assert.equal(r.lines.length, 1, r.stderr);
    assert.equal(r.lines[0], `zn_gate: ZN_STRICT is set to '${value}', but only ZN_STRICT=1 turns it on, so it is off`);
    assert.ok(!r.stdout.includes('turns it on'), 'nothing on stdout');
  });
}

test('ZN_BLOCK_TRUNCATED=true warns once, read many times, and stays off', () => {
  const r = run({ ZN_BLOCK_TRUNCATED: 'true', ZN_ALLOW_TRUNCATED: '1' });
  assert.equal(r.lines.length, 1, r.stderr);
  assert.match(r.lines[0], /ZN_BLOCK_TRUNCATED is set to 'true', but only ZN_BLOCK_TRUNCATED=1 turns it on/);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).blocks, 0, 'still off');
  assert.ok(!r.stdout.includes('turns it on'));
});

test('"1" turns the flag on; 0, empty and unset are quiet', () => {
  const on = run({ ZN_BLOCK_TRUNCATED: '1', ZN_ALLOW_TRUNCATED: '1' });
  assert.equal(JSON.parse(on.stdout.trim().split('\n').pop()).blocks, 3);
  assert.equal(on.lines.length, 0, on.stderr);
  for (const env of [{ ZN_STRICT: '0' }, { ZN_STRICT: '' }, {}]) {
    const r = run(env);
    assert.equal(r.lines.length, 0, r.stderr);
  }
});

test('the hook runner warns on stderr and keeps stdout for JSON', () => {
  const env = { ...process.env, ZN_STATS: 'off', ZN_STRICT: 'true' };
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'CLAUDE.md', content: 'x' }, cwd: process.cwd() });
  const r = spawnSync(process.execPath, [path.join(lib, 'hooks', 'runner.js'), 'claude-code'], { env, input: event, encoding: 'utf8' });
  assert.equal(r.stderr.split('\n').filter((l) => l.includes('turns it on')).length, 1, r.stderr);
  assert.ok(!r.stdout.includes('turns it on'), 'nothing on stdout');
  if (r.stdout.trim()) JSON.parse(r.stdout);
});
