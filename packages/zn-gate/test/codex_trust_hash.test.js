'use strict';

// Pins the hashes the real Codex 0.163.0 computes for the hooks `zn-gate hooks install codex` writes, so the
// expected values do not come from hookHash itself. The fixture holds the hooks.json entries and the
// currentHash Codex reported for them (user install, paths with spaces, project install, Windows paths),
// once as Codex hashes on Linux/macOS and once as it hashes on Windows (commandWindows replaces command).

const test = require('node:test');
const assert = require('node:assert/strict');
const { hookHash } = require('../lib/codex-trust');
const fixture = require('./fixtures/codex_trust_hashes.json');

const snake = (e) => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

for (const c of fixture.cases) {
  for (const platform of ['linux', 'win32']) {
    test('hookHash matches Codex ' + fixture.codex_version + ': ' + c.name + ' on ' + platform, () => {
      const mode = platform === 'win32' ? 'windows' : 'native';
      for (const [event, groups] of Object.entries(c.hooks)) {
        const group = groups[0];
        assert.equal(hookHash(event, group, group.hooks[0], platform), c.codex[mode][snake(event)], event);
      }
    });
  }
}

test('hookHash ignores commandWindows when not on Windows', () => {
  const group = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'zn hook codex', timeout: 30 }] };
  const a = hookHash('PreToolUse', group, { ...group.hooks[0], commandWindows: 'other' }, 'linux');
  assert.equal(a, hookHash('PreToolUse', group, group.hooks[0], 'linux'));
});

test('pinned default PreToolUse hash', () => {
  const a = fixture.cases[0];
  assert.equal(a.codex.native.pre_tool_use, 'sha256:bb2904275a6d6d82c7edb153ca8a477d008151ee0f2f7c19c6ae6ee06d85583d');
});
