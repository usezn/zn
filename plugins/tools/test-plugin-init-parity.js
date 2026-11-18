#!/usr/bin/env node
'use strict';

/**
 * The Claude Code and Codex plugin hooks, and the version and license of every plugin manifest, against what
 * `zn hooks install` writes today and what packages/zn-gate/package.json says. (The ZCode plugin has the same check in
 * test-zcode-plugin.js.) A difference that is on purpose is named here with its reason; any other difference fails.
 *
 *   node plugins/tools/test-plugin-init-parity.js     (from the repository root)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'zn-gate');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const claude = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents', 'claude-code.js'));
const codex = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents', 'codex.js'));
let n = 0;
function test(name, fn) {
  fn();
  n++;
  process.stdout.write('ok ' + n + ' - ' + name + '\n');
}

// Events that `zn hooks install` registers and the plugin does not, on purpose or not yet. Each one needs its reason.
const CLAUDE_NOT_IN_PLUGIN = {
  ConfigChange: 'documented in docs/compat.md: only the install registers it (run the install again to add it)',
  InstructionsLoaded: 'documented in docs/compat.md: only the install registers it (run the install again to add it)',
};
// Events that the plugin registers and the install does not.
const CLAUDE_ONLY_IN_PLUGIN = {
  SessionStart: 'the plugin reports its own installation status (`check`) when a session starts',
};
const CODEX_NOT_IN_PLUGIN = {
  SessionStart: 'reminder for the model only; not protection, and Codex may not load plugin hooks at all',
  SubagentStart: 'reminder for the model only; not protection, and Codex may not load plugin hooks at all',
  Stop: 'last-answer check that only warns; not protection, and Codex may not load plugin hooks at all',
};

const commandOf = (entry) => entry.command;

test('Claude Code plugin hooks: same matchers, timeout and onFailure as the entries `zn hooks install claude-code` writes', () => {
  const mine = json(PLUGIN, 'hooks', 'hooks.json').hooks;
  const theirs = claude.ourHooks((event) => 'zn ' + event);
  const expected = Object.keys(theirs).filter((e) => !(e in CLAUDE_NOT_IN_PLUGIN)).concat(Object.keys(CLAUDE_ONLY_IN_PLUGIN));
  assert.deepStrictEqual(Object.keys(mine).sort(), expected.sort());
  for (const [event, group] of Object.entries(theirs)) {
    if (event in CLAUDE_NOT_IN_PLUGIN) continue;
    assert.strictEqual(mine[event].length, 1, event);
    assert.strictEqual(mine[event][0].matcher, group.matcher, event + ' matcher');
    assert.strictEqual(mine[event][0].hooks.length, group.hooks.length, event);
    group.hooks.forEach((h, i) => {
      const p = mine[event][0].hooks[i];
      assert.strictEqual(p.timeout, h.timeout, event + ' timeout');
      assert.strictEqual(p.onFailure, h.onFailure, event + ' onFailure');
      assert.strictEqual(p.type, h.type, event + ' type');
      assert.ok(commandOf(p).includes('scripts/zn-node.sh" ' + event + ' hook claude-code'), event + ' runs the launcher for its own event');
    });
  }
});

test('Codex plugin hooks: same events, matchers and timeout as the entries `zn hooks install codex` writes', () => {
  const mine = json(PLUGIN, 'com.openai', 'hooks.json').hooks;
  const theirs = codex.hookGroups((event) => ({ event, timeout: codex.HOOK_TIMEOUT_S, statusMessage: codex.HOOK_STATUS }));
  const expected = Object.keys(theirs).filter((e) => !(e in CODEX_NOT_IN_PLUGIN));
  assert.deepStrictEqual(Object.keys(mine).sort(), expected.sort());
  for (const event of expected) {
    assert.strictEqual(mine[event].length, 1, event);
    assert.strictEqual(mine[event][0].matcher, theirs[event].matcher, event + ' matcher');
    for (const p of mine[event][0].hooks) {
      assert.strictEqual(p.timeout, codex.HOOK_TIMEOUT_S, event + ' timeout');
      assert.strictEqual(p.statusMessage, codex.HOOK_STATUS, event + ' status text');
      assert.ok(commandOf(p).includes('scripts/zn-node.sh" ' + event + ' hook codex'), event + ' runs the launcher for its own event');
    }
  }
});

// The plugin is pinned to a published release, so on a release pull request its version may be one release behind
// packages/zn-gate/package.json (check-plugins.js --release --pre-tag checks that). The manifests, the plugin package.json
// and the lock file must always agree with each other; the license is the package's.
test('every plugin manifest, the plugin package.json and the lock file carry one version, and the license of packages/zn-gate', () => {
  const pkg = json(ROOT, 'packages', 'zn-gate', 'package.json');
  const files = [
    ['plugins', 'zn-gate', 'plugin.json'],
    ['plugins', 'zn-gate', '.claude-plugin', 'plugin.json'],
    ['plugins', 'zcode', '.zcode-plugin', 'plugin.json'],
    ['plugins', 'zn-gate', 'package.json'],
  ];
  const lock = json(PLUGIN, 'scripts', 'zn-gate.lock.json');
  for (const f of files) {
    const m = json(ROOT, ...f);
    assert.strictEqual(m.version, lock.version, f.join('/') + ' version');
    assert.strictEqual(m.license, pkg.license, f.join('/') + ' license');
  }
  assert.strictEqual(json(PLUGIN, 'package.json').dependencies['zn-gate'], lock.version, 'plugin package.json pins the release');
});

process.stdout.write('1..' + n + '\n');
