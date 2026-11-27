'use strict';
// Two gaps closed in the .env guard: a file name zn cannot read in full (longer than the path limit, or a percent-encoded file: URI)
// is refused instead of dropped, and the everyday commands that only read a project .env (source, ., --env-file of node and
// docker, dotenv runners) pass while every write keeps its refusal. The fixtures use a scratch project and inert text.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const codex = require('../lib/agents/codex');
const gemini = require('../lib/agents/gemini');
const copilot = require('../lib/agents/copilot');
const antigravity = require('../lib/agents/antigravity');
const opencode = require('../lib/agents/opencode');
const zcode = require('../lib/agents/zcode');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

function project(t) {
  const dir = tempDir(t, 'zn-envread-');
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=1\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi\n');
  return dir;
}

// The answer the agent gets: the adapter's own output (a call the adapter could not read is refused there).
async function verdict(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  const out = JSON.stringify(res.output || {}) + ' ' + JSON.stringify(res.decision || {});
  return /"deny"|"block"|"permissionDecision":"deny"|"permission":"deny"/.test(out) ? 'deny' : 'allow';
}

const cc = (dir, tool, input) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't' });
const cdx = (dir, tool, input) => ({ session_id: 's', cwd: dir, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, turn_id: 'u', tool_use_id: 't' });
const gem = (dir, tool, input) => ({ session_id: 's', cwd: dir, hook_event_name: 'BeforeTool', tool_name: tool, tool_input: input });
const cop = (dir, tool, args) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName: tool, toolArgs: JSON.stringify(args) });
const ag = (dir, name, args) => ({ conversationId: 'c1', workspacePaths: [dir], toolCall: { name, args } });
const oc = (dir, tool, args) => ({ hook: 'tool.execute.before', tool, args, cwd: dir, sessionID: 's' });

const longEnv = (dir) => dir + '/' + './'.repeat(2100) + '.env'; // over the 4096-character path limit

test('a .env name longer than the path limit is refused for an MCP write in every agent', async (t) => {
  const dir = project(t);
  const body = { path: longEnv(dir), content: 'LD_PRELOAD=/x.so\n' };
  assert.equal(await verdict(claude, cc(dir, 'mcp__filesystem__write_file', body)), 'deny', 'claude write_file');
  assert.equal(await verdict(claude, cc(dir, 'mcp__filesystem__edit_file', { path: longEnv(dir), edits: [] })), 'deny', 'claude edit_file');
  assert.equal(await verdict(claude, cc(dir, 'mcp__fs__move_file', { source: 'notes.txt', destination: longEnv(dir) })), 'deny', 'claude move_file');
  assert.equal(await verdict(codex, cdx(dir, 'mcp__filesystem__write_file', body)), 'deny', 'codex');
  assert.equal(await verdict(gemini, gem(dir, 'mcp_filesystem_write_file', body)), 'deny', 'gemini mcp');
  assert.equal(await verdict(copilot, cop(dir, 'filesystem-write_file', body)), 'deny', 'copilot');
  assert.equal(await verdict(antigravity, ag(dir, 'mcp_filesystem_write_file', body)), 'deny', 'antigravity');
  assert.equal(await verdict(opencode, oc(dir, 'filesystem_write_file', body)), 'deny', 'opencode');
});

test('a long name is refused for the own file tools of Gemini CLI (write and read), a short one is judged as before', async (t) => {
  const dir = project(t);
  assert.equal(await verdict(gemini, gem(dir, 'write_file', { file_path: longEnv(dir), content: 'LD_PRELOAD=/x.so\n' })), 'deny', 'write_file long');
  const home = path.join(dir, 'home');
  const longKey = home + '/' + 'a'.repeat(4100) + '/../.ssh/id_rsa';
  assert.equal(await verdict(gemini, gem(dir, 'read_file', { file_path: longKey })), 'deny', 'read_file long');
  assert.equal(await verdict(gemini, gem(dir, 'read_file', { file_path: path.join(dir, 'notes.txt') })), 'allow', 'read_file short');
});

