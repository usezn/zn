#!/usr/bin/env node
'use strict';

/**
 * Tests that a release pin moves the version named in the plugin README
 * (plugins/zn-gate/README.md), as it already does for the other versioned docs. Reads the repository only and
 * writes nothing.
 *
 *   node plugins/tools/test-pin-release-docs.js
 */

const assert = require('assert');
const { versionedTexts } = require('./pin-release');

const REL = 'zn-gate/README.md';
const OLD = require('../zn-gate/.claude-plugin/plugin.json').version;
const NEW = '9.9.9';

const changes = versionedTexts(OLD, NEW);
const found = changes.find(([file]) => file.replace(/\\/g, '/').endsWith('/plugins/' + REL));
assert.ok(found, REL + ' is not in the versioned docs of a pin change');

const [, text] = found;
assert.ok(text.includes('zn-gate@' + NEW), 'the README does not name the new version');
assert.ok(!text.includes('zn-gate@' + OLD), 'the README still names the old version');

assert.deepStrictEqual(versionedTexts(NEW, NEW), [], 'a pin that does not change moves nothing');

console.log('ok 1 - a pin change moves the version in plugins/zn-gate/README.md');
console.log('ok 2 - an unchanged pin moves nothing');
