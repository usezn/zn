'use strict';

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const zc = require('../lib/agents/zcode');
const { tempDir } = require('./helpers/tmp');

test('pluginWindowsArgs for PostToolUse fails open with exit 0', () => {
  const args = zc.pluginWindowsArgs('PostToolUse');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(args.length, 4);
  const script = args[3];
  assert.ok(script.includes("'PostToolUse'"));
  assert.ok(script.includes('zn is NOT protecting this session'));
  assert.ok(script.includes('catch {'));
  assert.ok(script.includes('exit 0 }; exit 0'));
  assert.ok(!script.includes('exit 2'));
});

test('pluginWindowsArgs for another event blocks with exit 2', () => {
  const args = zc.pluginWindowsArgs('PreToolUse');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const script = args[3];
  assert.ok(script.includes("'PreToolUse'"));
  assert.ok(script.includes('This call was blocked'));
  assert.ok(script.includes('exit 2 }; exit 2'));
  assert.ok(!script.includes('exit 0'));
  assert.ok(!script.includes('NOT protecting'));
});

test('configFile points at .zcode/cli/config.json under the given home', (t) => {
  const home = tempDir(t, 'zn-zcode-home-');
  const file = zc.configFile({ home });
  assert.equal(file, path.join(home, '.zcode', 'cli', 'config.json'));
  assert.equal(zc.hooksFile({ home }), file);
});