test('a percent-encoded file: URI that names .env is refused under any key', async (t) => {
  const dir = project(t);
  for (const key of ['u', 'uri', 'target']) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__fs__write_file', { [key]: 'file://' + dir + '/%2Eenv', content: 'X=1' })), 'deny', key);
  }
});

test('an MCP call with long text that does not name a file still passes', async (t) => {
  const dir = project(t);
  assert.equal(await verdict(claude, cc(dir, 'mcp__github__create_issue', { title: 'docs', body: 'x'.repeat(5000) })), 'allow');
});

const READS = [
  'node --env-file=.env app.js',
  'node --env-file .env app.js',
  'docker run --env-file .env alpine true',
  'docker compose --env-file .env.local up -d',
  'npx dotenv -e .env -- node app.js',
  'dotenvx run -f .env -- node app.js',
];

const WRITES = [
  'echo .env | xargs -I{} cp notes.txt {}',
  'ls .env | xargs -I{} cp notes.txt {}',
  "node --env-file=.env -e \"require('fs').writeFileSync('.env','x')\"",
  "npx dotenv -e .env -- python3 -c \"open('.env','w').write('x')\"",
  "cat .env; python3 -c \"open('.env','w')\"",
  'source .env > .env',
  'node --env-file .env app.js > .env',
  'docker run --env-file .env alpine sh -c "echo A=1 >> .env"',
  'cp notes.txt $(echo .env)',
  'for f in .env; do cp notes.txt $f; done',
  'git reset --hard && cat .env',
  'git stash pop && source .env',
  'cat .env && cp notes.txt .env',
  'node -e .env',
  'python3 -m venv .env',
  'source .env && npm test',
  'set -a; . ./.env; set +a; npm start',
];

test('commands that only read a project .env pass (--env-file, dotenv runners)', async (t) => {
  const dir = project(t);
  for (const command of READS) {
    assert.equal(await verdict(claude, cc(dir, 'Bash', { command })), 'allow', 'claude: ' + command);
    assert.equal(await verdict(gemini, gem(dir, 'run_shell_command', { command })), 'allow', 'gemini: ' + command);
  }
});

test('a command that can still write .env is refused, also next to a read', async (t) => {
  const dir = project(t);
  for (const command of WRITES) {
    assert.equal(await verdict(claude, cc(dir, 'Bash', { command })), 'deny', 'claude: ' + command);
    assert.equal(await verdict(gemini, gem(dir, 'run_shell_command', { command })), 'deny', 'gemini: ' + command);
  }
});

test('the refusal for a program zn cannot prove read-only says so and names the reads that pass', async (t) => {
  const dir = project(t);
  const res = await runner.handle(claude, cc(dir, 'Bash', { command: 'node -e .env' }), { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', znRunPrefix: 'x --' });
  const text = JSON.stringify(res.decision);
  assert.match(text, /zn cannot tell whether this command writes \.env/);
  assert.match(text, /use --env-file/);
  assert.match(text, /source and \. run the file as shell code/);
});

// source and . run the file as shell code: a .env whose lines rewrite the file would change it after the check, so they are refused
// whatever the file holds.
test('source and . of a .env are refused, also for a .env whose sourced lines rewrite it', async (t) => {
  for (const body of ['PORT=1\n', "printf 'LD_DEBUG=help\\n' > .env\n", 'PORT=1\necho LD_PRELOAD=/x.so >> .env\n']) {
    const dir = project(t);
    fs.writeFileSync(path.join(dir, '.env'), body);
    for (const command of ['source .env', '. ./.env', 'source .env && npm test']) {
      assert.equal(await verdict(claude, cc(dir, 'Bash', { command })), 'deny', JSON.stringify(body) + ' ' + command);
      assert.equal(await verdict(gemini, gem(dir, 'run_shell_command', { command })), 'deny', 'gemini ' + JSON.stringify(body) + ' ' + command);
    }
  }
});

// Long or multi-line text is not an unreadable file name: a long value is classified like any other, and a multi-line value is checked
// by its trimmed whole and each line that starts like a path. Ordinary prompts, plans, code and long URLs pass; a .env still does not.
const zc = (dir, tool, input) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't' });
const longText = ('Read guide/setup.txt and src/app/main.ts, then update the README section about configuration. ').repeat(70);

