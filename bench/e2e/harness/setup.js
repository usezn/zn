#!/usr/bin/env node
'use strict';
/**
 * Prepares one end-to-end run directory:
 *
 *   <run>/proj           a git project: shadowed .env (markers only), a config
 *                        file with plain-text fake cloud keys, src/
 *   <run>/home           isolated HOME with a fake ~/.aws/credentials
 *   <run>/zn             ZN_HOME for the test vault
 *   <run>/values.json    every fake value (for the leak check; never committed)
 *   <run>/secrets.json   what the test vault stores
 *   <run>/scenario.json  the scripted model turns for <agent>
 *
 *   node setup.js --pkg <packages/zn-gate> --run <dir> --agent claude-code|codex|opencode|copilot|gemini [--scenario <name>]
 *
 * With --scenario (Codex only, see run_codex_scenarios.sh) the scripted turns
 * are those of one hook scenario instead of the main task.
 *
 * All values come from the fake-secret generator of the leak bench.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PKG = path.resolve(arg('--pkg'));
const RUN = path.resolve(arg('--run'));
const AGENT = arg('--agent', 'claude-code');
const SCENARIO = arg('--scenario', '');
const { generateAll } = require(path.join(PKG, 'test', 'fixtures', 'fake_secrets'));

const FAKE = generateAll(20261011, { perType: 1, piiPerType: 1 });
const pick = (t) => FAKE.secrets.find((s) => s.type === t);
const DB = pick('postgres_connection_string').sensitive;
const GH = pick('github_pat_classic').value;
const AWS_ID = pick('aws_access_key_id').value;
const AWS_SECRET = pick('aws_secret_access_key').value;
const PASTED = pick('stripe_secret_key') ? pick('stripe_secret_key').value : pick('openai_api_key').value;

const proj = path.join(RUN, 'proj');
const home = path.join(RUN, 'home');
for (const d of [proj, home, path.join(RUN, 'zn'), path.join(RUN, 'out'), path.join(proj, 'config'), path.join(proj, 'src'), path.join(home, '.aws')]) fs.mkdirSync(d, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: proj });
fs.writeFileSync(path.join(proj, '.gitignore'), '.env\n.env.local\n');
fs.writeFileSync(path.join(proj, '.env'), 'DB_PASSWORD=__ZN_DB_PASSWORD__\nGITHUB_TOKEN=__ZN_GITHUB_TOKEN__\nPORT=3000\n');
fs.writeFileSync(path.join(proj, 'config', 'settings.yml'), 'region: eu-west-1\naws_access_key_id: ' + AWS_ID + '\naws_secret_access_key: ' + AWS_SECRET + '\nretries: 3\n');
fs.writeFileSync(path.join(proj, 'src', 'index.js'), 'console.log("hello");\n');
fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = ' + AWS_ID + '\naws_secret_access_key = ' + AWS_SECRET + '\n');
spawnSync('git', ['add', '.gitignore', 'config', 'src'], { cwd: proj });
// Gemini CLI refuses paths outside the project before any hook runs, so the credentials file it is asked to
// read has to be inside the project (a fake one, named like the real one).
if (AGENT === 'gemini') {
  fs.mkdirSync(path.join(proj, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.aws', 'credentials'), '[default]\naws_access_key_id = ' + AWS_ID + '\naws_secret_access_key = ' + AWS_SECRET + '\n');
}

fs.writeFileSync(path.join(RUN, 'values.json'), JSON.stringify([
  { name: 'DB_PASSWORD', value: DB },
  { name: 'GITHUB_TOKEN', value: GH },
  { name: 'AWS_ACCESS_KEY_ID', value: AWS_ID },
  { name: 'AWS_SECRET_ACCESS_KEY', value: AWS_SECRET },
  { name: 'PASTED_KEY', value: PASTED },
], null, 2));
fs.writeFileSync(path.join(RUN, 'secrets.json'), JSON.stringify([
  { name: 'DB_PASSWORD', value: DB, meta: { mode: 'env', allowCommands: ['node', 'python3'] } },
  { name: 'GITHUB_TOKEN', value: GH, meta: { mode: 'proxy', allowHosts: ['api.github.com'] } },
], null, 2));
fs.writeFileSync(path.join(RUN, 'pasted.txt'), 'Deploy the app with this key: ' + PASTED + '\n');

const P = (...p) => path.join(proj, ...p);
const PRINT_NODE = 'node -e "console.log(\'db:\', process.argv[1])" __ZN_DB_PASSWORD__';
const PRINT_PY = 'python3 -c "import sys; print(\'db:\', sys.argv[1])" __ZN_DB_PASSWORD__';
const RESTORE = 'printf %s __ZN_AWS_KEY_1__ | wc -c';
// A secret marker in a command's arguments is refused (the value would show in the process list), so the
// allowed and the declined command take the secret the supported way: as an environment variable of the
// program, through zn run --secrets. The output still prints the value, and zn masks it back to the marker.
const ENV_NODE = 'zn run --secrets DB_PASSWORD -- node -e "console.log(\'db:\', process.env.DB_PASSWORD)"';
const ENV_PY = 'zn run --secrets DB_PASSWORD -- python3 -c "import os; print(\'db:\', os.environ[\'DB_PASSWORD\'])"';

const scenarios = {
  'claude-code': [
    { tool: 'Read', input: { file_path: P('.env') } },
    { tool: 'Read', input: { file_path: P('config', 'settings.yml') } },
    { tool: 'Write', input: { file_path: P('src', 'client.js'), content: 'const token = process.env.GITHUB_TOKEN; // stored as __ZN_GITHUB_TOKEN__\n' } },
    { tool: 'Bash', input: { command: ENV_NODE, description: 'allowed command' } },
    { tool: 'Bash', input: { command: ENV_PY, description: 'command not approved' } },
    { tool: 'Bash', input: { command: RESTORE, description: 'restore a detected value locally' } },
    { tool: 'Read', input: { file_path: path.join(home, '.aws', 'credentials') } },
    { tool: 'Bash', input: { command: 'cat config/settings.yml', description: 'read the config again' } },
  ],
  codex: [
    { tool: 'exec_command', input: { cmd: 'cat .env' } },
    { tool: 'exec_command', input: { cmd: 'cat config/settings.yml' } },
    { tool: 'exec_command', input: { cmd: PRINT_NODE } },
    { tool: 'exec_command', input: { cmd: ENV_NODE } },
    { tool: 'exec_command', input: { cmd: ENV_PY } },
    { tool: 'exec_command', input: { cmd: 'cat ~/.aws/credentials' } },
  ],
  opencode: [
    { tool: 'read', input: { filePath: P('.env') } },
    { tool: 'read', input: { filePath: P('config', 'settings.yml') } },
    { tool: 'write', input: { filePath: P('src', 'client.js'), content: 'const token = process.env.GITHUB_TOKEN; // stored as __ZN_GITHUB_TOKEN__\n' } },
    { tool: 'bash', input: { command: ENV_NODE, description: 'allowed command' } },
    { tool: 'bash', input: { command: ENV_PY, description: 'command not approved' } },
    { tool: 'read', input: { filePath: path.join(home, '.aws', 'credentials') } },
    { tool: 'bash', input: { command: 'cat config/settings.yml', description: 'read the config again' } },
  ],
};
scenarios.copilot = [
  { tool: 'view', input: { path: P('.env') } },
  { tool: 'view', input: { path: P('config', 'settings.yml') } },
  { tool: 'create', input: { path: P('src', 'client.js'), file_text: 'const token = process.env.GITHUB_TOKEN; // stored as __ZN_GITHUB_TOKEN__\n' } },
  { tool: 'bash', input: { command: PRINT_NODE, description: 'allowed command' } },
  { tool: 'bash', input: { command: PRINT_PY, description: 'command not approved' } },
  { tool: 'view', input: { path: path.join(home, '.aws', 'credentials') } },
  { tool: 'bash', input: { command: 'cat config/settings.yml', description: 'read the config again' } },
];
// Gemini CLI: hooks cannot rewrite what a tool returns, so the plain-text config file is not part of this
// scenario (its values would reach the model, as the experimental adapter's notes say). `expect` is read by
// summarize_gemini.js: "denied" = the hook must refuse the call, "ran" = the call must go through.
scenarios.gemini = [
  { tool: 'read_file', input: { file_path: P('src', 'index.js') }, expect: 'ran' },
  { tool: 'read_file', input: { file_path: P('.aws', 'credentials') }, expect: 'denied' },
  { tool: 'run_shell_command', input: { command: 'cat ~/.aws/credentials', description: 'read the credentials' }, expect: 'denied' },
  { tool: 'run_shell_command', input: { command: PRINT_NODE, description: 'command with a marker' }, expect: 'denied' },
  { tool: 'run_shell_command', input: { command: 'zn run -- ' + PRINT_NODE, description: 'allowed command through zn run' }, expect: 'ran' },
  { tool: 'run_shell_command', input: { command: 'zn run -- ' + PRINT_PY, description: 'command not approved' }, expect: 'ran' },
  { tool: 'write_file', input: { file_path: P('src', 'client.js'), content: 'const token = process.env.GITHUB_TOKEN; // stored as __ZN_GITHUB_TOKEN__\n' }, expect: 'ran' },
  { tool: 'write_file', input: { file_path: P('.gemini', 'settings.json'), content: '{}' }, expect: 'denied' },
];
let script = { steps: scenarios[AGENT], final: 'All steps done.' };
if (SCENARIO) {
  // A value the scripted model itself writes into an MCP call. It is kept out
  // of values.json: the model's own call comes back in the next request, so it
  // would count as sent. mcp-values.json is checked against what the server got.
  const MCP_KEY = pick('anthropic_api_key').value;
  fs.writeFileSync(path.join(RUN, 'mcp-values.json'), JSON.stringify([{ name: 'MCP_ARG_KEY', value: MCP_KEY }], null, 2));
  const ex = (cmd) => ({ tool: 'exec_command', input: { cmd } });
  const echo = (text) => ({ tool: 'echo', namespace: 'mcp__echo', input: { text } });
  // A call that asks to run outside the sandbox, which needs an approval.
  const ask = (cmd) => ({ tool: 'exec_command', input: { cmd, sandbox_permissions: 'require_escalated', justification: 'end-to-end test' } });
  const DONE = 'All steps done.';
  const byName = {
    permission: { steps: [ask(PRINT_NODE), ask('node -e "console.log(\'ran-after-approval\')"')], final: DONE },
    // A placeholder, then a secret value, then nothing to hide.
    mcp: { steps: [echo('token __ZN_GITHUB_TOKEN__'), echo('key ' + MCP_KEY), echo('hello from the end-to-end run')], final: DONE },
    'stop-warn': { steps: [], final: 'Deploy with this key: ' + PASTED },
    // The answer holds a secret value: with stopReview "block", Stop asks for a rewrite once.
    'stop-block': { steps: [], finals: ['Deploy with this key: ' + MCP_KEY, 'Rewritten without the key.'] },
    // The answer holds a placeholder that no tool or user message ever had (observation).
    'stop-placeholder': { steps: [], final: 'Use the token __ZN_GITHUB_TOKEN__ for the call.' },
    replace: { steps: [ex('cat config/settings.yml')], final: DONE },
    thirdparty: { steps: [ex('echo benign-ok')], final: DONE },
    // The model starts a subagent (spawn_agent); the subagent reads a credential file, which zn denies when its hooks run.
    // The parent then waits a few seconds so that the subagent has time to run.
    'session-context': {
      steps: [{ tool: 'spawn_agent', auto: true, input: { message: 'Read the credentials file with cat.' } }, ex('sleep 10')],
      child: { steps: [ex('cat ~/.aws/credentials')], final: 'Subagent done.' },
      final: DONE,
    },
  };
  if (!byName[SCENARIO]) throw new Error('unknown scenario ' + SCENARIO);
  script = byName[SCENARIO];
}
fs.writeFileSync(path.join(RUN, 'scenario.json'), JSON.stringify(script, null, 2));
process.stdout.write(RUN + '\n');
