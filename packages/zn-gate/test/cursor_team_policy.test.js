'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Team policy and the Cursor adapter, through the real hook runner. The fake
// vault answers like a daemon whose organization policy denies PROD_DB_URL.
// Cursor cannot rewrite shell commands or restore values into files, so the
// policy is kept by denying markers (shell, MCP) and by never restoring one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const cursor = getAdapter('cursor');
const cu = (event, extra) => ({ conversation_id: 'c', generation_id: 'g', hook_event_name: event, workspace_roots: [extra.cwd || '/'], ...extra });

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
  const dir = tempDir(t, 'zn-cursor-team-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  return dir;
}

async function run(vault, raw) {
  return runner.handle(cursor, raw, { engine: fakeEngine, vault, failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

test('cursor: a shell command with a marker is denied whatever the policy says, and the agent is sent to zn run (where the policy applies)', async (t) => {
  const vault = teamVault();
  await vault.setSecret(DENIED_NAME, DENIED_VALUE, { mode: 'env' });
  const dir = project(t);
  const r = await run(vault, cu('beforeShellExecution', { cwd: dir, command: 'psql "' + MARKER + '" -c "select 1"' }));
  assert.equal(r.output.permission, 'deny');
  assert.match(r.output.agent_message, /run --secrets NAME -- <command>/);
  assert.ok(!JSON.stringify(r.output).includes(DENIED_VALUE), 'the value is never printed');
});

test('cursor: an MCP call with a marker is denied whatever the policy says', async (t) => {
  const vault = teamVault();
  await vault.setSecret(DENIED_NAME, DENIED_VALUE, { mode: 'env' });
  const dir = project(t);
  const r = await run(vault, cu('beforeMCPExecution', { cwd: dir, tool_name: 'query', mcp_server_name: 'db', tool_input: { url: MARKER } }));
  assert.equal(r.output.permission, 'deny');
  assert.ok(!JSON.stringify(r.output).includes(DENIED_VALUE), 'the value is never printed');
});

test('cursor and the team policy: a file write that holds a marker never gets the value back', async (t) => {
  // Documented fail-safe: Cursor restores nothing into files (its Write hook gives zn no text to edit),
  // so a marker the agent writes stays a marker, whatever the organization policy says about it.
  const vault = teamVault();
  await vault.setSecret(DENIED_NAME, DENIED_VALUE, { mode: 'env' });
  const dir = project(t);
  const r = await run(vault, cu('preToolUse', { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, '.env'), contents: 'DATABASE_URL=' + MARKER + '\n' } }));
  assert.ok(!JSON.stringify(r.output || {}).includes(DENIED_VALUE), 'the value is not in the answer');
  assert.ok(!(r.output && r.output.updated_input), 'nothing is rewritten');
  assert.ok(!vault.resolved.includes(MARKER), 'the vault is not even asked to put the value back');
});

// The secrets MCP server is added to Cursor by hand: the install only prints the line. For a project it names zn on the PATH
// (the file is shared); for the user it names this machine's node and zn-gate. Both carry --agent cursor, which the policy needs
// to offer a host written for Cursor.
test('cursor: the install prints the secrets MCP server line with --agent cursor, for the user and for a project', (t) => {
  const os = require('os');
  const cursorAgent = getAdapter('cursor');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cursor-hint-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cursor-hint-proj-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const lineOf = (r) => r.warnings.find((w) => /"secrets" MCP server/.test(w)) || '';
  const user = cursorAgent.install({ home, env: {}, mcp: true });
  const userLine = lineOf(user);
  assert.match(userLine, /~\/\.cursor\/mcp\.json/);
  assert.match(userLine, /"secrets-mcp","--agent","cursor"\]/);
  assert.doesNotMatch(userLine, /"command":"zn"/);
  const proj = cursorAgent.install({ home, env: {}, mcp: true, scope: 'project', projectDir: project });
  const projLine = lineOf(proj);
  assert.match(projLine, /\.cursor\/mcp\.json in this project/);
  assert.match(projLine, /\{"command":"zn","args":\["secrets-mcp","--agent","cursor"\]\}/);
  // The install writes no MCP server itself.
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'mcp.json')), false);
  assert.equal(fs.existsSync(path.join(project, '.cursor', 'mcp.json')), false);
});
