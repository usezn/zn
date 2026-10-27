'use strict';

// zn-gate check runs each hook with its event on stdin. A hook that answers and exits before reading all of its
// input makes that write fail with EPIPE; the hook still ran, so its exit code and output are its answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { _internal } = require('../lib/check');

const posix = process.platform !== 'win32';

test('check: a hook that blocks and exits before reading a large event is read as a block, not as a hook that could not start', { skip: !posix }, (t) => {
  const dir = tempDir(t, 'zn-check-epipe-');
  const hook = path.join(dir, 'hook.sh');
  const lines = ['#!/bin/sh', "printf '%s' '{\"permissionDecision\":\"deny\"}'", 'exit 2', ''];
  fs.writeFileSync(hook, lines.join(String.fromCharCode(10)), { mode: 0o755 });
  const big = { hook_event_name: 'PreToolUse', pad: 'x'.repeat(8 * 1024 * 1024) };
  for (let i = 0; i < 5; i++) {
    const r = _internal.spawnHook(hook, [], big, {}, dir);
    assert.equal(r.ran, true, JSON.stringify({ why: r.why }));
    assert.equal(r.status, 2);
    assert.equal(r.decision, 'deny');
  }
});

test('check: a hook that cannot be started is still reported as not run', { skip: !posix }, (t) => {
  const dir = tempDir(t, 'zn-check-enoent-');
  const r = _internal.spawnHook(path.join(dir, 'missing.sh'), [], {}, {}, dir);
  assert.equal(r.ran, false);
  assert.equal(r.why, 'ENOENT');
});