test('long prompts, plans and skill arguments that mention paths pass in ZCode', async (t) => {
  const dir = project(t);
  assert.ok(longText.length > 6000);
  assert.equal(await verdict(zcode, zc(dir, 'Task', { description: 'x', prompt: longText, subagent_type: 'general-purpose' })), 'allow', 'Task');
  assert.equal(await verdict(zcode, zc(dir, 'Agent', { description: 'x', prompt: longText })), 'allow', 'Agent');
  assert.equal(await verdict(zcode, zc(dir, 'ExitPlanMode', { plan: '# Plan\n\n' + longText.replace(/\. /g, '.\n') })), 'allow', 'ExitPlanMode');
  assert.equal(await verdict(zcode, zc(dir, 'Skill', { skill: 'x', args: longText })), 'allow', 'Skill');
});

test('multi-line code or text under a path-like key and a long https URI pass in MCP calls; a .env line does not', async (t) => {
  const dir = project(t);
  const longUri = 'https://example.com/search?q=' + 'a'.repeat(5000);
  for (const [name, args] of [['source', { source: 'import os\nprint(1)' }], ['target', { target: 'line one\nline two' }], ['uri', { uri: longUri }]]) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__jupyter__insert_cell', args)), 'allow', 'claude ' + name);
    assert.equal(await verdict(gemini, gem(dir, 'mcp_jupyter_insert_cell', args)), 'allow', 'gemini ' + name);
    assert.equal(await verdict(zcode, zc(dir, 'mcp__jupyter__insert_cell', args)), 'allow', 'zcode ' + name);
  }
  for (const target of ['.env\n', 'notes\n./.env\n', '\n  .env  \n']) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__fs__copy', { source: 'notes.txt', target })), 'deny', 'claude ' + JSON.stringify(target));
    assert.equal(await verdict(gemini, gem(dir, 'mcp_fs_copy', { source: 'notes.txt', target })), 'deny', 'gemini ' + JSON.stringify(target));
  }
});

test('a long fact for Gemini save_memory and a long note to a tool zn does not know pass', async (t) => {
  const dir = project(t);
  assert.equal(await verdict(gemini, gem(dir, 'save_memory', { fact: longText })), 'allow', 'save_memory');
  assert.equal(await verdict(gemini, gem(dir, 'custom_tool', { note: longText })), 'allow', 'gemini unknown');
  assert.equal(await verdict(antigravity, ag(dir, 'custom_tool', { note: longText })), 'allow', 'antigravity unknown');
  assert.equal(await verdict(copilot, cop(dir, 'custom_tool', { note: longText })), 'allow', 'copilot unknown');
});

// A tool may take one file name per line: under a file key every line counts, and a watched dotenv line anywhere refuses the call.
test('a .env on any line of a multi-line value is refused, also a relative one after another name', async (t) => {
  const dir = project(t);
  for (const value of ['notes\nsub/.env', 'notes.txt\r\nsub/.env\r\n', 'a\nb\n.env.local']) {
    for (const key of ['path', 'paths', 'target', 'note']) {
      const args = { [key]: value };
      assert.equal(await verdict(claude, cc(dir, 'mcp__custom__write_names', args)), 'deny', 'claude ' + key + ' ' + JSON.stringify(value));
      assert.equal(await verdict(codex, cdx(dir, 'mcp__custom__write_names', args)), 'deny', 'codex ' + key);
      assert.equal(await verdict(gemini, gem(dir, 'mcp_custom_write_names', args)), 'deny', 'gemini ' + key);
      assert.equal(await verdict(antigravity, ag(dir, 'mcp_custom_write_names', args)), 'deny', 'antigravity ' + key);
      assert.equal(await verdict(copilot, cop(dir, 'custom-write_names', args)), 'deny', 'copilot ' + key);
      assert.equal(await verdict(opencode, oc(dir, 'custom_write_names', args)), 'deny', 'opencode ' + key);
      assert.equal(await verdict(zcode, zc(dir, 'mcp__custom__write_names', args)), 'deny', 'zcode ' + key);
    }
  }
});

