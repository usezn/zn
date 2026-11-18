'use strict';

// zn-gate check: when the agent's --version cannot even be started (a timeout that is not a valid number), the
// version is "not found" and nothing is thrown. Fictitious agents: shell scripts in a temporary folder.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const V = require('../lib/agents/versions');

const POSIX = { skip: process.platform === 'win32' && 'the fake agent is a #!/bin/sh script' };

test('an agent whose version check cannot be started gives "not found", never a throw', POSIX, (t) => {
  const home = tempDir(t, 'zn-ver-spawn-home-');
  const bin = tempDir(t, 'zn-ver-spawn-bin-');
  const cwd = tempDir(t, 'zn-ver-spawn-cwd-');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho 0.163.0\n', { mode: 0o755 });
  const env = { HOME: home, USERPROFILE: home, PATH: bin + path.delimiter + '/usr/bin:/bin' };
  // A negative timeout is refused by child_process itself: the program is found, but the check cannot run.
  assert.equal(V.foundVersion('codex', { env, cwd, timeoutMs: -1 }), null);
  const info = V.versionInfo('codex', { env, cwd, timeoutMs: -1 });
  assert.equal(info.relation, 'not-found');
  assert.equal(V.versionLine(info), 'version: not found (tested with 0.163.0)');
  // The same agent with a valid timeout is found, so the failure above came from the check, not the program.
  assert.equal(V.foundVersion('codex', { env, cwd }), '0.163.0');
});

test('an agent id that the data file does not know has no version', () => {
  assert.equal(V.foundVersion('no-such-agent'), null);
  assert.equal(V.versionInfo('no-such-agent').relation, 'not-found');
});
