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

assert.deepStrictEqual(versionedTexts(NEW, NEW), [], 'a pin that does not change moves nothing');

console.log('ok 1 - a pin change moves zn-gate@<version> in plugins/zn-gate/README.md and plugins/README.md');
console.log('ok 2 - the Claude Code plugin README names no version');
console.log('ok 3 - an unchanged pin moves nothing');
