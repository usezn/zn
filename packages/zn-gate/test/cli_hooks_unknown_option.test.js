'use strict';
// zn hooks reports an unknown option by name and lists the options it does take.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    env: Object.assign({}, process.env, { NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' }),
  });
}

test('hooks with an unknown option names it, lists the valid ones and exits 64', () => {
  const r = run(['hooks', 'install', 'claude-code', '--bogus']);
  assert.strictEqual(r.status, 64);
  assert.match(r.stderr, /unknown option "--bogus"/);
  assert.match(r.stderr, /--project and --no-mcp/);
  assert.doesNotMatch(r.stderr, /needs a value/);
});

test('hooks with an unknown option before the action is reported as unknown too', () => {
  const r = run(['hooks', '--bogus']);
  assert.strictEqual(r.status, 64);
  assert.match(r.stderr, /unknown option "--bogus"/);
});

test('hooks accepts its own options without reporting an unknown option', () => {
  const r = run(['hooks', 'install', '--no-mcp']);
  assert.strictEqual(r.status, 64);
  assert.doesNotMatch(r.stderr, /unknown option/);
});
