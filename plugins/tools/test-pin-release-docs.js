#!/usr/bin/env node
'use strict';

/**
 * Tests that a release pin moves the versions named in the plugin READMEs
 * (`zn-gate@<version>`) and the plugin tag of every install command
 * (`usezn/zn#plugin-v<version>` for Claude Code, `--ref plugin-v<version>` for
 * Codex) wherever the marketplace is added: the plugin READMEs, README.md, the
 * package READMEs and docs/. Reads the repository only and writes nothing.
 *
 *   node plugins/tools/test-pin-release-docs.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { versionedTexts } = require('./pin-release');

const PLUGINS = path.join(__dirname, '..');
const REPO = path.join(PLUGINS, '..');
const OLD = require('../zn-gate/.claude-plugin/plugin.json').version;
const NEW = '9.9.9';

const changes = versionedTexts(OLD, NEW);
const textOf = (abs) => {
  const found = changes.find(([file]) => path.resolve(file) === path.resolve(abs));
  assert.ok(found, path.relative(REPO, abs) + ' is not in the versioned docs of a pin change');
  return found[1];
};

// The test is only real if the README names the current pin in the form the rule moves.
for (const rel of ['zn-gate/README.md', 'README.md']) {
  assert.ok(fs.readFileSync(path.join(PLUGINS, rel), 'utf8').includes('zn-gate@' + OLD), rel + ' does not name zn-gate@' + OLD + ': this test would check nothing');
  const text = textOf(path.join(PLUGINS, rel));
  assert.ok(text.includes('zn-gate@' + NEW), rel + ': the README does not name the new version');
  assert.ok(!text.includes('zn-gate@' + OLD), rel + ': the README still names the old version');
}

// Every surface that adds the marketplace names the plugin tag of the pin, and a pin change moves it there: inside the
// plugin folder and outside it (README.md, the package README and docs/), for Claude Code (#) and Codex (--ref).
const SURFACES = [
  ['plugins/README.md', ['#', '--ref ']],
  ['plugins/zn-gate/README.md', ['#']],
  ['plugins/claude-dir/README.md', ['#']],
  ['README.md', ['#']],
  ['packages/zn-gate/README.md', ['#']],
  ['docs/by-agent.md', ['#']],
  ['docs/upgrading.md', ['#']],
];
for (const [rel, forms] of SURFACES) {
  const abs = path.join(REPO, rel);
  const before = fs.readFileSync(abs, 'utf8');
  for (const form of forms) {
    const old = (form === '#' ? 'usezn/zn#' : 'usezn/zn --ref ') + 'plugin-v' + OLD;
    assert.ok(before.includes(old), rel + ' does not name ' + old + ': this test would check nothing');
    const text = textOf(abs);
    assert.ok(text.includes((form === '#' ? 'usezn/zn#' : 'usezn/zn --ref ') + 'plugin-v' + NEW), rel + ': the ' + form.trim() + ' plugin tag did not move');
    assert.ok(!text.includes('plugin-v' + OLD), rel + ': the old plugin tag is still there');
  }
}

// Only the plugin tag of the old pin moves: another version, a longer number and a release tag outside the plugin folder
// stay. The docs name no such ref today, so the test feeds them into README.md (outside plugins/) and plugins/README.md.
{
  const lines = [
    'claude plugin marketplace add usezn/zn#plugin-v' + OLD,
    'codex plugin marketplace add usezn/zn --ref plugin-v' + OLD,
    'the tag `plugin-v' + OLD + '`',
    'claude plugin marketplace add usezn/zn#plugin-v' + OLD + '0',
    'claude plugin marketplace add usezn/zn#plugin-v' + OLD + '.1',
    'claude plugin marketplace add usezn/zn#plugin-v0.0.1',
    'see zn-plugin-v' + OLD,
  ];
  const targets = [path.join(PLUGINS, 'README.md'), path.join(REPO, 'README.md')];
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    const out = real.call(this, p, ...rest);
    return typeof out === 'string' && targets.includes(path.resolve(String(p))) ? out + '\n' + lines.join('\n') + '\n' : out;
  };
  let moved;
  try { moved = versionedTexts(OLD, NEW); } finally { fs.readFileSync = real; }
  for (const target of targets) {
    const doc = moved.find(([file]) => path.resolve(file) === target);
    assert.ok(doc, path.relative(REPO, target) + ' did not change');
    const t = doc[1];
    assert.ok(t.includes('claude plugin marketplace add usezn/zn#plugin-v' + NEW + '\n'), target + ': the #plugin-v<version> ref did not move');
    assert.ok(t.includes('codex plugin marketplace add usezn/zn --ref plugin-v' + NEW + '\n'), target + ': the --ref plugin-v<version> ref did not move');
    assert.ok(t.includes('the tag `plugin-v' + NEW + '`\n'), target + ': the tag named in prose did not move');
    assert.ok(t.includes('usezn/zn#plugin-v' + OLD + '0\n'), target + ': a longer version number must not move');
    assert.ok(t.includes('usezn/zn#plugin-v' + OLD + '.1\n'), target + ': a longer version number must not move');
    assert.ok(t.includes('usezn/zn#plugin-v0.0.1\n'), target + ': another version must not move');
    assert.ok(t.includes('see zn-plugin-v' + OLD + '\n'), target + ': a longer name must not move');
  }
}

// Outside the plugin folder nothing but the plugin tag follows the pin.
{
  const abs = path.join(REPO, 'README.md');
  const before = fs.readFileSync(abs, 'utf8');
  assert.strictEqual(textOf(abs), before.split('plugin-v' + OLD).join('plugin-v' + NEW), 'README.md: a pin change moved more than the plugin tag');
}

assert.deepStrictEqual(versionedTexts(NEW, NEW), [], 'a pin that does not change moves nothing');

console.log('ok 1 - a pin change moves zn-gate@<version> in plugins/zn-gate/README.md and plugins/README.md');
console.log('ok 2 - a pin change moves the plugin tag of every install command, in and outside the plugin folder');
console.log('ok 3 - only the plugin tag of the old pin moves (Claude Code and Codex); other versions do not');
console.log('ok 4 - outside the plugin folder nothing but the plugin tag moves');
console.log('ok 5 - an unchanged pin moves nothing');
