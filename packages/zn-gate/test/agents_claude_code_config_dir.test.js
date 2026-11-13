'use strict';
/*
 * configDir of the Claude Code adapter: the folder comes from
 * CLAUDE_CONFIG_DIR when it is set (made absolute), otherwise it is
 * <home>/.claude. Every home is a temporary folder; no real config is read.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const claude = require('../lib/agents/claude-code');

test('configDir uses an absolute CLAUDE_CONFIG_DIR as is', (t) => {
  const home = tempDir(t, 'zn-cc-configdir-');
  const custom = path.join(home, 'custom-claude');
  assert.equal(claude.configDir({ home, env: { CLAUDE_CONFIG_DIR: custom } }), custom);
});

test('configDir resolves a relative CLAUDE_CONFIG_DIR against the current folder', (t) => {
  const home = tempDir(t, 'zn-cc-configdir-');
  const got = claude.configDir({ home, env: { CLAUDE_CONFIG_DIR: path.join('relative', 'claude-config') } });
  assert.ok(path.isAbsolute(got));
  assert.equal(got, path.resolve(process.cwd(), 'relative', 'claude-config'));
});

test('configDir falls back to <home>/.claude without the variable', (t) => {
  const home = tempDir(t, 'zn-cc-configdir-');
  assert.equal(claude.configDir({ home, env: {} }), path.join(home, '.claude'));
});

test('configDir ignores an empty CLAUDE_CONFIG_DIR', (t) => {
  const home = tempDir(t, 'zn-cc-configdir-');
  assert.equal(claude.configDir({ home, env: { CLAUDE_CONFIG_DIR: '' } }), path.join(home, '.claude'));
});

test('configDir with no options ends in .claude', (t) => {
  // Without options the process environment is read; keep the host's value out.
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });
  const got = claude.configDir();
  assert.equal(path.basename(got), '.claude');
  assert.equal(got, path.join(os.homedir(), '.claude'));
});
