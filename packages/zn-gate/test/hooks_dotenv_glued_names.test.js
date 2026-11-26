'use strict';
// A watched .env name glued to an option, to a sed write command or inside a container volume spec is a write target like the
// same name standing alone. Benign uses of similar words still pass. The fixtures use a scratch project and inert text.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const gemini = require('../lib/agents/gemini');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

function project(t) {
  const dir = tempDir(t, 'zn-glued-');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=1\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi\n');
  return dir;
}

async function verdict(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  const out = JSON.stringify(res.output || {}) + ' ' + JSON.stringify(res.decision || {});
  return /"deny"|"block"|"permissionDecision":"deny"/.test(out) ? 'deny' : 'allow';
}

const cc = (dir, command) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' });
const gem = (dir, command) => ({ session_id: 's', cwd: dir, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command } });

const WRITES = [
  'sort -o.env notes.txt',
  'sort -o./sub/.env notes.txt',
  "sed -n 'w.env' notes.txt",
  "sed -n 'W./.env' notes.txt",
  'docker run -v ./.env:/app/e:rw alpine sh -c "echo A=1 >> /app/e"',
  'podman run -v .env:/app/e alpine true',
  'docker run --mount type=bind,source=./.env,target=/app/e alpine true',
];

const BENIGN = [
  'sort -o out.txt notes.txt',
  "sed -n 'p' notes.txt",
  'docker run -v ./data:/app/data alpine true',
  'docker run --mount type=bind,source=./data,target=/app/data alpine true',
  'cp notes.txt prod.env',
  'grep -e.env notes.txt',
];

test('a .env name glued to an option, a sed w command or a container volume spec is refused', async (t) => {
  const dir = project(t);
  for (const command of WRITES) {
    assert.equal(await verdict(claude, cc(dir, command)), 'deny', 'claude: ' + command);
    assert.equal(await verdict(gemini, gem(dir, command)), 'deny', 'gemini: ' + command);
  }
});

test('similar commands that do not write a watched .env still pass', async (t) => {
  const dir = project(t);
  for (const command of BENIGN) {
    assert.equal(await verdict(claude, cc(dir, command)), 'allow', 'claude: ' + command);
  }
});
