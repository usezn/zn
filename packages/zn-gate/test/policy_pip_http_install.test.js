'use strict';

// The agent hook policy on pip installs. A plain install by name is allowed. An install from a raw http URL
// (a direct archive or an index given as http) is expected to be blocked, but the policy allows it today:
// the package check reads installs by name only and skips URL sources by design (see lib/package-check.js).
// That case is a todo until the policy changes; nothing here changes product code.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const CWD = path.join(path.sep, 'work', 'proj');

function decide(t, command) {
  const home = tempDir(t, 'zn-pip-http-');
  const raw = { session_id: 's', cwd: CWD, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_pip' };
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
}

test('pip install by name is allowed by the policy', async (t) => {
  const r = await decide(t, 'pip install requests');
  assert.equal(r.decision.decision, 'allow');
});

const HTTP_INSTALLS = [
  'pip install http://example.invalid/x.tar.gz',
  'pip install --index-url http://example.invalid/simple requests',
  'python3 -m pip install http://example.invalid/x.whl',
];

for (const command of HTTP_INSTALLS) {
  test('pip install from a raw http URL is blocked: ' + command, { todo: 'policy allows pip installs from raw http URLs today (no rule for pip URL sources; package-check skips URL installs by design)' }, async (t) => {
    const r = await decide(t, command);
    assert.equal(r.decision.decision, 'deny');
  });
}
