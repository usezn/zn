#!/usr/bin/env node
'use strict';

/**
 * Tests that a release pin moves the versions named in the plugin READMEs
 * (plugins/zn-gate/README.md and plugins/README.md: `zn-gate@<version>`, and the
 * Codex `--ref v<version>`), as it already does for the other versioned docs. The
 * Claude Code marketplace command carries no version (it is added without a tag), so
 * plugins/claude-dir/README.md names none and must stay free of one. Reads the
 * repository only and writes nothing.
 *
 *   node plugins/tools/test-pin-release-docs.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { versionedTexts } = require('./pin-release');

const PLUGINS = path.join(__dirname, '..');
const OLD = require('../zn-gate/.claude-plugin/plugin.json').version;
const NEW = '9.9.9';

const changes = versionedTexts(OLD, NEW);
const textOf = (rel) => {
  const found = changes.find(([file]) => file.split(path.sep).join('/').endsWith('/plugins/' + rel));
  assert.ok(found, rel + ' is not in the versioned docs of a pin change');
  return found[1];
};

// The test is only real if the README names the current pin in the form the rule moves.
for (const rel of ['zn-gate/README.md', 'README.md']) {
  assert.ok(fs.readFileSync(path.join(PLUGINS, rel), 'utf8').includes('zn-gate@' + OLD), rel + ' does not name zn-gate@' + OLD + ': this test would check nothing');
  const text = textOf(rel);
  assert.ok(text.includes('zn-gate@' + NEW), rel + ': the README does not name the new version');
  assert.ok(!text.includes('zn-gate@' + OLD), rel + ': the README still names the old version');
}

// The Claude Code install steps name no version: a pin change must not need to touch them.
const claudeDir = fs.readFileSync(path.join(PLUGINS, 'claude-dir', 'README.md'), 'utf8');
assert.ok(/marketplace add usezn\/zn(?![\w#@./-])/.test(claudeDir), 'claude-dir/README.md lost the untagged marketplace command');
assert.ok(!claudeDir.includes(OLD), 'claude-dir/README.md names the pinned version ' + OLD + ': a pin change would leave it stale');

// A tagged marketplace ref left in a versioned doc (the Claude Code `#v<version>` or the Codex `--ref v<version>`) moves with
// the pin, and another version's tag or a longer version number does not. The docs name no such ref today, so the test feeds one in.
{
  const target = path.join(PLUGINS, 'README.md');
  const real = fs.readFileSync;
  const lines = [
    'claude plugin marketplace add usezn/zn#v' + OLD,
    'codex plugin marketplace add usezn/zn --ref v' + OLD,
    'claude plugin marketplace add usezn/zn#v' + OLD + '0',
    'claude plugin marketplace add usezn/zn#v0.0.1',
  ];
  fs.readFileSync = function (p, ...rest) {
    const out = real.call(this, p, ...rest);
    return typeof out === 'string' && path.resolve(String(p)) === target ? out + '\n' + lines.join('\n') + '\n' : out;
  };
  let moved;
  try { moved = versionedTexts(OLD, NEW); } finally { fs.readFileSync = real; }
  const readme = moved.find(([file]) => path.resolve(file) === target);
  assert.ok(readme, 'plugins/README.md did not change');
  assert.ok(readme[1].includes('claude plugin marketplace add usezn/zn#v' + NEW + '\n'), 'the #v<version> ref did not move');
  assert.ok(readme[1].includes('codex plugin marketplace add usezn/zn --ref v' + NEW + '\n'), 'the --ref v<version> ref did not move');
  assert.ok(readme[1].includes('usezn/zn#v' + OLD + '0\n'), 'a longer version number must not move');
  assert.ok(readme[1].includes('usezn/zn#v0.0.1\n'), 'another version tag must not move');
}

assert.deepStrictEqual(versionedTexts(NEW, NEW), [], 'a pin that does not change moves nothing');

console.log('ok 1 - a pin change moves zn-gate@<version> in plugins/zn-gate/README.md and plugins/README.md');
console.log('ok 2 - the Claude Code plugin README names no version');
console.log('ok 3 - an unchanged pin moves nothing');
console.log('ok 4 - a tagged marketplace ref (Claude Code and Codex) moves with the pin, other tags do not');