// A name with blanks around it is the same file for many servers (and for Windows): it is checked trimmed.
test('a .env name with spaces or a tab around it is refused in an MCP call', async (t) => {
  const dir = project(t);
  for (const name of ['.env ', ' .env', '.env\t', '  ./.env  ']) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__fs__write_file', { path: name, content: 'X=1' })), 'deny', 'claude ' + JSON.stringify(name));
    assert.equal(await verdict(gemini, gem(dir, 'mcp_fs_write_file', { path: name, content: 'X=1' })), 'deny', 'gemini ' + JSON.stringify(name));
    assert.equal(await verdict(claude, cc(dir, 'mcp__x__batch_write', { names: 'notes.txt\n' + name })), 'deny', 'claude names ' + JSON.stringify(name));
  }
});

// A tool may take one URI per line: a percent-encoded file: URI on any line is decoded and checked like a one-line value.
test('a percent-encoded file: URI naming .env on a line of a multi-line value is refused in every agent', async (t) => {
  const dir = project(t);
  for (const value of ['notes\nfile://' + dir + '/%2Eenv', 'file://' + dir + '/notes.txt\r\n  file://' + dir + '/%2eenv  \r\n']) {
    for (const key of ['uri', 'path', 'note']) {
      const args = { [key]: value };
      assert.equal(await verdict(claude, cc(dir, 'mcp__custom__open_uris', args)), 'deny', 'claude ' + key);
      assert.equal(await verdict(codex, cdx(dir, 'mcp__custom__open_uris', args)), 'deny', 'codex ' + key);
      assert.equal(await verdict(gemini, gem(dir, 'mcp_custom_open_uris', args)), 'deny', 'gemini ' + key);
      assert.equal(await verdict(antigravity, ag(dir, 'mcp_custom_open_uris', args)), 'deny', 'antigravity ' + key);
      assert.equal(await verdict(copilot, cop(dir, 'custom-open_uris', args)), 'deny', 'copilot ' + key);
      assert.equal(await verdict(opencode, oc(dir, 'custom_open_uris', args)), 'deny', 'opencode ' + key);
      assert.equal(await verdict(zcode, zc(dir, 'mcp__custom__open_uris', args)), 'deny', 'zcode ' + key);
    }
  }
});

// A search, title or message that is only the word ".env" is text, not a file: it passes. A path (./.env, sub/.env) under the same
// keys, and a bare .env under a file key or any other key, is still refused.
test('a free-text value that is only the word .env passes; a path to .env under the same key does not', async (t) => {
  const dir = project(t);
  for (const [key, value] of [['query', '.env'], ['q', '.env.local'], ['title', ' .env '], ['search', '.env']]) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__search__find', { [key]: value })), 'allow', 'claude ' + key);
    assert.equal(await verdict(gemini, gem(dir, 'mcp_search_find', { [key]: value })), 'allow', 'gemini ' + key);
    assert.equal(await verdict(copilot, cop(dir, 'search-find', { [key]: value })), 'allow', 'copilot ' + key);
  }
  // A tool whose name does not say it only reads or searches may use a title or message as the file it writes: still refused.
  for (const [name, key] of [['notes__create', 'title'], ['custom__tool', 'title'], ['mail__send', 'subject'], ['docs__search_and_update', 'query'],
    ['fs__writeNote', 'message']]) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__' + name, { [key]: '.env', content: 'X=1' })), 'deny', 'claude ' + name);
    assert.equal(await verdict(gemini, gem(dir, 'mcp_' + name.replace('__', '_'), { [key]: '.env', content: 'X=1' })), 'deny', 'gemini ' + name);
    assert.equal(await verdict(copilot, cop(dir, name.replace('__', '-'), { [key]: '.env', content: 'X=1' })), 'deny', 'copilot ' + name);
  }
  for (const [key, value] of [['query', './.env'], ['query', 'sub/.env'], ['path', '.env'], ['target', '.env'], ['x', '.env']]) {
    assert.equal(await verdict(claude, cc(dir, 'mcp__fs__write', { [key]: value, content: 'X=1' })), 'deny', 'claude ' + key + ' ' + value);
    assert.equal(await verdict(gemini, gem(dir, 'mcp_fs_write', { [key]: value, content: 'X=1' })), 'deny', 'gemini ' + key + ' ' + value);
  }
});
