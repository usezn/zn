'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Team policy and the OpenCode adapter, through the real hook runner. The fake
// vault answers like a daemon whose organization policy denies PROD_DB_URL.
// OpenCode keeps the arguments a plugin rewrites in its session, so zn applies
// only a rewrite that adds no secret value (wrapping in `zn run`). A marker in a
// shell command is denied, and a marker written into a file is never restored.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const opencode = getAdapter('opencode');
const oc = (tool, cwd, args) => ({ hook: 'tool.execute.before', tool, sessionID: 's', cwd, args });

const DENIED_NAME = 'PROD_DB_URL';
const DENIED_VALUE = 'postgres://u:' + 'p'.repeat(24) + '@db.internal/app'; // fake, built at runtime
const MARKER = '__ZN_' + DENIED_NAME + '__';

function teamVault() {
  const vault = createFakeVault();
  const resolved = [];
  const plain = vault.resolve.bind(vault);
  vault.resolved = resolved;
  vault.resolve = async (project, token, o) => {
    resolved.push(String(token));
    if (token === MARKER) return o && o.withPolicy === true ? { value: null, policy: 1, deny: true } : null;
    return plain(project, token, o);
  };
  return vault;
}

function project(t) {
  const dir = tempDir(t, 'zn-opencode-team-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  return dir;
}

async function run(vault, raw) {
  return runner.handle(opencode, raw, { engine: fakeEngine, vault, failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

test('opencode: a shell command with a marker is denied whatever the policy says, and the agent is sent to zn run (where the policy applies)', async (t) => {
  const vault = teamVault();
  await vault.setSecret(DENIED_NAME, DENIED_VALUE, { mode: 'env' });
  const dir = project(t);
  const r = await run(vault, oc('bash', dir, { command: 'psql "' + MARKER + '" -c "select 1"' }));
  assert.equal(r.output.action, 'deny');
  assert.match(r.output.message, /run --secrets NAME -- <command>/);
  assert.ok(!JSON.stringify(r.output).includes(DENIED_VALUE), 'the value is never printed');
});

test('opencode and the team policy: a file write that holds a marker never gets the value back', async (t) => {
  // Documented fail-safe: OpenCode restores nothing into files (its plugin API keeps the rewritten arguments in
  // the session, so respond() applies only a rewrite that adds no secret value), so a marker the agent writes
  // stays a marker, whatever the organization policy says about it.
  const vault = teamVault();
  await vault.setSecret(DENIED_NAME, DENIED_VALUE, { mode: 'env' });
  const dir = project(t);
  const file = path.join(dir, '.env');
  const patch = '*** Begin Patch\n*** Add File: ' + file + '\n+DATABASE_URL=' + MARKER + '\n*** End Patch\n';
  const calls = [
    ['write', { filePath: file, content: 'DATABASE_URL=' + MARKER + '\n' }],
    ['edit', { filePath: file, oldString: 'DATABASE_URL=x', newString: 'DATABASE_URL=' + MARKER }],
    ['apply_patch', { patchText: patch }],
  ];
  for (const [tool, args] of calls) {
    const r = await run(vault, oc(tool, dir, args));
    assert.ok(!JSON.stringify(r.output || {}).includes(DENIED_VALUE), tool + ': the value is not in the answer');
    assert.ok(!(r.output && r.output.args), tool + ': nothing is rewritten');
    assert.ok(!vault.resolved.includes(MARKER), tool + ': the vault is not even asked to put the value back');
  }
});

test('opencode and the team policy: the plugin blocks the call when the hook cannot answer', async (t) => {
  // The generated plugin, loaded as OpenCode loads it, with a node that does not exist: the hook runner cannot start,
  // runHook answers {action:"error"}, and tool.execute.before throws, so the call is blocked rather than let through.
  const dir = tempDir(t, 'zn-opencode-plugin-');
  const missing = path.join(dir, 'no-such-node').replace(/\\/g, '/');
  const file = path.join(dir, 'plugin.mjs');
  fs.writeFileSync(file, opencode.pluginSource({ nodePath: missing, runnerPath: path.join(dir, 'runner.js') }));
  const mod = await import(pathToFileURL(file).href);
  const hooks = await mod.ZnGate({ directory: dir });
  const output = { args: { command: 'psql "' + MARKER + '"' } };
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, output), /the secret scrubber is not working/);
  assert.equal(output.args.command, 'psql "' + MARKER + '"', 'the arguments are not touched');
});
