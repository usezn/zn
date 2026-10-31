'use strict';

// claudeProjectHooksFile: which project settings file of Claude Code holds a zn hook.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _internal } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const hooks = (command) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } });
const ZN = 'zn hook claude-code';

function project(t, files) {
  const cwd = tempDir(t, 'zn-cphf-');
  fs.mkdirSync(path.join(cwd, '.claude'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, '.claude', name), text);
  return cwd;
}

test('claudeProjectHooksFile: no settings files gives an empty name', (t) => {
  assert.equal(_internal.claudeProjectHooksFile(project(t, {})), '');
  assert.equal(_internal.claudeProjectHooksFile(tempDir(t, 'zn-cphf-')), '');
});

test('claudeProjectHooksFile: finds settings.json, then settings.local.json', (t) => {
  const a = project(t, { 'settings.json': hooks(ZN) });
  assert.equal(_internal.claudeProjectHooksFile(a), path.join(a, '.claude', 'settings.json'));
  const b = project(t, { 'settings.local.json': hooks(ZN) });
  assert.equal(_internal.claudeProjectHooksFile(b), path.join(b, '.claude', 'settings.local.json'));
  const both = project(t, { 'settings.json': hooks(ZN), 'settings.local.json': hooks(ZN) });
  assert.equal(_internal.claudeProjectHooksFile(both), path.join(both, '.claude', 'settings.json'));
});

test('claudeProjectHooksFile: a hook that is not zn does not count', (t) => {
  assert.equal(_internal.claudeProjectHooksFile(project(t, { 'settings.json': hooks('echo other') })), '');
});

test('claudeProjectHooksFile: a broken or BOM-prefixed file is skipped or read, never thrown', (t) => {
  const broken = project(t, { 'settings.json': '{bad', 'settings.local.json': hooks(ZN) });
  assert.equal(_internal.claudeProjectHooksFile(broken), path.join(broken, '.claude', 'settings.local.json'));
  const bom = project(t, { 'settings.json': '﻿' + hooks(ZN) });
  assert.equal(_internal.claudeProjectHooksFile(bom), path.join(bom, '.claude', 'settings.json'));
  assert.equal(_internal.claudeProjectHooksFile(project(t, { 'settings.json': 'null' })), '');
});
